import type { EvidenceEvent, EvidenceSink } from '../src/evidence/types.js';
import type { GuardedCall, ToolOutcome } from '../src/guard/types.js';
import type { LedgerEvent, LedgerStore, LedgerTx } from '../src/ledger/types.js';

export const START_MS = 1_761_912_345_678;

export class RecordingSink implements EvidenceSink {
  readonly events: EvidenceEvent[] = [];

  emit(event: EvidenceEvent): void {
    this.events.push(event);
  }

  ofKind(kind: EvidenceEvent['kind']): EvidenceEvent[] {
    return this.events.filter((event) => event.kind === kind);
  }
}

export class RecordingStore implements LedgerStore {
  readonly appended: LedgerEvent[] = [];
  beforeTransact: (() => void) | undefined;
  private transactions = 0;

  constructor(readonly inner: LedgerStore) {}

  get transactionCount(): number {
    return this.transactions;
  }

  transact<T>(fn: (tx: LedgerTx) => T): T {
    this.transactions += 1;
    this.beforeTransact?.();
    const pending: LedgerEvent[] = [];
    const result = this.inner.transact((tx) =>
      fn({
        latest: (intentHash) => tx.latest(intentHash),
        append: (event) => {
          const stored = tx.append(event);
          pending.push(stored);
          return stored;
        },
      }),
    );
    this.appended.push(...pending);
    return result;
  }

  findAction(actionId: string): LedgerEvent | undefined {
    return this.inner.findAction(actionId);
  }

  listInDoubt(nowMs: number): LedgerEvent[] {
    return this.inner.listInDoubt(nowMs);
  }

  close(): void {
    this.inner.close();
  }

  states(): string[] {
    return this.appended.map((event) => event.state);
  }

  last(): LedgerEvent {
    const event = this.appended.at(-1);
    if (event === undefined) throw new Error('nothing was appended');
    return event;
  }
}

export function guardedCall(overrides: Partial<GuardedCall> = {}): GuardedCall {
  return {
    tool: 'create_ticket',
    args: { title: 'Printer jam', priority: 2 },
    sessionKey: 'client:/work',
    sessionExplicit: false,
    policy: 'guard',
    toolClass: 'standard',
    ...overrides,
  };
}

export function scripted(...outcomes: ToolOutcome[]): { execute: (context: { actionId?: string }) => Promise<ToolOutcome>; calls: Array<string | undefined> } {
  const calls: Array<string | undefined> = [];
  return {
    calls,
    execute: async (context) => {
      calls.push(context.actionId);
      const outcome = outcomes[Math.min(calls.length - 1, outcomes.length - 1)];
      if (outcome === undefined) throw new Error('no scripted outcome');
      return outcome;
    },
  };
}

export function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
