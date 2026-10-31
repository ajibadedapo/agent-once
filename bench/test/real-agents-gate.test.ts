import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MAX_RUN_USD_ENV, USAGE_FILE_ENV } from '../src/real-agents/agent-env.js';
import { runClaudeAgent } from '../src/real-agents/claude-agent-sdk.js';
import { CONFIRM_SPEND_FLAG, MAX_SPEND_FLAG, realCommand, type RealDeps } from '../src/real-agents/gate.js';
import { OPENAI_MAX_COMPLETION_TOKENS, OPENAI_PRICE_ENVS, requestCompletion, runOpenAiAgent, turnCostUsd, turnFits, worstTurnCostUsd } from '../src/real-agents/openai.js';

const PRICES = { AGENT_ONCE_OPENAI_MODEL: 'model-b', [OPENAI_PRICE_ENVS.input]: '2', [OPENAI_PRICE_ENVS.output]: '8' };
const TASK_ENV = { AGENT_ONCE_TASK: 'task', AGENT_ONCE_CHAOS_MCP: '["node","server.js"]' };
const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deps(env: NodeJS.ProcessEnv, argv: string[]): RealDeps & { lines: string[]; runMatrix: ReturnType<typeof vi.fn> } {
  const lines: string[] = [];
  const runMatrix = vi.fn(async () => []);
  return { env, argv, runMatrix, log: (line) => lines.push(line), lines };
}

const CONFIRMED = [CONFIRM_SPEND_FLAG, MAX_SPEND_FLAG, '5'];

describe('real-model agents', () => {
  test('real agents are skipped without keys and never spawn', async () => {
    const run = deps({}, CONFIRMED);
    const outcome = await realCommand(run);
    expect(run.runMatrix).not.toHaveBeenCalled();
    expect(run.lines).toContain('skipped: claude-agent-sdk needs ANTHROPIC_API_KEY');
    expect(run.lines).toContain('skipped: openai needs OPENAI_API_KEY');
    expect(outcome).toMatchObject({ exitCode: 0, records: [], skipped: ['claude-agent-sdk', 'openai'] });
  });

  test('an empty key counts as no key', async () => {
    const run = deps({ ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '   ', ...PRICES }, CONFIRMED);
    await realCommand(run);
    expect(run.runMatrix).not.toHaveBeenCalled();
  });

  test('bench:real refuses without --confirm-spend', async () => {
    const run = deps({ ANTHROPIC_API_KEY: 'sk-test', OPENAI_API_KEY: 'sk-test', ...PRICES }, [MAX_SPEND_FLAG, '5']);
    const outcome = await realCommand(run);
    expect(run.runMatrix).not.toHaveBeenCalled();
    expect(outcome.exitCode).toBe(2);
    expect(run.lines.join('\n')).toContain('bench:real makes paid model API calls; rerun with --confirm-spend');
  });

  test.each([[[CONFIRM_SPEND_FLAG]], [[CONFIRM_SPEND_FLAG, MAX_SPEND_FLAG]], [[CONFIRM_SPEND_FLAG, MAX_SPEND_FLAG, '0']], [[CONFIRM_SPEND_FLAG, MAX_SPEND_FLAG, 'ten']]])(
    'bench:real refuses %j without a positive --max-spend-usd',
    async (argv) => {
      const run = deps({ ANTHROPIC_API_KEY: 'sk-test', OPENAI_API_KEY: 'sk-test', ...PRICES }, argv);
      const outcome = await realCommand(run);
      expect(run.runMatrix).not.toHaveBeenCalled();
      expect(outcome.exitCode).toBe(2);
      expect(run.lines.join('\n')).toContain('bench:real needs --max-spend-usd <dollars> with --confirm-spend');
    },
  );

  test('with --confirm-spend only the agents whose key is set are run, under the spend limit', async () => {
    const run = deps({ ANTHROPIC_API_KEY: 'sk-test' }, CONFIRMED);
    const outcome = await realCommand(run);
    expect(run.runMatrix).toHaveBeenCalledTimes(1);
    const [options] = run.runMatrix.mock.calls[0] as unknown as [{ agents: { name: string }[]; budget: { limitUsd: number } }];
    expect(options.agents.map((agent) => agent.name)).toEqual(['claude-agent-sdk']);
    expect(options.budget.limitUsd).toBe(5);
    expect(outcome).toMatchObject({ skipped: ['openai'], limitUsd: 5, stoppedAtLimit: false });
  });

  test('OpenAI is skipped when its model or prices are not set, so its spend could not be capped', async () => {
    const run = deps({ OPENAI_API_KEY: 'sk-test' }, CONFIRMED);
    await realCommand(run);
    expect(run.runMatrix).not.toHaveBeenCalled();
    expect(run.lines).toContain(`skipped: openai needs AGENT_ONCE_OPENAI_MODEL and ${OPENAI_PRICE_ENVS.input} and ${OPENAI_PRICE_ENVS.output}`);
  });

  test('the Claude adapter refuses without a key and never calls the model', async () => {
    const query = vi.fn();
    await expect(runClaudeAgent({ env: { ...TASK_ENV, [MAX_RUN_USD_ENV]: '1' }, query })).rejects.toThrow('ANTHROPIC_API_KEY');
    expect(query).not.toHaveBeenCalled();
  });

  test('the Claude adapter refuses without a per-run spend cap and never calls the model', async () => {
    const query = vi.fn();
    await expect(runClaudeAgent({ env: { ...TASK_ENV, ANTHROPIC_API_KEY: 'sk-test' }, query })).rejects.toThrow(MAX_RUN_USD_ENV);
    expect(query).not.toHaveBeenCalled();
  });

  test('the Claude adapter caps the run budget and records the usage the SDK reports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-once-usage-'));
    dirs.push(dir);
    const usageFile = join(dir, 'usage.jsonl');
    const seen: Options[] = [];
    const result = {
      type: 'result',
      subtype: 'success',
      is_error: false,
      num_turns: 3,
      total_cost_usd: 0.0123,
      modelUsage: { 'model-a': { inputTokens: 1_000, outputTokens: 200, cacheReadInputTokens: 300, cacheCreationInputTokens: 50, costUSD: 0.0123 } },
    } as unknown as SDKMessage;
    const query = (params: { prompt: string; options?: Options }): AsyncIterable<SDKMessage> => {
      seen.push(params.options as Options);
      return (async function* () {
        yield result;
      })();
    };
    await runClaudeAgent({ env: { ...TASK_ENV, ANTHROPIC_API_KEY: 'sk-test', [MAX_RUN_USD_ENV]: '0.75', [USAGE_FILE_ENV]: usageFile }, query });
    expect(seen[0]?.maxBudgetUsd).toBe(0.75);
    expect(readFileSync(usageFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))).toEqual([
      { agent: 'claude-agent-sdk', model: 'model-a', inputTokens: 1_350, outputTokens: 200, costUsd: 0.0123 },
    ]);
  });

  test('the OpenAI adapter refuses without a key and never calls the model', async () => {
    const fetch = vi.fn();
    await expect(runOpenAiAgent({ env: { ...TASK_ENV, ...PRICES, [MAX_RUN_USD_ENV]: '1' }, fetch })).rejects.toThrow('OPENAI_API_KEY');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('the OpenAI adapter refuses without prices or a per-run cap and never calls the model', async () => {
    const fetch = vi.fn();
    const base = { ...TASK_ENV, OPENAI_API_KEY: 'sk-test', AGENT_ONCE_OPENAI_MODEL: 'model-b' };
    await expect(runOpenAiAgent({ env: { ...base, [MAX_RUN_USD_ENV]: '1' }, fetch })).rejects.toThrow(OPENAI_PRICE_ENVS.input);
    await expect(runOpenAiAgent({ env: { ...base, ...PRICES }, fetch })).rejects.toThrow(MAX_RUN_USD_ENV);
    expect(fetch).not.toHaveBeenCalled();
  });

  test('OpenAI turn cost is priced per million input and output tokens', () => {
    expect(turnCostUsd({ prompt_tokens: 250_000, completion_tokens: 10_000 }, { inputUsdPerMTok: 2, outputUsdPerMTok: 8 })).toBeCloseTo(0.58, 10);
  });

  test('an OpenAI turn whose worst case would pass the per-run cap is not sent', () => {
    const prices = { inputUsdPerMTok: 2, outputUsdPerMTok: 8 };
    expect(worstTurnCostUsd(500_000, prices)).toBeCloseTo((500_000 * 2 + OPENAI_MAX_COMPLETION_TOKENS * 8) / 1_000_000, 12);
    expect(turnFits(0.2, 0.7, 1)).toBe(true);
    expect(turnFits(0.4, 0.7, 1)).toBe(false);
  });

  test('an OpenAI request that fails in flight is recorded as unpriced, so the whole cap is charged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-once-usage-'));
    dirs.push(dir);
    const usageFile = join(dir, 'usage.jsonl');
    const fetch = vi.fn(async () => {
      throw new Error('The operation was aborted due to timeout');
    });
    await expect(requestCompletion({ env: { [USAGE_FILE_ENV]: usageFile }, fetch }, 'sk-test', { model: 'model-b' })).rejects.toThrow('timeout');
    expect(JSON.parse(readFileSync(usageFile, 'utf8').trim())).toEqual({ agent: 'openai', model: 'model-b', inputTokens: 0, outputTokens: 0, costUsd: null });
  });

  test('an OpenAI response body that fails to arrive is recorded as unpriced too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-once-usage-'));
    dirs.push(dir);
    const usageFile = join(dir, 'usage.jsonl');
    const fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async (): Promise<string> => {
        throw new Error('body aborted');
      },
    }));
    await expect(requestCompletion({ env: { [USAGE_FILE_ENV]: usageFile }, fetch }, 'sk-test', { model: 'model-b' })).rejects.toThrow('body aborted');
    expect(JSON.parse(readFileSync(usageFile, 'utf8').trim())).toMatchObject({ costUsd: null });
  });
});
