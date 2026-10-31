import type { JsonValue } from '../canonical/jcs.js';

export const LEDGER_SCHEMA_VERSION = 1;
export const NESTED_TRANSACT = 'transact cannot be nested; finish the current transaction first';
export const THENABLE_RESULT = 'the transact callback must be synchronous but returned a thenable';

export type LedgerState = 'intended' | 'sent' | 'confirmed' | 'failed' | 'reconciled';
export type ToolClass = 'money' | 'irreversible' | 'standard';
export type GuardPolicy = 'guard' | 'block-on-doubt';

export interface LedgerEvent {
  seq: number;
  actionId: string;
  intentHash: string;
  occurrence: number;
  state: LedgerState;
  atMs: number;
  expiresAtMs: number;
  sessionKey: string;
  sessionExplicit: boolean;
  intentKeyExplicit: boolean;
  runInstance: string;
  tool: string;
  toolClass: ToolClass;
  policy: GuardPolicy;
  argsJson: string | null;
  detail: Record<string, JsonValue>;
}

export type NewLedgerEvent = Omit<LedgerEvent, 'seq'>;

export interface LedgerTx {
  latest(intentHash: string): LedgerEvent | undefined;
  append(event: NewLedgerEvent): LedgerEvent;
}

export interface LedgerStore {
  transact<T>(fn: (tx: LedgerTx) => T): T;
  findAction(actionId: string): LedgerEvent | undefined;
  listInDoubt(nowMs: number): LedgerEvent[];
  close(): void;
}

export function isUnresolvedEvent(event: Pick<LedgerEvent, 'state' | 'expiresAtMs' | 'detail'>, nowMs: number): boolean {
  if (event.expiresAtMs <= nowMs) return false;
  if (event.state === 'intended' || event.state === 'sent') return true;
  return event.state === 'failed' && event.detail.failure_kind !== 'not_dispatched';
}

export function isThenable(value: unknown): boolean {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && 'then' in value && typeof value.then === 'function';
}
