import { describe, expect, test, vi } from 'vitest';
import { CanonicalizationError } from '../src/canonical/jcs.js';
import { Guard, type GuardDeps } from '../src/guard/guard.js';
import { ActionInDoubtError, type DoubtInfo, type GuardResult, type HumanResolution } from '../src/guard/types.js';
import { actionId, intentHash } from '../src/identity/identity.js';
import { DEFAULT_VOLATILE_KEYS, projectArgs } from '../src/identity/project-args.js';
import { MemoryLedgerStore } from '../src/ledger/memory-store.js';
import type { LedgerStore } from '../src/ledger/types.js';
import { ManualClock } from '../src/time/clock.js';
import { RecordingSink, RecordingStore, START_MS, deferred, guardedCall, scripted } from './guard-harness.js';

const OK = { kind: 'ok', result: { ticket: 'T-1' } } as const;
const TRANSPORT = { kind: 'transport_error', error: 'upstream closed the connection' } as const;

function setup(options: Partial<Omit<GuardDeps, 'store' | 'clock' | 'evidence'>> = {}) {
  const clock = new ManualClock(START_MS);
  const ledger = new RecordingStore(new MemoryLedgerStore(clock));
  const evidence = new RecordingSink();
  const guard = new Guard({ store: ledger, clock, runInstance: 'run-1', evidence, ...options });
  return { clock, ledger, evidence, guard };
}

function expectStatus<S extends GuardResult['status']>(result: GuardResult, status: S): GuardResult & { status: S } {
  expect(result.status).toBe(status);
  return result as GuardResult & { status: S };
}

function humanAnswering(answer: HumanResolution): {
  resolve(doubt: DoubtInfo, signal?: AbortSignal): Promise<HumanResolution>;
  asked: DoubtInfo[];
  signals: (AbortSignal | undefined)[];
} {
  const asked: DoubtInfo[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  return {
    asked,
    signals,
    resolve: async (doubt, signal) => {
      asked.push(doubt);
      signals.push(signal);
      return answer;
    },
  };
}

const throwingStore: LedgerStore = {
  transact: () => {
    throw new Error('the ledger must not be touched');
  },
  findAction: () => {
    throw new Error('the ledger must not be touched');
  },
  listInDoubt: () => {
    throw new Error('the ledger must not be touched');
  },
  close: () => {},
};

describe('Guard.run', () => {
  test('executes a new action once and records intended, sent, confirmed', async () => {
    const { ledger, guard } = setup();
    const tool = scripted(OK);
    const call = guardedCall();
    const result = expectStatus(await guard.run(call, tool.execute), 'executed');
    const hash = intentHash({ sessionKey: call.sessionKey, tool: call.tool, projectedArgs: projectArgs(call.args, undefined, DEFAULT_VOLATILE_KEYS) });
    expect(result.actionId).toBe(actionId(hash, 0, START_MS));
    expect(result.outcome).toEqual(OK);
    expect(tool.calls).toEqual([result.actionId]);
    expect(tool.keys).toEqual([result.actionId]);
    expect(result.recorded).toBeUndefined();
    expect(ledger.states()).toEqual(['intended', 'sent', 'confirmed']);
    expect(ledger.last().detail).toEqual({ result: { ticket: 'T-1' }, result_truncated: false, delivery: 'delivered' });
    expect(ledger.last().argsJson).toBe('{"priority":2,"title":"Printer jam"}');
  });

  test('records the captured value on intended and sent', async () => {
    const { ledger, guard } = setup();
    const result = expectStatus(await guard.run(guardedCall({ captured: 'ORD-1001' }), scripted(OK).execute), 'executed');
    expect(ledger.appended.slice(0, 2).map((event) => event.detail)).toEqual([
      { captured: 'ORD-1001', idempotency_key: result.actionId ?? '' },
      { captured: 'ORD-1001', idempotency_key: result.actionId ?? '' },
    ]);
  });

  test('a failed outcome repeats the captured value so a later reconciler can read it', async () => {
    const { ledger, guard } = setup();
    const result = expectStatus(await guard.run(guardedCall({ captured: 'ORD-1001' }), scripted(TRANSPORT).execute), 'executed');
    expect(ledger.last().detail).toEqual({
      captured: 'ORD-1001',
      failure_kind: 'transport_error',
      error: TRANSPORT.error,
      result: null,
      idempotency_key: result.actionId ?? '',
    });
  });

  test('storeArgs false keeps args out of the ledger', async () => {
    const { ledger, guard } = setup({ storeArgs: false });
    await guard.run(guardedCall(), scripted(OK).execute);
    expect(ledger.appended.every((event) => event.argsJson === null)).toBe(true);
  });

  test('a retry after a transport error within the window is in doubt and does not dispatch', async () => {
    const { clock, ledger, guard } = setup();
    const tool = scripted(TRANSPORT, OK);
    const first = expectStatus(await guard.run(guardedCall(), tool.execute), 'executed');
    expect(first.outcome).toEqual(TRANSPORT);
    expect(ledger.last().detail).toEqual({ failure_kind: 'transport_error', error: 'upstream closed the connection', result: null, idempotency_key: first.actionId ?? '' });
    clock.advance(119_999);
    const second = expectStatus(await guard.run(guardedCall(), tool.execute), 'in_doubt');
    expect(second.doubt).toEqual({
      actionId: first.actionId,
      tool: 'create_ticket',
      args: { title: 'Printer jam', priority: 2 },
      toolClass: 'standard',
      reason: 'failed_within_window',
      sinceMs: START_MS,
    });
    expect(tool.calls).toHaveLength(1);
  });

  test('a retry after the window executes a new occurrence', async () => {
    const { clock, ledger, guard } = setup();
    const tool = scripted(TRANSPORT, OK);
    const first = expectStatus(await guard.run(guardedCall(), tool.execute), 'executed');
    clock.advance(120_000);
    const second = expectStatus(await guard.run(guardedCall(), tool.execute), 'executed');
    expect(second.actionId).not.toBe(first.actionId);
    expect(ledger.last()).toMatchObject({ occurrence: 1, state: 'confirmed' });
    expect(tool.calls).toHaveLength(2);
  });

  test('an error result is recorded as failed with its result', async () => {
    const { ledger, guard } = setup();
    const outcome = { kind: 'error_result', result: { isError: true, text: 'card declined' } } as const;
    const result = expectStatus(await guard.run(guardedCall(), scripted(outcome).execute), 'executed');
    expect(ledger.last().detail).toEqual({
      failure_kind: 'error_result',
      error: 'the tool returned an error result',
      result: outcome.result,
      idempotency_key: result.actionId ?? '',
    });
  });

  test('not_dispatched failure allows an immediate retry', async () => {
    const { ledger, guard } = setup();
    const tool = scripted({ kind: 'not_dispatched', error: 'stale element ref' }, OK);
    await guard.run(guardedCall(), tool.execute);
    const second = expectStatus(await guard.run(guardedCall(), tool.execute), 'executed');
    expect(second.outcome).toEqual(OK);
    expect(tool.calls).toHaveLength(2);
    expect(ledger.last().occurrence).toBe(1);
  });

  test('execute throwing is a transport error and the join map is released', async () => {
    const { ledger, guard } = setup();
    const result = expectStatus(
      await guard.run(guardedCall(), async () => {
        throw new Error('socket hang up');
      }),
      'executed',
    );
    expect(result.outcome).toEqual({ kind: 'transport_error', error: 'socket hang up' });
    expect(ledger.last().detail).toMatchObject({ failure_kind: 'transport_error', error: 'socket hang up' });
    const retry = await guard.run(guardedCall(), scripted(OK).execute);
    expect(retry.status).toBe('in_doubt');
  });

  test('reconciler happened turns doubt into a replay without dispatch', async () => {
    const { ledger, guard } = setup();
    const tool = scripted(TRANSPORT, OK);
    const first = expectStatus(await guard.run(guardedCall(), tool.execute), 'executed');
    const seen: string[] = [];
    const reconciler = async (ctx: { actionId: string }) => {
      seen.push(ctx.actionId);
      return { outcome: 'happened', result: { ticket: 'T-9' } } as const;
    };
    const second = expectStatus(await guard.run(guardedCall({ reconciler }), tool.execute), 'replayed');
    expect(second).toEqual({ status: 'replayed', actionId: first.actionId, result: { ticket: 'T-9' }, resultTruncated: false, reason: 'replay_undelivered' });
    expect(seen).toEqual([first.actionId]);
    expect(tool.calls).toHaveLength(1);
    expect(ledger.last().detail).toEqual({ outcome: 'happened', resolved_by: 'reconciler', result: { ticket: 'T-9' }, result_truncated: false });
  });

  test('reconciler not_happened before the settle window is treated as unknown', async () => {
    const { clock, ledger, evidence, guard } = setup();
    const tool = scripted(TRANSPORT, OK);
    await guard.run(guardedCall(), tool.execute);
    clock.advance(9_999);
    const reconciler = async () => ({ outcome: 'not_happened' }) as const;
    const second = expectStatus(await guard.run(guardedCall({ reconciler }), tool.execute), 'in_doubt');
    expect(second.doubt.reason).toBe('failed_within_window');
    expect(tool.calls).toHaveLength(1);
    expect(ledger.states()).toEqual(['intended', 'sent', 'failed']);
    expect(evidence.ofKind('reconcile').at(-1)?.detail).toEqual({ outcome: 'unknown', reason: 'too_soon' });
  });

  test('reconciler not_happened after the settle window dispatches once', async () => {
    const { clock, ledger, guard } = setup();
    const tool = scripted(TRANSPORT, OK);
    await guard.run(guardedCall(), tool.execute);
    clock.advance(10_000);
    const reconciler = async () => ({ outcome: 'not_happened' }) as const;
    const second = expectStatus(await guard.run(guardedCall({ reconciler }), tool.execute), 'executed');
    expect(second.outcome).toEqual(OK);
    expect(tool.calls).toHaveLength(2);
    expect(ledger.states()).toEqual(['intended', 'sent', 'failed', 'reconciled', 'intended', 'sent', 'confirmed']);
    expect(ledger.appended[3]?.detail).toEqual({ outcome: 'not_happened', resolved_by: 'reconciler', result: null, result_truncated: false });
    expect(ledger.last().occurrence).toBe(1);
  });

  test('reconciler not_happened with retryByAgent records it and hands the retry back without dispatch', async () => {
    const { clock, ledger, guard } = setup();
    const tool = scripted(TRANSPORT, OK);
    const first = expectStatus(await guard.run(guardedCall(), tool.execute), 'executed');
    clock.advance(10_000);
    const reconciler = async () => ({ outcome: 'not_happened', retryByAgent: true }) as const;
    const second = await guard.run(guardedCall({ reconciler }), tool.execute);
    expect(second).toEqual({ status: 'retry_by_agent', actionId: first.actionId });
    expect(tool.calls).toHaveLength(1);
    expect(ledger.states()).toEqual(['intended', 'sent', 'failed', 'reconciled']);
    const third = expectStatus(await guard.run(guardedCall({ reconciler }), tool.execute), 'executed');
    expect(third.outcome).toEqual(OK);
    expect(ledger.last().occurrence).toBe(1);
  });

  test('a retryByAgent not_happened inside the settle window stays in doubt', async () => {
    const { clock, guard } = setup();
    const tool = scripted(TRANSPORT, OK);
    await guard.run(guardedCall(), tool.execute);
    clock.advance(9_999);
    const reconciler = async () => ({ outcome: 'not_happened', retryByAgent: true }) as const;
    expect((await guard.run(guardedCall({ reconciler }), tool.execute)).status).toBe('in_doubt');
  });

  test('a reconciler that throws is treated as unknown', async () => {
    const { guard } = setup();
    const tool = scripted(TRANSPORT, OK);
    await guard.run(guardedCall(), tool.execute);
    const reconciler = async () => {
      throw new Error('status endpoint down');
    };
    expect((await guard.run(guardedCall({ reconciler }), tool.execute)).status).toBe('in_doubt');
    expect(tool.calls).toHaveLength(1);
  });

  test('a failed action past the window asks the reconciler before repeating', async () => {
    const { clock, guard } = setup();
    const tool = scripted(TRANSPORT, OK);
    await guard.run(guardedCall(), tool.execute);
    clock.advance(120_000);
    const reconciler = async () => ({ outcome: 'happened', result: { ticket: 'T-1' } }) as const;
    expect((await guard.run(guardedCall({ reconciler }), tool.execute)).status).toBe('replayed');
    expect(tool.calls).toHaveLength(1);
  });

  test('a failed action past the window repeats when the reconciler cannot tell', async () => {
    const { clock, guard } = setup();
    const tool = scripted(TRANSPORT, OK);
    await guard.run(guardedCall(), tool.execute);
    clock.advance(120_000);
    const reconciler = async () => ({ outcome: 'unknown', reason: 'no status endpoint' }) as const;
    expect((await guard.run(guardedCall({ reconciler }), tool.execute)).status).toBe('executed');
    expect(tool.calls).toHaveLength(2);
  });

  test('block-on-doubt asks the human resolver and blocks when unresolved', async () => {
    const human = humanAnswering({ outcome: 'unresolved' });
    const { guard } = setup({ humanResolver: human });
    const call = guardedCall({ policy: 'block-on-doubt', toolClass: 'money' });
    const tool = scripted(TRANSPORT, OK);
    const first = expectStatus(await guard.run(call, tool.execute), 'executed');
    const second = expectStatus(await guard.run(call, tool.execute), 'blocked');
    expect(second.doubt).toMatchObject({ actionId: first.actionId, toolClass: 'money', reason: 'failed_block_on_doubt' });
    expect(human.asked).toEqual([second.doubt]);
    expect(tool.calls).toHaveLength(1);
  });

  test('block-on-doubt without a human resolver blocks', async () => {
    const { guard } = setup();
    const call = guardedCall({ policy: 'block-on-doubt', toolClass: 'money' });
    const tool = scripted(TRANSPORT, OK);
    await guard.run(call, tool.execute);
    expect((await guard.run(call, tool.execute)).status).toBe('blocked');
  });

  test('human happened replays and records reconciled by human', async () => {
    const { ledger, guard } = setup({ humanResolver: humanAnswering({ outcome: 'happened', by: 'human' }) });
    const call = guardedCall({ policy: 'block-on-doubt', toolClass: 'irreversible' });
    const tool = scripted(TRANSPORT, OK);
    const first = expectStatus(await guard.run(call, tool.execute), 'executed');
    const second = expectStatus(await guard.run(call, tool.execute), 'replayed');
    expect(second).toMatchObject({ actionId: first.actionId, result: null, resultTruncated: false });
    expect(ledger.last().detail).toEqual({ outcome: 'happened', resolved_by: 'human', result: null, result_truncated: false });
    expect(tool.calls).toHaveLength(1);
  });

  test('a webhook answer is recorded as resolved by the webhook and the resolver gets the call signal', async () => {
    const human = humanAnswering({ outcome: 'happened', by: 'webhook' });
    const { ledger, guard } = setup({ humanResolver: human });
    const controller = new AbortController();
    const call = guardedCall({ policy: 'block-on-doubt', toolClass: 'money', signal: controller.signal });
    const tool = scripted(TRANSPORT, OK);
    await guard.run(call, tool.execute);
    expect((await guard.run(call, tool.execute)).status).toBe('replayed');
    expect(ledger.last().detail).toMatchObject({ outcome: 'happened', resolved_by: 'webhook' });
    expect(human.signals).toEqual([controller.signal]);
  });

  test('a malformed human answer blocks', async () => {
    const { guard } = setup({ humanResolver: { resolve: async () => ({ outcome: 'happened', by: 'agent' }) as unknown as HumanResolution } });
    const call = guardedCall({ policy: 'block-on-doubt', toolClass: 'money' });
    const tool = scripted(TRANSPORT, OK);
    await guard.run(call, tool.execute);
    expect((await guard.run(call, tool.execute)).status).toBe('blocked');
  });

  test('human not_happened executes the next occurrence', async () => {
    const { guard } = setup({ humanResolver: humanAnswering({ outcome: 'not_happened', by: 'human' }) });
    const call = guardedCall({ policy: 'block-on-doubt', toolClass: 'money' });
    const tool = scripted(TRANSPORT, OK);
    await guard.run(call, tool.execute);
    expect((await guard.run(call, tool.execute)).status).toBe('executed');
    expect(tool.calls).toHaveLength(2);
  });

  test('two concurrent identical runs dispatch once and both get the outcome', async () => {
    const { ledger, guard } = setup();
    const gate = deferred<void>();
    let dispatched = 0;
    const execute = async () => {
      dispatched += 1;
      await gate.promise;
      return OK;
    };
    const first = guard.run(guardedCall(), execute);
    const second = guard.run(guardedCall(), execute);
    gate.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(dispatched).toBe(1);
    expect(a).toEqual(b);
    expect(expectStatus(a, 'executed').outcome).toEqual(OK);
    expect(ledger.states()).toEqual(['intended', 'sent', 'confirmed']);
  });

  test('a call aborted by the client records delivery cancelled and the retry replays', async () => {
    const { ledger, guard } = setup();
    const controller = new AbortController();
    const tool = scripted(OK);
    const first = await guard.run(guardedCall({ signal: controller.signal }), async (context) => {
      controller.abort();
      return tool.execute(context);
    });
    expect(first.status).toBe('executed');
    expect(ledger.last().detail).toMatchObject({ delivery: 'cancelled' });
    const retry = expectStatus(await guard.run(guardedCall(), tool.execute), 'replayed');
    expect(retry).toMatchObject({ result: { ticket: 'T-1' }, reason: 'replay_undelivered' });
    expect(tool.calls).toHaveLength(1);
  });

  test('pass policy dispatches without touching the ledger', async () => {
    const clock = new ManualClock(START_MS);
    const guard = new Guard({ store: throwingStore, clock, runInstance: 'run-1', evidence: new RecordingSink() });
    const tool = scripted(OK);
    const result = await guard.run(guardedCall({ policy: 'pass' }), tool.execute);
    expect(result).toEqual({ status: 'passed', outcome: OK });
    expect(tool.calls).toEqual([undefined]);
  });

  test('a result over maxResultBytes is stored truncated and the replay reports resultTruncated', async () => {
    const { ledger, guard } = setup({ maxResultBytes: 64 });
    const big = { kind: 'ok', result: { image: 'x'.repeat(100) } } as const;
    const call = guardedCall({ intentKey: 'screenshot-1' });
    const first = expectStatus(await guard.run(call, scripted(big).execute), 'executed');
    expect(first.outcome).toEqual(big);
    expect(ledger.last().detail).toEqual({ result: null, result_truncated: true, delivery: 'delivered' });
    const replay = expectStatus(await guard.run(call, scripted(OK).execute), 'replayed');
    expect(replay).toMatchObject({ result: null, resultTruncated: true, reason: 'replay_explicit_intent' });
  });

  test('a result exactly at maxResultBytes is kept', async () => {
    const { ledger, guard } = setup({ maxResultBytes: 13 });
    await guard.run(guardedCall(), scripted({ kind: 'ok', result: { a: 'xxxxx' } }).execute);
    expect(ledger.last().detail).toMatchObject({ result: { a: 'xxxxx' }, result_truncated: false });
  });

  test('non-finite args return ledger-free error without dispatch', async () => {
    const { ledger, guard } = setup();
    const tool = scripted(OK);
    await expect(guard.run(guardedCall({ args: { amount: Number.NaN } }), tool.execute)).rejects.toBeInstanceOf(CanonicalizationError);
    await expect(guard.run(guardedCall({ args: { nested: { ts: Number.POSITIVE_INFINITY } } }), tool.execute)).rejects.toBeInstanceOf(
      CanonicalizationError,
    );
    expect(tool.calls).toHaveLength(0);
    expect(ledger.transactionCount).toBe(0);
  });

  test('store throwing LedgerUnavailableError returns ledger_unavailable without dispatch', async () => {
    const clock = new ManualClock(START_MS);
    const store = new MemoryLedgerStore(clock);
    store.close();
    const guard = new Guard({ store, clock, runInstance: 'run-1', evidence: new RecordingSink() });
    const tool = scripted(OK);
    const result = expectStatus(await guard.run(guardedCall(), tool.execute), 'ledger_unavailable');
    expect(result.error).toBe('agent-once ledger unavailable: the ledger is closed');
    expect(tool.calls).toHaveLength(0);
  });

  test('a resolution that lands between claim and send is honoured', async () => {
    const { ledger, guard } = setup();
    const tool = scripted(OK);
    ledger.beforeTransact = () => {
      const intended = ledger.appended.find((event) => event.state === 'intended');
      if (intended === undefined || ledger.transactionCount !== 2) return;
      ledger.inner.transact((tx) =>
        tx.append({ ...intended, state: 'reconciled', detail: { outcome: 'not_happened', resolved_by: 'human', result: null } }),
      );
    };
    const result = expectStatus(await guard.run(guardedCall(), tool.execute), 'executed');
    expect(tool.calls).toEqual([result.actionId]);
    expect(ledger.last()).toMatchObject({ occurrence: 1, state: 'confirmed' });
  });

  test('the outcome is returned when recording it fails, and the action stays in doubt', async () => {
    const { ledger, guard } = setup();
    const tool = scripted(OK);
    ledger.beforeTransact = () => {
      if (ledger.transactionCount === 3) throw new (class extends Error {})('disk full');
    };
    await expect(guard.run(guardedCall(), tool.execute)).resolves.toMatchObject({ status: 'executed', outcome: OK, recorded: false });
    ledger.beforeTransact = undefined;
    expect((await guard.run(guardedCall(), tool.execute)).status).toBe('in_doubt');
    expect(tool.calls).toHaveLength(1);
  });

  test('a failing evidence sink never loses the outcome', async () => {
    const clock = new ManualClock(START_MS);
    const evidence = {
      emit: () => {
        throw new Error('evidence disk full');
      },
    };
    const guard = new Guard({ store: new MemoryLedgerStore(clock), clock, runInstance: 'run-1', evidence, onEvidenceError: () => {} });
    expect(await guard.run(guardedCall(), scripted(OK).execute)).toMatchObject({ status: 'executed', outcome: OK });
  });

  test('emits decision and state evidence with v 1', async () => {
    const { evidence, guard } = setup();
    const result = expectStatus(await guard.run(guardedCall(), scripted(OK).execute), 'executed');
    expect(evidence.events.map((event) => [event.kind, event.detail.decision ?? event.detail.state])).toEqual([
      ['decision', 'execute'],
      ['state', 'intended'],
      ['state', 'sent'],
      ['state', 'confirmed'],
    ]);
    expect(evidence.events[0]).toEqual({
      v: 1,
      atMs: START_MS,
      kind: 'decision',
      actionId: result.actionId,
      tool: 'create_ticket',
      sessionKey: 'client:/work',
      detail: { decision: 'execute', reason: 'new', occurrence: 0 },
    });
  });
});

describe('Guard abandoned outcome', () => {
  test('an abandoned dispatch writes nothing after sent, emits evidence and clears the in-flight join', async () => {
    const { ledger, guard, evidence } = setup();
    const call = guardedCall();
    const first = expectStatus(await guard.run(call, async () => ({ kind: 'abandoned' })), 'executed');
    expect(first.outcome).toEqual({ kind: 'abandoned' });
    expect(ledger.states()).toEqual(['intended', 'sent']);
    expect(evidence.ofKind('state').map((event) => event.detail.state)).toEqual(['intended', 'sent', 'abandoned']);
    const tool = scripted(OK);
    const retry = expectStatus(await guard.run(call, tool.execute), 'in_doubt');
    expect(retry.doubt.actionId).toBe(first.actionId);
    expect(tool.calls).toEqual([]);
  });
});

describe('Guard.resolve', () => {
  async function inDoubt(toolClass: 'money' | 'irreversible' | 'standard') {
    const context = setup();
    const first = expectStatus(await context.guard.run(guardedCall({ toolClass, tool: `tool_${toolClass}` }), scripted(TRANSPORT).execute), 'executed');
    return { ...context, id: first.actionId ?? '' };
  }

  test('resolve by agent refuses money and irreversible classes', async () => {
    for (const toolClass of ['money', 'irreversible'] as const) {
      const { guard, clock, id } = await inDoubt(toolClass);
      clock.advance(10_000);
      const refusal = { ok: false, reason: 'agent_cannot_resolve_class', event: { actionId: id, toolClass } };
      expect(guard.resolve(id, 'happened', 'agent')).toMatchObject(refusal);
      expect(guard.resolve(id, 'not_happened', 'agent')).toMatchObject(refusal);
      expect(guard.resolve(id, 'happened', 'human').ok).toBe(true);
    }
  });

  test('resolve by agent happened is accepted for standard actions and the next call replays', async () => {
    const { guard, id, evidence } = await inDoubt('standard');
    const resolved = guard.resolve(id, 'happened', 'agent');
    expect(resolved).toMatchObject({ ok: true, event: { state: 'reconciled', detail: { outcome: 'happened', resolved_by: 'agent', result: null, result_truncated: false } } });
    expect(evidence.ofKind('resolve').at(-1)?.detail).toEqual({ outcome: 'happened', by: 'agent', ok: true });
    const tool = scripted(OK);
    expect((await guard.run(guardedCall({ tool: 'tool_standard' }), tool.execute)).status).toBe('replayed');
    expect(tool.calls).toHaveLength(0);
  });

  test('resolve not_happened by agent inside the settle window is refused as too_soon', async () => {
    const { guard, clock, id } = await inDoubt('standard');
    clock.advance(9_999);
    expect(guard.resolve(id, 'not_happened', 'agent')).toEqual({ ok: false, reason: 'too_soon' });
    clock.advance(1);
    expect(guard.resolve(id, 'not_happened', 'agent').ok).toBe(true);
    const tool = scripted(OK);
    expect((await guard.run(guardedCall({ tool: 'tool_standard' }), tool.execute)).status).toBe('executed');
    expect(tool.calls).toHaveLength(1);
  });

  test('humans and webhooks resolve not_happened at once', async () => {
    const { guard, id } = await inDoubt('money');
    expect(guard.resolve(id, 'not_happened', 'webhook').ok).toBe(true);
  });

  test('unknown and settled actions are refused', async () => {
    const { guard, id } = await inDoubt('standard');
    expect(guard.resolve('ao_000000000000000000000000', 'happened', 'human')).toEqual({ ok: false, reason: 'unknown_action' });
    expect(guard.resolve(id, 'happened', 'human').ok).toBe(true);
    expect(guard.resolve(id, 'happened', 'human')).toEqual({ ok: false, reason: 'not_in_doubt' });
  });

  test('a not_dispatched failure is not in doubt', async () => {
    const { guard } = setup();
    const first = expectStatus(await guard.run(guardedCall(), scripted({ kind: 'not_dispatched', error: 'stale ref' }).execute), 'executed');
    expect(guard.resolve(first.actionId ?? '', 'happened', 'human')).toEqual({ ok: false, reason: 'not_in_doubt' });
  });
});

describe('Guard.wrap', () => {
  test('wrap returns the result and replays without calling again', async () => {
    const { guard } = setup();
    let calls = 0;
    const create = guard.wrap({ tool: 'create_ticket', sessionKey: 's', sessionExplicit: false, intentKey: 'k', policy: 'guard', toolClass: 'standard' }, async (args: { title: string }) => {
      calls += 1;
      return { ticket: args.title };
    });
    expect(await create({ title: 'a' })).toEqual({ ticket: 'a' });
    expect(await create({ title: 'a' })).toEqual({ ticket: 'a' });
    expect(calls).toBe(1);
  });

  test('wrap throws ActionInDoubtError when in doubt', async () => {
    const { guard } = setup();
    const failure = new Error('socket hang up');
    const meta = { tool: 'create_ticket', sessionKey: 's', sessionExplicit: false, policy: 'guard', toolClass: 'standard' } as const;
    const create = guard.wrap(meta, async (_args: { title: string }) => {
      throw failure;
    });
    await expect(create({ title: 'a' })).rejects.toBe(failure);
    const error = await create({ title: 'a' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ActionInDoubtError);
    expect((error as ActionInDoubtError).blocked).toBe(false);
    expect((error as ActionInDoubtError).doubt.reason).toBe('failed_within_window');
    const blockedCall = guard.wrap({ ...meta, tool: 'pay', policy: 'block-on-doubt', toolClass: 'money' }, async (_args: { n: number }) => {
      throw failure;
    });
    await expect(blockedCall({ n: 1 })).rejects.toBe(failure);
    await expect(blockedCall({ n: 1 })).rejects.toMatchObject({ blocked: true });
  });
});

describe('Guard with two processes on one ledger', () => {
  function twoGuards() {
    const clock = new ManualClock(START_MS);
    const store = new RecordingStore(new MemoryLedgerStore(clock));
    const a = new Guard({ store, clock, runInstance: 'proc-a', evidence: new RecordingSink() });
    const b = new Guard({ store, clock, runInstance: 'proc-b', evidence: new RecordingSink() });
    return { clock, store, a, b };
  }

  test('a late failed outcome never overwrites a resolution made meanwhile', async () => {
    const { clock, store, a, b } = twoGuards();
    const call = guardedCall({ sessionExplicit: true });
    let effects = 0;
    const gate = deferred<void>();
    const inFlight = a.run(call, async () => {
      effects += 1;
      await gate.promise;
      return TRANSPORT;
    });
    clock.advance(15_000);
    const doubt = expectStatus(await b.run(call, scripted(OK).execute), 'in_doubt');
    expect(b.resolve(doubt.doubt.actionId, 'happened', 'agent').ok).toBe(true);
    gate.resolve();
    expect((await inFlight).status).toBe('executed');
    expect(store.last()).toMatchObject({ state: 'reconciled', detail: { outcome: 'happened' } });
    clock.advance(120_000);
    const late = await a.run(call, async () => {
      effects += 1;
      return OK;
    });
    expect(late.status).toBe('replayed');
    expect(effects).toBe(1);
  });

  test('a slow human answer never becomes a repeat when another process resolved meanwhile', async () => {
    const clock = new ManualClock(START_MS);
    const store = new MemoryLedgerStore(clock);
    const answer = deferred<HumanResolution>();
    const a = new Guard({ store, clock, runInstance: 'proc-a', evidence: new RecordingSink() });
    const b = new Guard({ store, clock, runInstance: 'proc-b', evidence: new RecordingSink(), humanResolver: { resolve: () => answer.promise } });
    const call = guardedCall({ policy: 'block-on-doubt', toolClass: 'money' });
    const tool = scripted(TRANSPORT, OK);
    const first = expectStatus(await a.run(call, tool.execute), 'executed');
    clock.advance(1_000);
    const waiting = b.run(call, tool.execute);
    expect(a.resolve(first.actionId ?? '', 'happened', 'human').ok).toBe(true);
    clock.advance(200_000);
    answer.resolve({ outcome: 'happened', by: 'human' });
    expect((await waiting).status).toBe('replayed');
    expect(tool.calls).toHaveLength(1);
  });

  test('a late confirmed outcome is always recorded', async () => {
    const { clock, store, a, b } = twoGuards();
    const call = guardedCall({ sessionExplicit: true });
    const gate = deferred<void>();
    const inFlight = a.run(call, async () => {
      await gate.promise;
      return OK;
    });
    clock.advance(15_000);
    const doubt = expectStatus(await b.run(call, scripted(OK).execute), 'in_doubt');
    expect(b.resolve(doubt.doubt.actionId, 'happened', 'agent').ok).toBe(true);
    gate.resolve();
    await inFlight;
    expect(store.last()).toMatchObject({ state: 'confirmed', detail: { result: { ticket: 'T-1' } } });
  });
});

describe('Guard review fixes', () => {
  test('a reconciled result over maxResultBytes replays as truncated', async () => {
    const { ledger, guard } = setup({ maxResultBytes: 64 });
    const tool = scripted(TRANSPORT, OK);
    await guard.run(guardedCall(), tool.execute);
    const reconciler = async () => ({ outcome: 'happened', result: { image: 'x'.repeat(100) } }) as const;
    const replay = expectStatus(await guard.run(guardedCall({ reconciler }), tool.execute), 'replayed');
    expect(replay).toMatchObject({ result: null, resultTruncated: true });
    expect(ledger.last().detail).toEqual({ outcome: 'happened', resolved_by: 'reconciler', result: null, result_truncated: true });
  });

  test('a result that cannot be canonicalized is recorded as a result error, not truncated', async () => {
    const { ledger, guard } = setup();
    const outcome = { kind: 'ok', result: { ratio: Number.NaN } } as const;
    const result = expectStatus(await guard.run(guardedCall(), scripted(outcome).execute), 'executed');
    expect(result.outcome).toBe(outcome);
    expect(ledger.last().detail).toEqual({
      result: null,
      result_truncated: false,
      result_error: 'cannot canonicalize the non-finite number NaN at $.ratio',
      delivery: 'delivered',
    });
  });

  test('evidence sink failures reach onEvidenceError', async () => {
    const clock = new ManualClock(START_MS);
    const failure = new Error('evidence disk full');
    const seen: Array<{ error: unknown; kind: string }> = [];
    const guard = new Guard({
      store: new MemoryLedgerStore(clock),
      clock,
      runInstance: 'run-1',
      evidence: {
        emit: () => {
          throw failure;
        },
      },
      onEvidenceError: (error, event) => {
        seen.push({ error, kind: event.kind });
      },
    });
    expect(await guard.run(guardedCall(), scripted(OK).execute)).toMatchObject({ status: 'executed', outcome: OK });
    expect(seen.map((entry) => entry.kind)).toEqual(['decision', 'state', 'state', 'state']);
    expect(seen.every((entry) => entry.error === failure)).toBe(true);
  });

  test('evidence sink failures go to stderr by default', async () => {
    const clock = new ManualClock(START_MS);
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const evidence = {
        emit: () => {
          throw new Error('evidence disk full');
        },
      };
      const guard = new Guard({ store: new MemoryLedgerStore(clock), clock, runInstance: 'run-1', evidence });
      await guard.run(guardedCall(), scripted(OK).execute);
      expect(write).toHaveBeenCalledWith('agent-once: evidence sink failed: evidence disk full\n');
    } finally {
      write.mockRestore();
    }
  });

  test('a late retry after the window reuses the idempotency key', async () => {
    const { clock, guard } = setup();
    const tool = scripted(TRANSPORT, TRANSPORT, OK);
    const first = expectStatus(await guard.run(guardedCall(), tool.execute), 'executed');
    clock.advance(120_000);
    await guard.run(guardedCall(), tool.execute);
    clock.advance(120_000);
    await guard.run(guardedCall(), tool.execute);
    expect(new Set(tool.calls).size).toBe(3);
    expect(tool.keys).toEqual([first.actionId, first.actionId, first.actionId]);
  });

  test('the sent event of a late retry repeats the inherited idempotency key for a later reconciler', async () => {
    const { clock, ledger, guard } = setup();
    const first = expectStatus(await guard.run(guardedCall(), scripted(TRANSPORT).execute), 'executed');
    clock.advance(120_000);
    const reconciler = async () => ({ outcome: 'unknown', reason: 'no status endpoint' }) as const;
    const hanging = deferred<{ kind: 'abandoned' }>();
    const dispatched = deferred<undefined>();
    const retry = guard.run(guardedCall({ reconciler }), () => {
      dispatched.resolve(undefined);
      return hanging.promise;
    });
    await dispatched.promise;
    const sent = ledger.last();
    expect(sent.occurrence).toBe(1);
    expect(sent.actionId).not.toBe(first.actionId);
    expect(sent.detail).toEqual({ idempotency_key: first.actionId ?? '' });
    hanging.resolve({ kind: 'abandoned' });
    await retry;
  });

  test('a retry after not_dispatched reuses the idempotency key', async () => {
    const { guard } = setup();
    const tool = scripted({ kind: 'not_dispatched', error: 'stale ref' }, OK);
    const first = expectStatus(await guard.run(guardedCall(), tool.execute), 'executed');
    await guard.run(guardedCall(), tool.execute);
    expect(tool.keys).toEqual([first.actionId, first.actionId]);
  });

  test('a late retry the reconciler cannot settle reuses the idempotency key', async () => {
    const { clock, guard } = setup();
    const tool = scripted(TRANSPORT, OK);
    const first = expectStatus(await guard.run(guardedCall(), tool.execute), 'executed');
    clock.advance(120_000);
    const reconciler = async () => ({ outcome: 'unknown', reason: 'no status endpoint' }) as const;
    await guard.run(guardedCall({ reconciler }), tool.execute);
    expect(tool.keys).toEqual([first.actionId, first.actionId]);
  });

  test('a deliberate repeat and a reconciled not_happened get a fresh idempotency key', async () => {
    const { clock, guard } = setup();
    const tool = scripted(OK, TRANSPORT, OK);
    await guard.run(guardedCall(), tool.execute);
    await guard.run(guardedCall(), tool.execute);
    clock.advance(10_000);
    await guard.run(guardedCall({ reconciler: async () => ({ outcome: 'not_happened' }) }), tool.execute);
    expect(tool.keys).toEqual(tool.calls);
    expect(new Set(tool.keys).size).toBe(3);
  });

  test('a settle window longer than the retry window is rejected', () => {
    const clock = new ManualClock(START_MS);
    expect(
      () => new Guard({ store: new MemoryLedgerStore(clock), clock, runInstance: 'run-1', evidence: new RecordingSink(), retryWindowMs: 5_000, settleWindowMs: 5_001 }),
    ).toThrow(RangeError);
  });

  test('resolve reports an unavailable ledger as a result', () => {
    const clock = new ManualClock(START_MS);
    const store = new MemoryLedgerStore(clock);
    store.close();
    const guard = new Guard({ store, clock, runInstance: 'run-1', evidence: new RecordingSink() });
    expect(guard.resolve('ao_000000000000000000000000', 'happened', 'human')).toEqual({
      ok: false,
      reason: 'ledger_unavailable',
      error: 'agent-once ledger unavailable: the ledger is closed',
    });
  });
});
