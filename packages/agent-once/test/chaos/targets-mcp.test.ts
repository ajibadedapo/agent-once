import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, test } from 'vitest';
import { chaosTargetsPreset } from '../../src/chaos/presets.js';
import { createTargetsMcpServer } from '../../src/chaos/targets-mcp/server.js';
import type { JsonValue } from '../../src/canonical/jcs.js';
import { loadConfig } from '../../src/config/load.js';
import { parseConfig, type AgentOnceConfig } from '../../src/config/schema.js';
import { Guard } from '../../src/guard/guard.js';
import type { ExecuteContext, ToolOutcome } from '../../src/guard/types.js';
import { MemoryLedgerStore } from '../../src/ledger/memory-store.js';
import type { LedgerEvent } from '../../src/ledger/types.js';
import { browserReadBackRule } from '../../src/mcp/browser/read-back.js';
import { ACTION_META_KEY } from '../../src/mcp/meta.js';
import { resultText } from '../../src/mcp/proxy.js';
import { ReadBackReconciler } from '../../src/mcp/read-back-reconciler.js';
import { findToolRule, resolveToolPolicy } from '../../src/mcp/tool-policy.js';
import { ManualClock, type Clock } from '../../src/time/clock.js';
import { RecordingSink } from '../guard-harness.js';
import { START_MS, formFields, pageText, postForm, send, targetsOnManualClock } from './chaos-harness.js';

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
});

async function connect(url: string, clock: Clock, timeoutMs?: number): Promise<Client> {
  const server = createTargetsMcpServer({ url, clock, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'chaos-test', version: '1.0.0' });
  await server.connect(serverSide);
  await client.connect(clientSide);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>, key?: string): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args, ...(key === undefined ? {} : { _meta: { [ACTION_META_KEY]: key } }) })) as CallToolResult;
}

function presetConfig(): AgentOnceConfig {
  return { ...loadConfig({ cwd: '/work', env: { AGENT_ONCE_HOME: '/state' }, homedir: '/home/user' }), ...chaosTargetsPreset() };
}

function sentEvent(tool: string, detail: Record<string, string>): LedgerEvent {
  return {
    seq: 2,
    actionId: 'ao_0123456789abcdef01234567',
    intentHash: 'e'.repeat(64),
    occurrence: 0,
    state: 'sent',
    atMs: START_MS,
    expiresAtMs: START_MS + 86_400_000,
    sessionKey: 'chaos:/work',
    sessionExplicit: false,
    intentKeyExplicit: false,
    runInstance: 'run-1',
    tool,
    toolClass: 'standard',
    policy: 'guard',
    argsJson: null,
    detail,
  };
}

const ORDER = { item: 'Blue mug', qty: 1 };

describe('targets MCP server', () => {
  test('lists the four mutating tools and their read-only lists with annotations', async () => {
    const { clock, targets } = await targetsOnManualClock();
    const client = await connect(targets.url, clock);
    const { tools } = await client.listTools();
    const annotations = Object.fromEntries(tools.map((tool) => [tool.name, tool.annotations]));
    for (const name of ['place_order', 'book_slot', 'send_email', 'create_ticket']) {
      expect(annotations[name]).toEqual({ destructiveHint: true, idempotentHint: false });
    }
    for (const name of ['list_orders', 'list_bookings', 'list_sent_emails', 'list_tickets']) {
      expect(annotations[name]).toEqual({ readOnlyHint: true });
    }
    expect(tools).toHaveLength(8);
  });

  test('targets-mcp tools map to the API and surface faults as error results', async () => {
    const { clock, targets } = await targetsOnManualClock();
    const client = await connect(targets.url, clock);
    const placed = await call(client, 'place_order', ORDER, 'ao_forwarded');
    expect(placed.isError).toBeUndefined();
    expect(JSON.parse(resultText(placed))).toMatchObject({ id: 'ORD-1', clientRef: 'ao_forwarded', fields: { item: 'Blue mug', qty: '1' } });
    await call(client, 'book_slot', { slot: 'Mon 10:00', name: 'Sam' });
    await call(client, 'send_email', { to: 'a@example.test', subject: 'Hi', body: 'Hello' });
    await call(client, 'create_ticket', { title: 'Printer jam', body: 'Jammed.' });
    expect(Object.fromEntries(Object.entries(targets.truth()).map(([target, effects]) => [target, effects.map((effect) => effect.id)]))).toEqual({
      checkout: ['ORD-1'],
      booking: ['BK-1'],
      email: ['MSG-1'],
      ticket: ['TCK-1'],
    });
    expect(resultText(await call(client, 'list_orders', {}))).toBe(JSON.stringify(targets.truth().checkout));
    expect(resultText(await call(client, 'list_bookings', {}))).toBe(JSON.stringify(targets.truth().booking));
    expect(resultText(await call(client, 'list_sent_emails', {}))).toBe(JSON.stringify(targets.truth().email));
    expect(resultText(await call(client, 'list_tickets', {}))).toBe(JSON.stringify(targets.truth().ticket));

    targets.setFaults([
      { target: 'checkout', nth: 1, kind: 'lost_response_after_commit', holdMs: 0 },
      { target: 'checkout', nth: 2, kind: 'stale_element', holdMs: 0 },
    ]);
    const lost = await call(client, 'place_order', ORDER);
    expect(lost.isError).toBe(true);
    expect(resultText(lost)).toMatch(/^request failed: (socket hang up|read ECONNRESET)$/);
    const stale = await call(client, 'place_order', ORDER);
    expect(stale).toMatchObject({ isError: true, content: [{ type: 'text', text: 'stale form: nothing was submitted' }] });
    const invalid = await call(client, 'place_order', { item: 'no quantity' });
    expect(invalid).toMatchObject({ isError: true, content: [{ type: 'text', text: 'missing field qty' }] });
    expect(targets.truth().checkout.map((effect) => effect.id)).toEqual(['ORD-1', 'ORD-2']);
    const unknown = await call(client, 'refund_order', {});
    expect(unknown).toMatchObject({ isError: true, content: [{ type: 'text', text: 'unknown tool refund_order' }] });
  });

  test('a target that does not answer times out on the injected clock', async () => {
    const clock = new ManualClock(START_MS);
    let arrived: (request: IncomingMessage) => void = () => {};
    const arrival = new Promise<IncomingMessage>((resolve) => {
      arrived = resolve;
    });
    const silent: HttpServer = createServer((request) => arrived(request));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    closers.push(
      () =>
        new Promise<void>((resolve) => {
          silent.closeAllConnections();
          silent.close(() => resolve());
        }),
    );
    const client = await connect(`http://127.0.0.1:${(silent.address() as AddressInfo).port}`, clock, 2_500);
    const pending = call(client, 'create_ticket', { title: 'Printer jam', body: 'Jammed.' }, 'ao_waiting');
    const request = await arrival;
    expect(request.headers['idempotency-key']).toBe('ao_waiting');
    clock.advance(2_499);
    clock.advance(1);
    expect(await pending).toMatchObject({ isError: true, content: [{ type: 'text', text: 'request failed: timed out after 2500 ms' }] });
  });

  test('an unreachable target is an error result', async () => {
    const clock = new ManualClock(START_MS);
    const closed = createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const client = await connect(`http://127.0.0.1:${port}`, clock);
    expect(resultText(await call(client, 'list_orders', {}))).toMatch(/^request failed: connect ECONNREFUSED/);
  });
});

describe('chaos targets preset', () => {
  test('the preset is a valid config and the default classifier gives the expected classes', () => {
    const config = presetConfig();
    expect(parseConfig(JSON.parse(JSON.stringify(chaosTargetsPreset())), { file: 'preset.json', baseDir: '/work', env: {}, homedir: '/home/user' }).tools).toEqual(config.tools);
    const mutating = { destructiveHint: true, idempotentHint: false };
    expect(resolveToolPolicy('place_order', mutating, config)).toEqual({ policy: 'block-on-doubt', toolClass: 'money' });
    expect(resolveToolPolicy('book_slot', mutating, config)).toEqual({ policy: 'guard', toolClass: 'standard' });
    expect(resolveToolPolicy('send_email', mutating, config)).toEqual({ policy: 'block-on-doubt', toolClass: 'irreversible' });
    expect(resolveToolPolicy('create_ticket', mutating, config)).toEqual({ policy: 'guard', toolClass: 'standard' });
    expect(resolveToolPolicy('list_orders', { readOnlyHint: true }, config).policy).toBe('pass');
    expect(findToolRule('send_email', config)?.notDispatchedErrors).toEqual(['stale form: nothing was submitted']);
    expect(config.browser.notDispatchedErrors).toContain('stale form: nothing was submitted');
  });

  test('read-back preset finds an effect by action id', async () => {
    const { clock, targets } = await targetsOnManualClock();
    const client = await connect(targets.url, clock);
    const upstream = { callUpstreamTool: (name: string, args: Record<string, unknown>) => call(client, name, args) };
    const config = presetConfig();
    const expectations = [
      ['place_order', ORDER],
      ['book_slot', { slot: 'Mon 10:00', name: 'Sam' }],
      ['send_email', { to: 'a@example.test', subject: 'Hi', body: 'Hello' }],
      ['create_ticket', { title: 'Printer jam', body: 'Jammed.' }],
    ] as const;
    for (const [tool, args] of expectations) {
      const rule = findToolRule(tool, config)?.readBack;
      if (rule === undefined) throw new Error(`no read-back for ${tool}`);
      const reconciler = new ReadBackReconciler(rule, upstream);
      const key = `ao_${tool}_key00000000000`;
      expect(await reconciler.reconcile({ tool, args, actionId: 'ao_other', event: sentEvent(tool, { idempotency_key: key }) })).toEqual({ outcome: 'not_happened' });
      await call(client, tool, args, key);
      expect(await reconciler.reconcile({ tool, args, actionId: 'ao_other', event: sentEvent(tool, { idempotency_key: key }) })).toEqual({ outcome: 'happened' });
      expect(await reconciler.reconcile({ tool, args, actionId: 'ao_other', event: sentEvent(tool, { idempotency_key: `${key}9` }) })).toEqual({
        outcome: 'not_happened',
      });
    }
  });

  test('the browser read-back finds a captured reference on the history page', async () => {
    const { targets } = await targetsOnManualClock();
    const config = presetConfig();
    let lastPage = '';
    const browser = {
      callUpstreamTool: async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
        if (name === 'browser_navigate') lastPage = pageText((await send(String(args.url))).body);
        return { content: [{ type: 'text', text: name === 'browser_snapshot' ? lastPage : `Navigated to ${String(args.url)}` }] };
      },
    };
    for (const target of ['checkout', 'booking', 'email', 'ticket']) {
      const page = await send(`${targets.url}/${target}`);
      const capture = config.browser.capture.find((rule) => new RegExp(rule.urlPattern, 'i').test(`${targets.url}/${target}`));
      const captured = new RegExp(capture?.regex ?? 'no capture rule').exec(pageText(page.body))?.[1];
      expect(captured).toMatch(/^F-\d+$/);
      const rule = browserReadBackRule(config.browser, `${targets.url}/${target}`);
      if (rule === undefined || captured === undefined) throw new Error(`no browser read-back for ${target}`);
      const reconciler = new ReadBackReconciler(rule, browser, { origin: targets.url });
      const context = { tool: 'browser_click', args: {}, actionId: 'ao_click', event: sentEvent('browser_click', { captured }) };
      expect(await reconciler.reconcile(context)).toEqual({ outcome: 'not_happened' });
      await postForm(`${targets.url}/${target}/submit`, formFields(page.body));
      expect(await reconciler.reconcile(context)).toEqual({ outcome: 'happened' });
    }
  });

  test('a captured reference does not match a longer reference on the history page', async () => {
    const { targets } = await targetsOnManualClock();
    const config = presetConfig();
    const rule = browserReadBackRule(config.browser, `${targets.url}/checkout`);
    if (rule === undefined) throw new Error('no checkout read-back');
    const browser = {
      callUpstreamTool: async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => ({
        content: [{ type: 'text', text: name === 'browser_navigate' ? pageText((await send(String(args.url))).body) : '' }],
      }),
    };
    for (let rendered = 0; rendered < 12; rendered += 1) await send(`${targets.url}/booking`);
    const page = await send(`${targets.url}/checkout`);
    expect(pageText(page.body)).toContain('Reference F-13');
    await postForm(`${targets.url}/checkout/submit`, formFields(page.body));
    const reconciler = new ReadBackReconciler(rule, browser, { origin: targets.url });
    const context = (captured: string) => ({ tool: 'browser_click', args: {}, actionId: 'ao_click', event: sentEvent('browser_click', { captured }) });
    expect(await reconciler.reconcile(context('F-1'))).toEqual({ outcome: 'not_happened' });
    expect(await reconciler.reconcile(context('F-13'))).toEqual({ outcome: 'happened' });
  });

  test('the guard settles a lost response and a timeout against the targets without a duplicate', async () => {
    const { clock, targets } = await targetsOnManualClock();
    const client = await connect(targets.url, clock);
    const config = presetConfig();
    const upstream = { callUpstreamTool: (name: string, args: Record<string, unknown>) => call(client, name, args) };
    const guard = new Guard({ store: new MemoryLedgerStore(clock), clock, runInstance: 'run-1', evidence: new RecordingSink() });
    const run = (tool: string, args: Record<string, unknown>) => {
      const rule = findToolRule(tool, config)?.readBack;
      if (rule === undefined) throw new Error(`no read-back for ${tool}`);
      const execute = async ({ idempotencyKey }: ExecuteContext): Promise<ToolOutcome> => {
        const result = await call(client, tool, args, idempotencyKey);
        return result.isError === true ? { kind: 'error_result', result: result as unknown as JsonValue } : { kind: 'ok', result: result as unknown as JsonValue };
      };
      return guard.run(
        { tool, args, sessionKey: 'chaos:/work', sessionExplicit: true, policy: 'guard', toolClass: 'standard', reconciler: new ReadBackReconciler(rule, upstream).reconcile },
        execute,
      );
    };
    const ticket = { title: 'Printer jam', body: 'Jammed.' };
    targets.setFaults([{ target: 'ticket', nth: 1, kind: 'lost_response_after_commit', holdMs: 0 }]);
    expect((await run('create_ticket', ticket)).status).toBe('executed');
    expect((await run('create_ticket', ticket)).status).toBe('replayed');
    expect(targets.truth().ticket).toHaveLength(1);

    const booking = { slot: 'Mon 10:00', name: 'Sam' };
    targets.setFaults([{ target: 'booking', nth: 1, kind: 'timeout_before_commit', holdMs: 0 }]);
    expect((await run('book_slot', booking)).status).toBe('executed');
    expect((await run('book_slot', booking)).status).toBe('in_doubt');
    clock.advance(10_000);
    expect((await run('book_slot', booking)).status).toBe('executed');
    expect(targets.truth().booking).toHaveLength(1);
  });
});

