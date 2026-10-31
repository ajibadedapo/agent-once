import { describe, expect, test } from 'vitest';
import { CanonicalizationError, canonicalize } from '../src/canonical/jcs.js';
import { loadVectors, substituteNonFinite, type CanonicalVector } from './vectors.js';

const vectors = loadVectors<CanonicalVector>('canonical.json');

describe('canonical matches every spec vector', () => {
  test('the vector file is not empty', () => {
    expect(vectors.length).toBeGreaterThan(40);
  });

  for (const vector of vectors) {
    test(vector.name, () => {
      if ('canonical' in vector) {
        expect(canonicalize(vector.input)).toBe(vector.canonical);
      } else {
        expect(() => canonicalize(substituteNonFinite(vector.input))).toThrow(CanonicalizationError);
      }
    });
  }
});

function thrownBy(fn: () => unknown): CanonicalizationError {
  try {
    fn();
  } catch (error) {
    if (error instanceof CanonicalizationError) return error;
    throw error;
  }
  throw new Error('expected a CanonicalizationError');
}

describe('canonical throws CanonicalizationError with the path for NaN and Infinity', () => {
  test('NaN in an object member', () => {
    expect(thrownBy(() => canonicalize({ price: Number.NaN })).path).toBe('$.price');
  });

  test('Infinity nested in arrays and objects', () => {
    const error = thrownBy(() => canonicalize({ items: [1, [{ qty: Number.POSITIVE_INFINITY }]] }));
    expect(error.path).toBe('$.items[1][0].qty');
    expect(error.message).toContain('$.items[1][0].qty');
  });

  test('-Infinity at the top level', () => {
    expect(thrownBy(() => canonicalize(Number.NEGATIVE_INFINITY)).path).toBe('$');
  });

  test('keys that are not identifiers are quoted in the path', () => {
    expect(thrownBy(() => canonicalize({ 'a b': Number.NaN })).path).toBe('$["a b"]');
  });
});

describe('canonical rejects values JSON cannot represent', () => {
  test('undefined inside an array', () => {
    expect(thrownBy(() => canonicalize([1, undefined])).path).toBe('$[1]');
  });

  test('a function', () => {
    expect(thrownBy(() => canonicalize({ run: () => 1 })).path).toBe('$.run');
  });

  test('a bigint', () => {
    expect(thrownBy(() => canonicalize({ amount: 10n })).path).toBe('$.amount');
  });

  test('a symbol', () => {
    expect(thrownBy(() => canonicalize([Symbol('s')])).path).toBe('$[0]');
  });

  test('top-level undefined', () => {
    expect(thrownBy(() => canonicalize(undefined)).path).toBe('$');
  });

  test('a non-plain object such as a Date', () => {
    expect(thrownBy(() => canonicalize({ when: new Date(1_761_912_345_678) })).path).toBe('$.when');
  });

  test('a lone surrogate in a string or key', () => {
    expect(thrownBy(() => canonicalize({ text: 'a\ud800' })).path).toBe('$.text');
    expect(thrownBy(() => canonicalize({ outer: { ['\udc00']: 1 } })).path).toBe('$.outer["\\udc00"]');
  });

  test('a cycle', () => {
    const looped: Record<string, unknown> = {};
    looped.self = looped;
    expect(thrownBy(() => canonicalize(looped)).path).toBe('$.self');
  });
});

describe('canonical object members', () => {
  test('members whose value is undefined are omitted', () => {
    expect(canonicalize({ b: undefined, a: 1 })).toBe('{"a":1}');
  });

  test('objects with a null prototype are accepted', () => {
    const bare = Object.create(null) as Record<string, unknown>;
    bare.z = 1;
    bare.a = 2;
    expect(canonicalize(bare)).toBe('{"a":2,"z":1}');
  });

  test('the same object may appear twice without being a cycle', () => {
    const shared = { k: 1 };
    expect(canonicalize([shared, shared])).toBe('[{"k":1},{"k":1}]');
  });
});
