import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import { canonicalize, type JsonValue } from '../canonical/jcs.js';
import type { Clock } from '../time/clock.js';
import { LedgerConflictError, LedgerSchemaTooNewError, LedgerUnavailableError, LedgerUsageError } from './errors.js';
import { loadNodeSqlite } from './suppress-sqlite-warning.js';
import {
  LEDGER_SCHEMA_VERSION,
  NESTED_TRANSACT,
  THENABLE_RESULT,
  isThenable,
  isUnresolvedEvent,
  type GuardPolicy,
  type LedgerEvent,
  type LedgerState,
  type LedgerStore,
  type LedgerTx,
  type NewLedgerEvent,
  type ToolClass,
} from './types.js';

export const LEDGER_V1_SQL = `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  action_id TEXT NOT NULL,
  intent_hash TEXT NOT NULL,
  occurrence INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('intended','sent','confirmed','failed','reconciled')),
  at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  session_key TEXT NOT NULL,
  session_explicit INTEGER NOT NULL,
  intent_key_explicit INTEGER NOT NULL,
  run_instance TEXT NOT NULL,
  tool TEXT NOT NULL,
  tool_class TEXT NOT NULL CHECK (tool_class IN ('money','irreversible','standard')),
  policy TEXT NOT NULL CHECK (policy IN ('guard','block-on-doubt')),
  args_json TEXT,
  detail_json TEXT NOT NULL
);
CREATE UNIQUE INDEX events_one_intended ON events(intent_hash, occurrence) WHERE state = 'intended';
CREATE INDEX events_by_intent ON events(intent_hash, occurrence, seq);
CREATE INDEX events_by_action ON events(action_id, seq);
CREATE INDEX events_by_expiry ON events(expires_at_ms);
INSERT INTO meta (key, value) VALUES ('schema_version', '1');
`;

const DEFAULT_BUSY_TIMEOUT_MS = 5000;
const SQLITE_CONSTRAINT_UNIQUE = 2067;
const POSITIVE_INTEGER = /^[1-9][0-9]*$/;
const LEDGER_FILE = 'ledger.db';
const DEFAULT_HOME_DIR = '.agent-once';

interface EventRow {
  seq: number;
  action_id: string;
  intent_hash: string;
  occurrence: number;
  state: LedgerState;
  at_ms: number;
  expires_at_ms: number;
  session_key: string;
  session_explicit: number;
  intent_key_explicit: number;
  run_instance: string;
  tool: string;
  tool_class: ToolClass;
  policy: GuardPolicy;
  args_json: string | null;
  detail_json: string;
}

export interface SqliteLedgerOptions {
  busyTimeoutMs?: number;
}

interface TransactionState {
  poisoned: boolean;
}

export interface SqliteLedgerSettings {
  journalMode: string;
  synchronous: number;
  busyTimeoutMs: number;
}

export function defaultLedgerPath(env: NodeJS.ProcessEnv, homedir: string): string {
  const home = env['AGENT_ONCE_HOME'];
  return join(home !== undefined && home !== '' ? home : join(homedir, DEFAULT_HOME_DIR), LEDGER_FILE);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unavailable(error: unknown, context: string): LedgerUnavailableError {
  if (error instanceof LedgerUnavailableError) return error;
  return new LedgerUnavailableError(`${context}: ${errorMessage(error)}`, { cause: error });
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'errcode' in error && error.errcode === SQLITE_CONSTRAINT_UNIQUE;
}

function toEvent(row: EventRow): LedgerEvent {
  return {
    seq: row.seq,
    actionId: row.action_id,
    intentHash: row.intent_hash,
    occurrence: row.occurrence,
    state: row.state,
    atMs: row.at_ms,
    expiresAtMs: row.expires_at_ms,
    sessionKey: row.session_key,
    sessionExplicit: row.session_explicit === 1,
    intentKeyExplicit: row.intent_key_explicit === 1,
    runInstance: row.run_instance,
    tool: row.tool,
    toolClass: row.tool_class,
    policy: row.policy,
    argsJson: row.args_json,
    detail: JSON.parse(row.detail_json) as Record<string, JsonValue>,
  };
}

function pragmaValue(db: DatabaseSync, name: string): unknown {
  const row = db.prepare(`PRAGMA ${name}`).get();
  return row === undefined ? undefined : Object.values(row)[0];
}

function abortedTransaction(): LedgerUnavailableError {
  return new LedgerUnavailableError('the transaction was aborted by a storage error; no further reads or writes are possible in it');
}

function rollbackIfOpen(db: DatabaseSync): void {
  if (db.isTransaction) db.exec('ROLLBACK');
}

function checkSchemaVersion(db: DatabaseSync): void {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (row === undefined) throw new LedgerUnavailableError('the meta table has no schema_version');
  const value = row['value'];
  if (typeof value !== 'string' || !POSITIVE_INTEGER.test(value)) {
    throw new LedgerUnavailableError(`schema_version ${JSON.stringify(value)} is not a positive integer`);
  }
  const found = Number(value);
  if (found > LEDGER_SCHEMA_VERSION) throw new LedgerSchemaTooNewError(found, LEDGER_SCHEMA_VERSION);
}

function initializeSchema(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const hasMeta = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'").get() !== undefined;
    if (hasMeta) {
      checkSchemaVersion(db);
    } else {
      const existing = db.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get();
      if (existing?.['n'] !== 0) throw new LedgerUnavailableError('the file is a SQLite database but not an agent-once ledger');
      db.exec(LEDGER_V1_SQL);
    }
    db.exec('COMMIT');
  } catch (error) {
    rollbackIfOpen(db);
    throw error;
  }
}

function configureJournal(db: DatabaseSync): void {
  if (pragmaValue(db, 'journal_mode = WAL') !== 'wal') throw new LedgerUnavailableError('cannot enable the WAL journal');
  db.exec('PRAGMA synchronous = NORMAL');
}

export class SqliteLedgerStore implements LedgerStore {
  private db: DatabaseSync | undefined;
  private readonly latestStatement: StatementSync;
  private readonly appendStatement: StatementSync;
  private readonly findActionStatement: StatementSync;
  private readonly inDoubtStatement: StatementSync;
  private readonly actionsStatement: StatementSync;
  private readonly tx: LedgerTx;
  private active: TransactionState | undefined;

  private constructor(db: DatabaseSync) {
    this.db = db;
    this.latestStatement = db.prepare('SELECT * FROM events WHERE intent_hash = ? ORDER BY occurrence DESC, seq DESC LIMIT 1');
    this.appendStatement = db.prepare(
      `INSERT INTO events (action_id, intent_hash, occurrence, state, at_ms, expires_at_ms, session_key, session_explicit,
        intent_key_explicit, run_instance, tool, tool_class, policy, args_json, detail_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.findActionStatement = db.prepare('SELECT * FROM events WHERE action_id = ? ORDER BY seq DESC LIMIT 1');
    this.inDoubtStatement = db.prepare(
      `SELECT * FROM events AS e
       WHERE e.state IN ('intended', 'sent', 'failed') AND e.expires_at_ms > ?
         AND NOT EXISTS (
           SELECT 1 FROM events AS later
           WHERE later.intent_hash = e.intent_hash AND (later.occurrence > e.occurrence OR (later.occurrence = e.occurrence AND later.seq > e.seq))
         )
       ORDER BY e.seq`,
    );
    this.actionsStatement = db.prepare(
      `SELECT * FROM events AS e
       WHERE e.expires_at_ms > ?
         AND NOT EXISTS (SELECT 1 FROM events AS later WHERE later.action_id = e.action_id AND later.seq > e.seq)
       ORDER BY e.seq`,
    );
    this.tx = {
      latest: (intentHash) => this.latest(intentHash),
      append: (event) => this.append(event),
    };
  }

  static open(path: string, clock: Clock, options: SqliteLedgerOptions = {}): SqliteLedgerStore {
    const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
    if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0) {
      throw new RangeError(`busyTimeoutMs must be a non-negative integer, got ${busyTimeoutMs}`);
    }
    const { DatabaseSync } = loadNodeSqlite();
    let db: DatabaseSync | undefined;
    try {
      mkdirSync(dirname(path), { recursive: true });
      db = new DatabaseSync(path);
      db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
      initializeSchema(db);
      configureJournal(db);
      db.prepare('DELETE FROM events WHERE expires_at_ms < ?').run(clock.nowMs());
      return new SqliteLedgerStore(db);
    } catch (error) {
      if (db?.isOpen === true) db.close();
      throw unavailable(error, `cannot open ${path}`);
    }
  }

  transact<T>(fn: (tx: LedgerTx) => T): T {
    const db = this.connection();
    if (this.active !== undefined) throw new LedgerUsageError(NESTED_TRANSACT);
    try {
      db.exec('BEGIN IMMEDIATE');
    } catch (error) {
      throw unavailable(error, 'cannot begin a transaction');
    }
    const state: TransactionState = { poisoned: false };
    this.active = state;
    try {
      const result = fn(this.tx);
      if (isThenable(result)) throw new TypeError(THENABLE_RESULT);
      if (state.poisoned) throw abortedTransaction();
      try {
        db.exec('COMMIT');
      } catch (error) {
        throw unavailable(error, 'cannot commit');
      }
      return result;
    } catch (error) {
      this.abort(db);
      throw error;
    } finally {
      this.active = undefined;
    }
  }

  findAction(actionId: string): LedgerEvent | undefined {
    this.connection();
    try {
      const row = this.findActionStatement.get(actionId) as EventRow | undefined;
      return row === undefined ? undefined : toEvent(row);
    } catch (error) {
      throw unavailable(error, 'cannot read the ledger');
    }
  }

  listInDoubt(nowMs: number): LedgerEvent[] {
    this.connection();
    try {
      return (this.inDoubtStatement.all(nowMs) as unknown as EventRow[]).map(toEvent).filter((event) => isUnresolvedEvent(event, nowMs));
    } catch (error) {
      throw unavailable(error, 'cannot read the ledger');
    }
  }

  listActions(nowMs: number): LedgerEvent[] {
    this.connection();
    try {
      return (this.actionsStatement.all(nowMs) as unknown as EventRow[]).map(toEvent);
    } catch (error) {
      throw unavailable(error, 'cannot read the ledger');
    }
  }

  settings(): SqliteLedgerSettings {
    const db = this.connection();
    return {
      journalMode: String(pragmaValue(db, 'journal_mode')),
      synchronous: Number(pragmaValue(db, 'synchronous')),
      busyTimeoutMs: Number(pragmaValue(db, 'busy_timeout')),
    };
  }

  close(): void {
    const db = this.db;
    this.db = undefined;
    if (db?.isOpen === true) db.close();
  }

  private connection(): DatabaseSync {
    if (this.db === undefined) throw new LedgerUnavailableError('the ledger is closed');
    return this.db;
  }

  private abort(db: DatabaseSync): void {
    try {
      rollbackIfOpen(db);
    } catch {
      this.close();
    }
  }

  private activeConnection(): DatabaseSync {
    const db = this.connection();
    if (this.active?.poisoned === true) throw abortedTransaction();
    return db;
  }

  private storageFailure(db: DatabaseSync, error: unknown, context: string): LedgerUnavailableError {
    if (this.active !== undefined && !db.isTransaction) this.active.poisoned = true;
    return unavailable(error, context);
  }

  private latest(intentHash: string): LedgerEvent | undefined {
    const db = this.activeConnection();
    try {
      const row = this.latestStatement.get(intentHash) as EventRow | undefined;
      return row === undefined ? undefined : toEvent(row);
    } catch (error) {
      throw this.storageFailure(db, error, 'cannot read the ledger');
    }
  }

  private append(event: NewLedgerEvent): LedgerEvent {
    const db = this.activeConnection();
    const detailJson = canonicalize(event.detail);
    let seq: number;
    try {
      const { lastInsertRowid } = this.appendStatement.run(
        event.actionId,
        event.intentHash,
        event.occurrence,
        event.state,
        event.atMs,
        event.expiresAtMs,
        event.sessionKey,
        event.sessionExplicit ? 1 : 0,
        event.intentKeyExplicit ? 1 : 0,
        event.runInstance,
        event.tool,
        event.toolClass,
        event.policy,
        event.argsJson,
        detailJson,
      );
      seq = Number(lastInsertRowid);
    } catch (error) {
      if (isUniqueViolation(error)) throw new LedgerConflictError(event.intentHash, event.occurrence, { cause: error });
      throw this.storageFailure(db, error, 'cannot append to the ledger');
    }
    return { ...event, seq, detail: JSON.parse(detailJson) as Record<string, JsonValue> };
  }
}
