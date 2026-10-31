import { describe, expect, test } from 'vitest';
import { actionId, intentHash } from '../src/identity/identity.js';
import { BROWSER_VOLATILE_KEYS, DEFAULT_VOLATILE_KEYS, projectArgs } from '../src/identity/project-args.js';
import { loadVectors, type IdentityVector } from './vectors.js';

const vectors = loadVectors<IdentityVector>('identity.json');

function browserIdentity(browser: { page_url: string; label: string }): { page_url: string; label: string } {
  const url = new URL(browser.page_url);
  return { page_url: url.origin + url.pathname, label: browser.label };
}

function project(vector: IdentityVector) {
  if (vector.browser === undefined) return projectArgs(vector.args, vector.identity_rule, DEFAULT_VOLATILE_KEYS);
  return projectArgs(vector.args, vector.identity_rule, BROWSER_VOLATILE_KEYS, browserIdentity(vector.browser));
}

describe('intentHash and actionId match every identity vector', () => {
  test('the vector file covers browser, rule and intent key cases', () => {
    expect(vectors.some((vector) => vector.browser !== undefined)).toBe(true);
    expect(vectors.some((vector) => vector.identity_rule !== undefined)).toBe(true);
    expect(vectors.some((vector) => vector.intent_key !== undefined)).toBe(true);
  });

  for (const vector of vectors) {
    test(vector.name, () => {
      const projected = project(vector);
      expect(projected).toEqual(vector.projected);
      const hash = intentHash({
        sessionKey: vector.session_key,
        tool: vector.tool,
        projectedArgs: projected,
        ...(vector.intent_key === undefined ? {} : { intentKey: vector.intent_key }),
      });
      expect(hash).toBe(vector.intent_hash);
      expect(actionId(hash, vector.occurrence, vector.intended_at_ms)).toBe(vector.action_id);
    });
  }
});

describe('projectArgs removes volatile keys at any depth', () => {
  test('inside nested objects and arrays of arrays', () => {
    const args = {
      ts: 1,
      order: { nonce: 'n', lines: [[{ sku: 'A', requestId: 'r' }], { _meta: {}, qty: 2 }] },
    };
    expect(projectArgs(args, undefined, DEFAULT_VOLATILE_KEYS)).toEqual({
      order: { lines: [[{ sku: 'A' }], { qty: 2 }] },
    });
  });

  test('a __proto__ argument key stays a plain data member', () => {
    const args = JSON.parse('{"__proto__":{"polluted":true},"nested":{"__proto__":{"x":1},"nonce":"n"}}') as Record<string, unknown>;
    const projected = projectArgs(args, undefined, DEFAULT_VOLATILE_KEYS) as Record<string, unknown>;
    expect(Object.getPrototypeOf(projected)).toBe(Object.prototype);
    expect(Object.keys(projected)).toEqual(['__proto__', 'nested']);
    expect(Object.keys(projected.nested as object)).toEqual(['__proto__']);
  });

  test('does not mutate the input', () => {
    const args = { ts: 1, nested: { nonce: 'n', keep: true } };
    projectArgs(args, undefined, DEFAULT_VOLATILE_KEYS);
    expect(args).toEqual({ ts: 1, nested: { nonce: 'n', keep: true } });
  });

  test('the browser keys extend the default keys', () => {
    for (const key of DEFAULT_VOLATILE_KEYS) expect(BROWSER_VOLATILE_KEYS).toContain(key);
    for (const key of ['element', 'target', 'ref', 'uid', 'pageId', 'from_uid', 'to_uid', 'slowly', 'includeSnapshot']) {
      expect(BROWSER_VOLATILE_KEYS).toContain(key);
      expect(DEFAULT_VOLATILE_KEYS).not.toContain(key);
    }
  });
});

describe('include and exclude rules', () => {
  const args = { a: 1, b: { a: 2 }, c: 3, nonce: 'x' };

  test('include keeps only listed top-level keys that are present', () => {
    expect(projectArgs(args, { include: ['a', 'nonce', 'missing'] }, DEFAULT_VOLATILE_KEYS)).toEqual({ a: 1 });
  });

  test('exclude removes listed top-level keys only', () => {
    expect(projectArgs(args, { exclude: ['a'] }, DEFAULT_VOLATILE_KEYS)).toEqual({ b: { a: 2 }, c: 3 });
  });

  test('extra identity replaces argument keys after the rule', () => {
    expect(projectArgs({ label: 'spoofed', a: 1 }, { include: ['a'] }, DEFAULT_VOLATILE_KEYS, { label: 'real' })).toEqual({
      a: 1,
      label: 'real',
    });
  });
});

describe('explicit intent key ignores args', () => {
  test('different projected args give the same hash under one intent key', () => {
    const base = { sessionKey: 's', tool: 'place_order', intentKey: 'cart-1' };
    expect(intentHash({ ...base, projectedArgs: { qty: 1 } })).toBe(intentHash({ ...base, projectedArgs: { qty: 9 } }));
  });

  test('an intent key hash differs from the args hash and from other sessions and tools', () => {
    const projectedArgs = { qty: 1 };
    const keyed = intentHash({ sessionKey: 's', tool: 't', projectedArgs, intentKey: 'k' });
    expect(keyed).not.toBe(intentHash({ sessionKey: 's', tool: 't', projectedArgs }));
    expect(keyed).not.toBe(intentHash({ sessionKey: 'other', tool: 't', projectedArgs, intentKey: 'k' }));
    expect(keyed).not.toBe(intentHash({ sessionKey: 's', tool: 'other', projectedArgs, intentKey: 'k' }));
  });
});

describe('actionId', () => {
  const hash = intentHash({ sessionKey: 's', tool: 't', projectedArgs: {} });

  test('has the ao_ prefix and 24 lowercase hex characters', () => {
    expect(actionId(hash, 0, 1_761_912_345_678)).toMatch(/^ao_[0-9a-f]{24}$/);
  });

  test('changes with the occurrence and with the intended time', () => {
    const first = actionId(hash, 0, 1_761_912_345_678);
    expect(actionId(hash, 1, 1_761_912_345_678)).not.toBe(first);
    expect(actionId(hash, 0, 1_761_912_345_679)).not.toBe(first);
  });
});
