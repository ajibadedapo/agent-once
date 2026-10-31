import { expect, test } from 'vitest';
import { filterSqliteExperimentalWarning, loadNodeSqlite } from '../src/ledger/suppress-sqlite-warning.js';

const SQLITE_MESSAGE = 'SQLite is an experimental feature and might change at any time';

function recordingEmitter(): { emit: typeof process.emitWarning; calls: unknown[][] } {
  const calls: unknown[][] = [];
  const emit = ((...args: unknown[]) => {
    calls.push(args);
  }) as typeof process.emitWarning;
  return { emit, calls };
}

test('swallows the SQLite ExperimentalWarning in every emitWarning form', () => {
  const { emit, calls } = recordingEmitter();
  const filtered = filterSqliteExperimentalWarning(emit);
  filtered(SQLITE_MESSAGE, 'ExperimentalWarning');
  filtered(SQLITE_MESSAGE, { type: 'ExperimentalWarning' });
  const error = new Error(SQLITE_MESSAGE);
  error.name = 'ExperimentalWarning';
  filtered(error);
  expect(calls).toEqual([]);
});

test('re-emits every other warning unchanged', () => {
  const { emit, calls } = recordingEmitter();
  const filtered = filterSqliteExperimentalWarning(emit);
  const deprecation = new Error('old api');
  deprecation.name = 'DeprecationWarning';
  filtered('VM modules are an experimental feature', 'ExperimentalWarning');
  filtered(SQLITE_MESSAGE, 'DeprecationWarning', 'DEP0001');
  filtered(SQLITE_MESSAGE);
  filtered('sqlite mentioned', { type: 'Warning', code: 'X1' });
  filtered(deprecation);
  expect(calls).toEqual([
    ['VM modules are an experimental feature', 'ExperimentalWarning'],
    [SQLITE_MESSAGE, 'DeprecationWarning', 'DEP0001'],
    [SQLITE_MESSAGE],
    ['sqlite mentioned', { type: 'Warning', code: 'X1' }],
    [deprecation],
  ]);
});

test('loadNodeSqlite installs the filter once and the SQLite warning never reaches warning listeners', async () => {
  const sqlite = loadNodeSqlite();
  const installed = process.emitWarning;
  expect(loadNodeSqlite()).toBe(sqlite);
  expect(process.emitWarning).toBe(installed);
  const seen: string[] = [];
  const listener = (warning: Error) => seen.push(warning.message);
  process.on('warning', listener);
  try {
    process.emitWarning(SQLITE_MESSAGE, 'ExperimentalWarning');
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off('warning', listener);
  }
  expect(seen).toEqual([]);
  expect(typeof sqlite.DatabaseSync).toBe('function');
});
