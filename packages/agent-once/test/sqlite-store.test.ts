import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { canonicalize } from '../src/canonical/jcs.js';
import { LedgerConflictError, LedgerSchemaTooNewError, LedgerUnavailableError } from '../src/ledger/errors.js';
import { LEDGER_V1_SQL, SqliteLedgerStore, defaultLedgerPath } from '../src/ledger/sqlite-store.js';
import { loadNodeSqlite } from '../src/ledger/suppress-sqlite-warning.js';
import { ManualClock } from '../src/time/clock.js';
import { EXPIRY_MS, START_MS, ledgerContract, newEvent } from './ledger.contract.js';

const { DatabaseSync } = loadNodeSqlite();

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-once-ledger-'));
  tempDirs.push(dir);
  return dir;
}

function cleanupTempDirs(): void {
  for (const dir of tempDirs.splice(0)) {
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  }
}

function rawQuery(path: string, sql: string): Record<string, unknown>[] {
  const db = new DatabaseSync(path);
  try {
    return db.prepare(sql).all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

function rawExec(path: string, sql: string): void {
  const db = new DatabaseSync(path);
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

ledgerContract('SqliteLedgerStore', () => {
  const dir = tempDir();
  return { open: (clock) => SqliteLedgerStore.open(join(dir, 'ledger.db'), clock), cleanup: cleanupTempDirs };
});

describe('SqliteLedgerStore', () => {
  const stores: SqliteLedgerStore[] = [];

  function open(path: string, clock = new ManualClock(START_MS)): SqliteLedgerStore {
    const store = SqliteLedgerStore.open(path, clock);
    stores.push(store);
    return store;
  }

  afterEach(() => {
    for (const store of stores.splice(0)) store.close();
    cleanupTempDirs();
  });

  test('the embedded schema is spec/ledger-v1.sql verbatim', () => {
    const spec = readFileSync(fileURLToPath(new URL('../../../spec/ledger-v1.sql', import.meta.url)), 'utf8');
    expect(LEDGER_V1_SQL).toBe(spec);
  });

  test('uses WAL, synchronous NORMAL and a 5000 ms busy timeout', () => {
    const path = join(tempDir(), 'ledger.db');
    const store = open(path);
    expect(store.settings()).toEqual({ journalMode: 'wal', synchronous: 1, busyTimeoutMs: 5000 });
    expect(rawQuery(path, 'PRAGMA journal_mode')).toEqual([{ journal_mode: 'wal' }]);
  });

  test('creates the schema with schema_version 1 and a missing parent directory', () => {
    const path = join(tempDir(), 'nested', 'home', 'ledger.db');
    open(path);
    expect(rawQuery(path, "SELECT value FROM meta WHERE key = 'schema_version'")).toEqual([{ value: '1' }]);
  });

  test('prunes expired rows on open', () => {
    const path = join(tempDir(), 'ledger.db');
    const first = open(path);
    first.transact((tx) => {
      tx.append(newEvent({ intentHash: '1'.repeat(64), expiresAtMs: START_MS + 100 }));
      tx.append(newEvent({ intentHash: '2'.repeat(64), expiresAtMs: START_MS + 200 }));
      tx.append(newEvent({ intentHash: '3'.repeat(64), expiresAtMs: START_MS + 201 }));
    });
    first.close();
    open(path, new ManualClock(START_MS + 200));
    expect(rawQuery(path, 'SELECT intent_hash FROM events ORDER BY seq')).toEqual([
      { intent_hash: '2'.repeat(64) },
      { intent_hash: '3'.repeat(64) },
    ]);
  });

  test('once every event of an intent is pruned its occurrence 0 can be claimed again', () => {
    const path = join(tempDir(), 'ledger.db');
    open(path).transact((tx) => tx.append(newEvent({ actionId: 'ao_old' })));
    const later = open(path, new ManualClock(START_MS + EXPIRY_MS + 1));
    const claimed = later.transact((tx) => {
      expect(tx.latest('a'.repeat(64))).toBeUndefined();
      return tx.append(newEvent({ actionId: 'ao_new', atMs: START_MS + EXPIRY_MS + 1 }));
    });
    expect(claimed).toMatchObject({ actionId: 'ao_new', occurrence: 0 });
  });

  test('refuses a newer schema_version with LedgerSchemaTooNewError naming the version, without modifying the file', () => {
    const path = join(tempDir(), 'ledger.db');
    open(path).close();
    rawExec(path, "UPDATE meta SET value = '7' WHERE key = 'schema_version'");
    const before = readFileSync(path);
    let caught: unknown;
    try {
      open(path, new ManualClock(START_MS + EXPIRY_MS * 3));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LedgerSchemaTooNewError);
    expect(caught).toBeInstanceOf(LedgerUnavailableError);
    expect((caught as LedgerSchemaTooNewError).found).toBe(7);
    expect((caught as Error).message).toContain('schema_version 7');
    expect(readFileSync(path).equals(before)).toBe(true);
  });

  test.each([
    ['a missing schema_version row', "DELETE FROM meta WHERE key = 'schema_version'"],
    ['a non-integer schema_version', "UPDATE meta SET value = '1.5' WHERE key = 'schema_version'"],
    ['an empty schema_version', "UPDATE meta SET value = '' WHERE key = 'schema_version'"],
    ['schema_version 0', "UPDATE meta SET value = '0' WHERE key = 'schema_version'"],
  ])('%s raises LedgerUnavailableError and is not mistaken for a newer schema', (_label, sql) => {
    const path = join(tempDir(), 'ledger.db');
    open(path).close();
    rawExec(path, sql);
    let caught: unknown;
    try {
      open(path);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LedgerUnavailableError);
    expect(caught).not.toBeInstanceOf(LedgerSchemaTooNewError);
    expect((caught as Error).message).toContain('agent-once ledger unavailable');
  });

  test('a database with other tables but no meta table is unavailable', () => {
    const path = join(tempDir(), 'other.db');
    rawExec(path, 'CREATE TABLE unrelated (id INTEGER)');
    expect(() => open(path)).toThrow(LedgerUnavailableError);
    expect(rawQuery(path, "SELECT name FROM sqlite_master WHERE type = 'table'")).toEqual([{ name: 'unrelated' }]);
  });

  test("two store handles on one file: a transaction in the second sees the first's intended event", () => {
    const path = join(tempDir(), 'ledger.db');
    const first = open(path);
    const second = open(path);
    first.transact((tx) => tx.append(newEvent({ actionId: 'ao_first' })));
    const seen = second.transact((tx) => tx.latest('a'.repeat(64)));
    expect(seen).toMatchObject({ actionId: 'ao_first', state: 'intended', occurrence: 0 });
    expect(() => second.transact((tx) => tx.append(newEvent({ actionId: 'ao_second', atMs: START_MS + 1 })))).toThrow(
      LedgerConflictError,
    );
    expect(rawQuery(path, 'SELECT action_id FROM events')).toEqual([{ action_id: 'ao_first' }]);
  });

  test('transact holds the write lock from its first statement, before any read or write', () => {
    const path = join(tempDir(), 'ledger.db');
    const store = open(path);
    const competitor = new DatabaseSync(path);
    try {
      competitor.exec('PRAGMA busy_timeout = 0');
      store.transact(() => {
        expect(() => competitor.exec('BEGIN IMMEDIATE')).toThrow(/locked|busy/i);
      });
      competitor.exec('BEGIN IMMEDIATE');
      competitor.exec('ROLLBACK');
    } finally {
      competitor.close();
    }
  });

  test('unwritable directory raises LedgerUnavailableError', () => {
    const dir = tempDir();
    chmodSync(dir, 0o500);
    expect(() => open(join(dir, 'ledger.db'))).toThrow(LedgerUnavailableError);
    expect(() => open(join(dir, 'missing', 'ledger.db'))).toThrow(LedgerUnavailableError);
  });

  test('corrupt file raises LedgerUnavailableError', () => {
    const path = join(tempDir(), 'ledger.db');
    writeFileSync(path, Buffer.alloc(8192, 'not a sqlite ledger '));
    let caught: unknown;
    try {
      open(path);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(LedgerUnavailableError);
    expect((caught as Error).message).toMatch(/^agent-once ledger unavailable: /);
    expect((caught as Error).cause).toBeDefined();
  });

  test('round-trips detail and args JSON byte for byte', () => {
    const path = join(tempDir(), 'ledger.db');
    const argsJson = '{ "note": "café 😀  ",\n  "amount": 12.50, "big": 9007199254740993 }';
    const detail = { result: { text: 'café 😀', n: 1e21, nested: [null, true, -0.5] }, result_truncated: false, delivery: 'delivered' };
    open(path).transact((tx) => tx.append(newEvent({ state: 'confirmed', argsJson, detail })));
    expect(rawQuery(path, 'SELECT args_json, detail_json FROM events')).toEqual([
      { args_json: argsJson, detail_json: canonicalize(detail) },
    ]);
    const reread = open(path).findAction('ao_000000000000000000000001');
    expect(reread?.argsJson).toBe(argsJson);
    expect(reread?.detail).toEqual(detail);
  });

  test('a detail that cannot be canonicalized is rejected before anything is written', () => {
    const path = join(tempDir(), 'ledger.db');
    const store = open(path);
    expect(() => store.transact((tx) => tx.append(newEvent({ detail: { result: Number.NaN } })))).toThrow(/non-finite/);
    expect(rawQuery(path, 'SELECT COUNT(*) AS n FROM events')).toEqual([{ n: 0 }]);
  });

  test('close is idempotent and a closed store is unavailable', () => {
    const store = open(join(tempDir(), 'ledger.db'));
    store.close();
    store.close();
    expect(() => store.transact((tx) => tx.latest('a'.repeat(64)))).toThrow(LedgerUnavailableError);
    expect(() => store.findAction('ao_x')).toThrow(LedgerUnavailableError);
    expect(() => store.listInDoubt(START_MS)).toThrow(LedgerUnavailableError);
  });
});

describe('defaultLedgerPath', () => {
  test('defaultLedgerPath honours AGENT_ONCE_HOME', () => {
    expect(defaultLedgerPath({ AGENT_ONCE_HOME: '/srv/once' }, '/home/ada')).toBe(join('/srv/once', 'ledger.db'));
  });

  test('defaultLedgerPath falls back to ~/.agent-once when AGENT_ONCE_HOME is unset or empty', () => {
    expect(defaultLedgerPath({}, '/home/ada')).toBe(join('/home/ada', '.agent-once', 'ledger.db'));
    expect(defaultLedgerPath({ AGENT_ONCE_HOME: '' }, '/home/ada')).toBe(join('/home/ada', '.agent-once', 'ledger.db'));
  });
});
