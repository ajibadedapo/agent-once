import type { JsonValue } from '../canonical/jcs.js';

export const LEDGER_SCHEMA_VERSION = 1;

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

export function isInDoubtState(state: LedgerState): boolean {
  return state === 'intended' || state === 'sent';
}
