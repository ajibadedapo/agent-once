import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { LEDGER_SCHEMA_VERSION } from '../src/index.js';

test('LEDGER_SCHEMA_VERSION matches the schema_version written by spec/ledger-v1.sql', () => {
  const sql = readFileSync(fileURLToPath(new URL('../../../spec/ledger-v1.sql', import.meta.url)), 'utf8');
  const match = /INSERT INTO meta \(key, value\) VALUES \('schema_version', '(\d+)'\);/.exec(sql);
  expect(match?.[1]).toBe(String(LEDGER_SCHEMA_VERSION));
});
