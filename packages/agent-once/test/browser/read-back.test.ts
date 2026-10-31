import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, test } from 'vitest';
import type { JsonValue } from '../../src/canonical/jcs.js';
import type { ReadBackRule } from '../../src/config/schema.js';
import type { ReconcileContext } from '../../src/guard/types.js';
import type { LedgerEvent } from '../../src/ledger/types.js';
import { ReadBackReconciler } from '../../src/mcp/read-back-reconciler.js';
import { renderArgs, renderPattern, TemplateError } from '../../src/mcp/template.js';
import { fixture, originOf } from './fixtures.js';

const START_MS = 1_761_912_345_678;

function event(detail: Record<string, JsonValue> = {}): LedgerEvent {
  return {
    seq: 2,
    actionId: 'ao_0123456789abcdef01234567',
    intentHash: 'f'.repeat(64),
    occurrence: 0,
    state: 'sent',
    atMs: START_MS,
    expiresAtMs: START_MS + 86_400_000,
    sessionKey: 'test:/work',
    sessionExplicit: false,
    intentKeyExplicit: false,
    runInstance: 'run-1',
    tool: 'browser_click',
    toolClass: 'money',
    policy: 'block-on-doubt',
    argsJson: null,
    detail,
  };
}

function reconcileContext(args: Record<string, unknown>, detail: Record<string, JsonValue> = {}): ReconcileContext {
  const sent = event(detail);
  return { tool: sent.tool, args, actionId: sent.actionId, event: sent };
}

class FakeUpstream {
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];

  constructor(private readonly answers: Record<string, CallToolResult | Error>) {}

  callUpstreamTool = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    this.calls.push({ name, args });
    const answer = this.answers[name];
    if (answer === undefined) throw new Error(`unexpected read-back call to ${name}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
}

const ORDERS_RULE: ReadBackRule = {
  steps: [
    { tool: 'browser_navigate', args: { url: '{{origin}}/orders' } },
    { tool: 'browser_snapshot', args: {} },
  ],
  happened: '{{captured}} placed',
  notHappened: 'Your orders',
};

function ordersUpstream(): FakeUpstream {
  return new FakeUpstream({ browser_navigate: fixture('playwright', 'navigate-orders'), browser_snapshot: fixture('playwright', 'orders-snapshot') });
}

describe('ReadBackReconciler', () => {
  test('read-back with templated steps reports happened, not_happened and unknown', async () => {
    const origin = originOf('playwright');
    const upstream = ordersUpstream();
    const reconciler = new ReadBackReconciler(ORDERS_RULE, upstream, { origin });
    expect(await reconciler.reconcile(reconcileContext({}, { captured: 'AO-48213' }))).toEqual({ outcome: 'happened' });
    expect(upstream.calls).toEqual([
      { name: 'browser_navigate', args: { url: `${origin}/orders` } },
      { name: 'browser_snapshot', args: {} },
    ]);
    expect(await reconciler.reconcile(reconcileContext({}, { captured: 'AO-99999' }))).toEqual({ outcome: 'not_happened' });

    const failing = new ReadBackReconciler(ORDERS_RULE, new FakeUpstream({ browser_navigate: fixture('playwright', 'click-stale') }), { origin });
    expect(await failing.reconcile(reconcileContext({}, { captured: 'AO-48213' }))).toEqual({
      outcome: 'unknown',
      reason: expect.stringContaining('browser_navigate returned an error') as string,
    });

    const throwing = new ReadBackReconciler(ORDERS_RULE, new FakeUpstream({ browser_navigate: new Error('the MCP server exited') }), { origin });
    expect(await throwing.reconcile(reconcileContext({}, { captured: 'AO-48213' }))).toEqual({
      outcome: 'unknown',
      reason: expect.stringContaining('the MCP server exited') as string,
    });

    const silent = new ReadBackReconciler({ ...ORDERS_RULE, notHappened: 'Nothing like this' }, ordersUpstream(), { origin });
    expect(await silent.reconcile(reconcileContext({}, { captured: 'AO-77777' }))).toEqual({
      outcome: 'unknown',
      reason: 'the read-back matched neither pattern',
    });
  });

  test('a missing template value is unknown without calling the server', async () => {
    const upstream = ordersUpstream();
    const reconciler = new ReadBackReconciler(ORDERS_RULE, upstream, {});
    expect(await reconciler.reconcile(reconcileContext({}, { captured: 'AO-48213' }))).toEqual({
      outcome: 'unknown',
      reason: 'read-back template: no value for {{origin}}',
    });
    const noCapture = new ReadBackReconciler(ORDERS_RULE, upstream, { origin: originOf('playwright') });
    expect(await noCapture.reconcile(reconcileContext({}))).toEqual({ outcome: 'unknown', reason: 'read-back template: no value for {{captured}}' });
    expect(upstream.calls).toEqual([]);
  });

  test('substituted values are matched literally in patterns', async () => {
    const rule: ReadBackRule = { steps: [{ tool: 'browser_snapshot', args: {} }], happened: '{{captured}} placed' };
    const upstream = new FakeUpstream({ browser_snapshot: fixture('playwright', 'orders-snapshot') });
    const reconciler = new ReadBackReconciler(rule, upstream, {});
    expect(await reconciler.reconcile(reconcileContext({}, { captured: 'AO.48213' }))).toEqual({ outcome: 'unknown', reason: 'the read-back matched neither pattern' });
    expect(await reconciler.reconcile(reconcileContext({}, { captured: '.*' }))).toEqual({ outcome: 'unknown', reason: 'the read-back matched neither pattern' });
  });

  test('tool arguments and the action id fill step templates', async () => {
    const upstream = new FakeUpstream({ find_ticket: { content: [{ type: 'text', text: 'ticket "Printer on fire" created by ao_0123456789abcdef01234567' }] } });
    const rule: ReadBackRule = {
      steps: [{ tool: 'find_ticket', args: { title: '{{args.ticket.title}}', limit: '{{args.limit}}', note: 'by {{action_id}}' } }],
      happened: '"{{args.ticket.title}}" created by {{action_id}}',
    };
    const reconciler = new ReadBackReconciler(rule, upstream, {});
    expect(await reconciler.reconcile(reconcileContext({ ticket: { title: 'Printer on fire' }, limit: 5 }))).toEqual({ outcome: 'happened' });
    expect(upstream.calls[0]?.args).toEqual({ title: 'Printer on fire', limit: 5, note: 'by ao_0123456789abcdef01234567' });
  });

  test('the idempotency key the proxy forwarded fills templates, falling back to the action id', async () => {
    const inherited = 'ao_fedcba9876543210fedcba98';
    const listing = { content: [{ type: 'text' as const, text: `[{"id":"ORD-1","clientRef":"${inherited}"}]` }] };
    const rule: ReadBackRule = {
      steps: [{ tool: 'list_orders', args: { ref: '{{idempotency_key}}' } }],
      happened: '"clientRef":"{{idempotency_key}}"',
      notHappened: '^\\[',
    };
    const upstream = new FakeUpstream({ list_orders: listing });
    const reconciler = new ReadBackReconciler(rule, upstream, {});
    expect(await reconciler.reconcile(reconcileContext({}, { idempotency_key: inherited }))).toEqual({ outcome: 'happened' });
    expect(upstream.calls[0]?.args).toEqual({ ref: inherited });
    expect(await reconciler.reconcile(reconcileContext({}))).toEqual({ outcome: 'not_happened' });
    expect(upstream.calls[1]?.args).toEqual({ ref: 'ao_0123456789abcdef01234567' });
  });
});

describe('templates', () => {
  test('render nested arguments and escape pattern values', () => {
    const vars = { args: { a: { b: 'x(y)' }, n: 3 }, actionId: 'ao_1', captured: 'C+1' };
    expect(renderArgs({ q: ['{{args.a.b}}', '{{args.n}}'], id: '{{action_id}}-{{args.n}}' }, vars)).toEqual({ q: ['x(y)', 3], id: 'ao_1-3' });
    expect(renderPattern('^{{captured}} and {{args.a.b}}$', vars)).toBe('^C\\+1 and x\\(y\\)$');
    expect(() => renderArgs('{{args.missing}}', vars)).toThrow(TemplateError);
    expect(() => renderArgs('{{unknown}}', vars)).toThrow(TemplateError);
  });

  test('render the idempotency key and refuse it when it is absent', () => {
    expect(renderPattern('"clientRef":"{{idempotency_key}}"', { args: {}, actionId: 'ao_1', idempotencyKey: 'ao_0.1' })).toBe('"clientRef":"ao_0\\.1"');
    expect(() => renderPattern('{{idempotency_key}}', { args: {}, actionId: 'ao_1' })).toThrow('no value for {{idempotency_key}}');
  });
});
