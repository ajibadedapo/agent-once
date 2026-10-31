import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { guardSettings } from '../cli/io.js';
import { proxyExtensions } from '../cli/commands/mcp.js';
import { loadConfig } from '../config/load.js';
import type { AgentOnceConfig } from '../config/schema.js';
import { Guard } from '../guard/guard.js';
import { SqliteLedgerStore } from '../ledger/sqlite-store.js';
import { createHumanResolver } from '../mcp/doubt/human-resolver.js';
import { SESSION_ENV } from '../mcp/meta.js';
import { createProxy, type RunningProxy } from '../mcp/proxy.js';
import { ManualClock, systemClock, type Clock } from '../time/clock.js';
import { DEFAULT_EXTERNAL_AGENT_TIMEOUT_MS, externalAgentName, startExternalAgent, type ExternalAgentOptions, type ExternalAgentRun } from './agents/external-agent.js';
import { ScriptedApiAgent, type AgentStats, type ScriptedAgentKind, type Wait } from './agents/scripted-api-agent.js';
import { checkEffects, flushPendingCommits } from './checker.js';
import { chaosTargetsPreset } from './presets.js';
import {
  CHAOS_TASKS,
  CRASH_RERUN_AFTER_MS,
  REAL_CLOCK_HOLD_MS,
  REAL_CLOCK_SETTLE_SECONDS,
  scenarioSpec,
  type ChaosTask,
  type RunnableScenario,
} from './scenarios.js';
import type { TargetName } from './targets/catalog.js';
import { startTargets, type RunningTargets } from './targets/server.js';
import { createTargetsMcpServer } from './targets-mcp/server.js';

export type AgentKind = 'scripted:naive' | 'scripted:obedient' | { external: string[] };

export interface RunScenarioOptions {
  scenario: RunnableScenario;
  target: TargetName;
  agent: AgentKind;
  guard: boolean;
  clock: ManualClock | 'real';
  ledgerDir: string;
  seed: number;
  cli?: string[];
  agentTimeoutMs?: number;
  log?: (message: string) => void;
}

export interface RunRecord {
  scenario: RunnableScenario;
  target: TargetName;
  agent: string;
  guard: boolean;
  effects: number;
  duplicate: boolean;
  missing: boolean;
  agentCalls: number;
  blockedOrDoubt: number;
  durationMs: number;
}

export interface MatrixOptions {
  agents: AgentKind[];
  scenarios: RunnableScenario[];
  targets: TargetName[];
  guard: 'on' | 'off' | 'both';
  runs: number;
  ledgerDir: string;
  cli?: string[];
  agentTimeoutMs?: number;
  log?: (message: string) => void;
  onRecord?: (record: RunRecord) => void;
}

export const CHAOS_START_MS = 1_761_912_345_678;

const SCRIPTED_KINDS: Readonly<Record<string, ScriptedAgentKind>> = { 'scripted:naive': 'naive', 'scripted:obedient': 'obedient' };
const REAL_CRASH_RERUN_MARGIN_MS = 1_000;
const DISPATCH_POLL_MS = 20;

export function defaultCli(): string[] {
  return [process.execPath, fileURLToPath(new URL('../cli/main.js', import.meta.url))];
}

export function agentName(agent: AgentKind): string {
  return typeof agent === 'string' ? agent : externalAgentName(agent.external);
}

interface World {
  options: RunScenarioOptions;
  task: ChaosTask;
  clock: Clock;
  wait: Wait;
  targets: RunningTargets;
  runDir: string;
  session: string;
  holdMs: number;
  log: (message: string) => void;
}

class DispatchTap implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly dispatched: Promise<void>;
  private markDispatched: () => void = () => {};
  private readonly mutatingIds = new Set<string | number>();
  private swallowed = false;

  constructor(
    private readonly inner: Transport,
    private readonly tool: string,
    private readonly crash: boolean,
  ) {
    this.dispatched = new Promise((resolve) => {
      this.markDispatched = resolve;
    });
    inner.onclose = () => this.onclose?.();
    inner.onerror = (error) => this.onerror?.(error);
    inner.onmessage = (message) => this.receive(message);
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if ('method' in message && 'id' in message && message.method === 'tools/call' && message.params?.name === this.tool) this.mutatingIds.add(message.id);
    return this.inner.send(message);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  private receive(message: JSONRPCMessage): void {
    const id = 'method' in message ? undefined : (message as { id?: unknown }).id;
    const answersMutation = (typeof id === 'string' || typeof id === 'number') && this.mutatingIds.has(id);
    if (answersMutation && this.crash && !this.swallowed) {
      this.swallowed = true;
      this.markDispatched();
      return;
    }
    this.onmessage?.(message);
  }
}

function chaosConfig(runDir: string, settleSeconds: number | undefined): AgentOnceConfig {
  const base = loadConfig({ cwd: runDir, env: { AGENT_ONCE_HOME: runDir }, homedir: runDir });
  return {
    ...base,
    ...chaosTargetsPreset(),
    ledger: { ...base.ledger, ...(settleSeconds === undefined ? {} : { settleSeconds }) },
    evidence: { jsonl: null },
  };
}

function targetsMcpCommand(cli: string[], url: string): string[] {
  return [...cli, 'chaos', 'targets-mcp', '--url', url];
}

async function scriptedLife(world: World, kind: ScriptedAgentKind, crash: boolean, stats: AgentStats): Promise<void> {
  const { options, clock, targets, runDir, session } = world;
  const server = createTargetsMcpServer({ url: targets.url, clock });
  const [upstreamSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const tap = new DispatchTap(upstreamSide, world.task.tool, crash);
  let proxy: RunningProxy | undefined;
  let store: SqliteLedgerStore | undefined;
  let agentTransport: Transport = tap;
  const client = new Client({ name: `chaos-${kind}`, version: '1.0.0' });
  try {
    if (options.guard) {
      const config = chaosConfig(runDir, options.clock === 'real' ? REAL_CLOCK_SETTLE_SECONDS : undefined);
      const env = { [SESSION_ENV]: session };
      const openedStore = SqliteLedgerStore.open(config.ledger.path, clock);
      store = openedStore;
      const [agentSide, proxySide] = InMemoryTransport.createLinkedPair();
      const runInstance = randomUUID();
      proxy = await createProxy({
        client: proxySide,
        upstream: tap,
        guard: (ctx) =>
          new Guard({
            store: openedStore,
            clock,
            runInstance,
            evidence: { emit: () => {} },
            humanResolver: createHumanResolver(ctx, config, env, { log: world.log }),
            ...guardSettings(config),
          }),
        config,
        clock,
        cwd: runDir,
        env,
        extensions: proxyExtensions(config, targetsMcpCommand(defaultCli(), targets.url)),
        log: crash ? () => {} : world.log,
      });
      agentTransport = agentSide;
    }
    await client.connect(agentTransport);
    const agent = new ScriptedApiAgent(kind, client, world.task, world.wait);
    const running = agent.run().finally(() => {
      stats.calls += agent.stats.calls;
      stats.blockedOrDoubt += agent.stats.blockedOrDoubt;
    });
    if (crash) {
      running.catch(() => undefined);
      await Promise.race([running, tap.dispatched]);
    } else {
      await running;
    }
  } finally {
    await client.close();
    if (proxy !== undefined) await proxy.closed;
    store?.close();
    await server.close();
  }
}

async function runScripted(world: World, kind: ScriptedAgentKind, crash: boolean): Promise<AgentStats> {
  const stats: AgentStats = { calls: 0, blockedOrDoubt: 0 };
  await scriptedLife(world, kind, crash, stats);
  if (crash) {
    await world.wait(world.options.clock === 'real' ? world.holdMs + REAL_CRASH_RERUN_MARGIN_MS : CRASH_RERUN_AFTER_MS);
    await scriptedLife(world, kind, false, stats);
  }
  return stats;
}

function externalEnv(world: World, mcp: string[]): ExternalAgentOptions['env'] {
  return {
    AGENT_ONCE_CHAOS_URL: world.targets.url,
    AGENT_ONCE_CHAOS_MCP: JSON.stringify(mcp),
    AGENT_ONCE_TASK: world.task.prompt,
    AGENT_ONCE_SESSION: world.session,
    AGENT_ONCE_HOME: world.runDir,
  };
}

async function untilDispatched(targets: RunningTargets, agent: ExternalAgentRun): Promise<void> {
  let exited = false;
  void agent.exited.then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    },
  );
  while (!exited && targets.pendingCommits() === 0) await delay(DISPATCH_POLL_MS);
}

async function externalLife(world: World, command: string[], mcp: string[], crash: boolean): Promise<void> {
  const agent = startExternalAgent({ command, env: externalEnv(world, mcp), timeoutMs: world.options.agentTimeoutMs ?? DEFAULT_EXTERNAL_AGENT_TIMEOUT_MS });
  if (crash) {
    await untilDispatched(world.targets, agent);
    agent.kill();
  }
  const { code, signal, stderr } = await agent.exited;
  if (!crash && code !== 0) world.log(`agent-once chaos: ${externalAgentName(command)} exited with ${code ?? signal ?? 'unknown status'}${stderr === '' ? '' : `: ${stderr.trim()}`}`);
}

async function runExternal(world: World, command: string[], crash: boolean): Promise<AgentStats> {
  const cli = world.options.cli ?? defaultCli();
  const targetsMcp = targetsMcpCommand(cli, world.targets.url);
  let mcp = targetsMcp;
  if (world.options.guard) {
    const configPath = join(world.runDir, 'agent-once.json');
    const config = { ...chaosTargetsPreset(), ledger: { path: join(world.runDir, 'ledger.db'), settleSeconds: REAL_CLOCK_SETTLE_SECONDS } };
    writeFileSync(configPath, JSON.stringify(config));
    mcp = [...cli, 'mcp', '--config', configPath, '--', ...targetsMcp];
  }
  await externalLife(world, command, mcp, crash);
  if (crash) {
    await world.wait(world.holdMs + REAL_CRASH_RERUN_MARGIN_MS);
    await externalLife(world, command, mcp, false);
  }
  return { calls: 0, blockedOrDoubt: 0 };
}

export async function runScenario(options: RunScenarioOptions): Promise<RunRecord> {
  const spec = scenarioSpec(options.scenario);
  const real = options.clock === 'real';
  if (typeof options.agent !== 'string' && !real) throw new Error('external agents run on the real clock; pass clock "real"');
  const scriptedKind = typeof options.agent === 'string' ? SCRIPTED_KINDS[options.agent] : undefined;
  if (typeof options.agent === 'string' && scriptedKind === undefined) throw new Error(`unknown agent ${options.agent}`);
  const manual = options.clock === 'real' ? undefined : options.clock;
  const clock: Clock = manual ?? systemClock;
  const wait: Wait = manual === undefined ? (ms) => delay(ms) : (ms) => Promise.resolve(manual.advance(ms));
  const holdMs = real && spec.holdMs > 0 ? REAL_CLOCK_HOLD_MS : spec.holdMs;
  const targets = await startTargets({ clock });
  const runDir = mkdtempSync(join(options.ledgerDir, 'run-'));
  try {
    if (spec.faultKind !== 'none') targets.setFaults([{ target: options.target, nth: 1, kind: spec.faultKind, holdMs }]);
    const world: World = {
      options,
      task: CHAOS_TASKS[options.target],
      clock,
      wait,
      targets,
      runDir,
      session: `chaos:${options.scenario}:${options.target}:${options.seed}`,
      holdMs,
      log: options.log ?? (() => {}),
    };
    const startedMs = clock.nowMs();
    const stats =
      typeof options.agent === 'string' ? await runScripted(world, scriptedKind as ScriptedAgentKind, spec.crash) : await runExternal(world, options.agent.external, spec.crash);
    const durationMs = clock.nowMs() - startedMs;
    await flushPendingCommits(targets, options.clock, holdMs);
    const check = checkEffects(targets.truth()[options.target], 1);
    return {
      scenario: options.scenario,
      target: options.target,
      agent: agentName(options.agent),
      guard: options.guard,
      ...check,
      agentCalls: stats.calls,
      blockedOrDoubt: stats.blockedOrDoubt,
      durationMs,
    };
  } finally {
    await targets.close();
    rmSync(runDir, { recursive: true, force: true });
  }
}

function guardModes(guard: MatrixOptions['guard']): boolean[] {
  if (guard === 'on') return [true];
  if (guard === 'off') return [false];
  return [false, true];
}

export async function runMatrix(options: MatrixOptions): Promise<RunRecord[]> {
  const records: RunRecord[] = [];
  for (const agent of options.agents) {
    for (const guard of guardModes(options.guard)) {
      for (const scenario of options.scenarios) {
        for (const target of options.targets) {
          for (let seed = 1; seed <= options.runs; seed += 1) {
            const record = await runScenario({
              scenario,
              target,
              agent,
              guard,
              clock: typeof agent === 'string' ? new ManualClock(CHAOS_START_MS) : 'real',
              ledgerDir: options.ledgerDir,
              seed,
              ...(options.cli === undefined ? {} : { cli: options.cli }),
              ...(options.agentTimeoutMs === undefined ? {} : { agentTimeoutMs: options.agentTimeoutMs }),
              ...(options.log === undefined ? {} : { log: options.log }),
            });
            records.push(record);
            options.onRecord?.(record);
          }
        }
      }
    }
  }
  return records;
}
