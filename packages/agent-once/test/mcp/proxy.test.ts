import { ListRootsRequestSchema, LoggingMessageNotificationSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { GuardedCall, HumanResolver } from '../../src/guard/types.js';
import { LedgerUnavailableError } from '../../src/ledger/errors.js';
import type { ProxyContext } from '../../src/mcp/proxy.js';
import { connectDirect, startProxy, stats, statusOf, textOf, Workspace } from './proxy-harness.js';

const REPLAY_TEXT = (actionId: string) =>
  `agent-once: this action already happened (action ${actionId}); returning the recorded result instead of repeating it.`;

let workspace: Workspace;

beforeEach(() => {
  workspace = new Workspace();
});

afterEach(async () => {
  await workspace.dispose();
});

describe('relay', () => {
  test('passes initialize, tools/list, resources and notifications through unchanged apart from the appended resolve tool', async () => {
    const direct = await connectDirect(workspace, `${workspace.dir}/direct.json`);
    const { client } = await startProxy(workspace, { capabilities: { roots: { listChanged: true } } });
    expect(client.getServerVersion()).toEqual(direct.getServerVersion());
    expect(client.getServerCapabilities()).toEqual(direct.getServerCapabilities());
    expect(client.getInstructions()).toEqual(direct.getInstructions());

    const proxied = await client.listTools();
    const unproxied = await direct.listTools();
    expect(proxied.tools.slice(0, -1)).toEqual(unproxied.tools);
    expect(proxied.tools.at(-1)?.name).toBe('agent_once_resolve');
    expect(proxied.tools.at(-1)?.inputSchema.required).toEqual(['action_id', 'outcome']);

    expect(await client.listResources()).toEqual(await direct.listResources());
    expect(await client.readResource({ uri: 'counter://about' })).toEqual(await direct.readResource({ uri: 'counter://about' }));

    const logs: unknown[] = [];
    client.setNotificationHandler(LoggingMessageNotificationSchema, (notification) => {
      logs.push(notification.params);
    });
    await client.callTool({ name: 'emit_log', arguments: {} });
    expect(logs).toEqual([{ level: 'info', data: 'hello from the counter' }]);

    await client.sendRootsListChanged();
    expect((await stats(client)).rootsChanged).toBe(1);
  });

  test('tools/list pagination appends the resolve tool only on the last page', async () => {
    const { client } = await startProxy(workspace, { upstreamEnv: { COUNTER_PAGE_SIZE: '4' } });
    const pages: string[][] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor === undefined ? {} : { cursor });
      pages.push(page.tools.map((tool) => tool.name));
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages.slice(0, -1)) expect(page).not.toContain('agent_once_resolve');
    expect(pages.at(-1)?.at(-1)).toBe('agent_once_resolve');
    expect(pages.flat().filter((name) => name === 'agent_once_resolve')).toHaveLength(1);
  });

  test('the resolve tool is not listed when exposeResolveTool is false', async () => {
    const { client } = await startProxy(workspace, { config: workspace.config({ exposeResolveTool: false }) });
    expect((await client.listTools()).tools.map((tool) => tool.name)).not.toContain('agent_once_resolve');
  });
});

describe('guarded tools/call', () => {
  test('read-only tool passes without a ledger entry', async () => {
    const { client, store } = await startProxy(workspace);
    const result = await client.callTool({ name: 'read_count', arguments: {} });
    expect(textOf(result)).toBe('count=0');
    expect(statusOf(result)).toBeUndefined();
    expect(store.listActions(workspace.clock.nowMs())).toEqual([]);
  });

  test('unannotated tool is guarded and the idempotency key is forwarded upstream', async () => {
    const { client, store } = await startProxy(workspace);
    const result = await client.callTool({ name: 'increment', arguments: { note: 'a' } });
    expect(textOf(result)).toBe('count=1');
    const status = statusOf(result);
    expect(status?.status).toBe('executed');
    const actionId = status?.action_id ?? '';
    expect(store.findAction(actionId)?.state).toBe('confirmed');
    expect(store.findAction(actionId)?.policy).toBe('guard');
    expect((await stats(client)).actionKeys).toEqual([actionId]);
  });

  test('tool annotations are fetched before the first call when the client never listed tools', async () => {
    const { client, store } = await startProxy(workspace);
    const result = await client.callTool({ name: 'read_count', arguments: {} });
    expect(statusOf(result)).toBeUndefined();
    await client.callTool({ name: 'charge', arguments: { amount: 5 } });
    const [charged] = store.listActions(workspace.clock.nowMs());
    expect(charged?.toolClass).toBe('money');
    expect(charged?.policy).toBe('block-on-doubt');
  });

  test('a retry after an error result within the window does not reach upstream', async () => {
    const { client } = await startProxy(workspace);
    const first = await client.callTool({ name: 'increment', arguments: { fail: true } });
    expect(first.isError).toBe(true);
    expect(textOf(first)).toBe('counted to 1 but reported a failure');
    expect(statusOf(first)?.status).toBe('executed');
    workspace.clock.advance(5_000);
    const retry = await client.callTool({ name: 'increment', arguments: { fail: true } });
    expect(retry.isError).toBe(true);
    expect(statusOf(retry)).toEqual({ status: 'in_doubt', action_id: statusOf(first)?.action_id });
    expect(textOf(retry)).toContain('agent_once_resolve');
    expect((await stats(client)).count).toBe(1);
  });

  test('a confirmed call repeated in the same run executes as a deliberate repeat', async () => {
    const { client, sink } = await startProxy(workspace);
    const first = await client.callTool({ name: 'increment', arguments: {} });
    const second = await client.callTool({ name: 'increment', arguments: {} });
    expect(textOf(second)).toBe('count=2');
    expect(statusOf(second)?.action_id).not.toBe(statusOf(first)?.action_id);
    expect(sink.events.filter((event) => event.kind === 'decision').map((event) => event.detail.reason)).toEqual(['new', 'deliberate_repeat']);
  });

  test('a rerun with a new proxy instance and AGENT_ONCE_SESSION replays a confirmed call', async () => {
    const env = { AGENT_ONCE_SESSION: 'nightly-report' };
    const firstRun = await startProxy(workspace, { env, runInstance: 'run-a' });
    const first = await firstRun.client.callTool({ name: 'increment', arguments: { note: 'report' } });
    await firstRun.client.close();
    await firstRun.proxy.close();
    workspace.clock.advance(600_000);

    const secondRun = await startProxy(workspace, { env, runInstance: 'run-b', store: firstRun.store });
    const replay = await secondRun.client.callTool({ name: 'increment', arguments: { note: 'report' } });
    const actionId = statusOf(first)?.action_id ?? '';
    expect(statusOf(replay)).toEqual({ status: 'replayed', action_id: actionId });
    expect(replay.content).toEqual([
      { type: 'text', text: REPLAY_TEXT(actionId) },
      { type: 'text', text: 'count=1' },
    ]);
    expect((await stats(secondRun.client)).count).toBe(1);
  });

  test('client cancellation of a guarded call is not forwarded and the retry replays', async () => {
    const { client, sink, store, logs, clientErrors } = await startProxy(workspace);
    const controller = new AbortController();
    const pending = client.callTool({ name: 'slow', arguments: {} }, undefined, { signal: controller.signal });
    await client.callTool({ name: 'slow_started', arguments: {} });
    controller.abort(new Error('user pressed stop'));
    await expect(pending).rejects.toThrow();
    const confirmed = sink.next((event) => event.kind === 'state' && event.detail.state === 'confirmed');
    await client.callTool({ name: 'release', arguments: {} });
    const event = await confirmed;
    expect(event.detail.delivery).toBe('cancelled');

    const retry = await client.callTool({ name: 'slow', arguments: {} });
    expect(statusOf(retry)).toEqual({ status: 'replayed', action_id: event.actionId });
    expect(textOf(retry)).toContain('slow done');
    const after = await stats(client);
    expect(after.count).toBe(1);
    expect(after.cancelledSeen).toBe(0);
    expect(after.cancelNotices).toBe(0);
    expect(store.findAction(event.actionId ?? '')?.detail.delivery).toBe('cancelled');
    expect(logs.some((line) => line.includes('cancel'))).toBe(true);
    expect(clientErrors).toEqual([]);
  });

  test('client cancellation of a pass call is forwarded upstream', async () => {
    const { client } = await startProxy(workspace, { config: workspace.config({ tools: { slow: { policy: 'pass' } } }) });
    const controller = new AbortController();
    const pending = client.callTool({ name: 'slow', arguments: {} }, undefined, { signal: controller.signal });
    await client.callTool({ name: 'slow_started', arguments: {} });
    controller.abort(new Error('user pressed stop'));
    await expect(pending).rejects.toThrow();
    await client.callTool({ name: 'release', arguments: {} });
    const after = await stats(client);
    expect(after.cancelNotices).toBe(1);
  });

  test('agent_once_resolve not_happened lets the next call dispatch', async () => {
    const { client } = await startProxy(workspace);
    await client.callTool({ name: 'increment', arguments: { fail: true } });
    const doubt = await client.callTool({ name: 'increment', arguments: { fail: true } });
    const actionId = statusOf(doubt)?.action_id ?? '';
    expect(statusOf(doubt)?.status).toBe('in_doubt');

    const tooSoon = await client.callTool({ name: 'agent_once_resolve', arguments: { action_id: actionId, outcome: 'not_happened' } });
    expect(tooSoon.isError).toBe(true);
    workspace.clock.advance(10_000);
    const resolved = await client.callTool({ name: 'agent_once_resolve', arguments: { action_id: actionId, outcome: 'not_happened' } });
    expect(resolved.isError).toBeFalsy();
    expect(textOf(resolved)).toContain(actionId);

    const next = await client.callTool({ name: 'increment', arguments: { fail: true } });
    expect(statusOf(next)?.status).toBe('executed');
    expect((await stats(client)).count).toBe(2);
  });

  test('agent_once_resolve rejects malformed input and unknown actions', async () => {
    const { client } = await startProxy(workspace);
    const malformed = await client.callTool({ name: 'agent_once_resolve', arguments: { action_id: 'ao_x', outcome: 'maybe' } });
    expect(malformed.isError).toBe(true);
    const unknown = await client.callTool({ name: 'agent_once_resolve', arguments: { action_id: 'ao_missing', outcome: 'happened' } });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('ao_missing');
  });

  test('upstream crash mid-call leaves the action sent, answers the client with an error and closed resolves with the exit code', async () => {
    const { client, store, proxy, sink } = await startProxy(workspace);
    const abandoned = sink.next((event) => event.kind === 'state' && event.detail.state === 'abandoned');
    const result = (await client.callTool({ name: 'crash_during', arguments: {} })) as CallToolResult;
    expect((await abandoned).tool).toBe('crash_during');
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('exited');
    expect(await proxy.closed).toEqual({ upstreamExitCode: 7 });
    const inDoubt = store.listInDoubt(workspace.clock.nowMs());
    expect(inDoubt.map((event) => [event.tool, event.state])).toEqual([['crash_during', 'sent']]);
    expect(textOf(result)).toContain(inDoubt[0]?.actionId);
  });

  test('ledger unavailable makes guarded calls return an error result while read tools still work', async () => {
    const store = workspace.openStore();
    store.close();
    const { client } = await startProxy(workspace, { store });
    const guarded = await client.callTool({ name: 'increment', arguments: {} });
    expect(guarded.isError).toBe(true);
    expect(textOf(guarded)).toContain('agent-once ledger unavailable');
    expect(textOf(await client.callTool({ name: 'read_count', arguments: {} }))).toBe('count=0');
  });

  test('an outcome the ledger could not record is still forwarded and logged', async () => {
    let transactions = 0;
    const { client, logs } = await startProxy(workspace, {
      wrapStore: (inner) => ({
        transact: (fn) => {
          transactions += 1;
          if (transactions === 3) throw new LedgerUnavailableError('disk full');
          return inner.transact(fn);
        },
        findAction: (actionId) => inner.findAction(actionId),
        listInDoubt: (nowMs) => inner.listInDoubt(nowMs),
        close: () => inner.close(),
      }),
    });
    const result = await client.callTool({ name: 'increment', arguments: {} });
    expect(textOf(result)).toBe('count=1');
    expect(statusOf(result)?.status).toBe('executed');
    expect(logs.some((line) => line.includes(`action ${statusOf(result)?.action_id}`) && line.includes('could not be written'))).toBe(true);
  });

  test('non-finite arguments return an error result without dispatch', async () => {
    const { client } = await startProxy(workspace);
    const result = await client.callTool({ name: 'increment', arguments: { amount: Number.NaN } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('NaN');
    expect((await stats(client)).count).toBe(0);
  });

  test('session from mandate meta wins over env', async () => {
    const { client, store } = await startProxy(workspace, { env: { AGENT_ONCE_SESSION: 'env-session' } });
    const result = await client.callTool({
      name: 'increment',
      arguments: {},
      _meta: { 'io.github.ajibadedapo.agent-mandates/mandate-id': 'mandate-42' },
    });
    const event = store.findAction(statusOf(result)?.action_id ?? '');
    expect(event?.sessionKey).toBe('mandate-42');
    expect(event?.sessionExplicit).toBe(true);
  });

  test('the default session is the client name and working directory', async () => {
    const { client, store } = await startProxy(workspace, { clientName: 'cursor' });
    const result = await client.callTool({ name: 'increment', arguments: {} });
    const event = store.findAction(statusOf(result)?.action_id ?? '');
    expect(event?.sessionKey).toBe('cursor:/work');
    expect(event?.sessionExplicit).toBe(false);
  });

  test('an intent key in meta identifies the action regardless of arguments', async () => {
    const { client } = await startProxy(workspace, { env: { AGENT_ONCE_SESSION: 'fixed' } });
    const intent = { 'io.github.ajibadedapo/agent-once-intent': 'order-17' };
    await client.callTool({ name: 'increment', arguments: { note: 'first wording' }, _meta: intent });
    const again = await client.callTool({ name: 'increment', arguments: { note: 'second wording' }, _meta: intent });
    expect(statusOf(again)?.status).toBe('replayed');
    expect((await stats(client)).count).toBe(1);
  });

  test('notDispatchedErrors turn a matching error result into not_dispatched so the retry dispatches at once', async () => {
    const config = workspace.config({ tools: { increment: { notDispatchedErrors: ['^rejected before'] } } });
    const { client, store } = await startProxy(workspace, { config });
    const first = await client.callTool({ name: 'increment', arguments: { reject: true } });
    expect(textOf(first)).toBe('rejected before anything happened');
    expect(store.findAction(statusOf(first)?.action_id ?? '')?.detail.failure_kind).toBe('not_dispatched');
    const retry = await client.callTool({ name: 'increment', arguments: { reject: true } });
    expect(statusOf(retry)?.status).toBe('executed');
    expect((await stats(client)).rejections).toBe(2);
  });

  test('without a not-dispatched rule the same error result puts the retry in doubt', async () => {
    const { client } = await startProxy(workspace);
    await client.callTool({ name: 'increment', arguments: { reject: true } });
    const retry = await client.callTool({ name: 'increment', arguments: { reject: true } });
    expect(statusOf(retry)?.status).toBe('in_doubt');
    expect((await stats(client)).rejections).toBe(1);
  });

  test('a config pass rule forwards without a ledger entry', async () => {
    const { client, store } = await startProxy(workspace, { config: workspace.config({ tools: { 'incr*': { policy: 'pass' } } }) });
    await client.callTool({ name: 'increment', arguments: {} });
    await client.callTool({ name: 'increment', arguments: {} });
    expect(store.listActions(workspace.clock.nowMs())).toEqual([]);
    expect((await stats(client)).actionKeys).toEqual([null, null]);
  });
});

describe('upstream-initiated traffic', () => {
  test('an upstream request to the client is relayed, also while a tools/list prefetch is waiting on it', async () => {
    const { client } = await startProxy(workspace, { capabilities: { roots: {} }, upstreamEnv: { COUNTER_ROOTS_IN_LIST: '1' } });
    client.setRequestHandler(ListRootsRequestSchema, async () => ({ roots: [{ uri: 'file:///work', name: 'work' }] }));
    const result = await client.callTool({ name: 'ask_roots', arguments: {} });
    expect(statusOf(result)?.status).toBe('executed');
    expect(JSON.parse(textOf(result))).toEqual([{ uri: 'file:///work', name: 'work' }]);
  });

  test('progress notifications for a guarded call reach the client', async () => {
    const { client } = await startProxy(workspace);
    const progress: unknown[] = [];
    const result = await client.callTool({ name: 'progress_work', arguments: {} }, undefined, { onprogress: (update) => progress.push(update) });
    expect(statusOf(result)?.status).toBe('executed');
    expect(progress).toEqual([{ progress: 1, total: 2, message: 'halfway' }]);
  });

  test('identical guarded calls in flight together dispatch once and both get the result', async () => {
    const { client } = await startProxy(workspace);
    const first = client.callTool({ name: 'slow', arguments: {} });
    await client.callTool({ name: 'slow_started', arguments: {} });
    const second = client.callTool({ name: 'slow', arguments: {} });
    await client.callTool({ name: 'release', arguments: {} });
    const [a, b] = await Promise.all([first, second]);
    expect(textOf(a)).toBe('slow done');
    expect(textOf(b)).toBe('slow done');
    expect(statusOf(b)).toEqual(statusOf(a));
    expect((await stats(client)).count).toBe(1);
  });
});

describe('doubt delivery seam', () => {
  test('a money action in doubt is blocked without a human resolver', async () => {
    const { client } = await startProxy(workspace);
    await client.callTool({ name: 'charge', arguments: { amount: 10, fail: true } });
    const retry = await client.callTool({ name: 'charge', arguments: { amount: 10, fail: true } });
    expect(retry.isError).toBe(true);
    expect(statusOf(retry)?.status).toBe('blocked');
    expect(textOf(retry)).toContain('npx agent-once resolve');
    const refused = await client.callTool({ name: 'agent_once_resolve', arguments: { action_id: statusOf(retry)?.action_id, outcome: 'happened' } });
    expect(refused.isError).toBe(true);
    expect((await stats(client)).count).toBe(1);
  });

  test('the human resolver reads the client capabilities through the live context at resolve time', async () => {
    const seen: unknown[] = [];
    const humanResolver = (ctx: ProxyContext): HumanResolver => ({
      resolve: async () => {
        seen.push(ctx.clientCapabilities.elicitation);
        return 'happened';
      },
    });
    const { client } = await startProxy(workspace, { capabilities: { elicitation: {} }, humanResolver });
    await client.callTool({ name: 'charge', arguments: { amount: 10, fail: true } });
    const retry = await client.callTool({ name: 'charge', arguments: { amount: 10, fail: true } });
    expect(statusOf(retry)?.status).toBe('replayed');
    expect(seen).toEqual([{}]);
    expect((await stats(client)).count).toBe(1);
  });
});

describe('extensions', () => {
  test('hooks see client requests and upstream results, can adjust calls and classify outcomes, and the context reaches both sides', async () => {
    const requests: string[] = [];
    const results: string[] = [];
    let context: ProxyContext | undefined;
    const { client, store } = await startProxy(workspace, {
      capabilities: { roots: {} },
      extensions: [
        {
          onClientRequest: (message, ctx) => {
            requests.push(message.method);
            context = ctx;
          },
          onUpstreamResult: (tool, _args, result) => {
            results.push(`${tool}:${textOf(result)}`);
          },
          adjustCall: (call: GuardedCall) => (call.tool === 'read_count' ? { ...call, policy: 'guard' } : call),
          classifyOutcome: (tool) => (tool === 'read_count' ? { kind: 'not_dispatched', error: 'classified by extension' } : undefined),
        },
      ],
    });
    client.setRequestHandler(ListRootsRequestSchema, async () => ({
      roots: [{ uri: 'file:///work', name: 'work' }],
    }));
    const guardedRead = await client.callTool({ name: 'read_count', arguments: {} });
    expect(store.findAction(statusOf(guardedRead)?.action_id ?? '')?.detail.failure_kind).toBe('not_dispatched');
    expect(requests).toContain('tools/call');
    expect(results).toContain('read_count:count=0');

    const viaContext = await context?.callUpstreamTool('read_count', {});
    expect(textOf(viaContext)).toBe('count=0');
    expect(await context?.requestClient('roots/list', {})).toEqual({ roots: [{ uri: 'file:///work', name: 'work' }] });
    expect(context?.clientInfo?.name).toBe('test-client');
  });
});
