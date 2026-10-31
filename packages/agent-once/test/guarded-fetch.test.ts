import { describe, expect, test } from 'vitest';
import { Guard } from '../src/guard/guard.js';
import { guardedFetch } from '../src/http/guarded-fetch.js';
import { MemoryLedgerStore } from '../src/ledger/memory-store.js';
import { ManualClock } from '../src/time/clock.js';
import { RecordingSink, START_MS, guardedCall } from './guard-harness.js';

function setup() {
  const clock = new ManualClock(START_MS);
  const guard = new Guard({ store: new MemoryLedgerStore(clock), clock, runInstance: 'run-1', evidence: new RecordingSink() });
  const requests: Array<{ url: string; headers: Headers; method: string | undefined }> = [];
  const respond = (response: () => Response) =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers), method: init?.method });
      return response();
    }) as typeof fetch;
  return { guard, requests, respond };
}

const call = guardedCall({ tool: 'POST /orders', args: { sku: 'A-1', qty: 1 }, toolClass: 'money' });

describe('guardedFetch', () => {
  test('sets Idempotency-Key to the action id', async () => {
    const { guard, requests, respond } = setup();
    const result = await guardedFetch(guard, call, 'https://shop.test/orders', { method: 'POST', headers: { 'content-type': 'application/json' } }, respond(() => new Response('{"id":1}', { status: 201 })));
    expect(result).toMatchObject({ status: 'executed', outcome: { kind: 'ok', result: { status: 201, body: '{"id":1}' } } });
    expect(result.status === 'executed' && result.actionId).toMatch(/^ao_[0-9a-f]{24}$/);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.headers.get('idempotency-key')).toBe(result.status === 'executed' ? result.actionId : undefined);
    expect(requests[0]?.headers.get('content-type')).toBe('application/json');
    expect(requests[0]?.method).toBe('POST');
  });

  test('keeps a caller supplied key', async () => {
    const { guard, requests, respond } = setup();
    await guardedFetch(guard, call, 'https://shop.test/orders', { headers: { 'Idempotency-Key': 'caller-key' } }, respond(() => new Response('ok')));
    expect(requests[0]?.headers.get('idempotency-key')).toBe('caller-key');
  });

  test('a non-2xx response is an error result', async () => {
    const { guard, respond } = setup();
    const result = await guardedFetch(guard, call, 'https://shop.test/orders', {}, respond(() => new Response('nope', { status: 502 })));
    expect(result).toMatchObject({ status: 'executed', outcome: { kind: 'error_result', result: { status: 502, body: 'nope' } } });
  });

  test('a second identical call after a network error does not refetch', async () => {
    const { guard, requests } = setup();
    let attempts = 0;
    const flaky = (async () => {
      attempts += 1;
      requests.push({ url: '', headers: new Headers(), method: undefined });
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    const first = await guardedFetch(guard, call, 'https://shop.test/orders', {}, flaky);
    expect(first).toMatchObject({ status: 'executed', outcome: { kind: 'transport_error', error: 'fetch failed' } });
    const second = await guardedFetch(guard, call, 'https://shop.test/orders', {}, flaky);
    expect(second.status).toBe('in_doubt');
    expect(attempts).toBe(1);
  });
});
