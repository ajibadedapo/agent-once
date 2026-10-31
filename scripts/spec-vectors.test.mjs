import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const load = (file) => JSON.parse(readFileSync(new URL(`../spec/vectors/${file}`, import.meta.url), 'utf8'));
const canonical = load('canonical.json');
const identity = load('identity.json');
const decisions = load('decisions.json');

const DECISION_REASONS = [
  'new',
  'expired',
  'outcome_unknown',
  'not_dispatched',
  'failed_block_on_doubt',
  'failed_within_window',
  'failed_after_window',
  'replay_explicit_intent',
  'replay_undelivered',
  'replay_rerun_explicit_session',
  'replay_rerun_within_window',
  'deliberate_repeat',
  'reconciled_not_happened',
];

test('every vector file has unique case names', () => {
  for (const cases of [canonical, identity, decisions]) {
    assert.equal(new Set(cases.map((entry) => entry.name)).size, cases.length);
  }
});

test('canonical vectors include the required number, ordering and error cases', () => {
  const byCanonical = new Map(canonical.filter((entry) => 'canonical' in entry).map((entry) => [entry.canonical, entry]));
  for (const expected of ['1', '1e+21', '1e-7', '0.1', '0', '{"a":2,"b":1,"z":4,"é":3}']) {
    assert.ok(byCanonical.has(expected), expected);
  }
  assert.ok(canonical.some((entry) => typeof entry.canonical === 'string' && entry.canonical.includes('\\u001f')));
  assert.ok(canonical.filter((entry) => entry.error === 'non_finite').length >= 2);
  assert.ok(canonical.filter((entry) => entry.name.startsWith('rfc8785_number_')).length >= 20);
});

test('identity vectors cover rules, browser, intent keys and occurrences 0 and 3', () => {
  assert.ok(identity.length >= 8);
  assert.ok(identity.some((entry) => entry.identity_rule && 'include' in entry.identity_rule));
  assert.ok(identity.some((entry) => entry.identity_rule && 'exclude' in entry.identity_rule));
  assert.ok(identity.some((entry) => typeof entry.intent_key === 'string'));
  assert.ok(identity.some((entry) => entry.browser && entry.browser.page_url.includes('?')));
  assert.ok(identity.some((entry) => entry.occurrence === 0));
  assert.ok(identity.some((entry) => entry.occurrence === 3));
});

test('decision vectors cover every reason in the decision table', () => {
  assert.deepEqual([...new Set(decisions.map((entry) => entry.expect.reason))].sort(), [...DECISION_REASONS].sort());
});

test('decision vectors include the window end and expiry boundaries', () => {
  const atWindowEnd = decisions.filter(
    (entry) => entry.latest && entry.latest.at_ms + entry.retry_window_ms === entry.now_ms,
  );
  const atExpiry = decisions.filter((entry) => entry.latest && entry.latest.expires_at_ms === entry.now_ms);
  assert.ok(atWindowEnd.length >= 2);
  assert.ok(atWindowEnd.every((entry) => entry.expect.kind === 'execute'));
  assert.ok(atExpiry.length >= 1);
  assert.ok(atExpiry.every((entry) => entry.expect.reason === 'expired'));
});

test('identity action ids hash the intent, occurrence and intended time with non-zero milliseconds', () => {
  for (const entry of identity) {
    assert.ok(Number.isSafeInteger(entry.intended_at_ms) && entry.intended_at_ms % 1000 !== 0, entry.name);
    const preimage = JSON.stringify([entry.intent_hash, entry.occurrence, entry.intended_at_ms]);
    const digest = createHash('sha256').update(preimage, 'utf8').digest('hex');
    assert.equal(entry.action_id, `ao_${digest.slice(0, 24)}`, entry.name);
  }
});

test('the same intent and occurrence at a different intended time gets a different action id', () => {
  const restarted = identity.find((entry) => entry.name.includes('after_prune'));
  assert.ok(restarted);
  const earlier = identity.filter(
    (entry) =>
      entry !== restarted &&
      entry.intent_hash === restarted.intent_hash &&
      entry.occurrence === restarted.occurrence,
  );
  assert.ok(earlier.length >= 1);
  for (const entry of earlier) {
    assert.notEqual(entry.intended_at_ms, restarted.intended_at_ms);
    assert.notEqual(entry.action_id, restarted.action_id);
  }
});

test('browser identity drops the free-text element description', () => {
  const browserCases = identity.filter((entry) => entry.browser);
  assert.ok(browserCases.some((entry) => 'element' in entry.args));
  for (const entry of browserCases) {
    assert.equal('element' in entry.projected, false, entry.name);
    assert.equal(entry.projected.label, entry.browser.label, entry.name);
  }
  const plain = identity.filter((entry) => !entry.browser && 'element' in entry.args);
  assert.ok(plain.length >= 1);
  for (const entry of plain) {
    assert.equal(entry.projected.element, entry.args.element, entry.name);
  }
});
