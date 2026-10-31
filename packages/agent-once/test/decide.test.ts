import { describe, expect, test } from 'vitest';
import type { JsonValue } from '../src/canonical/jcs.js';
import { decide } from '../src/guard/decide.js';
import type { GuardPolicy, LedgerEvent, LedgerState } from '../src/ledger/types.js';
import { loadVectors } from './vectors.js';

interface DecisionVector {
  name: string;
  now_ms: number;
  retry_window_ms: number;
  expiry_ms: number;
  latest: null | {
    state: LedgerState;
    occurrence: number;
    at_ms: number;
    expires_at_ms: number;
    run_instance: string;
    detail: Record<string, JsonValue>;
  };
  call: { run_instance: string; session_explicit: boolean; intent_key_explicit: boolean; policy: GuardPolicy };
  expect: { kind: 'execute' | 'replay' | 'in_doubt'; occurrence: number; reason: string };
}

const vectors = loadVectors<DecisionVector>('decisions.json');

function toEvent(vector: DecisionVector): LedgerEvent | undefined {
  const latest = vector.latest;
  if (latest === null) return undefined;
  return {
    seq: 7,
    actionId: 'ao_000000000000000000000007',
    intentHash: 'b'.repeat(64),
    occurrence: latest.occurrence,
    state: latest.state,
    atMs: latest.at_ms,
    expiresAtMs: latest.expires_at_ms,
    sessionKey: 'client:/work',
    sessionExplicit: vector.call.session_explicit,
    intentKeyExplicit: vector.call.intent_key_explicit,
    runInstance: latest.run_instance,
    tool: 'place_order',
    toolClass: 'money',
    policy: vector.call.policy,
    argsJson: null,
    detail: latest.detail,
  };
}

describe('decide matches every decision vector', () => {
  test('the vector file covers every decision kind', () => {
    const kinds = new Set(vectors.map((vector) => vector.expect.kind));
    expect([...kinds].sort()).toEqual(['execute', 'in_doubt', 'replay']);
  });

  for (const vector of vectors) {
    test(vector.name, () => {
      const latest = toEvent(vector);
      const decision = decide({
        latest,
        nowMs: vector.now_ms,
        retryWindowMs: vector.retry_window_ms,
        call: {
          runInstance: vector.call.run_instance,
          sessionExplicit: vector.call.session_explicit,
          intentKeyExplicit: vector.call.intent_key_explicit,
          policy: vector.call.policy,
        },
      });
      expect(decision.kind).toBe(vector.expect.kind);
      expect(decision.reason).toBe(vector.expect.reason);
      const occurrence = decision.kind === 'execute' ? decision.occurrence : decision.event.occurrence;
      expect(occurrence).toBe(vector.expect.occurrence);
      if (decision.kind !== 'execute') expect(decision.event).toBe(latest);
    });
  }
});
