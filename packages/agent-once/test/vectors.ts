import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export type CanonicalVector =
  | { name: string; input: unknown; canonical: string }
  | { name: string; input: unknown; error: 'non_finite' };

export interface IdentityVector {
  name: string;
  session_key: string;
  tool: string;
  args: Record<string, unknown>;
  identity_rule?: { include: string[] } | { exclude: string[] };
  browser?: { page_url: string; label: string };
  intent_key?: string;
  projected: Record<string, unknown>;
  intent_hash: string;
  occurrence: number;
  intended_at_ms: number;
  action_id: string;
}

const NON_FINITE: Record<string, number> = {
  NaN: Number.NaN,
  Infinity: Number.POSITIVE_INFINITY,
  '-Infinity': Number.NEGATIVE_INFINITY,
};

export function loadVectors<T>(file: string): T[] {
  const path = fileURLToPath(new URL(`../../../spec/vectors/${file}`, import.meta.url));
  return JSON.parse(readFileSync(path, 'utf8')) as T[];
}

export function substituteNonFinite(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(substituteNonFinite);
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value);
    const only = entries[0];
    if (entries.length === 1 && only !== undefined && only[0] === '$number' && typeof only[1] === 'string' && only[1] in NON_FINITE) {
      return NON_FINITE[only[1]];
    }
    return Object.fromEntries(entries.map(([key, inner]) => [key, substituteNonFinite(inner)]));
  }
  return value;
}
