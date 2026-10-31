import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import type { LedgerState, NewLedgerEvent } from '../src/ledger/types.js';
import { SqliteLedgerStore } from '../src/ledger/sqlite-store.js';
import { UpstreamStdioTransport } from '../src/mcp/upstream.js';
import { ManualClock } from '../src/time/clock.js';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const CLI = join(PACKAGE_DIR, 'dist/cli/main.js');
const FIXTURE = fileURLToPath(new URL('./fixtures/counter-server.mjs', import.meta.url));
const START_MS = 1_761_912_345_678;
const FAR_FUTURE_MS = 4_102_444_800_123;

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-once-cli-'));
  tempDirs.push(dir);
  return dir;
}

beforeAll(() => {
  const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  const build = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: PACKAGE_DIR, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`build failed: ${build.stdout}${build.stderr}`);
}, 120_000);

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function runCli(args: string[], home: string, cwd = home): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, env: { ...process.env, AGENT_ONCE_HOME: home }, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function event(actionId: string, state: LedgerState, overrides: Partial<NewLedgerEvent> = {}): NewLedgerEvent {
  return {
    actionId,
    intentHash: `intent-${actionId}`,
    occurrence: 0,
    state,
    atMs: START_MS,
    expiresAtMs: FAR_FUTURE_MS,
    sessionKey: 'nightly',
    sessionExplicit: true,
    intentKeyExplicit: false,
    runInstance: 'run-1',
    tool: 'create_ticket',
    toolClass: 'standard',
    policy: 'guard',
    argsJson: '{"title":"Printer jam"}',
    detail: {},
    ...overrides,
  };
}

function seed(home: string, events: NewLedgerEvent[]): void {
  const store = SqliteLedgerStore.open(join(home, 'ledger.db'), new ManualClock(START_MS));
  try {
    store.transact((tx) => {
      for (const item of events) tx.append(item);
    });
  } finally {
    store.close();
  }
}

function readStore<T>(home: string, read: (store: SqliteLedgerStore) => T): T {
  const store = SqliteLedgerStore.open(join(home, 'ledger.db'), new ManualClock(START_MS));
  try {
    return read(store);
  } finally {
    store.close();
  }
}

describe('agent-once mcp', () => {
  test('cli mcp exits 2 on bad config without spawning upstream', () => {
    const home = tempDir();
    const marker = join(home, 'spawned');
    const configPath = join(home, 'agent-once.json');
    writeFileSync(configPath, JSON.stringify({ tools: { charge: { policy: 'maybe' } } }));
    const spawnMarker = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`;
    const result = runCli(['mcp', '--config', configPath, '--', process.execPath, '-e', spawnMarker], home);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(configPath);
    expect(result.stderr).toContain('/tools/charge/policy');
    expect(existsSync(marker)).toBe(false);
  });

  test('cli mcp exits 3 when the ledger cannot be opened, without spawning upstream', () => {
    const dir = tempDir();
    const home = join(dir, 'not-a-directory');
    writeFileSync(home, 'x');
    const marker = join(dir, 'spawned');
    const spawnMarker = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x')`;
    const result = runCli(['mcp', '--', process.execPath, '-e', spawnMarker], home, dir);
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('agent-once ledger unavailable');
    expect(existsSync(marker)).toBe(false);
  });

  test('cli mcp without a server command is a usage error', () => {
    const home = tempDir();
    const result = runCli(['mcp'], home);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('agent-once mcp');
  });

  test('cli mcp relays a real session, keeps stderr free of the SQLite warning and exits with the upstream code', async () => {
    const home = tempDir();
    const transport = new UpstreamStdioTransport({
      command: process.execPath,
      args: [CLI, 'mcp', '--session', 'cli-run', '--', process.execPath, FIXTURE],
      env: { ...(process.env as Record<string, string>), AGENT_ONCE_HOME: home, COUNTER_STATE: join(home, 'counter.json') },
      cwd: home,
      stderr: 'pipe',
    });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const client = new Client({ name: 'cli-test', version: '1.0.0' });
    const closed = new Promise<void>((resolve) => {
      client.onclose = resolve;
    });
    await client.connect(transport);
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    expect(tools).toContain('agent_once_resolve');
    const result = await client.callTool({ name: 'increment', arguments: {} });
    const actionId = (result._meta?.['io.github.ajibadedapo/agent-once'] as { action_id: string }).action_id;
    const crashed = await client.callTool({ name: 'crash_during', arguments: {} });
    expect(crashed.isError).toBe(true);
    await closed;
    expect(transport.exitCode).toBe(7);
    expect(stderr).not.toMatch(/ExperimentalWarning|SQLite/);
    const confirmed = readStore(home, (store) => store.findAction(actionId));
    expect(confirmed?.state).toBe('confirmed');
    expect(confirmed?.sessionKey).toBe('cli-run');
    expect(existsSync(join(home, 'events.jsonl'))).toBe(true);
  }, 30_000);

  test('cli mcp reconciles a doubtful retry through the configured read-back', async () => {
    const home = tempDir();
    const configPath = join(home, 'agent-once.json');
    writeFileSync(configPath, JSON.stringify({ tools: { increment: { readBack: { steps: [{ tool: 'read_count', args: {} }], happened: 'count=1$' } } } }));
    const transport = new UpstreamStdioTransport({
      command: process.execPath,
      args: [CLI, 'mcp', '--config', configPath, '--session', 'cli-read-back', '--', process.execPath, FIXTURE],
      env: { ...(process.env as Record<string, string>), AGENT_ONCE_HOME: home, COUNTER_STATE: join(home, 'counter.json') },
      cwd: home,
      stderr: 'ignore',
    });
    const client = new Client({ name: 'cli-test', version: '1.0.0' });
    await client.connect(transport);
    try {
      const failed = await client.callTool({ name: 'increment', arguments: { fail: true } });
      expect(failed.isError).toBe(true);
      const retry = await client.callTool({ name: 'increment', arguments: { fail: true } });
      expect((retry._meta?.['io.github.ajibadedapo/agent-once'] as { status: string }).status).toBe('replayed');
      const count = await client.callTool({ name: 'read_count', arguments: {} });
      expect(count.content).toEqual([{ type: 'text', text: 'count=1' }]);
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe('agent-once resolve', () => {
  test('cli resolve marks an in-doubt action happened', () => {
    const home = tempDir();
    seed(home, [event('ao_doubt', 'intended'), event('ao_doubt', 'sent')]);
    const result = runCli(['resolve', 'ao_doubt', '--happened'], home);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ao_doubt');
    const latest = readStore(home, (store) => store.findAction('ao_doubt'));
    expect(latest?.state).toBe('reconciled');
    expect(latest?.detail.outcome).toBe('happened');
    expect(latest?.detail.resolved_by).toBe('human');
  });

  test('cli resolve can record not happened for a money action', () => {
    const home = tempDir();
    seed(home, [event('ao_money', 'intended', { toolClass: 'money', policy: 'block-on-doubt' }), event('ao_money', 'sent', { toolClass: 'money', policy: 'block-on-doubt' })]);
    const result = runCli(['resolve', 'ao_money', '--not-happened'], home);
    expect(result.status).toBe(0);
    expect(readStore(home, (store) => store.findAction('ao_money'))?.detail.outcome).toBe('not_happened');
  });

  test('cli resolve fails for an unknown action and for a missing outcome flag', () => {
    const home = tempDir();
    const unknown = runCli(['resolve', 'ao_missing', '--happened'], home);
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('ao_missing');
    const noFlag = runCli(['resolve', 'ao_missing'], home);
    expect(noFlag.status).toBe(2);
    const bothFlags = runCli(['resolve', 'ao_missing', '--happened', '--not-happened'], home);
    expect(bothFlags.status).toBe(2);
  });
});

describe('agent-once ledger list', () => {
  test('cli ledger list --in-doubt --json prints in-doubt actions', () => {
    const home = tempDir();
    seed(home, [
      event('ao_doubt', 'intended'),
      event('ao_doubt', 'sent'),
      event('ao_done', 'intended', { intentHash: 'intent-done', tool: 'send_email', toolClass: 'irreversible', policy: 'block-on-doubt' }),
      event('ao_done', 'sent', { intentHash: 'intent-done' }),
      event('ao_done', 'confirmed', { intentHash: 'intent-done' }),
    ]);
    const result = runCli(['ledger', 'list', '--in-doubt', '--json'], home);
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      {
        action_id: 'ao_doubt',
        state: 'sent',
        tool: 'create_ticket',
        tool_class: 'standard',
        policy: 'guard',
        occurrence: 0,
        session_key: 'nightly',
        at_ms: START_MS,
        args: { title: 'Printer jam' },
      },
    ]);
  });

  test('cli ledger list --json prints the latest state of every action', () => {
    const home = tempDir();
    seed(home, [event('ao_doubt', 'intended'), event('ao_done', 'intended', { intentHash: 'intent-done', argsJson: null }), event('ao_done', 'confirmed', { intentHash: 'intent-done', argsJson: null })]);
    const result = runCli(['ledger', 'list', '--json'], home);
    expect(result.status).toBe(0);
    expect((JSON.parse(result.stdout) as { action_id: string; state: string; args: unknown }[]).map((row) => [row.action_id, row.state, row.args])).toEqual([
      ['ao_doubt', 'intended', { title: 'Printer jam' }],
      ['ao_done', 'confirmed', null],
    ]);
  });

  test('cli ledger list prints a readable table', () => {
    const home = tempDir();
    seed(home, [event('ao_doubt', 'intended')]);
    const result = runCli(['ledger', 'list'], home);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ao_doubt');
    expect(result.stdout).toContain('intended');
    expect(result.stdout).toContain('create_ticket');
    const empty = runCli(['ledger', 'list', '--in-doubt'], tempDir());
    expect(empty.stdout).toBe('No actions in doubt.\n');
  });

  test('an unknown command prints usage and exits 2', () => {
    const result = runCli(['frobnicate'], tempDir());
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Usage');
  });
});
