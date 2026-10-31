import { describe, expect, test } from 'vitest';
import { TARGET_NAMES } from '../../src/chaos/targets/catalog.js';
import { DEFAULT_BROWSER_CONFIG } from '../../src/config/schema.js';
import { START_MS, formFields, pageText, postForm, postJson, send, targetsOnManualClock } from './chaos-harness.js';

const BODIES = {
  checkout: { item: 'Blue mug', qty: 2 },
  booking: { slot: '2026-11-03 10:00', name: 'Sam Rivers' },
  email: { to: 'team@example.test', subject: 'Weekly update', body: 'All on track.' },
  ticket: { title: 'Printer jam', body: 'Second floor printer is jammed.' },
} as const;

describe('chaos targets', () => {
  test('each target commits one effect per accepted request and truth lists it', async () => {
    const { clock, targets } = await targetsOnManualClock();
    const replies = [];
    for (const target of TARGET_NAMES) {
      replies.push(await postJson(`${targets.url}/api/${target}`, BODIES[target], { 'Idempotency-Key': `key-${target}` }));
      clock.advance(1);
    }
    expect(replies.map((reply) => reply.status)).toEqual([201, 201, 201, 201]);
    expect(JSON.parse(replies[0]?.body ?? '')).toEqual({
      id: 'ORD-1',
      target: 'checkout',
      fields: { item: 'Blue mug', qty: '2' },
      clientRef: 'key-checkout',
      atMs: START_MS,
    });
    const truth = targets.truth();
    expect(truth.checkout.map((effect) => effect.id)).toEqual(['ORD-1']);
    expect(truth.booking).toEqual([{ id: 'BK-1', target: 'booking', fields: BODIES.booking, clientRef: 'key-booking', atMs: START_MS + 1 }]);
    expect(truth.email).toEqual([{ id: 'MSG-1', target: 'email', fields: BODIES.email, clientRef: 'key-email', atMs: START_MS + 2 }]);
    expect(truth.ticket).toEqual([{ id: 'TCK-1', target: 'ticket', fields: BODIES.ticket, clientRef: 'key-ticket', atMs: START_MS + 3 }]);
    const listed = await send(`${targets.url}/api/booking`);
    expect(listed.status).toBe(200);
    expect(listed.body).toBe(JSON.stringify(truth.booking));
    expect(listed.body).toContain('"clientRef":"key-booking"');
    expect(JSON.parse((await send(`${targets.url}/__truth`)).body)).toEqual(truth);
  });

  test('an invalid request is rejected and commits nothing', async () => {
    const { targets } = await targetsOnManualClock();
    const missing = await postJson(`${targets.url}/api/checkout`, { item: 'Blue mug' });
    expect(missing).toEqual({ status: 400, body: '{"error":"missing field qty"}' });
    const garbled = await send(`${targets.url}/api/ticket`, { method: 'POST', body: '{not json', headers: { 'content-type': 'application/json' } });
    expect(garbled).toEqual({ status: 400, body: '{"error":"the body is not a JSON object"}' });
    expect((await send(`${targets.url}/api/nowhere`)).status).toBe(404);
    expect((await send(`${targets.url}/api/checkout`, { method: 'DELETE' })).status).toBe(405);
    expect(Object.values(targets.truth()).flat()).toEqual([]);
  });

  test('the idempotency key is stored but deduplicates only when honoured', async () => {
    const plain = await targetsOnManualClock();
    await postJson(`${plain.targets.url}/api/ticket`, BODIES.ticket, { 'Idempotency-Key': 'ao_same' });
    await postJson(`${plain.targets.url}/api/ticket`, BODIES.ticket, { 'Idempotency-Key': 'ao_same' });
    expect(plain.targets.truth().ticket.map((effect) => [effect.id, effect.clientRef])).toEqual([
      ['TCK-1', 'ao_same'],
      ['TCK-2', 'ao_same'],
    ]);

    const honouring = await targetsOnManualClock({ honourIdempotencyKey: true });
    const first = await postJson(`${honouring.targets.url}/api/ticket`, BODIES.ticket, { 'Idempotency-Key': 'ao_same' });
    const second = await postJson(`${honouring.targets.url}/api/ticket`, BODIES.ticket, { 'Idempotency-Key': 'ao_same' });
    const unkeyed = await postJson(`${honouring.targets.url}/api/ticket`, BODIES.ticket);
    expect([first.status, second.status, unkeyed.status]).toEqual([201, 200, 201]);
    expect(second.body).toBe(first.body);
    expect(honouring.targets.truth().ticket.map((effect) => [effect.id, effect.clientRef])).toEqual([
      ['TCK-1', 'ao_same'],
      ['TCK-2', null],
    ]);
  });

  test('UI form submit commits and the history page shows the reference', async () => {
    const { targets } = await targetsOnManualClock();
    const form = await send(`${targets.url}/checkout`);
    expect(form.status).toBe(200);
    expect(pageText(form.body)).toContain('Reference F-1');
    expect(pageText(form.body)).toContain('Place order');
    const fields = formFields(form.body);
    expect(fields).toMatchObject({ reference: 'F-1' });
    const emptyHistory = pageText((await send(`${targets.url}/checkout/history`)).body);
    expect(emptyHistory).toContain('Checkout history');
    expect(emptyHistory).not.toContain('F-1');

    const confirmation = await postForm(`${targets.url}/checkout/submit`, fields);
    expect(confirmation.status).toBe(200);
    expect(pageText(confirmation.body)).toContain('Order ORD-1 confirmed (reference F-1)');
    expect(targets.truth().checkout).toEqual([
      { id: 'ORD-1', target: 'checkout', fields: { item: 'Blue mug', qty: '1', reference: 'F-1' }, clientRef: null, atMs: START_MS },
    ]);
    const history = pageText((await send(`${targets.url}/checkout/history`)).body);
    expect(history).toContain('Checkout history');
    expect(history).toContain('F-1: Order ORD-1');
  });

  test('every UI target renders its button and a confirmation the default success markers accept', async () => {
    const { targets } = await targetsOnManualClock();
    const expected = {
      checkout: { button: 'Place order', confirmation: /Order ORD-1 confirmed \(reference F-1\)/ },
      booking: { button: 'Book slot', confirmation: /Booking BK-1 confirmed \(reference F-2\)/ },
      email: { button: 'Send message', confirmation: /Message MSG-1 sent \(reference F-3\)/ },
      ticket: { button: 'Create ticket', confirmation: /Ticket TCK-1 created \(reference F-4\)/ },
    } as const;
    const markers = DEFAULT_BROWSER_CONFIG.successMarkers.map((marker) => new RegExp(marker, 'i'));
    for (const target of TARGET_NAMES) {
      const form = await send(`${targets.url}/${target}`);
      expect(form.body).toContain(`<button type="submit">${expected[target].button}</button>`);
      const confirmation = pageText((await postForm(`${targets.url}/${target}/submit`, formFields(form.body))).body);
      expect(confirmation).toMatch(expected[target].confirmation);
      expect(markers.some((marker) => marker.test(confirmation))).toBe(true);
      expect(markers.some((marker) => marker.test(pageText(form.body)))).toBe(false);
    }
    const index = pageText((await send(`${targets.url}/`)).body);
    for (const target of TARGET_NAMES) expect(index).toContain(target);
  });

  test('a UI submission without a reference is rejected and commits nothing', async () => {
    const { targets } = await targetsOnManualClock();
    const reply = await postForm(`${targets.url}/booking/submit`, { slot: 'tomorrow', name: 'Sam' });
    expect(reply.status).toBe(400);
    expect(pageText(reply.body)).toContain('missing field reference');
    expect(targets.truth().booking).toEqual([]);
  });

  test('truth, faults and reset are reachable over HTTP', async () => {
    const { targets } = await targetsOnManualClock();
    await postJson(`${targets.url}/api/email`, BODIES.email);
    const faults = await postJson(`${targets.url}/__faults`, [{ target: 'email', nth: 1, kind: 'stale_element', holdMs: 0 }]);
    expect(faults.status).toBe(200);
    expect((await postJson(`${targets.url}/api/email`, BODIES.email)).status).toBe(409);
    const invalid = await postJson(`${targets.url}/__faults`, [{ target: 'email', nth: 0, kind: 'stale_element', holdMs: 0 }]);
    expect(invalid.status).toBe(400);
    expect(JSON.parse((await send(`${targets.url}/__truth`)).body).email).toHaveLength(1);
    expect((await send(`${targets.url}/__reset`, { method: 'POST' })).status).toBe(200);
    expect(JSON.parse((await send(`${targets.url}/__truth`)).body)).toEqual({ checkout: [], booking: [], email: [], ticket: [] });
    expect((await postJson(`${targets.url}/api/email`, BODIES.email)).status).toBe(201);
    expect(targets.truth().email.map((effect) => effect.id)).toEqual(['MSG-1']);
    expect(pageText((await send(`${targets.url}/email`)).body)).toContain('Reference F-1');
  });
});
