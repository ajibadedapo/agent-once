import { createHmac } from 'node:crypto';
import { ElicitRequestSchema, type ElicitRequest, type ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import type { AgentOnceConfig } from '../../src/config/schema.js';
import { Guard } from '../../src/guard/guard.js';
import type { DoubtInfo, HumanResolution, HumanResolver } from '../../src/guard/types.js';
import { ChainResolver } from '../../src/mcp/doubt/chain-resolver.js';
import { ElicitationResolver, ELICITATION_SCHEMA } from '../../src/mcp/doubt/elicitation-resolver.js';
import { createHumanResolver } from '../../src/mcp/doubt/human-resolver.js';
import { blockedToolResult, doubtQuestion, inDoubtToolResult } from '../../src/mcp/doubt/messages.js';
import { WebhookResolver } from '../../src/mcp/doubt/webhook-resolver.js';
import type { ProxyContext } from '../../src/mcp/proxy.js';
import { ManualClock } from '../../src/time/clock.js';
import { START_MS, startProxy, stats, statusOf, STATUS_KEY, textOf, Workspace } from './proxy-harness.js';

const HOOK_URL = 'https://approvals.example.test/hook';
const UNRESOLVED: HumanResolution = { outcome: 'unresolved' };
const byHuman = (outcome: 'happened' | 'not_happened'): HumanResolution => ({ outcome, by: 'human' });
const byWebhook = (outcome: 'happened' | 'not_happened'): HumanResolution => ({ outcome, by: 'webhook' });

const DOUBT: DoubtInfo = {
  actionId: 'ao_0123456789abcdef01234567',
  tool: 'charge',
  args: { amount: 10, card: 'visa' },
  toolClass: 'money',
  reason: 'failed_block_on_doubt',
  sinceMs: START_MS,
};

const BLOCKED_TEXT = (tool: string, actionId: string, toolClass: string) =>
  `agent-once blocked this call: an earlier identical ${tool} call (action ${actionId}) may already have taken effect and its outcome is unknown. This is a ${toolClass} action, so a person must confirm before anything is retried. Ask the user to run: npx agent-once resolve ${actionId} --happened (or --not-happened).`;

interface FetchCall {
  url: string;
  init: RequestInit;
}

function fakeFetch(answer: (call: FetchCall) => Promise<Response> | Response): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return Promise.resolve(answer(call));
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fakeContext(clock: ManualClock, capabilities: ProxyContext['clientCapabilities'], answer: (params: unknown, signal?: AbortSignal) => Promise<unknown>) {
  const requests: { method: string; params: unknown; signal?: AbortSignal }[] = [];
  const ctx: ProxyContext = {
    clientCapabilities: capabilities,
    clock,
    requestClient: (method, params, options) => {
      requests.push({ method, params, ...(options?.signal === undefined ? {} : { signal: options.signal }) });
      return answer(params, options?.signal);
    },
    callUpstreamTool: () => Promise.reject(new Error('not used')),
  };
  return { ctx, requests };
}

function fixed(answer: HumanResolution): HumanResolver & { asked: number; signals: (AbortSignal | undefined)[] } {
  const resolver = {
    asked: 0,
    signals: [] as (AbortSignal | undefined)[],
    resolve: async (_doubt: DoubtInfo, signal?: AbortSignal) => {
      resolver.asked += 1;
      resolver.signals.push(signal);
      return answer;
    },
  };
  return resolver;
}

let workspace: Workspace;

beforeEach(() => {
  workspace = new Workspace();
});

afterEach(async () => {
  await workspace.dispose();
});

function withWebhook(config: AgentOnceConfig, timeoutSeconds = 30): AgentOnceConfig {
  return { ...config, approvalWebhook: { url: HOOK_URL, timeoutSeconds } };
}

describe('exact copy', () => {
  test('exact copy for in-doubt, blocked and question', () => {
    const standard: DoubtInfo = { ...DOUBT, tool: 'increment', toolClass: 'standard' };
    const inDoubt = inDoubtToolResult(standard, true);
    expect(inDoubt.isError).toBe(true);
    expect(inDoubt.content).toEqual([
      {
        type: 'text',
        text: `agent-once stopped this call: an earlier identical increment call (action ${DOUBT.actionId}) may already have taken effect and its outcome is unknown. Do not retry it. Check whether it happened (for example, read the page or list the records), then call agent_once_resolve with action_id "${DOUBT.actionId}" and outcome "happened" or "not_happened".`,
      },
    ]);
    expect(inDoubt._meta).toEqual({ [STATUS_KEY]: { status: 'in_doubt', action_id: DOUBT.actionId, class: 'standard' } });

    const blocked = blockedToolResult(DOUBT);
    expect(blocked.isError).toBe(true);
    expect(blocked.content).toEqual([{ type: 'text', text: BLOCKED_TEXT('charge', DOUBT.actionId, 'money') }]);
    expect(blocked._meta).toEqual({ [STATUS_KEY]: { status: 'blocked', action_id: DOUBT.actionId, class: 'money' } });

    const question = (tool: string, verb: string) =>
      `agent-once: an earlier ${tool} call (action ${DOUBT.actionId}) may already have happened, and repeating it could ${verb} twice. Did it happen?`;
    expect(doubtQuestion(DOUBT)).toBe(question('charge', 'charge'));
    expect(doubtQuestion({ ...DOUBT, tool: 'send_email', toolClass: 'irreversible' })).toBe(question('send_email', 'send'));
    expect(doubtQuestion({ ...DOUBT, tool: 'increment', toolClass: 'standard' })).toBe(question('increment', 'act'));
  });

  test('an in-doubt result the agent may not resolve points to the person instead', () => {
    const result = inDoubtToolResult(DOUBT, false);
    expect(textOf(result)).not.toContain('agent_once_resolve');
    expect(textOf(result)).toContain(`npx agent-once resolve ${DOUBT.actionId} --happened (or --not-happened)`);
  });
});

describe('elicitation', () => {
  test('client with elicitation capability is asked and happened replays', async () => {
    const asked: ElicitRequest['params'][] = [];
    const { client, sink } = await startProxy(workspace, {
      capabilities: { elicitation: {} },
      humanResolver: (ctx) => createHumanResolver(ctx, workspace.config(), {}),
    });
    client.setRequestHandler(ElicitRequestSchema, async (request): Promise<ElicitResult> => {
      asked.push(request.params);
      return { action: 'accept', content: { agent_once_outcome: 'happened' } };
    });
    const first = await client.callTool({ name: 'charge', arguments: { amount: 10, fail: true } });
    const actionId = statusOf(first)?.action_id ?? '';
    const retry = await client.callTool({ name: 'charge', arguments: { amount: 10, fail: true } });
    expect(statusOf(retry)?.status).toBe('replayed');
    expect(asked).toEqual([
      {
        message: `agent-once: an earlier charge call (action ${actionId}) may already have happened, and repeating it could charge twice. Did it happen?`,
        requestedSchema: {
          type: 'object',
          properties: {
            agent_once_outcome: {
              type: 'string',
              title: 'Did it happen?',
              enum: ['happened', 'not_happened'],
              enumNames: ['Yes, it happened', 'No, it did not happen'],
            },
          },
          required: ['agent_once_outcome'],
        },
      },
    ]);
    const reconciled = sink.events.filter((event) => event.kind === 'state' && event.detail.state === 'reconciled');
    expect(reconciled.map((event) => [event.detail.outcome, event.detail.resolved_by])).toEqual([['happened', 'human']]);
    expect((await stats(client)).count).toBe(1);
  });

  test('client without elicitation capability gets the blocked result without an elicitation request', async () => {
    const { client } = await startProxy(workspace, { humanResolver: (ctx) => createHumanResolver(ctx, workspace.config(), {}) });
    const seen: string[] = [];
    client.fallbackRequestHandler = async (request) => {
      seen.push(request.method);
      throw new Error('unexpected request');
    };
    const first = await client.callTool({ name: 'charge', arguments: { amount: 10, fail: true } });
    const actionId = statusOf(first)?.action_id ?? '';
    const retry = await client.callTool({ name: 'charge', arguments: { amount: 10, fail: true } });
    expect(retry.isError).toBe(true);
    expect(textOf(retry)).toBe(BLOCKED_TEXT('charge', actionId, 'money'));
    expect(statusOf(retry)).toEqual({ status: 'blocked', action_id: actionId, class: 'money' });
    expect(seen).toEqual([]);
    expect((await stats(client)).count).toBe(1);
  });

  test('a client that declared only url elicitation is not sent a form request', async () => {
    const clock = new ManualClock(START_MS);
    const { ctx, requests } = fakeContext(clock, { elicitation: { url: {} } }, async () => ({ action: 'accept', content: { agent_once_outcome: 'happened' } }));
    expect(await new ElicitationResolver(ctx).resolve(DOUBT)).toEqual(UNRESOLVED);
    expect(requests).toEqual([]);
  });

  test('accept maps the value, decline, cancel, bad content and errors are unresolved', async () => {
    const clock = new ManualClock(START_MS);
    const answers: unknown[] = [
      { action: 'accept', content: { agent_once_outcome: 'not_happened' } },
      { action: 'decline' },
      { action: 'cancel' },
      { action: 'accept', content: { agent_once_outcome: 'maybe' } },
      { action: 'accept' },
    ];
    let next = 0;
    const { ctx, requests } = fakeContext(clock, { elicitation: { form: {} } }, async () => {
      const answer = answers[next];
      next += 1;
      if (answer === undefined) throw new Error('client error');
      return answer;
    });
    const resolver = new ElicitationResolver(ctx);
    const results: HumanResolution[] = [];
    for (let i = 0; i <= answers.length; i += 1) results.push(await resolver.resolve(DOUBT));
    expect(results).toEqual([byHuman('not_happened'), UNRESOLVED, UNRESOLVED, UNRESOLVED, UNRESOLVED, UNRESOLVED]);
    expect(requests.map((request) => request.method)).toEqual(Array(answers.length + 1).fill('elicitation/create'));
    expect(requests[0]?.params).toEqual({ message: doubtQuestion(DOUBT), requestedSchema: ELICITATION_SCHEMA });
  });

  test('a client that never answers the elicitation is unresolved once the timeout passes', async () => {
    const clock = new ManualClock(START_MS);
    const { ctx, requests } = fakeContext(clock, { elicitation: {} }, () => new Promise(() => {}));
    const pending = new ElicitationResolver(ctx, 60_000).resolve(DOUBT);
    let settled: HumanResolution | undefined;
    void pending.then((answer) => {
      settled = answer;
    });
    clock.advance(59_999);
    await Promise.resolve();
    expect(settled).toBeUndefined();
    clock.advance(1);
    expect(await pending).toEqual(UNRESOLVED);
    expect(requests[0]?.signal?.aborted).toBe(true);
  });

  test('the elicitation timeout defaults to 300 s and follows the webhook timeout when one is configured', async () => {
    const clock = new ManualClock(START_MS);
    const { ctx } = fakeContext(clock, { elicitation: {} }, () => new Promise(() => {}));
    const byDefault = createHumanResolver(ctx, workspace.config(), {}).resolve(DOUBT);
    clock.advance(300_000);
    expect(await byDefault).toEqual(UNRESOLVED);

    const { fetchImpl } = fakeFetch(() => json({ outcome: 'happened' }));
    const chained = createHumanResolver(ctx, withWebhook(workspace.config(), 45), {}, { fetchImpl }).resolve(DOUBT);
    clock.advance(45_000);
    expect(await chained).toEqual(byWebhook('happened'));
  });

  test('a client that never answers is told the question is withdrawn and the call is blocked', async () => {
    const { client, logs } = await startProxy(workspace, {
      capabilities: { elicitation: {} },
      humanResolver: (ctx) => createHumanResolver(ctx, workspace.config(), {}),
    });
    let asked: () => void = () => {};
    const question = new Promise<void>((wake) => {
      asked = wake;
    });
    let withdrawn: unknown;
    client.setRequestHandler(ElicitRequestSchema, (_request, extra) => {
      asked();
      return new Promise<ElicitResult>((settle) => {
        extra.signal.addEventListener('abort', () => {
          withdrawn = extra.signal.reason;
          settle({ action: 'accept', content: { agent_once_outcome: 'happened' } });
        });
      });
    });
    const first = await client.callTool({ name: 'charge', arguments: { amount: 10, fail: true } });
    const retry = client.callTool({ name: 'charge', arguments: { amount: 10, fail: true } });
    await question;
    workspace.clock.advance(300_000);
    expect(statusOf(await retry)).toEqual({ status: 'blocked', action_id: statusOf(first)?.action_id, class: 'money' });
    expect(String(withdrawn)).toContain('agent-once stopped waiting for an answer');
    expect((await stats(client)).count).toBe(1);
    expect(logs).toEqual([]);
  });

  test('elicitation failures are logged with the action id and error name only', async () => {
    const clock = new ManualClock(START_MS);
    const logs: string[] = [];
    let attempt = 0;
    const { ctx } = fakeContext(clock, { elicitation: {} }, () => {
      attempt += 1;
      return attempt === 1 ? Promise.reject(new TypeError('visa s3cret')) : new Promise(() => {});
    });
    const resolver = new ElicitationResolver(ctx, 60_000, (line) => logs.push(line));
    expect(await resolver.resolve(DOUBT)).toEqual(UNRESOLVED);
    const pending = resolver.resolve(DOUBT);
    clock.advance(60_000);
    expect(await pending).toEqual(UNRESOLVED);
    expect(logs).toEqual([
      `agent-once: the client gave no answer to the question about action ${DOUBT.actionId}: the request failed (TypeError)`,
      `agent-once: the client gave no answer to the question about action ${DOUBT.actionId}: no answer within 60 s`,
    ]);
  });

  test('a client cancel of the call withdraws the question and skips the webhook', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ outcome: 'happened' }));
    const config = withWebhook(workspace.config());
    let answered: Promise<HumanResolution> | undefined;
    const { client, logs } = await startProxy(workspace, {
      config,
      capabilities: { elicitation: {} },
      humanResolver: (ctx) => {
        const inner = createHumanResolver(ctx, config, {}, { fetchImpl });
        return {
          resolve: (doubt, signal) => {
            answered = inner.resolve(doubt, signal);
            return answered;
          },
        };
      },
    });
    let asked: () => void = () => {};
    const question = new Promise<void>((wake) => {
      asked = wake;
    });
    let withdrawn: unknown;
    client.setRequestHandler(ElicitRequestSchema, (_request, extra) => {
      asked();
      return new Promise<ElicitResult>((settle) => {
        extra.signal.addEventListener('abort', () => {
          withdrawn = extra.signal.reason;
          settle({ action: 'cancel' });
        });
      });
    });
    await client.callTool({ name: 'charge', arguments: { amount: 10, fail: true } });
    const controller = new AbortController();
    const retry = client.callTool({ name: 'charge', arguments: { amount: 10, fail: true } }, undefined, { signal: controller.signal });
    await question;
    controller.abort(new Error('user pressed stop'));
    await expect(retry).rejects.toThrow();
    expect(await answered).toEqual(UNRESOLVED);
    expect(String(withdrawn)).toContain('agent-once stopped waiting for an answer');
    expect(calls).toEqual([]);
    expect((await stats(client)).count).toBe(1);
    expect(logs.filter((line) => line.includes('no answer'))).toEqual([]);
  });

  test('decline falls back to the webhook', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ outcome: 'not_happened' }));
    const config = withWebhook(workspace.config());
    const { client, store } = await startProxy(workspace, {
      config,
      capabilities: { elicitation: {} },
      humanResolver: (ctx) => createHumanResolver(ctx, config, {}, { fetchImpl }),
    });
    let elicited = 0;
    client.setRequestHandler(ElicitRequestSchema, async (): Promise<ElicitResult> => {
      elicited += 1;
      return { action: 'decline' };
    });
    const first = await client.callTool({ name: 'charge', arguments: { amount: 10, fail: true } });
    workspace.clock.advance(10_000);
    const retry = await client.callTool({ name: 'charge', arguments: { amount: 10, fail: true } });
    expect(statusOf(retry)?.status).toBe('executed');
    expect(elicited).toBe(1);
    expect(calls).toHaveLength(1);
    const reconciled = store.findAction(statusOf(first)?.action_id ?? '');
    expect(reconciled?.state).toBe('reconciled');
    expect(reconciled?.detail).toMatchObject({ outcome: 'not_happened', resolved_by: 'webhook' });
    expect((await stats(client)).count).toBe(2);
  });
});

describe('approval webhook', () => {
  test('webhook signs the body and maps outcomes', async () => {
    const clock = new ManualClock(START_MS);
    const outcomes = ['happened', 'not_happened', 'unresolved'];
    let next = 0;
    const { fetchImpl, calls } = fakeFetch(() => json({ outcome: outcomes[next++] }));
    const resolver = new WebhookResolver({ url: HOOK_URL, timeoutSeconds: 30, secret: 's3cret' }, clock, fetchImpl);
    expect([await resolver.resolve(DOUBT), await resolver.resolve(DOUBT), await resolver.resolve(DOUBT)]).toEqual([byWebhook('happened'), byWebhook('not_happened'), UNRESOLVED]);

    const [call] = calls;
    expect(call?.url).toBe(HOOK_URL);
    expect(call?.init.method).toBe('POST');
    expect(call?.init.redirect).toBe('error');
    const body = String(call?.init.body);
    expect(JSON.parse(body)).toEqual({
      type: 'agent-once.approval_request',
      action_id: DOUBT.actionId,
      tool: 'charge',
      args: { amount: 10, card: 'visa' },
      class: 'money',
      reason: 'failed_block_on_doubt',
      since_ms: START_MS,
    });
    const headers = new Headers(call?.init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-agent-once-signature')).toBe(`sha256=${createHmac('sha256', 's3cret').update(body).digest('hex')}`);
  });

  test('a response body over 4 KiB is unresolved and one at the limit is read', async () => {
    const clock = new ManualClock(START_MS);
    const logs: string[] = [];
    const padded = (size: number) => {
      const base = JSON.stringify({ outcome: 'happened', pad: '' });
      return JSON.stringify({ outcome: 'happened', pad: 'x'.repeat(size - base.length) });
    };
    const bodies = [padded(4096), padded(4097)];
    let next = 0;
    const { fetchImpl } = fakeFetch(() => new Response(bodies[next++] ?? '', { status: 200 }));
    const resolver = new WebhookResolver({ url: HOOK_URL, timeoutSeconds: 30 }, clock, fetchImpl, (line) => logs.push(line));
    expect(await resolver.resolve(DOUBT)).toEqual(byWebhook('happened'));
    expect(await resolver.resolve(DOUBT)).toEqual(UNRESOLVED);
    expect(logs).toEqual([`agent-once: the approval webhook gave no usable answer for action ${DOUBT.actionId}: the response is larger than 4 KiB`]);
  });

  test('a cancelled call skips the webhook, and a cancel mid-request aborts it', async () => {
    const clock = new ManualClock(START_MS);
    const { fetchImpl, calls } = fakeFetch(() => json({ outcome: 'happened' }));
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await new WebhookResolver({ url: HOOK_URL, timeoutSeconds: 30 }, clock, fetchImpl).resolve(DOUBT, cancelled.signal)).toEqual(UNRESOLVED);
    expect(calls).toEqual([]);

    let signal: AbortSignal | undefined;
    const hanging = new WebhookResolver(
      { url: HOOK_URL, timeoutSeconds: 30 },
      clock,
      ((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise(() => {});
      }) as typeof fetch,
    );
    const midway = new AbortController();
    const pending = hanging.resolve(DOUBT, midway.signal);
    midway.abort();
    expect(await pending).toEqual(UNRESOLVED);
    expect(signal?.aborted).toBe(true);
  });

  test('without a secret the body is not signed', async () => {
    const { fetchImpl, calls } = fakeFetch(() => json({ outcome: 'happened' }));
    await new WebhookResolver({ url: HOOK_URL, timeoutSeconds: 30 }, new ManualClock(START_MS), fetchImpl).resolve(DOUBT);
    expect(new Headers(calls[0]?.init.headers).has('x-agent-once-signature')).toBe(false);
  });

  test('webhook non-200, bad JSON and timeout are unresolved', async () => {
    const clock = new ManualClock(START_MS);
    const logs: string[] = [];
    const replies: (() => Response)[] = [
      () => json({ outcome: 'happened' }, 201),
      () => json({ outcome: 'happened' }, 500),
      () => new Response('not json', { status: 200 }),
      () => json({ outcome: 'maybe' }),
      () => json(['happened']),
    ];
    let next = 0;
    const { fetchImpl } = fakeFetch(() => (replies[next++] ?? (() => json({})))());
    const resolver = new WebhookResolver({ url: HOOK_URL, timeoutSeconds: 30, secret: 's3cret' }, clock, fetchImpl, (line) => logs.push(line));
    for (let i = 0; i < replies.length; i += 1) expect(await resolver.resolve(DOUBT)).toEqual(UNRESOLVED);

    const failing = new WebhookResolver({ url: HOOK_URL, timeoutSeconds: 30 }, clock, (() => Promise.reject(new TypeError('fetch failed'))) as typeof fetch);
    expect(await failing.resolve(DOUBT)).toEqual(UNRESOLVED);

    let signal: AbortSignal | undefined;
    const hanging = new WebhookResolver(
      { url: HOOK_URL, timeoutSeconds: 30 },
      clock,
      ((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise(() => {});
      }) as typeof fetch,
      (line) => logs.push(line),
    );
    const pending = hanging.resolve(DOUBT);
    let settled: HumanResolution | undefined;
    void pending.then((answer) => {
      settled = answer;
    });
    clock.advance(29_999);
    await Promise.resolve();
    expect(settled).toBeUndefined();
    expect(signal?.aborted).toBe(false);
    clock.advance(1);
    expect(await pending).toEqual(UNRESOLVED);
    expect(signal?.aborted).toBe(true);

    expect(logs).toHaveLength(replies.length + 1);
    expect(logs.at(-1)).toContain('30 s');
    for (const line of logs) {
      expect(line).toContain(DOUBT.actionId);
      expect(line).not.toContain('s3cret');
      expect(line).not.toContain('visa');
    }
  });

  test('the secret comes from the environment variable the config names, and a missing one refuses to start', () => {
    const clock = new ManualClock(START_MS);
    const { ctx } = fakeContext(clock, {}, () => new Promise(() => {}));
    const config: AgentOnceConfig = { ...workspace.config(), approvalWebhook: { url: HOOK_URL, timeoutSeconds: 30, secretEnv: 'AO_SECRET' } };
    expect(() => createHumanResolver(ctx, config, {})).toThrow('approvalWebhook.secretEnv names AO_SECRET, but that environment variable is not set');
    expect(() => createHumanResolver(ctx, config, { AO_SECRET: 'from-env' })).not.toThrow();
  });

  test('the configured secret signs the request', async () => {
    const clock = new ManualClock(START_MS);
    const { ctx } = fakeContext(clock, {}, () => new Promise(() => {}));
    const { fetchImpl, calls } = fakeFetch(() => json({ outcome: 'happened' }));
    const config: AgentOnceConfig = { ...workspace.config(), approvalWebhook: { url: HOOK_URL, timeoutSeconds: 30, secretEnv: 'AO_SECRET' } };
    expect(await createHumanResolver(ctx, config, { AO_SECRET: 'from-env' }, { fetchImpl }).resolve(DOUBT)).toEqual(byWebhook('happened'));
    const body = String(calls[0]?.init.body);
    expect(new Headers(calls[0]?.init.headers).get('x-agent-once-signature')).toBe(`sha256=${createHmac('sha256', 'from-env').update(body).digest('hex')}`);
  });
});

describe('chain', () => {
  test('returns the first answer that is not unresolved and stops asking', async () => {
    const first = fixed(UNRESOLVED);
    const second = fixed(byWebhook('not_happened'));
    const third = fixed(byHuman('happened'));
    expect(await new ChainResolver([first, second, third]).resolve(DOUBT)).toEqual(byWebhook('not_happened'));
    expect([first.asked, second.asked, third.asked]).toEqual([1, 1, 0]);
  });

  test('a resolver that throws is skipped and an empty chain is unresolved', async () => {
    const throwing: HumanResolver = { resolve: () => Promise.reject(new Error('boom')) };
    expect(await new ChainResolver([throwing, fixed(byHuman('happened'))]).resolve(DOUBT)).toEqual(byHuman('happened'));
    expect(await new ChainResolver([]).resolve(DOUBT)).toEqual(UNRESOLVED);
  });

  test('passes the call signal to each resolver and stops once the call is cancelled', async () => {
    const controller = new AbortController();
    const first: HumanResolver = {
      resolve: async () => {
        controller.abort();
        return UNRESOLVED;
      },
    };
    const second = fixed(byWebhook('happened'));
    expect(await new ChainResolver([first, second]).resolve(DOUBT, controller.signal)).toEqual(UNRESOLVED);
    expect(second.asked).toBe(0);

    const live = new AbortController();
    const asked = fixed(byHuman('happened'));
    await new ChainResolver([asked]).resolve(DOUBT, live.signal);
    expect(asked.signals).toEqual([live.signal]);
  });
});

describe('blocked delivery', () => {
  test('blocked result stays blocked on every retry until resolved', async () => {
    const { client, store } = await startProxy(workspace, { humanResolver: (ctx) => createHumanResolver(ctx, workspace.config(), {}) });
    const first = await client.callTool({ name: 'charge', arguments: { amount: 10, fail: true } });
    const actionId = statusOf(first)?.action_id ?? '';
    for (const advance of [1_000, 60_000, 600_000]) {
      workspace.clock.advance(advance);
      const retry = await client.callTool({ name: 'charge', arguments: { amount: 10, fail: true } });
      expect(statusOf(retry)).toEqual({ status: 'blocked', action_id: actionId, class: 'money' });
      expect(textOf(retry)).toBe(BLOCKED_TEXT('charge', actionId, 'money'));
    }
    expect((await stats(client)).count).toBe(1);

    const person = new Guard({ store, clock: workspace.clock, runInstance: 'cli', evidence: { emit: () => {} } });
    expect(person.resolve(actionId, 'not_happened', 'human').ok).toBe(true);
    const after = await client.callTool({ name: 'charge', arguments: { amount: 10, fail: true } });
    expect(statusOf(after)?.status).toBe('executed');
    expect((await stats(client)).count).toBe(2);
  });

  test('agent_once_resolve is refused for money class with the blocked copy', async () => {
    const { client } = await startProxy(workspace);
    const first = await client.callTool({ name: 'charge', arguments: { amount: 10, fail: true } });
    const actionId = statusOf(first)?.action_id ?? '';
    await client.callTool({ name: 'charge', arguments: { amount: 10, fail: true } });
    const refused = await client.callTool({ name: 'agent_once_resolve', arguments: { action_id: actionId, outcome: 'happened' } });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toBe(BLOCKED_TEXT('charge', actionId, 'money'));
    expect(statusOf(refused)).toEqual({ status: 'blocked', action_id: actionId, class: 'money' });
    const retry = await client.callTool({ name: 'charge', arguments: { amount: 10, fail: true } });
    expect(statusOf(retry)?.status).toBe('blocked');
    expect((await stats(client)).count).toBe(1);
  });
});
