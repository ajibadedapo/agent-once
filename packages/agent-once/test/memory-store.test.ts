import { expect, test } from 'vitest';
import { LedgerUnavailableError } from '../src/ledger/errors.js';
import { MemoryLedgerStore } from '../src/ledger/memory-store.js';
import { ManualClock } from '../src/time/clock.js';
import { START_MS, ledgerContract, newEvent } from './ledger.contract.js';

ledgerContract('MemoryLedgerStore', () => ({
  open: (clock) => new MemoryLedgerStore(clock),
  cleanup: () => {},
}));

test('a closed memory store is unavailable', () => {
  const store = new MemoryLedgerStore(new ManualClock(START_MS));
  store.close();
  expect(() => store.transact((tx) => tx.append(newEvent()))).toThrow(LedgerUnavailableError);
  expect(() => store.findAction('ao_x')).toThrow(LedgerUnavailableError);
  expect(() => store.listInDoubt(START_MS)).toThrow(LedgerUnavailableError);
});
