import type { GuardPolicy, LedgerEvent } from '../ledger/types.js';

export type Decision =
  | { kind: 'execute'; occurrence: number; reason: string }
  | { kind: 'replay'; event: LedgerEvent; reason: string }
  | { kind: 'in_doubt'; event: LedgerEvent; reason: string };

export interface DecisionCall {
  runInstance: string;
  sessionExplicit: boolean;
  intentKeyExplicit: boolean;
  policy: GuardPolicy;
}

export interface DecisionInput {
  latest: LedgerEvent | undefined;
  nowMs: number;
  retryWindowMs: number;
  call: DecisionCall;
}

function execute(occurrence: number, reason: string): Decision {
  return { kind: 'execute', occurrence, reason };
}

function decideFailed(latest: LedgerEvent, withinWindow: boolean, call: DecisionCall): Decision {
  if (latest.detail.failure_kind === 'not_dispatched') return execute(latest.occurrence + 1, 'not_dispatched');
  if (call.policy === 'block-on-doubt') return { kind: 'in_doubt', event: latest, reason: 'failed_block_on_doubt' };
  if (withinWindow) return { kind: 'in_doubt', event: latest, reason: 'failed_within_window' };
  return execute(latest.occurrence + 1, 'failed_after_window');
}

function decideHappened(latest: LedgerEvent, withinWindow: boolean, call: DecisionCall): Decision {
  const replay = (reason: string): Decision => ({ kind: 'replay', event: latest, reason });
  if (call.intentKeyExplicit) return replay('replay_explicit_intent');
  const undelivered = latest.state === 'reconciled' || latest.detail.delivery === 'cancelled';
  if (undelivered && withinWindow) return replay('replay_undelivered');
  const otherRun = latest.runInstance !== call.runInstance;
  if (otherRun && call.sessionExplicit) return replay('replay_rerun_explicit_session');
  if (otherRun && withinWindow) return replay('replay_rerun_within_window');
  return execute(latest.occurrence + 1, 'deliberate_repeat');
}

export function decide(input: DecisionInput): Decision {
  const { latest, nowMs, retryWindowMs, call } = input;
  if (latest === undefined) return execute(0, 'new');
  if (latest.expiresAtMs <= nowMs) return execute(latest.occurrence + 1, 'expired');
  const withinWindow = nowMs < latest.atMs + retryWindowMs;
  switch (latest.state) {
    case 'intended':
    case 'sent':
      return { kind: 'in_doubt', event: latest, reason: 'outcome_unknown' };
    case 'failed':
      return decideFailed(latest, withinWindow, call);
    case 'confirmed':
      return decideHappened(latest, withinWindow, call);
    case 'reconciled':
      if (latest.detail.outcome === 'not_happened') return execute(latest.occurrence + 1, 'reconciled_not_happened');
      return decideHappened(latest, withinWindow, call);
  }
}
