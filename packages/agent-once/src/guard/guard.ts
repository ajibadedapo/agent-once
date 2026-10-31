import { canonicalize, type JsonValue } from '../canonical/jcs.js';
import type { EvidenceEvent, EvidenceKind, EvidenceSink } from '../evidence/types.js';
import { actionId as deriveActionId, intentHash } from '../identity/identity.js';
import { DEFAULT_VOLATILE_KEYS, projectArgs } from '../identity/project-args.js';
import { LedgerConflictError, LedgerUnavailableError } from '../ledger/errors.js';
import type { GuardPolicy, LedgerEvent, LedgerState, LedgerStore, LedgerTx, NewLedgerEvent } from '../ledger/types.js';
import type { Clock } from '../time/clock.js';
import { decide } from './decide.js';
import { DEFAULT_MAX_RESULT_BYTES, storedResultDetail } from './result-cap.js';
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
const ABANDONED_MESSAGE = 'the call was abandoned before its outcome was known';

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
  onEvidenceError?: (error: unknown, event: EvidenceEvent) => void;
}

type ProtectedCall = GuardedCall & { policy: GuardPolicy };
type RecordableOutcome = Exclude<ToolOutcome, { kind: 'abandoned' }>;

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

interface Resolution {
  event: LedgerEvent;
  outcome: 'happened' | 'not_happened';
  by: 'reconciler' | 'human' | 'webhook';
  result?: JsonValue;
  retryByAgent?: true;
}

const INHERITED_KEY_REASONS: ReadonlySet<string> = new Set(['failed_after_window', 'not_dispatched']);

interface EvidenceSubject {
  actionId?: string;
  tool: string;
  sessionKey: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportToStderr(error: unknown): void {
  process.stderr.write(`agent-once: evidence sink failed: ${errorMessage(error)}\n`);
}

function idempotencyKeyOf(event: LedgerEvent): string {
  const key = event.detail.idempotency_key;
  return typeof key === 'string' ? key : event.actionId;
}

function failureMessage(outcome: Exclude<ToolOutcome, { kind: 'ok' }>): string {
  switch (outcome.kind) {
    case 'error_result':
      return ERROR_RESULT_MESSAGE;
    case 'abandoned':
      return ABANDONED_MESSAGE;
    case 'transport_error':
    case 'not_dispatched':
      return outcome.error;
  }
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

const UNRESOLVED: HumanResolution = { outcome: 'unresolved' };

function isHumanAnswer(value: unknown): value is { outcome: 'happened' | 'not_happened'; by: 'human' | 'webhook' } {
  if (typeof value !== 'object' || value === null) return false;
  const { outcome, by } = value as { outcome?: unknown; by?: unknown };
  return (outcome === 'happened' || outcome === 'not_happened') && (by === 'human' || by === 'webhook');
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
  private readonly onEvidenceError: (error: unknown, event: EvidenceEvent) => void;
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
    this.onEvidenceError = deps.onEvidenceError ?? reportToStderr;
    if (this.settleWindowMs > this.retryWindowMs) {
      throw new RangeError(`settleWindowMs (${this.settleWindowMs}) must not exceed retryWindowMs (${this.retryWindowMs})`);
    }
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
    try {
      return this.resolveInLedger(actionId, outcome, by);
    } catch (error) {
      if (error instanceof LedgerUnavailableError) return { ok: false, reason: 'ledger_unavailable', error: error.message };
      throw error;
    }
  }

  private resolveInLedger(actionId: string, outcome: 'happened' | 'not_happened', by: ResolvedBy): ResolveResult {
    const found = this.store.findAction(actionId);
    if (found === undefined) return { ok: false, reason: 'unknown_action' };
    const result = this.store.transact((tx): ResolveResult => {
      const latest = tx.latest(found.intentHash);
      const nowMs = this.clock.nowMs();
      if (latest === undefined || latest.actionId !== actionId || !isUnresolved(latest, nowMs)) return { ok: false, reason: 'not_in_doubt' };
      if (by === 'agent' && latest.toolClass !== 'standard') return { ok: false, reason: 'agent_cannot_resolve_class', event: latest };
      if (by === 'agent' && outcome === 'not_happened' && nowMs - latest.atMs < this.settleWindowMs) return { ok: false, reason: 'too_soon' };
      return { ok: true, event: tx.append(this.followUp(latest, 'reconciled', { outcome, resolved_by: by, result: null, result_truncated: false })) };
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
          throw new GuardedCallFailedError(failureMessage(result.outcome));
        case 'replayed':
          return result.result as R;
        case 'in_doubt':
          throw new ActionInDoubtError(result.doubt, false);
        case 'blocked':
          throw new ActionInDoubtError(result.doubt, true);
        case 'ledger_unavailable':
          throw new GuardedCallFailedError(result.error);
        case 'retry_by_agent':
          throw new GuardedCallFailedError(`agent-once: the earlier ${meta.tool} attempt (action ${result.actionId}) did not happen; check the current state and call again`);
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
    const arrivedMs = this.clock.nowMs();
    let verifiedSeq: number | undefined;
    let pending: Resolution | undefined;
    for (;;) {
      if (pending?.retryByAgent === true) {
        const handed = this.handBack(pending);
        pending = undefined;
        if (handed !== undefined) return handed;
      }
      let claim: Claim;
      let resolved: LedgerEvent | undefined;
      try {
        [claim, resolved] = this.store.transact((tx): [Claim, LedgerEvent | undefined] => {
          const appended = pending === undefined ? undefined : this.applyResolution(tx, pending);
          return [this.decideAndClaim(tx, call, identity, arrivedMs, verifiedSeq), appended];
        });
      } catch (error) {
        if (error instanceof LedgerConflictError) continue;
        if (error instanceof LedgerUnavailableError) return unavailable(error);
        throw error;
      }
      pending = undefined;
      if (resolved !== undefined) this.emitState(resolved);
      this.emitDecision(call, claim);
      switch (claim.kind) {
        case 'execute': {
          this.emitState(claim.intended);
          const step = await this.dispatch(call, claim.intended, execute);
          if (step !== DECIDE_AGAIN) return step;
          break;
        }
        case 'replay':
          return replayed(claim.event, claim.reason);
        case 'in_doubt': {
          const step = await this.handleDoubt(call, claim.event, claim.reason);
          if ('status' in step) return step;
          pending = step;
          break;
        }
        case 'verify': {
          const outcome = await this.reconcile(call, claim.event);
          if (outcome.outcome === 'unknown') verifiedSeq = claim.event.seq;
          else pending = { event: claim.event, by: 'reconciler', ...outcome };
          break;
        }
      }
    }
  }

  private decideAndClaim(tx: LedgerTx, call: ProtectedCall, identity: Identity, arrivedMs: number, verifiedSeq: number | undefined): Claim {
    const latest = tx.latest(identity.hash);
    const nowMs = this.clock.nowMs();
    const decision = decide({
      latest,
      nowMs: arrivedMs,
      retryWindowMs: this.retryWindowMs,
      call: { runInstance: this.runInstance, sessionExplicit: call.sessionExplicit, intentKeyExplicit: call.intentKey !== undefined, policy: call.policy },
    });
    if (decision.kind !== 'execute') return decision;
    const needsVerification = decision.reason === 'failed_after_window' && call.reconciler !== undefined;
    if (latest !== undefined && needsVerification && latest.seq !== verifiedSeq) return { kind: 'verify', event: latest, reason: decision.reason };
    const newActionId = deriveActionId(identity.hash, decision.occurrence, nowMs);
    const inherits = latest !== undefined && INHERITED_KEY_REASONS.has(decision.reason);
    const intended = tx.append({
      actionId: newActionId,
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
      detail: { ...capturedDetail(call), idempotency_key: inherits ? idempotencyKeyOf(latest) : newActionId },
    });
    return { kind: 'execute', intended, reason: decision.reason };
  }

  private handBack(resolution: Resolution): GuardResult | undefined {
    let recorded: LedgerEvent | undefined;
    try {
      recorded = this.store.transact((tx) => this.applyResolution(tx, resolution));
    } catch (error) {
      if (error instanceof LedgerUnavailableError) return unavailable(error);
      throw error;
    }
    if (recorded === undefined) return undefined;
    this.emitState(recorded);
    return { status: 'retry_by_agent', actionId: recorded.actionId };
  }

  private applyResolution(tx: LedgerTx, resolution: Resolution): LedgerEvent | undefined {
    if (tx.latest(resolution.event.intentHash)?.seq !== resolution.event.seq) return undefined;
    const stored = resolution.result === undefined ? { result: null, result_truncated: false } : storedResultDetail(resolution.result, this.maxResultBytes);
    return tx.append(this.followUp(resolution.event, 'reconciled', { outcome: resolution.outcome, resolved_by: resolution.by, ...stored }));
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
    const idempotencyKey = idempotencyKeyOf(intended);
    const outcome = await invoke(execute, { actionId: intended.actionId, idempotencyKey });
    if (outcome.kind === 'abandoned') {
      this.emit(sent, 'state', { state: 'abandoned', occurrence: sent.occurrence });
      return { status: 'executed', actionId: intended.actionId, outcome };
    }
    const recorded = this.recordOutcome(call, sent, idempotencyKey, outcome);
    return recorded ? { status: 'executed', actionId: intended.actionId, outcome } : { status: 'executed', actionId: intended.actionId, outcome, recorded: false };
  }

  private recordOutcome(call: ProtectedCall, sent: LedgerEvent, idempotencyKey: string, outcome: RecordableOutcome): boolean {
    try {
      const recorded = this.store.transact((tx) => {
        if (outcome.kind !== 'ok' && tx.latest(sent.intentHash)?.seq !== sent.seq) return undefined;
        const detail = this.outcomeDetail(call, idempotencyKey, outcome);
        return tx.append(this.followUp(sent, outcome.kind === 'ok' ? 'confirmed' : 'failed', detail));
      });
      if (recorded === undefined) this.emit(sent, 'state', { state: 'superseded', occurrence: sent.occurrence, outcome: outcome.kind });
      else this.emitState(recorded);
      return true;
    } catch (error) {
      this.emit(sent, 'state', { state: 'unrecorded', occurrence: sent.occurrence, outcome: outcome.kind, error: errorMessage(error) });
      return false;
    }
  }

  private outcomeDetail(call: ProtectedCall, idempotencyKey: string, outcome: RecordableOutcome): Record<string, JsonValue> {
    switch (outcome.kind) {
      case 'ok': {
        const delivery = call.signal?.aborted === true ? 'cancelled' : 'delivered';
        return { ...storedResultDetail(outcome.result, this.maxResultBytes), delivery };
      }
      case 'error_result': {
        const { result, result_error: resultError } = storedResultDetail(outcome.result, this.maxResultBytes);
        return {
          ...capturedDetail(call),
          failure_kind: 'error_result',
          error: ERROR_RESULT_MESSAGE,
          result: result ?? null,
          ...(resultError === undefined ? {} : { result_error: resultError }),
          idempotency_key: idempotencyKey,
        };
      }
      case 'transport_error':
      case 'not_dispatched':
        return { ...capturedDetail(call), failure_kind: outcome.kind, error: outcome.error, result: null, idempotency_key: idempotencyKey };
    }
  }

  private async handleDoubt(call: ProtectedCall, event: LedgerEvent, reason: string): Promise<GuardResult | Resolution> {
    const doubt: DoubtInfo = { actionId: event.actionId, tool: call.tool, args: call.args, toolClass: call.toolClass, reason, sinceMs: event.atMs };
    if (call.reconciler !== undefined) {
      const outcome = await this.reconcile(call, event);
      if (outcome.outcome !== 'unknown') return { event, by: 'reconciler', ...outcome };
    }
    if (call.policy === 'guard') return { status: 'in_doubt', doubt };
    const answer = await this.askHuman(doubt, call.signal);
    if (answer.outcome === 'unresolved') return { status: 'blocked', doubt };
    return { event, by: answer.by, outcome: answer.outcome };
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

  private async askHuman(doubt: DoubtInfo, signal: AbortSignal | undefined): Promise<HumanResolution> {
    if (this.humanResolver === undefined) return UNRESOLVED;
    try {
      const answer: unknown = await this.humanResolver.resolve(doubt, signal);
      return isHumanAnswer(answer) ? { outcome: answer.outcome, by: answer.by } : UNRESOLVED;
    } catch {
      return UNRESOLVED;
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
    const event: EvidenceEvent = {
      v: 1,
      atMs: this.clock.nowMs(),
      kind,
      ...(subject.actionId === undefined ? {} : { actionId: subject.actionId }),
      tool: subject.tool,
      sessionKey: subject.sessionKey,
      detail,
    };
    try {
      this.evidence.emit(event);
    } catch (error) {
      this.reportEvidenceError(error, event);
    }
  }

  private reportEvidenceError(error: unknown, event: EvidenceEvent): void {
    try {
      this.onEvidenceError(error, event);
    } catch {
      return;
    }
  }
}
