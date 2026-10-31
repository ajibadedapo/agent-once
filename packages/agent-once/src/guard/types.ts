import type { JsonValue } from '../canonical/jcs.js';
import type { IdentityRule } from '../identity/project-args.js';
import type { GuardPolicy, LedgerEvent, ToolClass } from '../ledger/types.js';

export type ToolOutcome =
  | { kind: 'ok'; result: JsonValue }
  | { kind: 'error_result'; result: JsonValue }
  | { kind: 'transport_error'; error: string }
  | { kind: 'not_dispatched'; error: string }
  | { kind: 'abandoned' };

export type ReconcileOutcome = { outcome: 'happened'; result?: JsonValue } | { outcome: 'not_happened' } | { outcome: 'unknown'; reason: string };

export interface ReconcileContext {
  tool: string;
  args: Record<string, unknown>;
  actionId: string;
  event: LedgerEvent;
}

export type Reconciler = (ctx: ReconcileContext) => Promise<ReconcileOutcome>;

export interface DoubtInfo {
  actionId: string;
  tool: string;
  args: Record<string, unknown>;
  toolClass: ToolClass;
  reason: string;
  sinceMs: number;
}

export type HumanResolution = { outcome: 'happened' | 'not_happened'; by: 'human' | 'webhook' } | { outcome: 'unresolved' };

export interface HumanResolver {
  resolve(doubt: DoubtInfo, signal?: AbortSignal): Promise<HumanResolution>;
}

export interface GuardedCall {
  tool: string;
  args: Record<string, unknown>;
  sessionKey: string;
  sessionExplicit: boolean;
  intentKey?: string;
  policy: 'pass' | GuardPolicy;
  toolClass: ToolClass;
  identityRule?: IdentityRule;
  volatileKeys?: readonly string[];
  extraIdentity?: Record<string, JsonValue>;
  reconciler?: Reconciler;
  captured?: string;
  signal?: AbortSignal;
}

export interface ExecuteContext {
  actionId?: string;
  idempotencyKey?: string;
}

export type Execute = (context: ExecuteContext) => Promise<ToolOutcome>;

export type GuardResult =
  | { status: 'executed' | 'passed'; actionId?: string; outcome: ToolOutcome; recorded?: false }
  | { status: 'replayed'; actionId: string; result: JsonValue | null; resultTruncated: boolean; reason: string }
  | { status: 'in_doubt' | 'blocked'; doubt: DoubtInfo }
  | { status: 'ledger_unavailable'; error: string };

export type ResolvedBy = 'agent' | 'human' | 'webhook';

export type ResolveResult =
  | { ok: true; event: LedgerEvent }
  | { ok: false; reason: 'unknown_action' | 'not_in_doubt' | 'too_soon' }
  | { ok: false; reason: 'agent_cannot_resolve_class'; event: LedgerEvent }
  | { ok: false; reason: 'ledger_unavailable'; error: string };

export class ActionInDoubtError extends Error {
  override readonly name: string = 'ActionInDoubtError';
  readonly doubt: DoubtInfo;
  readonly blocked: boolean;

  constructor(doubt: DoubtInfo, blocked: boolean) {
    const verdict = blocked ? 'blocked until someone confirms whether it happened' : 'in doubt; resolve it before retrying';
    super(`agent-once: ${doubt.tool} action ${doubt.actionId} is ${verdict} (${doubt.reason})`);
    this.doubt = doubt;
    this.blocked = blocked;
  }
}

export class GuardedCallFailedError extends Error {
  override readonly name: string = 'GuardedCallFailedError';
}
