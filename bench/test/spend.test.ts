import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunRecord, RunScenarioOptions } from 'agent-once/chaos';
import { afterEach, describe, expect, test } from 'vitest';
import { runBenchMatrix } from '../src/matrix.js';
import { MAX_RUN_USD_ENV, readUsage, USAGE_FILE_ENV } from '../src/real-agents/agent-env.js';
import { SpendBudget } from '../src/real-agents/budget.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-once-spend-'));
  dirs.push(dir);
  return dir;
}

function envArg(command: string[], name: string): string {
  const entry = command.find((part) => part.startsWith(`${name}=`));
  if (entry === undefined) throw new Error(`no ${name} in ${command.join(' ')}`);
  return entry.slice(name.length + 1);
}

function fakeRun(costs: (number | null)[], seen: string[][]): (options: RunScenarioOptions) => Promise<RunRecord> {
  return async (options) => {
    const command = typeof options.agent === 'string' ? [] : options.agent.external;
    seen.push(command);
    const cost = costs.shift();
    if (cost !== undefined) appendFileSync(envArg(command, USAGE_FILE_ENV), `${JSON.stringify({ agent: 'claude-agent-sdk', model: 'model-a', inputTokens: 1_000, outputTokens: 100, costUsd: cost })}\n`);
    return {
      scenario: options.scenario,
      target: options.target,
      agent: command.join(' '),
      guard: options.guard,
      effects: 1,
      duplicate: false,
      missing: false,
      agentCalls: null,
      blockedOrDoubt: null,
      durationMs: 1_234,
    };
  };
}

const CLAUDE = { name: 'claude-agent-sdk', external: ['node', 'claude-agent-sdk.js'] };

describe('spend budget', () => {
  test('stops launching once the next run could exceed the limit', () => {
    const budget = new SpendBudget(1);
    expect(budget.canLaunch()).toBe(true);
    budget.record(0.4, 1);
    expect(budget.remainingUsd()).toBeCloseTo(0.6, 10);
    expect(budget.canLaunch()).toBe(true);
    budget.record(0.3, 0.6);
    expect(budget.canLaunch()).toBe(false);
    expect(budget.stoppedAtLimit).toBe(true);
  });

  test('a run that reported no cost is charged its whole per-run cap', () => {
    const budget = new SpendBudget(1);
    budget.record(null, 0.75);
    expect(budget.spentUsd).toBe(0.75);
  });

  test('the matrix gives each paid run the remaining budget as its cap, records its spend and stops at the limit', async () => {
    const seen: string[][] = [];
    const budget = new SpendBudget(1);
    const lines: string[] = [];
    const records = await runBenchMatrix(
      { agents: [CLAUDE], paths: ['api'], runs: 3, targets: ['checkout'], ledgerDir: tempDir(), budget, log: (line) => lines.push(line) },
      { runApiScenario: fakeRun([0.6, 0.6], seen) },
    );
    expect(seen).toHaveLength(1);
    expect(envArg(seen[0] as string[], MAX_RUN_USD_ENV)).toBe('1');
    expect(seen[0]?.slice(-2)).toEqual(CLAUDE.external);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ agent: 'claude-agent-sdk', spend: { inputTokens: 1_000, outputTokens: 100, costUsd: 0.6 } });
    expect(budget.stoppedAtLimit).toBe(true);
    expect(lines.join('\n')).toContain('stopped launching paid runs at the spend limit of $1.00');
  });

  test('paid agents cannot run without a spend budget', async () => {
    await expect(runBenchMatrix({ agents: [CLAUDE], paths: ['api'], runs: 1, ledgerDir: tempDir() }, { runApiScenario: fakeRun([], []) })).rejects.toThrow('spend budget');
  });

  test('a torn usage line is read as an unpriced run, so the whole per-run cap is charged', async () => {
    const dir = tempDir();
    const file = join(dir, 'usage.jsonl');
    appendFileSync(file, `${JSON.stringify({ agent: 'openai', model: 'm', inputTokens: 10, outputTokens: 1, costUsd: 0.001 })}\n{"agent":"openai","inp`);
    expect(readUsage(file)).toEqual({ inputTokens: 10, outputTokens: 1, costUsd: null });
  });

  test('a paid run that was killed is charged its whole cap, whatever it recorded', async () => {
    const budget = new SpendBudget(2);
    const killed = async (options: RunScenarioOptions): Promise<RunRecord> => ({
      ...(await fakeRun([0.1], [])(options)),
      agentExitCode: null,
      agentError: 'was stopped by SIGKILL',
    });
    await runBenchMatrix({ agents: [CLAUDE], paths: ['api'], runs: 1, targets: ['checkout'], ledgerDir: tempDir(), budget }, { runApiScenario: killed });
    expect(budget.spentUsd).toBe(2);
  });
});
