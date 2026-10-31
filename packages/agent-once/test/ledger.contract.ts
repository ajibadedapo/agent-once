import { afterEach, describe, expect, test } from 'vitest';
import { LedgerConflictError, LedgerUnavailableError, LedgerUsageError } from '../src/ledger/errors.js';
import type { LedgerStore, NewLedgerEvent } from '../src/ledger/types.js';
import { ManualClock } from '../src/time/clock.js';

export const START_MS = 1_761_912_345_678;
export const EXPIRY_MS = 86_400_000;

export function newEvent(overrides: Partial<NewLedgerEvent> = {}): NewLedgerEvent {
  const atMs = overrides.atMs ?? START_MS;
  return {
    actionId: 'ao_000000000000000000000001',
    intentHash: 'a'.repeat(64),
    occurrence: 0,
    state: 'intended',
    atMs,
    expiresAtMs: atMs + EXPIRY_MS,
    sessionKey: 'client:/work',
    sessionExplicit: false,
    intentKeyExplicit: false,
    runInstance: 'run-1',
    tool: 'pay_invoice',
    toolClass: 'money',
    policy: 'block-on-doubt',
    argsJson: '{"amount":12}',
    detail: {},
    ...overrides,
  };
}

export interface StoreHarness {
  open(clock: ManualClock): LedgerStore;
  cleanup(): void;
}

export function ledgerContract(name: string, makeHarness: () => StoreHarness): void {
  describe(`${name} ledger contract`, () => {
    let harness: StoreHarness | undefined;
    let store: LedgerStore | undefined;

    function openStore(clock = new ManualClock(START_MS)): LedgerStore {
      harness = makeHarness();
      store = harness.open(clock);
      return store;
    }

    afterEach(() => {
      store?.close();
      harness?.cleanup();
      store = undefined;
      harness = undefined;
    });

    test("latest returns the highest occurrence's newest event", () => {
      const ledger = openStore();
      ledger.transact((tx) => {
        tx.append(newEvent({ occurrence: 0, state: 'intended', actionId: 'ao_a0' }));
        tx.append(newEvent({ occurrence: 0, state: 'sent', actionId: 'ao_a0', atMs: START_MS + 1 }));
        tx.append(newEvent({ occurrence: 0, state: 'confirmed', actionId: 'ao_a0', atMs: START_MS + 2 }));
        tx.append(newEvent({ occurrence: 1, state: 'intended', actionId: 'ao_a1', atMs: START_MS + 3 }));
        tx.append(newEvent({ occurrence: 1, state: 'sent', actionId: 'ao_a1', atMs: START_MS + 4 }));
        tx.append(newEvent({ intentHash: 'b'.repeat(64), occurrence: 5, state: 'intended', actionId: 'ao_b5', atMs: START_MS + 5 }));
      });
      const latest = ledger.transact((tx) => tx.latest('a'.repeat(64)));
      expect(latest).toMatchObject({ occurrence: 1, state: 'sent', actionId: 'ao_a1', atMs: START_MS + 4 });
      expect(ledger.transact((tx) => tx.latest('c'.repeat(64)))).toBeUndefined();
    });

    test('latest still returns an expired latest event so decide moves to the next occurrence instead of reusing one', () => {
      const clock = new ManualClock(START_MS);
      const ledger = openStore(clock);
      ledger.transact((tx) => {
        tx.append(newEvent({ occurrence: 0, state: 'intended', actionId: 'ao_a0', expiresAtMs: START_MS + 10 }));
        tx.append(newEvent({ occurrence: 0, state: 'failed', actionId: 'ao_a0', atMs: START_MS + 1, expiresAtMs: START_MS + 11 }));
      });
      clock.advance(1_000);
      const latest = ledger.transact((tx) => tx.latest('a'.repeat(64)));
      expect(latest).toMatchObject({ occurrence: 0, state: 'failed', expiresAtMs: START_MS + 11 });
      expect(() => ledger.transact((tx) => tx.append(newEvent({ occurrence: 0, actionId: 'ao_reused', atMs: clock.nowMs() })))).toThrow(
        LedgerConflictError,
      );
    });

    test('append is visible to latest in the same transaction', () => {
      const ledger = openStore();
      const seen = ledger.transact((tx) => {
        const before = tx.latest('a'.repeat(64));
        const appended = tx.append(newEvent());
        return { before, appended, after: tx.latest('a'.repeat(64)) };
      });
      expect(seen.before).toBeUndefined();
      expect(seen.after).toEqual(seen.appended);
      expect(seen.appended.seq).toBeGreaterThan(0);
    });

    test('appends get increasing seq numbers', () => {
      const ledger = openStore();
      const [first, second] = ledger.transact((tx) => [
        tx.append(newEvent()),
        tx.append(newEvent({ state: 'sent', atMs: START_MS + 1 })),
      ]);
      expect(second!.seq).toBeGreaterThan(first!.seq);
    });

    test('a second intended for the same intent and occurrence throws', () => {
      const ledger = openStore();
      ledger.transact((tx) => tx.append(newEvent()));
      expect(() => ledger.transact((tx) => tx.append(newEvent({ actionId: 'ao_other', atMs: START_MS + 7 })))).toThrow(
        LedgerConflictError,
      );
      ledger.transact((tx) => tx.append(newEvent({ occurrence: 1, actionId: 'ao_next' })));
      ledger.transact((tx) => tx.append(newEvent({ state: 'sent' })));
    });

    test('a throwing transaction rolls back its appends', () => {
      const ledger = openStore();
      expect(() =>
        ledger.transact((tx) => {
          tx.append(newEvent());
          throw new Error('decide failed');
        }),
      ).toThrow('decide failed');
      expect(ledger.transact((tx) => tx.latest('a'.repeat(64)))).toBeUndefined();
      expect(ledger.findAction('ao_000000000000000000000001')).toBeUndefined();
    });

    test('a nested transact is rejected with LedgerUsageError and the outer transaction rolls back', () => {
      const ledger = openStore();
      let nestedError: unknown;
      expect(() =>
        ledger.transact((tx) => {
          tx.append(newEvent());
          try {
            ledger.transact((inner) => inner.latest('a'.repeat(64)));
          } catch (error) {
            nestedError = error;
          }
          throw nestedError;
        }),
      ).toThrow(LedgerUsageError);
      expect(nestedError).toBeInstanceOf(LedgerUsageError);
      expect(nestedError).not.toBeInstanceOf(LedgerUnavailableError);
      expect(ledger.findAction('ao_000000000000000000000001')).toBeUndefined();
      expect(ledger.transact((tx) => tx.append(newEvent())).state).toBe('intended');
    });

    test.each([
      ['a promise', () => Promise.resolve('late')],
      ['a custom thenable', () => ({ then: () => undefined })],
    ])('a callback returning %s is rejected with a TypeError after rolling back', (_label, makeResult) => {
      const ledger = openStore();
      expect(() =>
        ledger.transact((tx) => {
          tx.append(newEvent());
          return makeResult();
        }),
      ).toThrow(TypeError);
      expect(ledger.findAction('ao_000000000000000000000001')).toBeUndefined();
      expect(ledger.transact((tx) => tx.append(newEvent())).state).toBe('intended');
    });

    test('findAction returns the newest event for an action id', () => {
      const ledger = openStore();
      ledger.transact((tx) => {
        tx.append(newEvent({ actionId: 'ao_x' }));
        tx.append(newEvent({ actionId: 'ao_x', state: 'sent', atMs: START_MS + 1 }));
        tx.append(newEvent({ actionId: 'ao_y', occurrence: 1, atMs: START_MS + 2 }));
      });
      expect(ledger.findAction('ao_x')).toMatchObject({ actionId: 'ao_x', state: 'sent', atMs: START_MS + 1 });
      expect(ledger.findAction('ao_y')).toMatchObject({ actionId: 'ao_y', state: 'intended', occurrence: 1 });
      expect(ledger.findAction('ao_missing')).toBeUndefined();
    });

    test('listInDoubt returns the unexpired latest event of each intent that resolve would accept', () => {
      const ledger = openStore();
      const now = START_MS + 1_000;
      ledger.transact((tx) => {
        tx.append(newEvent({ intentHash: '1'.repeat(64), actionId: 'ao_intended' }));
        tx.append(newEvent({ intentHash: '2'.repeat(64), actionId: 'ao_sent' }));
        tx.append(newEvent({ intentHash: '2'.repeat(64), actionId: 'ao_sent', state: 'sent', atMs: START_MS + 1 }));
        tx.append(newEvent({ intentHash: '3'.repeat(64), actionId: 'ao_done' }));
        tx.append(newEvent({ intentHash: '3'.repeat(64), actionId: 'ao_done', state: 'sent', atMs: START_MS + 2 }));
        tx.append(
          newEvent({
            intentHash: '3'.repeat(64),
            actionId: 'ao_done',
            state: 'confirmed',
            atMs: START_MS + 3,
            detail: { result: null, result_truncated: false, delivery: 'delivered' },
          }),
        );
        tx.append(newEvent({ intentHash: '4'.repeat(64), actionId: 'ao_expired', expiresAtMs: now }));
        const failed = (actionId: string, intentHash: string, failureKind: string, occurrence = 0) =>
          newEvent({ intentHash, actionId, occurrence, state: 'failed', atMs: START_MS + 4, detail: { failure_kind: failureKind, error: 'HTTP 504', result: null } });
        tx.append(newEvent({ intentHash: '5'.repeat(64), actionId: 'ao_failed' }));
        tx.append(failed('ao_failed', '5'.repeat(64), 'error_result'));
        tx.append(newEvent({ intentHash: '6'.repeat(64), actionId: 'ao_not_dispatched' }));
        tx.append(failed('ao_not_dispatched', '6'.repeat(64), 'not_dispatched'));
        tx.append(newEvent({ intentHash: '7'.repeat(64), actionId: 'ao_superseded' }));
        tx.append(failed('ao_superseded', '7'.repeat(64), 'transport_error'));
        tx.append(newEvent({ intentHash: '7'.repeat(64), actionId: 'ao_retry', occurrence: 1, atMs: START_MS + 5 }));
        tx.append(
          newEvent({
            intentHash: '7'.repeat(64),
            actionId: 'ao_retry',
            occurrence: 1,
            state: 'confirmed',
            atMs: START_MS + 6,
            detail: { result: null, result_truncated: false, delivery: 'delivered' },
          }),
        );
      });
      const inDoubt = ledger.listInDoubt(now);
      expect(inDoubt.map((event) => [event.actionId, event.state])).toEqual([
        ['ao_intended', 'intended'],
        ['ao_sent', 'sent'],
        ['ao_failed', 'failed'],
      ]);
    });

    test('events round-trip every field', () => {
      const ledger = openStore();
      const input = newEvent({
        sessionExplicit: true,
        intentKeyExplicit: true,
        toolClass: 'irreversible',
        policy: 'guard',
        argsJson: null,
        state: 'reconciled',
        detail: { outcome: 'happened', resolved_by: 'human', result: { ok: true, ids: [1, 2.5, 'x'] } },
      });
      const stored = ledger.transact((tx) => tx.append(input));
      expect(stored).toEqual({ ...input, seq: stored.seq });
      expect(ledger.findAction(input.actionId)).toEqual(stored);
    });

    test('a stored event is not changed by mutating the appended input', () => {
      const ledger = openStore();
      const input = newEvent({ detail: { captured: 'ORD-1' } });
      ledger.transact((tx) => tx.append(input));
      input.detail['captured'] = 'ORD-2';
      expect(ledger.findAction(input.actionId)?.detail).toEqual({ captured: 'ORD-1' });
    });
  });
}
