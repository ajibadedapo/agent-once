import { isPlainObject, type JsonValue } from '../canonical/jcs.js';

export interface TemplateVars {
  args: Record<string, unknown>;
  actionId: string;
  idempotencyKey?: string;
  captured?: string;
  origin?: string;
}

export class TemplateError extends Error {
  override readonly name: string = 'TemplateError';
}

const PLACEHOLDER = /\{\{\s*([^{}]+?)\s*\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{\s*([^{}]+?)\s*\}\}$/;
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g;

function missing(name: string): never {
  throw new TemplateError(`read-back template: no value for {{${name}}}`);
}

function lookupArg(args: Record<string, unknown>, path: string, name: string): unknown {
  let value: unknown = args;
  for (const key of path.split('.')) {
    if (typeof value !== 'object' || value === null || !Object.hasOwn(value, key)) missing(name);
    value = (value as Record<string, unknown>)[key];
  }
  if (value === undefined) missing(name);
  return value;
}

function lookup(name: string, vars: TemplateVars): unknown {
  if (name === 'action_id') return vars.actionId;
  if (name === 'idempotency_key') return vars.idempotencyKey ?? missing(name);
  if (name === 'captured') return vars.captured ?? missing(name);
  if (name === 'origin') return vars.origin ?? missing(name);
  if (name.startsWith('args.')) return lookupArg(vars.args, name.slice('args.'.length), name);
  throw new TemplateError(`read-back template: unknown placeholder {{${name}}}; use args.<path>, action_id, idempotency_key, captured or origin`);
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function renderString(template: string, vars: TemplateVars, escape: (text: string) => string): string {
  return template.replace(PLACEHOLDER, (_match, name: string) => escape(asText(lookup(name, vars))));
}

export function escapeRegExp(text: string): string {
  return text.replace(REGEX_SPECIAL, '\\$&');
}

export function renderArgs(value: JsonValue, vars: TemplateVars): JsonValue {
  if (typeof value === 'string') {
    const whole = WHOLE_PLACEHOLDER.exec(value);
    if (whole?.[1] !== undefined) return lookup(whole[1], vars) as JsonValue;
    return renderString(value, vars, (text) => text);
  }
  if (Array.isArray(value)) return value.map((item) => renderArgs(item, vars));
  if (value !== null && typeof value === 'object' && isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, renderArgs(item, vars)]));
  }
  return value;
}

export function renderPattern(pattern: string, vars: TemplateVars): string {
  return renderString(pattern, vars, escapeRegExp);
}
