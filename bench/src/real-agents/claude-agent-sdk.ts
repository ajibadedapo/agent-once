import { fileURLToPath } from 'node:url';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { agentTask, MAX_RUN_USD_ENV, positiveNumberEnv, recordUsage, type RealAgent } from './agent-env.js';

export const CLAUDE_AGENT_NAME = 'claude-agent-sdk';
export const CLAUDE_KEY_ENV = 'ANTHROPIC_API_KEY';

const MAX_TURNS = 20;
const SERVER_NAME = 'targets';

export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

export interface ClaudeRunDeps {
  env: NodeJS.ProcessEnv;
  query: QueryFn;
}

export function claudeAgentSdkAgent(): RealAgent {
  return { name: CLAUDE_AGENT_NAME, keyEnv: CLAUDE_KEY_ENV, requiredEnv: [], external: [process.execPath, fileURLToPath(import.meta.url)] };
}

export async function runClaudeAgent(deps: ClaudeRunDeps): Promise<void> {
  const task = agentTask(CLAUDE_AGENT_NAME, CLAUDE_KEY_ENV, deps.env);
  const maxBudgetUsd = positiveNumberEnv(deps.env, MAX_RUN_USD_ENV, CLAUDE_AGENT_NAME);
  const model = deps.env.AGENT_ONCE_CLAUDE_MODEL;
  const options: Options = {
    maxBudgetUsd,
    mcpServers: { [SERVER_NAME]: { type: 'stdio', command: task.command, args: task.args, env: task.serverEnv } },
    strictMcpConfig: true,
    settingSources: [],
    tools: [],
    allowedTools: [`mcp__${SERVER_NAME}`],
    permissionMode: 'dontAsk',
    maxTurns: MAX_TURNS,
    ...(model === undefined || model === '' ? {} : { model }),
  };
  for await (const message of deps.query({ prompt: task.task, options })) {
    if (message.type !== 'result') continue;
    const usage = Object.values(message.modelUsage);
    recordUsage(deps.env, {
      agent: CLAUDE_AGENT_NAME,
      model: Object.keys(message.modelUsage).join(','),
      inputTokens: usage.reduce((sum, entry) => sum + entry.inputTokens + entry.cacheReadInputTokens + entry.cacheCreationInputTokens, 0),
      outputTokens: usage.reduce((sum, entry) => sum + entry.outputTokens, 0),
      costUsd: message.total_cost_usd,
    });
    if (message.is_error) throw new Error(`${CLAUDE_AGENT_NAME} ended with ${message.subtype}`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  runClaudeAgent({ env: process.env, query }).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
