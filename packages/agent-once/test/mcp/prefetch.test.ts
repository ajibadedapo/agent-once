import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import { Guard } from '../../src/guard/guard.js';
import { MemoryLedgerStore } from '../../src/ledger/memory-store.js';
import { createProxy, type RunningProxy } from '../../src/mcp/proxy.js';
import { ManualClock } from '../../src/time/clock.js';
import { START_MS, statusOf } from './proxy-harness.js';
import { ScriptedPeer, SignallingClock, toolResult } from './scripted-peer.js';

const ACTION_KEY = 'io.github.ajibadedapo/agent-once-action';
const READ_ONLY_MYSTERY = { name: 'mystery', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } };

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function startProxy(clientTransport: InMemoryTransport, clock: ManualClock): Promise<{ upstream: ScriptedPeer; proxy: RunningProxy; logs: string[] }> {
  const upstream = ScriptedPeer.upstream();
  await upstream.start();
  const store = new MemoryLedgerStore(clock);
  const logs: string[] = [];
  const proxy = await createProxy({
    client: clientTransport,
    upstream: upstream.transport,
    guard: () => new Guard({ store, clock, runInstance: 'run-1', evidence: { emit: () => {} } }),
    config: loadConfig({ cwd: '/work', env: { AGENT_ONCE_HOME: '/unused' }, homedir: '/unused' }),
    clock,
    cwd: '/work',
    env: {},
    log: (message) => logs.push(message),
  });
  cleanups.push(() => proxy.close());
  return { upstream, proxy, logs };
}

async function withClient(clock: ManualClock = new ManualClock(START_MS)) {
  const [clientSide, proxySide] = InMemoryTransport.createLinkedPair();
  const started = await startProxy(proxySide, clock);
  const client = new Client({ name: 'prefetch-test', version: '1.0.0' });
  await client.connect(clientSide);
  cleanups.push(() => client.close());
  return { ...started, client, clock };
}

async function withRawClient() {
  const client = ScriptedPeer.client();
  await client.start();
  const started = await startProxy(client.transport, new ManualClock(START_MS));
  return { ...started, client };
}

async function answerCall(upstream: ScriptedPeer, text: string): Promise<Record<string, unknown>> {
  const call = await upstream.expectRequest('tools/call');
  await upstream.reply(call.id, toolResult(text));
  return call.params;
}

function isGuarded(params: Record<string, unknown>): boolean {
  return (params._meta as Record<string, unknown> | undefined)?.[ACTION_KEY] !== undefined;
}

describe('tools/list prefetch', () => {
  test('a prefetch that never answers times out after 30 s of clock time, the call is guarded and no refetch follows', async () => {
    const clock = new SignallingClock(START_MS);
    const { client, upstream, logs } = await withClient(clock);
    const pending = client.callTool({ name: 'mystery', arguments: {} });
    await upstream.expectRequest('tools/list');
    await clock.timerSet;
    clock.advance(30_000);
    expect(isGuarded(await answerCall(upstream, 'done'))).toBe(true);
    expect(statusOf(await pending)?.status).toBe('executed');
    const second = client.callTool({ name: 'other', arguments: {} });
    expect(isGuarded(await answerCall(upstream, 'done again'))).toBe(true);
    await second;
    expect(logs.some((line) => line.includes('tools/list'))).toBe(true);
  });

  test('a repeated cursor stops the prefetch', async () => {
    const { client, upstream } = await withClient();
    const pending = client.callTool({ name: 'mystery', arguments: {} });
    const first = await upstream.expectRequest('tools/list');
    await upstream.reply(first.id, { tools: [], nextCursor: 'c1' });
    const second = await upstream.expectRequest('tools/list');
    expect(second.params.cursor).toBe('c1');
    await upstream.reply(second.id, { tools: [], nextCursor: 'c1' });
    expect(isGuarded(await answerCall(upstream, 'done'))).toBe(true);
    await pending;
  });

  test('the prefetch stops after 1000 pages', async () => {
    const { client, upstream } = await withClient();
    const pending = client.callTool({ name: 'mystery', arguments: {} });
    for (let page = 0; page < 1000; page += 1) {
      const list = await upstream.expectRequest('tools/list');
      await upstream.reply(list.id, { tools: [], nextCursor: `p${page + 1}` });
    }
    expect(isGuarded(await answerCall(upstream, 'done'))).toBe(true);
    await pending;
  });

  test('after a failed prefetch unknown tools stay guarded without refetching until list_changed or a client tools/list', async () => {
    const { client, upstream } = await withClient();
    const first = client.callTool({ name: 'mystery', arguments: {} });
    const list = await upstream.expectRequest('tools/list');
    await upstream.replyError(list.id, -32603, 'boom');
    expect(isGuarded(await answerCall(upstream, 'one'))).toBe(true);
    await first;

    const second = client.callTool({ name: 'other', arguments: {} });
    expect(isGuarded(await answerCall(upstream, 'two'))).toBe(true);
    await second;

    await upstream.notify('notifications/tools/list_changed');
    const third = client.callTool({ name: 'mystery', arguments: {} });
    const relisted = await upstream.expectRequest('tools/list');
    await upstream.replyError(relisted.id, -32603, 'boom again');
    await answerCall(upstream, 'three');
    await third;

    const listing = client.listTools();
    const clientList = await upstream.expectRequest('tools/list');
    await upstream.reply(clientList.id, { tools: [] });
    await listing;
    const fourth = client.callTool({ name: 'unlisted', arguments: {} });
    const refetched = await upstream.expectRequest('tools/list');
    await upstream.reply(refetched.id, { tools: [] });
    expect(isGuarded(await answerCall(upstream, 'four'))).toBe(true);
    await fourth;
  });

  test('a prefetch made stale by tools/list_changed is discarded', async () => {
    const { client, upstream } = await withClient();
    const first = client.callTool({ name: 'mystery', arguments: {} });
    const list = await upstream.expectRequest('tools/list');
    await upstream.notify('notifications/tools/list_changed');
    await upstream.reply(list.id, { tools: [READ_ONLY_MYSTERY] });
    expect(isGuarded(await answerCall(upstream, 'guarded'))).toBe(true);
    await first;
    const second = client.callTool({ name: 'mystery', arguments: {} });
    const relisted = await upstream.expectRequest('tools/list');
    await upstream.reply(relisted.id, { tools: [READ_ONLY_MYSTERY] });
    expect(isGuarded(await answerCall(upstream, 'passed'))).toBe(false);
    await second;
  });
});

describe('reserved ids and names', () => {
  test('an upstream request using the reserved id prefix is refused and never reaches the client', async () => {
    const { client, upstream } = await withRawClient();
    await upstream.send({ id: 'agent-once:upstream-1', method: 'roots/list', params: {} });
    const answer = await upstream.next();
    expect(answer.id).toBe('agent-once:upstream-1');
    expect(answer.error?.code).toBe(-32600);
    await upstream.send({ id: 7, method: 'roots/list', params: {} });
    expect((await client.next()).id).toBe(7);
  });

  test('an upstream response to an id that was never forwarded, or already answered, is dropped', async () => {
    const { client, upstream, logs } = await withRawClient();
    await upstream.send({ id: 41, result: { forged: true } });
    await client.send({ id: 3, method: 'resources/list', params: {} });
    const forwarded = await upstream.expectRequest('resources/list');
    await upstream.reply(forwarded.id, { resources: [] });
    await upstream.reply(forwarded.id, { resources: [{ uri: 'file:///late', name: 'late' }] });
    await upstream.notify('notifications/message', { level: 'info', data: 'after' });
    expect(await client.next()).toMatchObject({ id: 3, result: { resources: [] } });
    expect(await client.next()).toMatchObject({ method: 'notifications/message' });
    expect(logs.filter((line) => line.includes('never forwarded'))).toHaveLength(2);
  });

  test('a client request using the reserved id prefix is refused and never reaches the upstream', async () => {
    const { client, upstream } = await withRawClient();
    await client.send({ id: 'agent-once:upstream-1', method: 'resources/list', params: {} });
    const answer = await client.next();
    expect(answer.id).toBe('agent-once:upstream-1');
    expect(answer.error?.code).toBe(-32600);
    await client.send({ id: 3, method: 'resources/list', params: {} });
    expect((await upstream.expectRequest('resources/list')).id).toBe(3);
  });

  test('an upstream tool already named agent_once_resolve is not shadowed', async () => {
    const { client, upstream, logs } = await withClient();
    const listing = client.listTools();
    const list = await upstream.expectRequest('tools/list');
    await upstream.reply(list.id, { tools: [{ name: 'agent_once_resolve', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }] });
    expect((await listing).tools.map((tool) => tool.name)).toEqual(['agent_once_resolve']);
    expect(logs.some((line) => line.includes('agent_once_resolve'))).toBe(true);
    const call = client.callTool({ name: 'agent_once_resolve', arguments: { action_id: 'x', outcome: 'happened' } });
    const forwarded = await upstream.expectRequest('tools/call');
    expect(forwarded.params.name).toBe('agent_once_resolve');
    await upstream.reply(forwarded.id, toolResult('upstream resolve'));
    expect((await call).content).toEqual([{ type: 'text', text: 'upstream resolve' }]);
  });
});

describe('cancellation of answered guarded calls', () => {
  test('a cancel for a guarded call that was already answered is dropped', async () => {
    const { client, upstream } = await withRawClient();
    await client.send({ id: 1, method: 'tools/call', params: { name: 'create_ticket', arguments: { title: 'a' } } });
    const list = await upstream.expectRequest('tools/list');
    await upstream.reply(list.id, { tools: [] });
    await answerCall(upstream, 'created');
    expect((await client.next()).id).toBe(1);
    await client.notify('notifications/cancelled', { requestId: 1 });
    await client.send({ id: 2, method: 'resources/list', params: {} });
    expect((await upstream.next()).method).toBe('resources/list');
  });
});

class CallsCannotBeSent implements Transport {
  constructor(private readonly inner: Transport) {}

  set onmessage(handler: Transport['onmessage']) {
    this.inner.onmessage = handler;
  }

  set onclose(handler: Transport['onclose']) {
    this.inner.onclose = handler;
  }

  set onerror(handler: Transport['onerror']) {
    this.inner.onerror = handler;
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if ('method' in message && message.method === 'tools/call') return Promise.reject(new Error('pipe is broken'));
    return this.inner.send(message);
  }
}

describe('dispatch failures', () => {
  test('a guarded call that could not be sent is not reported as executed and is recorded not_dispatched', async () => {
    const clock = new ManualClock(START_MS);
    const client = ScriptedPeer.client();
    await client.start();
    const upstream = ScriptedPeer.upstream();
    await upstream.start();
    const store = new MemoryLedgerStore(clock);
    const proxy = await createProxy({
      client: client.transport,
      upstream: new CallsCannotBeSent(upstream.transport),
      guard: () => new Guard({ store, clock, runInstance: 'run-1', evidence: { emit: () => {} } }),
      config: loadConfig({ cwd: '/work', env: { AGENT_ONCE_HOME: '/unused' }, homedir: '/unused' }),
      clock,
      cwd: '/work',
      env: {},
      log: () => {},
    });
    cleanups.push(() => proxy.close());
    await client.send({ id: 1, method: 'tools/call', params: { name: 'create_ticket', arguments: {} } });
    const list = await upstream.expectRequest('tools/list');
    await upstream.reply(list.id, { tools: [] });
    const answer = await client.next();
    expect(answer.id).toBe(1);
    expect(answer.result?.isError).toBe(true);
    expect(JSON.stringify(answer.result)).toContain('pipe is broken');
    expect(statusOf(answer.result)).toBeUndefined();
    const actionId = /action (ao_[0-9a-f]+)/.exec(JSON.stringify(answer.result))?.[1] ?? '';
    const recorded = store.findAction(actionId);
    expect(recorded?.state).toBe('failed');
    expect(recorded?.detail.failure_kind).toBe('not_dispatched');
    expect(store.listInDoubt(START_MS)).toEqual([]);
  });
});
