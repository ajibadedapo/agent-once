export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export class CanonicalizationError extends Error {
  override readonly name = 'CanonicalizationError';
  readonly path: string;

  constructor(path: string, problem: string) {
    super(`cannot canonicalize ${problem} at ${path}`);
    this.path = path;
  }
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

function memberPath(parent: string, key: string): string {
  return IDENTIFIER.test(key) ? `${parent}.${key}` : `${parent}[${JSON.stringify(key)}]`;
}

function serializeString(value: string, path: string): string {
  if (LONE_SURROGATE.test(value)) throw new CanonicalizationError(path, 'a string with a lone surrogate');
  return JSON.stringify(value);
}

function isPlainObject(value: object): boolean {
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalizationError(path, `the non-finite number ${String(value)}`);
      return String(value);
    case 'string':
      return serializeString(value, path);
    case 'object':
      if (value === null) return 'null';
      if (ancestors.has(value)) throw new CanonicalizationError(path, 'a cyclic reference');
      ancestors.add(value);
      try {
        return Array.isArray(value) ? serializeArray(value, path, ancestors) : serializeObject(value, path, ancestors);
      } finally {
        ancestors.delete(value);
      }
    default:
      throw new CanonicalizationError(path, `a value of type ${typeof value}`);
  }
}

function serializeArray(value: unknown[], path: string, ancestors: Set<object>): string {
  return `[${value.map((item, index) => serialize(item, `${path}[${index}]`, ancestors)).join(',')}]`;
}

function serializeObject(value: object, path: string, ancestors: Set<object>): string {
  if (!isPlainObject(value)) throw new CanonicalizationError(path, 'an object that is not a plain object');
  const record = value as Record<string, unknown>;
  const members: string[] = [];
  for (const key of Object.keys(record).sort()) {
    const member = record[key];
    if (member === undefined) continue;
    members.push(`${serializeString(key, path)}:${serialize(member, memberPath(path, key), ancestors)}`);
  }
  return `{${members.join(',')}}`;
}

export function canonicalize(value: unknown): string {
  return serialize(value, '$', new Set());
}
