import { canonicalize, type JsonValue } from '../canonical/jcs.js';
import type { Clock } from '../time/clock.js';
import { LedgerConflictError, LedgerUnavailableError } from './errors.js';
import { isInDoubtState, type LedgerEvent, type LedgerStore, type LedgerTx, type NewLedgerEvent } from './types.js';

interface StoredEvent {
  fields: Omit<LedgerEvent, 'detail'>;
  detailJson: string;
}

function materialize(stored: StoredEvent): LedgerEvent {
  return { ...stored.fields, detail: JSON.parse(stored.detailJson) as Record<string, JsonValue> };
}

export class MemoryLedgerStore implements LedgerStore {
  private readonly events: StoredEvent[] = [];
  private nextSeq = 1;
  private closed = false;

  constructor(_clock: Clock) {}

  transact<T>(fn: (tx: LedgerTx) => T): T {
    this.assertOpen();
    const rollbackLength = this.events.length;
    const rollbackSeq = this.nextSeq;
    const tx: LedgerTx = {
      latest: (intentHash) => this.latest(intentHash),
      append: (event) => this.append(event),
    };
    try {
      return fn(tx);
    } catch (error) {
      this.events.length = rollbackLength;
      this.nextSeq = rollbackSeq;
      throw error;
    }
  }

  findAction(actionId: string): LedgerEvent | undefined {
    this.assertOpen();
    const newest = this.events.findLast((stored) => stored.fields.actionId === actionId);
    return newest === undefined ? undefined : materialize(newest);
  }

  listInDoubt(nowMs: number): LedgerEvent[] {
    this.assertOpen();
    const newestByAction = new Map<string, StoredEvent>();
    for (const stored of this.events) newestByAction.set(stored.fields.actionId, stored);
    return [...newestByAction.values()]
      .filter((stored) => isInDoubtState(stored.fields.state) && stored.fields.expiresAtMs > nowMs)
      .sort((a, b) => a.fields.seq - b.fields.seq)
      .map(materialize);
  }

  close(): void {
    this.closed = true;
  }

  private latest(intentHash: string): LedgerEvent | undefined {
    let latest: StoredEvent | undefined;
    for (const stored of this.events) {
      if (stored.fields.intentHash !== intentHash) continue;
      if (latest === undefined || stored.fields.occurrence >= latest.fields.occurrence) latest = stored;
    }
    return latest === undefined ? undefined : materialize(latest);
  }

  private append(event: NewLedgerEvent): LedgerEvent {
    const { detail, ...fields } = event;
    const detailJson = canonicalize(detail);
    const claimed = this.events.some(
      (stored) =>
        event.state === 'intended' &&
        stored.fields.state === 'intended' &&
        stored.fields.intentHash === event.intentHash &&
        stored.fields.occurrence === event.occurrence,
    );
    if (claimed) throw new LedgerConflictError(event.intentHash, event.occurrence);
    const stored: StoredEvent = { fields: { ...fields, seq: this.nextSeq++ }, detailJson };
    this.events.push(stored);
    return materialize(stored);
  }

  private assertOpen(): void {
    if (this.closed) throw new LedgerUnavailableError('the ledger is closed');
  }
}
