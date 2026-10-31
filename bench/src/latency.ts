import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { arch, cpus, platform, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { Guard, MemoryLedgerStore, SqliteLedgerStore, systemClock, type Clock, type Execute, type GuardedCall, type LedgerStore, type ToolOutcome } from 'agent-once';
import { createGuardedProxy, loadConfig, STATUS_META_KEY, type AgentOnceConfig } from 'agent-once/mcp';

export interface OverheadStats {
  p50Ms: number;
  p99Ms: number;
  meanMs: number;
  overThreshold: number;
}

export interface TailProbe {
  defaultCheckpoint: number[];
  noAutocheckpoint: number[];
  memoryLedger: number[];
  samples: number;
}

export interface TailReport {
  thresholdMs: number;
  probe: TailProbe | null;
}

export interface MachineInfo {
  node: string;
  cpu: string;
  os: string;
  sqlite: string;
  python: string | null;
  pythonSqlite?: string | null;
}

export interface LatencyReport {
  core: OverheadStats;
  proxy: OverheadStats;
  python: OverheadStats | null;
  tail: TailReport;
  iterations: number;
  warmup: number;
  machine: MachineInfo;
}

export interface LatencyOptions {
  iterations: number;
  warmup: number;
  ledgerDir: string;
  python?: boolean;
  clock?: Clock;
  now?: () => number;
}

export const FULL_LATENCY = { iterations: 5_000, warmup: 500 } as const;
export const SMOKE_LATENCY = { iterations: 200, warmup: 20 } as const;
export const TAIL_THRESHOLD_MS = 1;
export const TAIL_PROBE_REPEATS = 3;

const GUARDED_TOOL = 'place_order';
const PASS_TOOL = 'get_status';
const BENCH_SESSION = 'bench';
const OK: ToolOutcome = { kind: 'ok', result: null };
const UPSTREAM_COMMAND = ['node', 'bench-upstream.js'];
const PYTHON_SCRIPT = fileURLToPath(new URL('../src/latency-python.py', import.meta.url));
const PYTHON_PROJECT = fileURLToPath(new URL('../../python', import.meta.url));

interface Samples {
  guarded: number[];
  direct: number[];
}

function percentile(sorted: number[], fraction: number): number {
  const rank = Math.max(1, Math.ceil(fraction * sorted.length));
  return sorted[rank - 1] as number;
}

export function overheadStats(guarded: number[], direct: number[], thresholdMs: number = TAIL_THRESHOLD_MS): OverheadStats {
  if (guarded.length !== direct.length) throw new Error(`guarded and direct samples must be paired, got ${guarded.length} and ${direct.length}`);
  if (guarded.length === 0) throw new Error('no samples to summarise');
  const overhead = guarded.map((value, index) => value - (direct[index] as number));
  const sorted = [...overhead].sort((a, b) => a - b);
  return {
    p50Ms: percentile(sorted, 0.5),
    p99Ms: percentile(sorted, 0.99),
    meanMs: overhead.reduce((sum, value) => sum + value, 0) / overhead.length,
    overThreshold: overhead.filter((value) => value > thresholdMs).length,
  };
}

function benchCall(index: number): GuardedCall {
  return { tool: GUARDED_TOOL, args: { item: 'Blue mug', n: index }, sessionKey: BENCH_SESSION, sessionExplicit: true, policy: 'guard', toolClass: 'standard' };
}

type SizeOptions = Required<Pick<LatencyOptions, 'iterations' | 'warmup' | 'ledgerDir'>>;

type CoreLedger = 'sqlite' | 'sqlite-no-autocheckpoint' | 'memory';

function disableAutocheckpoint(store: SqliteLedgerStore): void {
  const connection: unknown = Reflect.get(store, 'db');
  if (typeof connection !== 'object' || connection === null || typeof (connection as { exec?: unknown }).exec !== 'function') {
    throw new Error('the tail probe cannot reach the ledger connection to disable WAL auto-checkpoint');
  }
  (connection as { exec(sql: string): void }).exec('PRAGMA wal_autocheckpoint = 0');
}

function openCoreLedger(ledger: CoreLedger, dir: string, clock: Clock): LedgerStore & { close(): void } {
  if (ledger === 'memory') return Object.assign(new MemoryLedgerStore(clock), { close: () => {} });
  const store = SqliteLedgerStore.open(join(mkdtempSync(join(dir, `core-${ledger}-`)), 'ledger.db'), clock);
  if (ledger === 'sqlite-no-autocheckpoint') disableAutocheckpoint(store);
  return store;
}

async function measureCore(options: SizeOptions, clock: Clock, now: () => number, ledger: CoreLedger = 'sqlite'): Promise<Samples> {
  const store = openCoreLedger(ledger, options.ledgerDir, clock);
  const guard = new Guard({ store, clock, runInstance: 'bench-core', evidence: { emit: () => {} } });
  const execute: Execute = async () => OK;
  const samples: Samples = { guarded: [], direct: [] };
  try {
    for (let index = 0; index < options.warmup + options.iterations; index += 1) {
      const start = now();
      await execute({});
      const middle = now();
      const result = await guard.run(benchCall(index), execute);
      const end = now();
      if (result.status !== 'executed') throw new Error(`core benchmark call ${index} was ${result.status}, not executed`);
      if (index < options.warmup) continue;
      samples.direct.push(middle - start);
      samples.guarded.push(end - middle);
    }
  } finally {
    store.close();
  }
  return samples;
}

function upstreamServer(): Server {
  const server = new Server({ name: 'bench-upstream', version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      { name: GUARDED_TOOL, inputSchema: { type: 'object' as const, properties: {} } },
      { name: PASS_TOOL, inputSchema: { type: 'object' as const, properties: {} }, annotations: { readOnlyHint: true } },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text' as const, text: 'ok' }] }));
  return server;
}

function guardStatus(result: CallToolResult): unknown {
  const status: unknown = result._meta?.[STATUS_META_KEY];
  return typeof status === 'object' && status !== null ? (status as { status?: unknown }).status : undefined;
}

function proxyConfig(dir: string): AgentOnceConfig {
  const base = loadConfig({ cwd: dir, env: { AGENT_ONCE_HOME: dir }, homedir: dir });
  return { ...base, ledger: { ...base.ledger, path: join(dir, 'proxy.db') }, evidence: { jsonl: null } };
}

async function measureProxy(options: SizeOptions, clock: Clock, now: () => number): Promise<Samples> {
  const config = proxyConfig(options.ledgerDir);
  const store = SqliteLedgerStore.open(config.ledger.path, clock);
  const server = upstreamServer();
  const [upstreamSide, serverSide] = InMemoryTransport.createLinkedPair();
  const [clientSide, proxySide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'bench-client', version: '1.0.0' });
  const samples: Samples = { guarded: [], direct: [] };
  try {
    await server.connect(serverSide);
    const proxy = await createGuardedProxy({
      client: proxySide,
      upstream: upstreamSide,
      config,
      store,
      clock,
      runInstance: 'bench-proxy',
      evidence: { emit: () => {} },
      cwd: options.ledgerDir,
      env: {},
      command: UPSTREAM_COMMAND,
    });
    try {
      await client.connect(clientSide);
      for (let index = 0; index < options.warmup + options.iterations; index += 1) {
        const args = { item: 'Blue mug', n: index };
        const start = now();
        const passed = (await client.callTool({ name: PASS_TOOL, arguments: args })) as CallToolResult;
        const middle = now();
        const guarded = (await client.callTool({ name: GUARDED_TOOL, arguments: args })) as CallToolResult;
        const end = now();
        if (guardStatus(guarded) !== 'executed') throw new Error(`proxy benchmark call ${index} was not guarded and executed: ${JSON.stringify(guarded._meta)}`);
        if (guardStatus(passed) !== undefined) throw new Error(`proxy benchmark pass call ${index} was guarded`);
        if (index < options.warmup) continue;
        samples.direct.push(middle - start);
        samples.guarded.push(end - middle);
      }
    } finally {
      await client.close();
      await proxy.closed;
    }
  } finally {
    await server.close();
    store.close();
  }
  return samples;
}

interface PythonOutput extends Samples {
  python: string;
  sqlite: string;
}

function measurePython(options: SizeOptions): PythonOutput {
  const run = spawnSync(
    'uv',
    ['run', '--project', PYTHON_PROJECT, 'python', PYTHON_SCRIPT, '--iterations', String(options.iterations), '--warmup', String(options.warmup), '--ledger-dir', options.ledgerDir],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.error !== undefined) throw new Error(`the Python benchmark could not start: ${run.error.message}`);
  if (run.status !== 0) throw new Error(`the Python benchmark exited with ${String(run.status)}: ${run.stderr.trim()}`);
  return JSON.parse(run.stdout) as PythonOutput;
}

function machineInfo(python: PythonOutput | null): MachineInfo {
  const cores = cpus();
  return {
    node: process.version,
    cpu: `${cores[0]?.model ?? 'unknown'} (${cores.length} cores)`,
    os: `${platform()} ${release()} ${arch()}`,
    sqlite: process.versions.sqlite ?? 'unknown',
    python: python?.python ?? null,
    pythonSqlite: python?.sqlite ?? null,
  };
}

export async function measureLatency(options: LatencyOptions): Promise<LatencyReport> {
  const clock = options.clock ?? systemClock;
  const now = options.now ?? (() => performance.now());
  const core = await measureCore(options, clock, now);
  const proxy = await measureProxy(options, clock, now);
  const python = options.python === false ? null : measurePython(options);
  const slow = async (ledger: CoreLedger): Promise<number> => {
    const samples = await measureCore(options, clock, now, ledger);
    return overheadStats(samples.guarded, samples.direct).overThreshold;
  };
  const modes: CoreLedger[] = ['sqlite', 'sqlite-no-autocheckpoint', 'memory'];
  const counts = new Map<CoreLedger, number[]>(modes.map((mode) => [mode, []]));
  for (let repeat = 0; repeat < TAIL_PROBE_REPEATS; repeat += 1) {
    for (let offset = 0; offset < modes.length; offset += 1) {
      const mode = modes[(repeat + offset) % modes.length] as CoreLedger;
      counts.get(mode)?.push(await slow(mode));
    }
  }
  const probe: TailProbe = {
    defaultCheckpoint: counts.get('sqlite') ?? [],
    noAutocheckpoint: counts.get('sqlite-no-autocheckpoint') ?? [],
    memoryLedger: counts.get('memory') ?? [],
    samples: options.iterations,
  };
  return {
    core: overheadStats(core.guarded, core.direct),
    proxy: overheadStats(proxy.guarded, proxy.direct),
    python: python === null ? null : overheadStats(python.guarded, python.direct),
    tail: { thresholdMs: TAIL_THRESHOLD_MS, probe },
    iterations: options.iterations,
    warmup: options.warmup,
    machine: machineInfo(python),
  };
}
