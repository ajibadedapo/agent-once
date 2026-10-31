import { describe, expect, test, vi } from 'vitest';
import { runClaudeAgent } from '../src/real-agents/claude-agent-sdk.js';
import { runOpenAiAgent } from '../src/real-agents/openai.js';
import { CONFIRM_SPEND_FLAG, realCommand, type RealDeps } from '../src/real-agents/gate.js';

function deps(env: NodeJS.ProcessEnv, argv: string[]): RealDeps & { lines: string[]; runMatrix: ReturnType<typeof vi.fn> } {
  const lines: string[] = [];
  const runMatrix = vi.fn(async () => []);
  return { env, argv, runMatrix, log: (line) => lines.push(line), lines };
}

describe('real-model agents', () => {
  test('real agents are skipped without keys and never spawn', async () => {
    const run = deps({}, [CONFIRM_SPEND_FLAG]);
    const outcome = await realCommand(run);
    expect(run.runMatrix).not.toHaveBeenCalled();
    expect(run.lines).toContain('skipped: claude-agent-sdk needs ANTHROPIC_API_KEY');
    expect(run.lines).toContain('skipped: openai needs OPENAI_API_KEY');
    expect(outcome).toEqual({ exitCode: 0, records: [], skipped: ['claude-agent-sdk', 'openai'] });
  });

  test('an empty key counts as no key', async () => {
    const run = deps({ ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '   ' }, [CONFIRM_SPEND_FLAG]);
    await realCommand(run);
    expect(run.runMatrix).not.toHaveBeenCalled();
  });

  test('bench:real refuses without --confirm-spend', async () => {
    const run = deps({ ANTHROPIC_API_KEY: 'sk-test', OPENAI_API_KEY: 'sk-test' }, []);
    const outcome = await realCommand(run);
    expect(run.runMatrix).not.toHaveBeenCalled();
    expect(outcome.exitCode).toBe(2);
    expect(run.lines.join('\n')).toContain('bench:real makes paid model API calls; rerun with --confirm-spend');
  });

  test('with --confirm-spend only the agents whose key is set are run', async () => {
    const run = deps({ ANTHROPIC_API_KEY: 'sk-test' }, [CONFIRM_SPEND_FLAG]);
    const outcome = await realCommand(run);
    expect(run.runMatrix).toHaveBeenCalledTimes(1);
    const [options] = run.runMatrix.mock.calls[0] as unknown as [{ agents: { name: string }[] }];
    expect(options.agents.map((agent) => agent.name)).toEqual(['claude-agent-sdk']);
    expect(outcome.skipped).toEqual(['openai']);
  });

  test('the Claude adapter refuses without a key and never calls the model', async () => {
    const query = vi.fn();
    await expect(runClaudeAgent({ env: { AGENT_ONCE_TASK: 'task', AGENT_ONCE_CHAOS_MCP: '["node","server.js"]' }, query })).rejects.toThrow('ANTHROPIC_API_KEY');
    expect(query).not.toHaveBeenCalled();
  });

  test('the OpenAI adapter refuses without a key and never calls the model', async () => {
    const fetch = vi.fn();
    await expect(runOpenAiAgent({ env: { AGENT_ONCE_TASK: 'task', AGENT_ONCE_CHAOS_MCP: '["node","server.js"]' }, fetch })).rejects.toThrow('OPENAI_API_KEY');
    expect(fetch).not.toHaveBeenCalled();
  });
});
