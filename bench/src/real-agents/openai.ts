import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { agentTask, MAX_RUN_USD_ENV, positiveNumberEnv, recordUsage, type RealAgent } from './agent-env.js';

export const OPENAI_AGENT_NAME = 'openai';
export const OPENAI_KEY_ENV = 'OPENAI_API_KEY';
export const OPENAI_MODEL_ENV = 'AGENT_ONCE_OPENAI_MODEL';
export const OPENAI_MAX_COMPLETION_TOKENS = 1_024;
export const OPENAI_PRICE_ENVS = { input: 'AGENT_ONCE_OPENAI_INPUT_USD_PER_MTOK', output: 'AGENT_ONCE_OPENAI_OUTPUT_USD_PER_MTOK' } as const;

export interface TokenPrices {
  inputUsdPerMTok: number;
  outputUsdPerMTok: number;
}

export interface CompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
}

const CHAT_COMPLETIONS_URL = 'https://api.openai.com/v1/chat/completions';
const MAX_TURNS = 20;
const REQUEST_TIMEOUT_MS = 120_000;

export type FetchFn = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface OpenAiRunDeps {
  env: NodeJS.ProcessEnv;
  fetch: FetchFn;
}

interface ToolCall {
  id: string;
  function: { name: string; arguments: string };
}

interface AssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: ToolCall[];
}

interface Completion {
  choices: { message: AssistantMessage }[];
  usage?: CompletionUsage;
}

type ChatMessage = { role: 'user'; content: string } | AssistantMessage | { role: 'tool'; tool_call_id: string; content: string };

export function openAiAgent(): RealAgent {
  return { name: OPENAI_AGENT_NAME, keyEnv: OPENAI_KEY_ENV, requiredEnv: [OPENAI_MODEL_ENV, OPENAI_PRICE_ENVS.input, OPENAI_PRICE_ENVS.output], external: [process.execPath, fileURLToPath(import.meta.url)] };
}

function resultText(result: CallToolResult): string {
  const text = result.content.map((item) => (item.type === 'text' ? item.text : `[${item.type}]`)).join('\n');
  return result.isError === true ? `Error: ${text}` : text;
}

async function callTool(client: Client, call: ToolCall['function']): Promise<string> {
  try {
    const args = JSON.parse(call.arguments === '' ? '{}' : call.arguments) as Record<string, unknown>;
    return resultText((await client.callTool({ name: call.name, arguments: args })) as CallToolResult);
  } catch (error) {
    return `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export async function requestCompletion(deps: OpenAiRunDeps, key: string, body: { model: string }): Promise<Completion> {
  let response: Awaited<ReturnType<FetchFn>>;
  let text: string;
  try {
    response = await deps.fetch(CHAT_COMPLETIONS_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    text = await response.text();
  } catch (error) {
    recordUsage(deps.env, { agent: OPENAI_AGENT_NAME, model: body.model, inputTokens: 0, outputTokens: 0, costUsd: null });
    throw error;
  }
  if (!response.ok) throw new Error(`${OPENAI_AGENT_NAME} request failed with ${response.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as Completion;
}

export function turnCostUsd(usage: CompletionUsage, prices: TokenPrices): number {
  return (usage.prompt_tokens * prices.inputUsdPerMTok + usage.completion_tokens * prices.outputUsdPerMTok) / 1_000_000;
}

export function worstTurnCostUsd(promptTokensUpperBound: number, prices: TokenPrices): number {
  return turnCostUsd({ prompt_tokens: promptTokensUpperBound, completion_tokens: OPENAI_MAX_COMPLETION_TOKENS }, prices);
}

export function turnFits(spentUsd: number, worstUsd: number, capUsd: number): boolean {
  return spentUsd + worstUsd <= capUsd;
}

export async function runOpenAiAgent(deps: OpenAiRunDeps): Promise<void> {
  const task = agentTask(OPENAI_AGENT_NAME, OPENAI_KEY_ENV, deps.env);
  const model = deps.env[OPENAI_MODEL_ENV];
  if (model === undefined || model.trim() === '') throw new Error(`${OPENAI_AGENT_NAME} needs ${OPENAI_MODEL_ENV}`);
  const prices: TokenPrices = {
    inputUsdPerMTok: positiveNumberEnv(deps.env, OPENAI_PRICE_ENVS.input, OPENAI_AGENT_NAME),
    outputUsdPerMTok: positiveNumberEnv(deps.env, OPENAI_PRICE_ENVS.output, OPENAI_AGENT_NAME),
  };
  const runCapUsd = positiveNumberEnv(deps.env, MAX_RUN_USD_ENV, OPENAI_AGENT_NAME);
  let spentUsd = 0;
  const client = new Client({ name: 'agent-once-bench-openai', version: '1.0.0' });
  try {
    await client.connect(new StdioClientTransport({ command: task.command, args: task.args, env: task.serverEnv, stderr: 'ignore' }));
    const { tools } = await client.listTools();
    const functions = tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema } }));
    const messages: ChatMessage[] = [{ role: 'user', content: task.task }];
    for (let turn = 0; turn < MAX_TURNS; turn += 1) {
      const body = { model, messages, tools: functions, max_completion_tokens: OPENAI_MAX_COMPLETION_TOKENS };
      const worstUsd = worstTurnCostUsd(Buffer.byteLength(JSON.stringify(body)), prices);
      if (!turnFits(spentUsd, worstUsd, runCapUsd)) throw new Error(`${OPENAI_AGENT_NAME} stopped before a turn that could pass the per-run spend cap of $${runCapUsd}`);
      const completion = await requestCompletion(deps, task.key, body);
      const usage = completion.usage;
      const costUsd = usage === undefined ? null : turnCostUsd(usage, prices);
      recordUsage(deps.env, { agent: OPENAI_AGENT_NAME, model, inputTokens: usage?.prompt_tokens ?? 0, outputTokens: usage?.completion_tokens ?? 0, costUsd });
      if (costUsd === null) throw new Error(`${OPENAI_AGENT_NAME} returned no usage, so the run cannot be kept under ${MAX_RUN_USD_ENV}`);
      spentUsd += costUsd;
      const message = completion.choices[0]?.message;
      if (message === undefined) throw new Error(`${OPENAI_AGENT_NAME} returned no message`);
      messages.push(message);
      const calls = message.tool_calls ?? [];
      if (calls.length === 0) return;
      for (const call of calls) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: await callTool(client, call.function) });
      }
    }
    throw new Error(`${OPENAI_AGENT_NAME} did not finish within ${MAX_TURNS} turns`);
  } finally {
    await client.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runOpenAiAgent({ env: process.env, fetch: (url, init) => fetch(url, init) }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
