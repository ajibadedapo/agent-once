import type { JsonValue } from '../canonical/jcs.js';

export type IdentityRule = { include: string[] } | { exclude: string[] } | undefined;

export const DEFAULT_VOLATILE_KEYS: readonly string[] = Object.freeze([
  'timestamp',
  'ts',
  'nonce',
  'request_id',
  'requestId',
  'idempotency_key',
  'idempotencyKey',
  'trace_id',
  'traceId',
  '_meta',
]);

export const BROWSER_VOLATILE_KEYS: readonly string[] = Object.freeze([
  ...DEFAULT_VOLATILE_KEYS,
  'element',
  'target',
  'ref',
  'uid',
  'pageId',
  'from_uid',
  'to_uid',
  'slowly',
  'includeSnapshot',
]);

function stripVolatile(value: unknown, volatile: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => stripVolatile(item, volatile));
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !volatile.has(key))
      .map(([key, inner]) => [key, stripVolatile(inner, volatile)]),
  );
}

function applyRule(args: Record<string, unknown>, rule: IdentityRule): Record<string, unknown> {
  if (rule === undefined) return args;
  if ('include' in rule) {
    const listed = new Set(rule.include);
    return Object.fromEntries(Object.entries(args).filter(([key]) => listed.has(key)));
  }
  const listed = new Set(rule.exclude);
  return Object.fromEntries(Object.entries(args).filter(([key]) => !listed.has(key)));
}

export function projectArgs(
  args: Record<string, unknown>,
  rule: IdentityRule,
  volatileKeys: readonly string[],
  extraIdentity: Readonly<Record<string, JsonValue>> = {},
): JsonValue {
  const stripped = stripVolatile(args, new Set(volatileKeys)) as Record<string, unknown>;
  return { ...applyRule(stripped, rule), ...extraIdentity } as JsonValue;
}
