import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Implementation, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { proxyExtensions } from '../../src/cli/commands/mcp.js';
import { parseConfig, type AgentOnceConfig } from '../../src/config/schema.js';
import { Guard } from '../../src/guard/guard.js';
import { MemoryLedgerStore } from '../../src/ledger/memory-store.js';
import type { LedgerEvent, LedgerStore, LedgerTx } from '../../src/ledger/types.js';
import { createProxy } from '../../src/mcp/proxy.js';
import { ManualClock } from '../../src/time/clock.js';

export const START_MS = 1_761_912_345_678;
export const STATUS_KEY = 'io.github.ajibadedapo/agent-once';

export class RecordingStore implements LedgerStore {
  readonly appended: LedgerEvent[] = [];
  private readonly inner: MemoryLedgerStore;

  constructor(clock: ManualClock) {
    this.inner = new MemoryLedgerStore(clock);
  }

  transact<T>(fn: (tx: LedgerTx) => T): T {
    return this.inner.transact((tx) =>
      fn({
        latest: (hash) => tx.latest(hash),
        append: (event) => {
          const stored = tx.append(event);
          this.appended.push(stored);
          return stored;
        },
      }),
    );
  }

  findAction(actionId: string): LedgerEvent | undefined {
    return this.inner.findAction(actionId);
  }

  listInDoubt(nowMs: number): LedgerEvent[] {
    return this.inner.listInDoubt(nowMs);
  }

  close(): void {
    this.inner.close();
  }
}

export class ReplayServer {
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  readonly server: Server;
  private readonly queues = new Map<string, CallToolResult[]>();

  constructor(info: Implementation, tools: Tool[]) {
    this.server = new Server(info, { capabilities: { tools: {} } });
    this.server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }));
    this.server.setRequestHandler(CallToolRequestSchema, (request) => {
      const args = request.params.arguments ?? {};
      this.calls.push({ name: request.params.name, args });
      const next = this.queues.get(request.params.name)?.shift();
      return next ?? { content: [{ type: 'text', text: `unscripted call to ${request.params.name}` }], isError: true };
    });
  }

  answer(tool: string, ...results: CallToolResult[]): void {
    this.queues.set(tool, [...(this.queues.get(tool) ?? []), ...results]);
  }

  callsTo(tool: string): number {
    return this.calls.filter((call) => call.name === tool).length;
  }
}

const DESTRUCTIVE = { readOnlyHint: false, destructiveHint: true };

export function playwrightTools(): Tool[] {
  const tool = (name: string, annotations: Tool['annotations']): Tool => ({ name, inputSchema: { type: 'object' }, annotations });
  return [
    tool('browser_navigate', DESTRUCTIVE),
    tool('browser_snapshot', { readOnlyHint: true, destructiveHint: false }),
    tool('browser_click', DESTRUCTIVE),
    tool('browser_hover', DESTRUCTIVE),
  ];
}

export function chromeDevtoolsTools(): Tool[] {
  const tool = (name: string, readOnlyHint: boolean): Tool => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint } });
  return [tool('navigate_page', false), tool('take_snapshot', false), tool('click', false), tool('list_pages', true)];
}

export function ticketTools(): Tool[] {
  return [
    { name: 'create_ticket', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: true } },
    { name: 'find_ticket', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
  ];
}

export function configFrom(raw: Record<string, unknown> = {}): AgentOnceConfig {
  return parseConfig({ evidence: { jsonl: null }, ...raw }, { file: '(test)', baseDir: '/work', env: { AGENT_ONCE_HOME: '/state' }, homedir: '/home/user' });
}

export interface BrowserProxy {
  client: Client;
  server: ReplayServer;
  store: RecordingStore;
  clock: ManualClock;
  logs: string[];
  close(): Promise<void>;
}

export async function startBrowserProxy(options: { info: Implementation; tools: Tool[]; config?: AgentOnceConfig; command?: string[] }): Promise<BrowserProxy> {
  const clock = new ManualClock(START_MS);
  const store = new RecordingStore(clock);
  const config = options.config ?? configFrom();
  const server = new ReplayServer(options.info, options.tools);
  const [upstreamSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.server.connect(serverSide);
  const [clientSide, proxySide] = InMemoryTransport.createLinkedPair();
  const logs: string[] = [];
  const proxy = await createProxy({
    client: proxySide,
    upstream: upstreamSide,
    guard: () =>
      new Guard({
        store,
        clock,
        runInstance: 'run-1',
        evidence: { emit: () => {} },
        retryWindowMs: config.ledger.retryWindowSeconds * 1000,
        settleWindowMs: config.ledger.settleSeconds * 1000,
      }),
    config,
    clock,
    cwd: '/work',
    env: {},
    extensions: proxyExtensions(config, options.command ?? []),
    log: (message) => logs.push(message),
  });
  const client = new Client({ name: 'browser-test', version: '1.0.0' });
  await client.connect(clientSide);
  return {
    client,
    server,
    store,
    clock,
    logs,
    close: async () => {
      await client.close();
      await proxy.close();
    },
  };
}

export function statusOf(result: unknown): { status: string; action_id: string } | undefined {
  return (result as CallToolResult)._meta?.[STATUS_KEY] as { status: string; action_id: string } | undefined;
}

export function textOf(result: unknown): string {
  return (result as CallToolResult).content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
}
