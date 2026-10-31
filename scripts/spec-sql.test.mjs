import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const schema = readFileSync(new URL('../spec/ledger-v1.sql', import.meta.url), 'utf8');

function openSpecDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  return db;
}

test('the spec schema applies to an empty database and records schema_version 1', () => {
  const db = openSpecDatabase();
  assert.deepEqual({ ...db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() }, { value: '1' });
});

test('the spec schema indexes events by expiry for pruning', () => {
  const db = openSpecDatabase();
  const plan = db
    .prepare('EXPLAIN QUERY PLAN DELETE FROM events WHERE expires_at_ms < ?')
    .all(1_761_912_345_678)
    .map((row) => row.detail)
    .join('\n');
  assert.match(plan, /USING (COVERING )?INDEX events_by_expiry/);
});
