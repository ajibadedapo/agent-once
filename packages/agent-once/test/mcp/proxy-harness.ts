import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult, ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { loadConfig } from '../../src/config/load.js';
import type { AgentOnceConfig } from '../../src/config/schema.js';
import type { EvidenceEvent, EvidenceSink } from '../../src/evidence/types.js';
import { Guard } from '../../src/guard/guard.js';
import type { HumanResolver } from '../../src/guard/types.js';
import { SqliteLedgerStore } from '../../src/ledger/sqlite-store.js';
import type { LedgerStore } from '../../src/ledger/types.js';
import { createProxy, type ProxyContext, type ProxyExtension, type RunningProxy } from '../../src/mcp/proxy.js';
import { UpstreamStdioTransport } from '../../src/mcp/upstream.js';
import { ManualClock } from '../../src/time/clock.js';

export const START_MS = 1_761_912_345_678;
export const FIXTURE = fileURLToPath(new URL('../fixtures/counter-server.mjs', import.meta.url));
export const STATUS_KEY = 'io.github.ajibadedapo/agent-once';

export class WaitingSink implements EvidenceSink {
  readonly events: EvidenceEvent[] = [];
  private readonly waiters: { match: (event: EvidenceEvent) => boolean; wake: (event: EvidenceEvent) => void }[] = [];

  emit(event: EvidenceEvent): void {
    this.events.push(event);
    for (const waiter of [...this.waiters]) {
      if (!waiter.match(event)) continue;
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.wake(event);
    }
  }

  next(match: (event: EvidenceEvent) => boolean): Promise<EvidenceEvent> {
    return new Promise((wake) => this.waiters.push({ match, wake }));
  }
}

export class Workspace {
  readonly dir = mkdtempSync(join(tmpdir(), 'agent-once-proxy-'));
  readonly statePath = join(this.dir, 'counter.json');
  readonly ledgerPath = join(this.dir, 'ledger.db');
  readonly clock = new ManualClock(START_MS);
  private readonly cleanups: (() => Promise<void> | void)[] = [];

  config(overrides: Partial<AgentOnceConfig> = {}): AgentOnceConfig {
    return { ...loadConfig({ cwd: this.dir, env: { AGENT_ONCE_HOME: this.dir }, homedir: this.dir }), ...overrides };
  }

  openStore(): SqliteLedgerStore {
    const store = SqliteLedgerStore.open(this.ledgerPath, this.clock);
    this.cleanups.push(() => store.close());
    return store;
  }

  onCleanup(fn: () => Promise<void> | void): void {
    this.cleanups.push(fn);
  }

  async dispose(): Promise<void> {
    for (const fn of this.cleanups.splice(0).reverse()) await fn();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

export interface ProxyOptions {
  store?: SqliteLedgerStore;
  wrapStore?: (store: SqliteLedgerStore) => LedgerStore;
  config?: AgentOnceConfig;
  env?: NodeJS.ProcessEnv;
  upstreamEnv?: Record<string, string>;
  runInstance?: string;
  capabilities?: ClientCapabilities;
  extensions?: ProxyExtension[];
  humanResolverFactory?: (ctx: ProxyContext) => HumanResolver | undefined;
  clientName?: string;
}

export interface ProxyHarness {
  client: Client;
  proxy: RunningProxy;
  store: SqliteLedgerStore;
  sink: WaitingSink;
  logs: string[];
  clientErrors: Error[];
}

export async function startProxy(workspace: Workspace, options: ProxyOptions = {}): Promise<ProxyHarness> {
  const store = options.store ?? workspace.openStore();
  const sink = new WaitingSink();
  const logs: string[] = [];
  const config = options.config ?? workspace.config();
  const upstream = new UpstreamStdioTransport({
    command: process.execPath,
    args: [FIXTURE],
    env: { COUNTER_STATE: workspace.statePath, ...options.upstreamEnv },
    stderr: 'ignore',
  });
  const [clientSide, proxySide] = InMemoryTransport.createLinkedPair();
  const proxy = await createProxy({
    client: proxySide,
    upstream,
    guard: (humanResolver) =>
      new Guard({
        store: options.wrapStore?.(store) ?? store,
        clock: workspace.clock,
        runInstance: options.runInstance ?? 'run-1',
        evidence: sink,
        humanResolver,
        retryWindowMs: config.ledger.retryWindowSeconds * 1000,
        settleWindowMs: config.ledger.settleSeconds * 1000,
      }),
    config,
    clock: workspace.clock,
    cwd: '/work',
    env: options.env ?? {},
    extensions: options.extensions,
    humanResolverFactory: options.humanResolverFactory,
    log: (message) => logs.push(message),
  });
  const client = new Client({ name: options.clientName ?? 'test-client', version: '1.0.0' }, { capabilities: options.capabilities ?? {} });
  const clientErrors: Error[] = [];
  client.onerror = (error) => clientErrors.push(error);
  await client.connect(clientSide);
  workspace.onCleanup(async () => {
    await client.close();
    await proxy.close();
  });
  return { client, proxy, store, sink, logs, clientErrors };
}

export async function connectDirect(workspace: Workspace, statePath: string, env: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: 'direct-client', version: '1.0.0' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [FIXTURE], env: { COUNTER_STATE: statePath, ...env }, stderr: 'ignore' }));
  workspace.onCleanup(() => client.close());
  return client;
}

export function textOf(result: unknown): string {
  const content = (result as CallToolResult).content;
  return content.map((item) => (item.type === 'text' ? item.text : `[${item.type}]`)).join('\n');
}

export function statusOf(result: unknown): { status: string; action_id: string } | undefined {
  const meta = (result as CallToolResult)._meta;
  return meta?.[STATUS_KEY] as { status: string; action_id: string } | undefined;
}

export interface FixtureStats {
  count: number;
  rejections: number;
  cancelledSeen: number;
  cancelNotices: number;
  rootsChanged: number;
  actionKeys: (string | null)[];
}

export async function stats(client: Client): Promise<FixtureStats> {
  return JSON.parse(textOf(await client.callTool({ name: 'stats', arguments: {} }))) as FixtureStats;
}
