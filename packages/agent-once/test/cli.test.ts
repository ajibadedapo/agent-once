import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { chaosTargetsPreset } from '../src/chaos/presets.js';
import { afterEach, describe, expect, test } from 'vitest';
import type { LedgerState, NewLedgerEvent } from '../src/ledger/types.js';
import { SqliteLedgerStore } from '../src/ledger/sqlite-store.js';
import { resultText } from '../src/mcp/proxy.js';
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

const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
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

const LISTENING = /^agent-once chaos targets listening on (http:\/\/127\.0\.0\.1:\d+)$/;

async function serveTargets(): Promise<{ child: ChildProcess; firstLine: string; url: string }> {
  const child = spawn(process.execPath, [CLI, 'chaos', 'serve', '--port', '0'], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  const firstLine = await new Promise<string>((resolve, reject) => {
    let buffered = '';
    child.once('exit', (code) => reject(new Error(`chaos serve exited with ${String(code)} before listening`)));
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      const newline = buffered.indexOf('\n');
      if (newline !== -1) resolve(buffered.slice(0, newline));
    });
  });
  child.removeAllListeners('exit');
  const url = LISTENING.exec(firstLine)?.[1];
  if (url === undefined) {
    child.kill('SIGTERM');
    throw new Error(`unexpected first line: ${firstLine}`);
  }
  return { child, firstLine, url };
}

function stopped(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.once('exit', (code) => resolve(code));
  });
}

async function postJson(url: string, body: unknown): Promise<number> {
  const response = await fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json', connection: 'close' } });
  await response.text();
  return response.status;
}

describe('agent-once chaos', () => {
  test('chaos serve prints its URL first and serves truth, faults and reset until stopped', async () => {
    const { child, firstLine, url } = await serveTargets();
    try {
      expect(firstLine).toMatch(LISTENING);
      expect(await postJson(`${url}/__faults`, [{ target: 'ticket', nth: 1, kind: 'stale_element', holdMs: 0 }])).toBe(200);
      expect(await postJson(`${url}/api/ticket`, { title: 'Printer jam', body: 'Jammed.' })).toBe(409);
      expect(await postJson(`${url}/api/ticket`, { title: 'Printer jam', body: 'Jammed.' })).toBe(201);
      const truth = (await (await fetch(`${url}/__truth`, { headers: { connection: 'close' } })).json()) as Record<string, unknown[]>;
      expect(truth.ticket).toHaveLength(1);
      expect(await postJson(`${url}/__reset`, {})).toBe(200);
    } finally {
      child.kill('SIGTERM');
    }
    expect(await stopped(child)).toBe(0);
  }, 30_000);

  test('the proxy over chaos targets-mcp with the preset replays a lost response instead of ordering twice', async () => {
    const { child, url } = await serveTargets();
    const home = tempDir();
    const configPath = join(home, 'agent-once.json');
    writeFileSync(configPath, JSON.stringify(chaosTargetsPreset()));
    const transport = new UpstreamStdioTransport({
      command: process.execPath,
      args: [CLI, 'mcp', '--config', configPath, '--session', 'chaos-cli', '--', process.execPath, CLI, 'chaos', 'targets-mcp', '--url', url, '--timeout-ms', '5000'],
      env: { ...(process.env as Record<string, string>), AGENT_ONCE_HOME: home },
      cwd: home,
      stderr: 'ignore',
    });
    const client = new Client({ name: 'cli-test', version: '1.0.0' });
    try {
      await client.connect(transport);
      expect(await postJson(`${url}/__faults`, [{ target: 'checkout', nth: 1, kind: 'lost_response_after_commit', holdMs: 0 }])).toBe(200);
      const lost = (await client.callTool({ name: 'place_order', arguments: { item: 'Blue mug', qty: 1 } })) as CallToolResult;
      expect(lost.isError).toBe(true);
      const retry = (await client.callTool({ name: 'place_order', arguments: { item: 'Blue mug', qty: 1 } })) as CallToolResult;
      expect((retry._meta?.['io.github.ajibadedapo/agent-once'] as { status: string }).status).toBe('replayed');
      const orders = JSON.parse(resultText((await client.callTool({ name: 'list_orders', arguments: {} })) as CallToolResult)) as { clientRef: string }[];
      expect(orders).toHaveLength(1);
      expect(orders[0]?.clientRef).toMatch(/^ao_[0-9a-f]{24}$/);
    } finally {
      await client.close();
      child.kill('SIGTERM');
    }
    expect(await stopped(child)).toBe(0);
  }, 30_000);

  test('chaos run --help prints every run flag on stdout and exits 0 without running', () => {
    const home = tempDir();
    const result = runCli(['chaos', 'run', '--help'], home);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    for (const flag of ['--agent', '--scenarios', '--targets', '--guard', '--runs', '--json', '--markdown', '--fail-on-duplicates']) expect(result.stdout).toContain(flag);
    expect(result.stdout).not.toContain('| Scenario');
  });

  test('chaos without a known subcommand is a usage error', () => {
    const home = tempDir();
    const result = runCli(['chaos', 'explode'], home);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('agent-once chaos serve');
    expect(runCli(['chaos', 'targets-mcp'], home).status).toBe(2);
    expect(runCli(['chaos', 'serve', '--port', 'eighty'], home).status).toBe(2);
    const zeroTimeout = runCli(['chaos', 'targets-mcp', '--url', 'http://127.0.0.1:9', '--timeout-ms', '0'], home);
    expect(zeroTimeout.status).toBe(2);
    expect(zeroTimeout.stderr).toContain('--timeout-ms expects a positive whole number up to 2147483647, got 0');
    const hugeTimeout = runCli(['chaos', 'targets-mcp', '--url', 'http://127.0.0.1:9', '--timeout-ms', '2147483648'], home);
    expect(hugeTimeout.status).toBe(2);
    expect(hugeTimeout.stderr).toContain('--timeout-ms expects a positive whole number up to 2147483647, got 2147483648');
  });
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

  test('cli ledger list --in-doubt shows a failed block-on-doubt action that resolve accepts', () => {
    const home = tempDir();
    const click = { tool: 'browser_click', toolClass: 'money' as const, policy: 'block-on-doubt' as const };
    seed(home, [
      event('ao_504', 'intended', click),
      event('ao_504', 'sent', click),
      event('ao_504', 'failed', { ...click, detail: { failure_kind: 'error_result', error: 'the tool returned an error result', result: null } }),
      event('ao_stale', 'intended'),
      event('ao_stale', 'failed', { detail: { failure_kind: 'not_dispatched', error: 'Ref e12 not found', result: null } }),
    ]);
    const listed = runCli(['ledger', 'list', '--in-doubt', '--json'], home);
    expect(listed.status).toBe(0);
    expect((JSON.parse(listed.stdout) as { action_id: string; state: string }[]).map((row) => [row.action_id, row.state])).toEqual([['ao_504', 'failed']]);
    expect(runCli(['resolve', 'ao_504', '--happened'], home).status).toBe(0);
    expect(runCli(['ledger', 'list', '--in-doubt'], home).stdout).toBe('No actions in doubt.\n');
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
