import { describe, expect, test } from 'vitest';
import { parseFaultPlan } from '../../src/chaos/targets/faults.js';
import { START_MS, formFields, pageText, postForm, postJson, send, targetsOnManualClock } from './chaos-harness.js';

const ORDER = { item: 'Blue mug', qty: 1 };
const STALE = '{"error":"stale form: nothing was submitted"}';

describe('chaos faults', () => {
  test('lost_response_after_commit commits and the client sees a socket error', async () => {
    const { targets } = await targetsOnManualClock();
    targets.setFaults([{ target: 'checkout', nth: 1, kind: 'lost_response_after_commit', holdMs: 0 }]);
    await expect(postJson(`${targets.url}/api/checkout`, ORDER, { 'Idempotency-Key': 'ao_lost' })).rejects.toThrow(/socket hang up|ECONNRESET/);
    expect(targets.truth().checkout).toEqual([{ id: 'ORD-1', target: 'checkout', fields: { item: 'Blue mug', qty: '1' }, clientRef: 'ao_lost', atMs: START_MS }]);
    expect(targets.pendingCommits()).toBe(0);
  });

  test('slow_commit commits only after the clock passes holdMs', async () => {
    const { clock, targets } = await targetsOnManualClock();
    targets.setFaults([{ target: 'booking', nth: 1, kind: 'slow_commit', holdMs: 5_000 }]);
    await expect(postJson(`${targets.url}/api/booking`, { slot: 'Mon 10:00', name: 'Sam' })).rejects.toThrow(/socket hang up|ECONNRESET/);
    expect(targets.truth().booking).toEqual([]);
    expect(targets.pendingCommits()).toBe(1);
    clock.advance(4_999);
    expect(targets.truth().booking).toEqual([]);
    clock.advance(1);
    expect(targets.truth().booking).toEqual([{ id: 'BK-1', target: 'booking', fields: { slot: 'Mon 10:00', name: 'Sam' }, clientRef: null, atMs: START_MS + 5_000 }]);
    expect(targets.pendingCommits()).toBe(0);
  });

  test('a slow commit already due commits before the connection drops, on any clock', async () => {
    const { targets } = await targetsOnManualClock();
    targets.setFaults([{ target: 'booking', nth: 1, kind: 'slow_commit', holdMs: 0 }]);
    await expect(postJson(`${targets.url}/api/booking`, { slot: 'Mon 10:00', name: 'Sam' })).rejects.toThrow(/socket hang up|ECONNRESET/);
    expect(targets.truth().booking.map((effect) => [effect.id, effect.atMs])).toEqual([['BK-1', START_MS]]);
    expect(targets.pendingCommits()).toBe(0);
  });

  test('a slow commit honours the idempotency key at commit time', async () => {
    const { clock, targets } = await targetsOnManualClock({ honourIdempotencyKey: true });
    targets.setFaults([{ target: 'ticket', nth: 1, kind: 'slow_commit', holdMs: 3_000 }]);
    const ticket = { title: 'Printer jam', body: 'Jammed.' };
    await expect(postJson(`${targets.url}/api/ticket`, ticket, { 'Idempotency-Key': 'ao_slow' })).rejects.toThrow();
    expect((await postJson(`${targets.url}/api/ticket`, ticket, { 'Idempotency-Key': 'ao_slow' })).status).toBe(201);
    clock.advance(3_000);
    expect(targets.truth().ticket.map((effect) => effect.id)).toEqual(['TCK-1']);
  });

  test('timeout_before_commit never commits', async () => {
    const { clock, targets } = await targetsOnManualClock();
    targets.setFaults([{ target: 'email', nth: 1, kind: 'timeout_before_commit', holdMs: 0 }]);
    await expect(postJson(`${targets.url}/api/email`, { to: 'a@example.test', subject: 'Hi', body: 'Hello' })).rejects.toThrow(/socket hang up|ECONNRESET/);
    clock.advance(3_600_000);
    expect(targets.truth().email).toEqual([]);
    expect(targets.pendingCommits()).toBe(0);
  });

  test('stale_element returns 409 without committing', async () => {
    const { targets } = await targetsOnManualClock();
    targets.setFaults([{ target: 'checkout', nth: 1, kind: 'stale_element', holdMs: 0 }]);
    expect(await postJson(`${targets.url}/api/checkout`, ORDER)).toEqual({ status: 409, body: STALE });
    expect(targets.truth().checkout).toEqual([]);
    expect((await postJson(`${targets.url}/api/checkout`, ORDER)).status).toBe(201);
  });

  test('stale_element on the UI re-renders the form with new element names without committing', async () => {
    const { targets } = await targetsOnManualClock();
    targets.setFaults([{ target: 'ticket', nth: 1, kind: 'stale_element', holdMs: 0 }]);
    const form = await send(`${targets.url}/ticket`);
    const firstFields = formFields(form.body);
    const stale = await postForm(`${targets.url}/ticket/submit`, firstFields);
    expect(stale.status).toBe(409);
    expect(pageText(stale.body)).toContain('stale form: nothing was submitted');
    expect(pageText(stale.body)).toContain('Create ticket');
    const freshFields = formFields(stale.body);
    expect(Object.keys(freshFields).filter((name) => name !== 'reference')).not.toEqual(Object.keys(firstFields).filter((name) => name !== 'reference'));
    expect(targets.truth().ticket).toEqual([]);
    const confirmation = await postForm(`${targets.url}/ticket/submit`, freshFields);
    expect(pageText(confirmation.body)).toMatch(/Ticket TCK-1 created \(reference F-\d+\)/);
    expect(targets.truth().ticket).toHaveLength(1);
  });

  test('nth counts only mutating requests to that target', async () => {
    const { targets } = await targetsOnManualClock();
    targets.setFaults([{ target: 'checkout', nth: 2, kind: 'stale_element', holdMs: 0 }]);
    await send(`${targets.url}/api/checkout`);
    await send(`${targets.url}/checkout`);
    await postJson(`${targets.url}/api/booking`, { slot: 'Mon', name: 'Sam' });
    await postJson(`${targets.url}/api/checkout`, { item: 'missing qty' });
    expect((await postJson(`${targets.url}/api/checkout`, ORDER)).status).toBe(201);
    const form = formFields((await send(`${targets.url}/checkout`)).body);
    expect((await postForm(`${targets.url}/checkout/submit`, form)).status).toBe(409);
    expect((await postJson(`${targets.url}/api/checkout`, ORDER)).status).toBe(201);
    expect(targets.truth().checkout.map((effect) => effect.id)).toEqual(['ORD-1', 'ORD-2']);
  });

  test('setting a plan restarts the count and reset drops pending commits and the plan', async () => {
    const { clock, targets } = await targetsOnManualClock();
    await postJson(`${targets.url}/api/checkout`, ORDER);
    targets.setFaults([{ target: 'checkout', nth: 1, kind: 'slow_commit', holdMs: 1_000 }]);
    await expect(postJson(`${targets.url}/api/checkout`, ORDER)).rejects.toThrow();
    expect(targets.pendingCommits()).toBe(1);
    targets.reset();
    expect(targets.pendingCommits()).toBe(0);
    clock.advance(1_000);
    expect(targets.truth().checkout).toEqual([]);
    expect((await postJson(`${targets.url}/api/checkout`, ORDER)).status).toBe(201);
    expect(targets.truth().checkout.map((effect) => effect.id)).toEqual(['ORD-1']);
  });

  test('a fault plan is validated', () => {
    expect(parseFaultPlan([{ target: 'email', nth: 3, kind: 'slow_commit', holdMs: 250 }])).toEqual([{ target: 'email', nth: 3, kind: 'slow_commit', holdMs: 250 }]);
    expect(parseFaultPlan([{ target: 'email', nth: 1, kind: 'none' }])).toEqual([{ target: 'email', nth: 1, kind: 'none', holdMs: 0 }]);
    expect(() => parseFaultPlan({})).toThrow('a fault plan must be an array');
    expect(() => parseFaultPlan([{ target: 'bank', nth: 1, kind: 'none', holdMs: 0 }])).toThrow('fault 0: unknown target "bank"');
    expect(() => parseFaultPlan([{ target: 'email', nth: 1.5, kind: 'none', holdMs: 0 }])).toThrow('fault 0: nth must be a positive integer');
    expect(() => parseFaultPlan([{ target: 'email', nth: 1, kind: 'crash', holdMs: 0 }])).toThrow('fault 0: unknown kind "crash"');
    expect(() => parseFaultPlan([{ target: 'email', nth: 1, kind: 'slow_commit', holdMs: -1 }])).toThrow('fault 0: holdMs must be a non-negative integer');
  });
});
