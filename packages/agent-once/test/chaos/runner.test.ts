import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { runChaos } from '../../src/cli/commands/chaos.js';
import type { CliIo } from '../../src/cli/io.js';
import { renderMarkdown, runMatrix, runScenario, summarize, type AgentKind, type RunRecord, type ScenarioName } from '../../src/chaos/index.js';
import { TARGET_NAMES, type TargetName } from '../../src/chaos/targets/catalog.js';
import { loadConfig } from '../../src/config/load.js';
import { ManualClock } from '../../src/time/clock.js';
import { START_MS } from './chaos-harness.js';

const ENV_AGENT = fileURLToPath(new URL('../fixtures/chaos-env-agent.mjs', import.meta.url));

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-once-chaos-'));
  dirs.push(dir);
  return dir;
}

interface Column {
  name: string;
  agent: AgentKind;
  guard: boolean;
}

const COLUMNS: readonly Column[] = [
  { name: 'naive, no guard', agent: 'scripted:naive', guard: false },
  { name: 'naive, guard', agent: 'scripted:naive', guard: true },
  { name: 'obedient, guard', agent: 'scripted:obedient', guard: true },
];

const EXPECTED: Record<ScenarioName, [number, number, number]> = {
  lost_response_after_commit: [2, 1, 1],
  slow_commit: [2, 1, 1],
  timeout_before_commit: [1, 1, 1],
  stale_element: [1, 1, 1],
  crash_mid_run: [2, 1, 1],
};

const CELLS = TARGET_NAMES.flatMap((target) =>
  (Object.keys(EXPECTED) as ScenarioName[]).flatMap((scenario) =>
    COLUMNS.map((column, index) => ({ target, scenario, column: column.name, agent: column.agent, guard: column.guard, effects: EXPECTED[scenario][index] as number })),
  ),
);

function record(overrides: Partial<RunRecord>): RunRecord {
  return {
    scenario: 'slow_commit',
    target: 'checkout',
    agent: 'scripted:naive',
    guard: true,
    effects: 1,
    duplicate: false,
    missing: false,
    agentCalls: 2,
    blockedOrDoubt: 1,
    durationMs: 6_000,
    ...overrides,
  };
}

function captureIo(): CliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { env: {}, cwd: tmpdir(), homedir: tmpdir(), stdout: (text) => out.push(text), stderr: (text) => err.push(text), out, err };
}

describe('chaos runner', () => {
  test.each(CELLS)('the table holds for every target: $target $scenario ($column) gives $effects', async ({ target, scenario, agent, guard, effects }) => {
    const run = await runScenario({ scenario, target, agent, guard, clock: new ManualClock(START_MS), ledgerDir: tempDir(), seed: 1 });
    expect(run).toMatchObject({ scenario, target, agent, guard, effects, duplicate: effects > 1, missing: effects < 1 });
  });

  test('guarded slow commits are held back by the guard rather than by luck', async () => {
    const naive = await runScenario({ scenario: 'slow_commit', target: 'checkout', agent: 'scripted:naive', guard: true, clock: new ManualClock(START_MS), ledgerDir: tempDir(), seed: 1 });
    expect(naive).toMatchObject({ effects: 1, agentCalls: 3, blockedOrDoubt: 1, durationMs: 6_000 });
    const obedient = await runScenario({ scenario: 'slow_commit', target: 'ticket', agent: 'scripted:obedient', guard: true, clock: new ManualClock(START_MS), ledgerDir: tempDir(), seed: 1 });
    expect(obedient).toMatchObject({ effects: 1, agentCalls: 5, blockedOrDoubt: 1, durationMs: 17_000 });
  });

  test('crash_mid_run cuts the first agent off after dispatch and the rerun on the same ledger replays', async () => {
    const guarded = await runScenario({ scenario: 'crash_mid_run', target: 'checkout', agent: 'scripted:naive', guard: true, clock: new ManualClock(START_MS), ledgerDir: tempDir(), seed: 1 });
    expect(guarded).toMatchObject({ effects: 1, agentCalls: 2, blockedOrDoubt: 0, durationMs: 6_000 });
    const unguarded = await runScenario({ scenario: 'crash_mid_run', target: 'checkout', agent: 'scripted:naive', guard: false, clock: new ManualClock(START_MS), ledgerDir: tempDir(), seed: 1 });
    expect(unguarded).toMatchObject({ effects: 2, agentCalls: 2, durationMs: 6_000 });
  });

  test.each(TARGET_NAMES.flatMap((target) => [true, false].map((guard) => ({ target, guard }))))(
    'no-fault runs produce exactly one effect with and without the guard: $target guard $guard',
    async ({ target, guard }: { target: TargetName; guard: boolean }) => {
      const run = await runScenario({ scenario: 'no_fault', target, agent: 'scripted:naive', guard, clock: new ManualClock(START_MS), ledgerDir: tempDir(), seed: 3 });
      expect(run).toMatchObject({ effects: 1, duplicate: false, missing: false, agentCalls: 1, blockedOrDoubt: 0 });
    },
  );

  test('runMatrix runs every combination once, since scripted agents are deterministic', async () => {
    const records = await runMatrix({ agents: ['scripted:naive'], scenarios: ['lost_response_after_commit'], targets: ['ticket', 'email'], guard: 'both', runs: 3, ledgerDir: tempDir() });
    expect(records).toHaveLength(4);
    expect(records.filter((run) => run.guard && run.duplicate)).toHaveLength(0);
    expect(records.filter((run) => !run.guard && run.duplicate)).toHaveLength(2);
  });

  test('matrix markdown lists duplicate and missing rates with run counts', () => {
    const records = [
      record({ guard: false, effects: 2, duplicate: true }),
      record({ guard: false, effects: 1 }),
      record({ guard: true, effects: 1 }),
      record({ guard: true, effects: 1, target: 'ticket' }),
      record({ agent: 'scripted:obedient', scenario: 'timeout_before_commit', target: 'email', guard: true, effects: 0, missing: true, agentCalls: 5 }),
      record({ agent: 'node agent.mjs', guard: true, agentCalls: null, blockedOrDoubt: null }),
    ];
    const markdown = renderMarkdown(summarize(records));
    expect(markdown).toContain('| Agent | Guard | Scenario | Runs | Duplicate rate | Missing rate | Mean agent calls |');
    expect(markdown).toContain('| scripted:naive | off | slow_commit | 2 | 50.0% (1/2) | 0.0% (0/2) | 2.0 |');
    expect(markdown).toContain('| scripted:naive | on | slow_commit | 2 | 0.0% (0/2) | 0.0% (0/2) | 2.0 |');
    expect(markdown).toContain('| scripted:obedient | on | timeout_before_commit | 1 | 0.0% (0/1) | 100.0% (1/1) | 5.0 |');
    expect(markdown).toContain('| node agent.mjs | on | slow_commit | 1 | 0.0% (0/1) | 0.0% (0/1) | not measured |');
    const failures = markdown.slice(markdown.indexOf('## Failures'));
    expect(failures).toContain('missing: scripted:obedient, guard on, timeout_before_commit, email, 0 effects');
    expect(failures).not.toContain('guard off');
    const clean = renderMarkdown(summarize([record({ guard: true })]));
    expect(clean.slice(clean.indexOf('## Failures'))).toContain('None: no guarded run duplicated or lost an effect, and every agent exited cleanly.');
  });

  test('an external agent command receives the documented env vars', async () => {
    const out = tempDir();
    const cli = ['agent-once-cli'];
    for (const guard of [true, false]) {
      const file = join(out, `env-${String(guard)}.json`);
      const ledgerDir = tempDir();
      const run = await runScenario({ scenario: 'stale_element', target: 'booking', agent: { external: [process.execPath, ENV_AGENT, file] }, guard, clock: 'real', ledgerDir, seed: 7, cli });
      expect(run).toMatchObject({ agent: `${process.execPath} ${ENV_AGENT} ${file}`, guard, effects: 0, missing: true });
      const seen = JSON.parse(readFileSync(file, 'utf8')) as {
        env: Record<string, string>;
        config: { ledger: { settleSeconds: number; path: string }; tools: Record<string, unknown> } | null;
        configPath: string | null;
        configCopy: string | null;
      };
      expect(run).toMatchObject({ agentCalls: null, blockedOrDoubt: null, agentExitCode: 0 });
      expect(run.agentError).toBeUndefined();
      const url = seen.env.AGENT_ONCE_CHAOS_URL ?? '';
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
      expect(seen.env.AGENT_ONCE_TASK).toContain('book_slot');
      expect(seen.env.AGENT_ONCE_SESSION).toBe('chaos:stale_element:booking:7');
      const mcp = JSON.parse(seen.env.AGENT_ONCE_CHAOS_MCP ?? '[]') as string[];
      const targetsMcp = ['agent-once-cli', 'chaos', 'targets-mcp', '--url', url];
      if (guard) {
        expect(mcp.slice(0, 3)).toEqual(['agent-once-cli', 'mcp', '--config']);
        expect(mcp.slice(4)).toEqual(['--', ...targetsMcp]);
        expect(seen.config?.ledger.settleSeconds).toBe(3);
        expect(Object.keys(seen.config?.tools ?? {})).toEqual(['place_order', 'book_slot', 'send_email', 'create_ticket']);
        const loaded = loadConfig({ path: seen.configCopy ?? '', cwd: out, env: {}, homedir: out });
        const runDir = dirname(seen.configPath ?? '');
        expect(dirname(runDir)).toBe(ledgerDir);
        expect(loaded.ledger.path).toBe(join(runDir, 'ledger.db'));
        expect(loaded.ledger.settleSeconds).toBe(3);
        expect(loaded.tools.place_order?.readBack?.steps).toEqual([{ tool: 'list_orders', args: {} }]);
      } else {
        expect(mcp).toEqual(targetsMcp);
        expect(seen.config).toBeNull();
      }
    }
  });
});

test('a failing external agent carries its exit code and shows under Failures', async () => {
  const agent = { external: [process.execPath, '-e', "process.stderr.write('boom'); process.exit(3)"] };
  const run = await runScenario({ scenario: 'stale_element', target: 'ticket', agent, guard: false, clock: 'real', ledgerDir: tempDir(), seed: 1, cli: ['agent-once-cli'] });
  expect(run).toMatchObject({ agentExitCode: 3, agentError: 'exited with code 3: boom', agentCalls: null, blockedOrDoubt: null });
  const failures = renderMarkdown(summarize([run]));
  expect(failures.slice(failures.indexOf('## Failures'))).toContain(`- agent error: ${run.agent}, guard off, stale_element, ticket: exited with code 3: boom`);
});

describe('agent-once chaos run', () => {
  test('--fail-on-duplicates exits 1 when a guarded run duplicates', async () => {
    const dir = tempDir();
    const markdownPath = join(dir, 'chaos.md');
    const jsonPath = join(dir, 'chaos.json');
    const duplicated = record({ guard: true, effects: 2, duplicate: true });
    const io = captureIo();
    const code = await runChaos(['run', '--fail-on-duplicates', '--markdown', markdownPath, '--json', jsonPath], io, { runMatrix: () => Promise.resolve([duplicated]) });
    expect(code).toBe(1);
    expect(readFileSync(markdownPath, 'utf8')).toContain('duplicate: scripted:naive, guard on, slow_commit, checkout, 2 effects');
    expect((JSON.parse(readFileSync(jsonPath, 'utf8')) as { records: RunRecord[] }).records).toEqual([duplicated]);
    expect(io.err.join('')).toContain('1 guarded run duplicated an effect');

    const unguarded = record({ guard: false, effects: 2, duplicate: true });
    expect(await runChaos(['run', '--fail-on-duplicates'], captureIo(), { runMatrix: () => Promise.resolve([unguarded]) })).toBe(0);
    expect(await runChaos(['run'], captureIo(), { runMatrix: () => Promise.resolve([duplicated]) })).toBe(0);
  });

  test('chaos run passes its selection to the matrix and prints the markdown', async () => {
    let seen: unknown;
    const io = captureIo();
    const code = await runChaos(
      ['run', '--agent', 'scripted:obedient', '--agent', 'node my-agent.mjs', '--scenarios', 'slow_commit,crash_mid_run', '--targets', 'ticket', '--guard', 'on', '--runs', '3'],
      io,
      {
        runMatrix: (options) => {
          seen = { agents: options.agents, scenarios: options.scenarios, targets: options.targets, guard: options.guard, runs: options.runs };
          return Promise.resolve([record({})]);
        },
      },
    );
    expect(code).toBe(0);
    expect(seen).toEqual({ agents: ['scripted:obedient', { external: ['node my-agent.mjs'] }], scenarios: ['slow_commit', 'crash_mid_run'], targets: ['ticket'], guard: 'on', runs: 3 });
    expect(io.out.join('')).toContain('| scripted:naive | on | slow_commit | 1 |');
  });

  test('chaos run rejects unknown scenarios, targets and guard values', async () => {
    const never = { runMatrix: () => Promise.reject(new Error('should not run')) };
    await expect(runChaos(['run', '--scenarios', 'meteor'], captureIo(), never)).rejects.toThrow(/unknown scenario meteor/);
    await expect(runChaos(['run', '--targets', 'bank'], captureIo(), never)).rejects.toThrow(/unknown target bank/);
    await expect(runChaos(['run', '--guard', 'maybe'], captureIo(), never)).rejects.toThrow(/--guard expects on, off or both/);
    await expect(runChaos(['run', '--runs', '0'], captureIo(), never)).rejects.toThrow(/--runs expects a positive whole number/);
  });
});
