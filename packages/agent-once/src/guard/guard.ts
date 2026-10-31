import { canonicalize, type JsonValue } from '../canonical/jcs.js';
import type { EvidenceKind, EvidenceSink } from '../evidence/types.js';
import { actionId as deriveActionId, intentHash } from '../identity/identity.js';
import { DEFAULT_VOLATILE_KEYS, projectArgs } from '../identity/project-args.js';
import { LedgerConflictError, LedgerUnavailableError } from '../ledger/errors.js';
import type { GuardPolicy, LedgerEvent, LedgerState, LedgerStore, LedgerTx, NewLedgerEvent } from '../ledger/types.js';
import type { Clock } from '../time/clock.js';
import { decide } from './decide.js';
import { DEFAULT_MAX_RESULT_BYTES, capResult } from './result-cap.js';
import {
  ActionInDoubtError,
  GuardedCallFailedError,
  type DoubtInfo,
  type Execute,
  type ExecuteContext,
  type GuardResult,
  type GuardedCall,
  type HumanResolution,
  type HumanResolver,
  type ReconcileOutcome,
  type ResolveResult,
  type ResolvedBy,
  type ToolOutcome,
} from './types.js';

export const DEFAULT_RETRY_WINDOW_MS = 120_000;
export const DEFAULT_EXPIRY_MS = 86_400_000;
export const DEFAULT_SETTLE_WINDOW_MS = 10_000;

const ERROR_RESULT_MESSAGE = 'the tool returned an error result';

export interface GuardDeps {
  store: LedgerStore;
  clock: Clock;
  runInstance: string;
  evidence: EvidenceSink;
  humanResolver?: HumanResolver;
  retryWindowMs?: number;
  expiryMs?: number;
  settleWindowMs?: number;
  storeArgs?: boolean;
  maxResultBytes?: number;
}

type ProtectedCall = GuardedCall & { policy: GuardPolicy };

interface Identity {
  hash: string;
  argsJson: string | null;
}

type Claim =
  | { kind: 'execute'; intended: LedgerEvent; reason: string }
  | { kind: 'verify'; event: LedgerEvent; reason: string }
  | { kind: 'replay'; event: LedgerEvent; reason: string }
  | { kind: 'in_doubt'; event: LedgerEvent; reason: string };

const DECIDE_AGAIN = Symbol('decide again');
type Step = GuardResult | typeof DECIDE_AGAIN;

interface EvidenceSubject {
  actionId?: string;
  tool: string;
  sessionKey: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isProtected(call: GuardedCall): call is ProtectedCall {
  return call.policy !== 'pass';
}

function unavailable(error: LedgerUnavailableError): GuardResult {
  return { status: 'ledger_unavailable', error: error.message };
}

async function invoke(execute: Execute, context: ExecuteContext): Promise<ToolOutcome> {
  try {
    return await execute(context);
  } catch (error) {
    return { kind: 'transport_error', error: errorMessage(error) };
  }
}

function capturedDetail(call: GuardedCall): Record<string, JsonValue> {
  return call.captured === undefined ? {} : { captured: call.captured };
}

function isUnresolved(event: LedgerEvent, nowMs: number): boolean {
  if (event.expiresAtMs <= nowMs) return false;
  if (event.state === 'intended' || event.state === 'sent') return true;
  return event.state === 'failed' && event.detail.failure_kind !== 'not_dispatched';
}

function replayed(event: LedgerEvent, reason: string): GuardResult {
  return {
    status: 'replayed',
    actionId: event.actionId,
    result: event.detail.result ?? null,
    resultTruncated: event.detail.result_truncated === true,
    reason,
  };
}

function isReconcileOutcome(value: unknown): value is ReconcileOutcome {
  if (typeof value !== 'object' || value === null || !('outcome' in value)) return false;
  return value.outcome === 'happened' || value.outcome === 'not_happened' || value.outcome === 'unknown';
}

export class Guard {
  private readonly store: LedgerStore;
  private readonly clock: Clock;
  private readonly runInstance: string;
  private readonly evidence: EvidenceSink;
  private readonly humanResolver: HumanResolver | undefined;
  private readonly retryWindowMs: number;
  private readonly expiryMs: number;
  private readonly settleWindowMs: number;
  private readonly storeArgs: boolean;
  private readonly maxResultBytes: number;
  private readonly inFlight = new Map<string, Promise<GuardResult>>();

  constructor(deps: GuardDeps) {
    this.store = deps.store;
    this.clock = deps.clock;
    this.runInstance = deps.runInstance;
    this.evidence = deps.evidence;
    this.humanResolver = deps.humanResolver;
    this.retryWindowMs = deps.retryWindowMs ?? DEFAULT_RETRY_WINDOW_MS;
    this.expiryMs = deps.expiryMs ?? DEFAULT_EXPIRY_MS;
    this.settleWindowMs = deps.settleWindowMs ?? DEFAULT_SETTLE_WINDOW_MS;
    this.storeArgs = deps.storeArgs ?? true;
    this.maxResultBytes = deps.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES;
  }

  async run(call: GuardedCall, execute: Execute): Promise<GuardResult> {
    if (!isProtected(call)) return { status: 'passed', outcome: await invoke(execute, {}) };
    const identity = this.identify(call);
    const joined = this.inFlight.get(identity.hash);
    if (joined !== undefined) return joined;
    const pending = this.runProtected(call, identity, execute);
    this.inFlight.set(identity.hash, pending);
    try {
      return await pending;
    } finally {
      this.inFlight.delete(identity.hash);
    }
  }

  resolve(actionId: string, outcome: 'happened' | 'not_happened', by: ResolvedBy): ResolveResult {
    const found = this.store.findAction(actionId);
    if (found === undefined) return { ok: false, reason: 'unknown_action' };
    const result = this.store.transact((tx): ResolveResult => {
      const latest = tx.latest(found.intentHash);
      const nowMs = this.clock.nowMs();
      if (latest === undefined || latest.actionId !== actionId || !isUnresolved(latest, nowMs)) return { ok: false, reason: 'not_in_doubt' };
      if (by === 'agent' && latest.toolClass !== 'standard') return { ok: false, reason: 'agent_cannot_resolve_class' };
      if (by === 'agent' && outcome === 'not_happened' && nowMs - latest.atMs < this.settleWindowMs) return { ok: false, reason: 'too_soon' };
      return { ok: true, event: tx.append(this.followUp(latest, 'reconciled', { outcome, resolved_by: by, result: null })) };
    });
    this.emit(found, 'resolve', result.ok ? { outcome, by, ok: true } : { outcome, by, ok: false, reason: result.reason });
    if (result.ok) this.emitState(result.event);
    return result;
  }

  wrap<A extends Record<string, unknown>, R extends JsonValue>(meta: Omit<GuardedCall, 'args'>, fn: (args: A) => Promise<R>): (args: A) => Promise<R> {
    return async (args) => {
      let thrown: { error: unknown } | undefined;
      const result = await this.run({ ...meta, args }, async () => {
        try {
          return { kind: 'ok', result: await fn(args) };
        } catch (error) {
          thrown = { error };
          return { kind: 'transport_error', error: errorMessage(error) };
        }
      });
      switch (result.status) {
        case 'executed':
        case 'passed':
          if (result.outcome.kind === 'ok') return result.outcome.result as R;
          if (thrown !== undefined) throw thrown.error;
          throw new GuardedCallFailedError(result.outcome.kind === 'error_result' ? ERROR_RESULT_MESSAGE : result.outcome.error);
        case 'replayed':
          return result.result as R;
        case 'in_doubt':
          throw new ActionInDoubtError(result.doubt, false);
        case 'blocked':
          throw new ActionInDoubtError(result.doubt, true);
        case 'ledger_unavailable':
          throw new GuardedCallFailedError(result.error);
      }
    };
  }

  private identify(call: ProtectedCall): Identity {
    const argsJson = canonicalize(call.args);
    const projectedArgs = projectArgs(call.args, call.identityRule, call.volatileKeys ?? DEFAULT_VOLATILE_KEYS, call.extraIdentity);
    const hash = intentHash({ sessionKey: call.sessionKey, tool: call.tool, projectedArgs, intentKey: call.intentKey });
    return { hash, argsJson: this.storeArgs ? argsJson : null };
  }

  private async runProtected(call: ProtectedCall, identity: Identity, execute: Execute): Promise<GuardResult> {
    let verifiedSeq: number | undefined;
    for (;;) {
      let claim: Claim;
      try {
        claim = this.store.transact((tx) => this.decideAndClaim(tx, call, identity, verifiedSeq));
      } catch (error) {
        if (error instanceof LedgerConflictError) continue;
        if (error instanceof LedgerUnavailableError) return unavailable(error);
        throw error;
      }
      this.emitDecision(call, claim);
      let step: Step;
      switch (claim.kind) {
        case 'execute':
          this.emitState(claim.intended);
          step = await this.dispatch(call, claim.intended, execute);
          break;
        case 'replay':
          return replayed(claim.event, claim.reason);
        case 'in_doubt':
          step = await this.handleDoubt(call, claim.event, claim.reason);
          break;
        case 'verify': {
          const outcome = await this.reconcile(call, claim.event);
          if (outcome.outcome === 'unknown') verifiedSeq = claim.event.seq;
          step = outcome.outcome === 'unknown' ? DECIDE_AGAIN : this.recordResolution(claim.event, outcome, 'reconciler');
          break;
        }
      }
      if (step !== DECIDE_AGAIN) return step;
    }
  }

  private decideAndClaim(tx: LedgerTx, call: ProtectedCall, identity: Identity, verifiedSeq: number | undefined): Claim {
    const latest = tx.latest(identity.hash);
    const nowMs = this.clock.nowMs();
    const decision = decide({
      latest,
      nowMs,
      retryWindowMs: this.retryWindowMs,
      call: { runInstance: this.runInstance, sessionExplicit: call.sessionExplicit, intentKeyExplicit: call.intentKey !== undefined, policy: call.policy },
    });
    if (decision.kind !== 'execute') return decision;
    const needsVerification = decision.reason === 'failed_after_window' && call.reconciler !== undefined;
    if (latest !== undefined && needsVerification && latest.seq !== verifiedSeq) return { kind: 'verify', event: latest, reason: decision.reason };
    const intended = tx.append({
      actionId: deriveActionId(identity.hash, decision.occurrence, nowMs),
      intentHash: identity.hash,
      occurrence: decision.occurrence,
      state: 'intended',
      atMs: nowMs,
      expiresAtMs: nowMs + this.expiryMs,
      sessionKey: call.sessionKey,
      sessionExplicit: call.sessionExplicit,
      intentKeyExplicit: call.intentKey !== undefined,
      runInstance: this.runInstance,
      tool: call.tool,
      toolClass: call.toolClass,
      policy: call.policy,
      argsJson: identity.argsJson,
      detail: capturedDetail(call),
    });
    return { kind: 'execute', intended, reason: decision.reason };
  }

  private async dispatch(call: ProtectedCall, intended: LedgerEvent, execute: Execute): Promise<Step> {
    let sent: LedgerEvent | typeof DECIDE_AGAIN;
    try {
      sent = this.appendIfLatest(intended, 'sent', capturedDetail(call));
    } catch (error) {
      if (error instanceof LedgerUnavailableError) return unavailable(error);
      throw error;
    }
    if (sent === DECIDE_AGAIN) return DECIDE_AGAIN;
    this.emitState(sent);
    const outcome = await invoke(execute, { actionId: intended.actionId });
    this.recordOutcome(call, sent, outcome);
    return { status: 'executed', actionId: intended.actionId, outcome };
  }

  private recordOutcome(call: ProtectedCall, sent: LedgerEvent, outcome: ToolOutcome): void {
    const state = outcome.kind === 'ok' ? 'confirmed' : 'failed';
    try {
      const recorded = this.store.transact((tx) => tx.append(this.followUp(sent, state, this.outcomeDetail(call, outcome))));
      this.emitState(recorded);
    } catch (error) {
      this.emit(sent, 'state', { state: 'unrecorded', occurrence: sent.occurrence, outcome: outcome.kind, error: errorMessage(error) });
    }
  }

  private outcomeDetail(call: ProtectedCall, outcome: ToolOutcome): Record<string, JsonValue> {
    switch (outcome.kind) {
      case 'ok': {
        const capped = capResult(outcome.result, this.maxResultBytes);
        const delivery = call.signal?.aborted === true ? 'cancelled' : 'delivered';
        return { result: capped.result, result_truncated: capped.truncated, delivery };
      }
      case 'error_result':
        return { failure_kind: 'error_result', error: ERROR_RESULT_MESSAGE, result: capResult(outcome.result, this.maxResultBytes).result };
      case 'transport_error':
      case 'not_dispatched':
        return { failure_kind: outcome.kind, error: outcome.error, result: null };
    }
  }

  private async handleDoubt(call: ProtectedCall, event: LedgerEvent, reason: string): Promise<Step> {
    const doubt: DoubtInfo = { actionId: event.actionId, tool: call.tool, args: call.args, toolClass: call.toolClass, reason, sinceMs: event.atMs };
    if (call.reconciler !== undefined) {
      const outcome = await this.reconcile(call, event);
      if (outcome.outcome !== 'unknown') return this.recordResolution(event, outcome, 'reconciler');
    }
    if (call.policy === 'guard') return { status: 'in_doubt', doubt };
    const answer = await this.askHuman(doubt);
    if (answer === 'unresolved') return { status: 'blocked', doubt };
    return this.recordResolution(event, { outcome: answer }, 'human');
  }

  private async reconcile(call: ProtectedCall, event: LedgerEvent): Promise<ReconcileOutcome> {
    let outcome: ReconcileOutcome;
    try {
      const answer: unknown = await call.reconciler?.({ tool: call.tool, args: call.args, actionId: event.actionId, event });
      outcome = isReconcileOutcome(answer) ? answer : { outcome: 'unknown', reason: 'invalid reconciler outcome' };
    } catch (error) {
      outcome = { outcome: 'unknown', reason: `reconciler failed: ${errorMessage(error)}` };
    }
    if (outcome.outcome === 'not_happened' && this.clock.nowMs() - event.atMs < this.settleWindowMs) {
      outcome = { outcome: 'unknown', reason: 'too_soon' };
    }
    this.emit(event, 'reconcile', outcome.outcome === 'unknown' ? { outcome: 'unknown', reason: outcome.reason } : { outcome: outcome.outcome });
    return outcome;
  }

  private async askHuman(doubt: DoubtInfo): Promise<HumanResolution> {
    if (this.humanResolver === undefined) return 'unresolved';
    try {
      const answer = await this.humanResolver.resolve(doubt);
      return answer === 'happened' || answer === 'not_happened' ? answer : 'unresolved';
    } catch {
      return 'unresolved';
    }
  }

  private recordResolution(
    event: LedgerEvent,
    outcome: { outcome: 'happened'; result?: JsonValue } | { outcome: 'not_happened' },
    by: 'reconciler' | 'human',
  ): Step {
    const result = outcome.outcome === 'happened' && outcome.result !== undefined ? capResult(outcome.result, this.maxResultBytes).result : null;
    try {
      const appended = this.appendIfLatest(event, 'reconciled', { outcome: outcome.outcome, resolved_by: by, result });
      if (appended !== DECIDE_AGAIN) this.emitState(appended);
      return DECIDE_AGAIN;
    } catch (error) {
      if (error instanceof LedgerUnavailableError) return unavailable(error);
      throw error;
    }
  }

  private appendIfLatest(basis: LedgerEvent, state: LedgerState, detail: Record<string, JsonValue>): LedgerEvent | typeof DECIDE_AGAIN {
    return this.store.transact((tx) => {
      if (tx.latest(basis.intentHash)?.seq !== basis.seq) return DECIDE_AGAIN;
      return tx.append(this.followUp(basis, state, detail));
    });
  }

  private followUp(basis: LedgerEvent, state: LedgerState, detail: Record<string, JsonValue>): NewLedgerEvent {
    const atMs = this.clock.nowMs();
    return {
      actionId: basis.actionId,
      intentHash: basis.intentHash,
      occurrence: basis.occurrence,
      state,
      atMs,
      expiresAtMs: atMs + this.expiryMs,
      sessionKey: basis.sessionKey,
      sessionExplicit: basis.sessionExplicit,
      intentKeyExplicit: basis.intentKeyExplicit,
      runInstance: this.runInstance,
      tool: basis.tool,
      toolClass: basis.toolClass,
      policy: basis.policy,
      argsJson: basis.argsJson,
      detail,
    };
  }

  private emitDecision(call: ProtectedCall, claim: Claim): void {
    const event = claim.kind === 'execute' ? claim.intended : claim.event;
    this.emit({ actionId: event.actionId, tool: call.tool, sessionKey: call.sessionKey }, 'decision', {
      decision: claim.kind,
      reason: claim.reason,
      occurrence: event.occurrence,
    });
  }

  private emitState(event: LedgerEvent): void {
    const summary = Object.fromEntries(Object.entries(event.detail).filter(([key]) => key !== 'result' && key !== 'captured'));
    this.emit(event, 'state', { state: event.state, occurrence: event.occurrence, ...summary });
  }

  private emit(subject: EvidenceSubject, kind: EvidenceKind, detail: Record<string, JsonValue>): void {
    try {
      this.evidence.emit({
        v: 1,
        atMs: this.clock.nowMs(),
        kind,
        ...(subject.actionId === undefined ? {} : { actionId: subject.actionId }),
        tool: subject.tool,
        sessionKey: subject.sessionKey,
        detail,
      });
    } catch {
      return;
    }
  }
}
