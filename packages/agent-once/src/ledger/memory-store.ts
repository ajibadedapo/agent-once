import { canonicalize, type JsonValue } from '../canonical/jcs.js';
import type { Clock } from '../time/clock.js';
import { LedgerConflictError, LedgerUnavailableError, LedgerUsageError } from './errors.js';
import {
  NESTED_TRANSACT,
  THENABLE_RESULT,
  isUnresolvedEvent,
  isThenable,
  type LedgerEvent,
  type LedgerStore,
  type LedgerTx,
  type NewLedgerEvent,
} from './types.js';

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
  private inTransaction = false;

  constructor(_clock: Clock) {}

  transact<T>(fn: (tx: LedgerTx) => T): T {
    this.assertOpen();
    if (this.inTransaction) throw new LedgerUsageError(NESTED_TRANSACT);
    const rollbackLength = this.events.length;
    const rollbackSeq = this.nextSeq;
    const tx: LedgerTx = {
      latest: (intentHash) => this.latest(intentHash),
      append: (event) => this.append(event),
    };
    this.inTransaction = true;
    try {
      const result = fn(tx);
      if (isThenable(result)) throw new TypeError(THENABLE_RESULT);
      return result;
    } catch (error) {
      this.events.length = rollbackLength;
      this.nextSeq = rollbackSeq;
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  findAction(actionId: string): LedgerEvent | undefined {
    this.assertOpen();
    const newest = this.events.findLast((stored) => stored.fields.actionId === actionId);
    return newest === undefined ? undefined : materialize(newest);
  }

  listInDoubt(nowMs: number): LedgerEvent[] {
    this.assertOpen();
    const latestByIntent = new Map<string, StoredEvent>();
    for (const stored of this.events) {
      const latest = latestByIntent.get(stored.fields.intentHash);
      if (latest === undefined || stored.fields.occurrence >= latest.fields.occurrence) latestByIntent.set(stored.fields.intentHash, stored);
    }
    return [...latestByIntent.values()]
      .sort((a, b) => a.fields.seq - b.fields.seq)
      .map(materialize)
      .filter((event) => isUnresolvedEvent(event, nowMs));
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
