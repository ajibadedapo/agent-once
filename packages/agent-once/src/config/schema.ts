import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { JsonValue } from '../canonical/jcs.js';
import type { IdentityRule } from '../identity/project-args.js';
import { defaultLedgerPath } from '../ledger/sqlite-store.js';
import type { ToolClass } from '../ledger/types.js';

export type ToolPolicy = 'guard' | 'pass' | 'block-on-doubt';

export interface ReadBackStep {
  tool: string;
  args: Record<string, JsonValue>;
}

export interface ReadBackRule {
  steps: ReadBackStep[];
  happened?: string;
  notHappened?: string;
}

export interface ToolRule {
  policy?: ToolPolicy;
  class?: ToolClass;
  identity?: Exclude<IdentityRule, undefined>;
  readBack?: ReadBackRule;
  notDispatchedErrors?: string[];
}

export interface BrowserConfig {
  enabled: 'auto' | boolean;
  [key: string]: unknown;
}

export interface ApprovalWebhookConfig {
  url: string;
  timeoutSeconds: number;
  secretEnv?: string;
}

export interface AgentOnceConfig {
  ledger: { path: string; expiryHours: number; retryWindowSeconds: number; settleSeconds: number; storeArgs: boolean };
  evidence: { jsonl: string | null };
  approvalWebhook?: ApprovalWebhookConfig;
  exposeResolveTool: boolean;
  tools: Record<string, ToolRule>;
  browser: BrowserConfig;
}

export interface ConfigContext {
  file: string;
  baseDir: string;
  env: NodeJS.ProcessEnv;
  homedir: string;
}

export const DEFAULT_EXPIRY_HOURS = 24;
export const DEFAULT_RETRY_WINDOW_SECONDS = 120;
export const DEFAULT_SETTLE_SECONDS = 10;
export const DEFAULT_WEBHOOK_TIMEOUT_SECONDS = 120;
const EVIDENCE_FILE = 'events.jsonl';
const POLICIES: readonly ToolPolicy[] = ['guard', 'pass', 'block-on-doubt'];
const CLASSES: readonly ToolClass[] = ['money', 'irreversible', 'standard'];

export class ConfigError extends Error {
  override readonly name: string = 'ConfigError';
  readonly file: string;
  readonly path: string;

  constructor(file: string, path: string, problem: string) {
    super(`agent-once config error in ${file} at ${path === '' ? '(root)' : path}: ${problem}`);
    this.file = file;
    this.path = path;
  }
}

type Fields = Record<string, unknown>;

function pointer(parent: string, key: string | number): string {
  return `${parent}/${String(key).replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function describe(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

class Reader {
  constructor(private readonly file: string) {}

  fail(path: string, problem: string): never {
    throw new ConfigError(this.file, path, problem);
  }

  object(value: unknown, path: string, allowed?: readonly string[]): Fields {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) this.fail(path, `expected an object, got ${describe(value)}`);
    const fields = value as Fields;
    if (allowed !== undefined) {
      for (const key of Object.keys(fields)) {
        if (!allowed.includes(key)) this.fail(pointer(path, key), `unknown key "${key}"; expected one of ${allowed.join(', ')}`);
      }
    }
    return fields;
  }

  string(value: unknown, path: string): string {
    if (typeof value !== 'string' || value === '') this.fail(path, `expected a non-empty string, got ${describe(value)}`);
    return value;
  }

  boolean(value: unknown, path: string): boolean {
    if (typeof value !== 'boolean') this.fail(path, `expected true or false, got ${describe(value)}`);
    return value;
  }

  number(value: unknown, path: string, minimum: number, exclusive: boolean): number {
    const ok = typeof value === 'number' && Number.isFinite(value) && (exclusive ? value > minimum : value >= minimum);
    if (!ok) this.fail(path, `expected a number ${exclusive ? 'greater than' : 'at least'} ${minimum}, got ${describe(value)}`);
    return value as number;
  }

  oneOf<T extends string>(value: unknown, path: string, options: readonly T[]): T {
    if (typeof value !== 'string' || !options.includes(value as T)) this.fail(path, `expected one of ${options.join(', ')}, got ${describe(value)}`);
    return value as T;
  }

  strings(value: unknown, path: string): string[] {
    if (!Array.isArray(value)) this.fail(path, `expected an array of strings, got ${describe(value)}`);
    return value.map((item, index) => this.string(item, pointer(path, index)));
  }

  regex(value: unknown, path: string): string {
    const source = this.string(value, path);
    try {
      new RegExp(source);
    } catch (error) {
      this.fail(path, `invalid regular expression: ${error instanceof Error ? error.message : String(error)}`);
    }
    return source;
  }

  regexes(value: unknown, path: string): string[] {
    if (!Array.isArray(value)) this.fail(path, `expected an array of regular expressions, got ${describe(value)}`);
    return value.map((item, index) => this.regex(item, pointer(path, index)));
  }

  json(value: unknown, path: string): JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return this.number(value, path, Number.NEGATIVE_INFINITY, false);
    if (Array.isArray(value)) return value.map((item, index) => this.json(item, pointer(path, index)));
    const fields = this.object(value, path);
    return Object.fromEntries(Object.entries(fields).map(([key, item]) => [key, this.json(item, pointer(path, key))]));
  }
}

function resolvePath(value: string, baseDir: string): string {
  return isAbsolute(value) ? value : resolve(baseDir, value);
}

function parseLedger(reader: Reader, raw: unknown, ctx: ConfigContext): AgentOnceConfig['ledger'] {
  const fields = reader.object(raw ?? {}, '/ledger', ['path', 'expiryHours', 'retryWindowSeconds', 'settleSeconds', 'storeArgs']);
  const ledger = {
    path: fields.path === undefined ? defaultLedgerPath(ctx.env, ctx.homedir) : resolvePath(reader.string(fields.path, '/ledger/path'), ctx.baseDir),
    expiryHours: fields.expiryHours === undefined ? DEFAULT_EXPIRY_HOURS : reader.number(fields.expiryHours, '/ledger/expiryHours', 0, true),
    retryWindowSeconds:
      fields.retryWindowSeconds === undefined
        ? DEFAULT_RETRY_WINDOW_SECONDS
        : reader.number(fields.retryWindowSeconds, '/ledger/retryWindowSeconds', 0, true),
    settleSeconds: fields.settleSeconds === undefined ? DEFAULT_SETTLE_SECONDS : reader.number(fields.settleSeconds, '/ledger/settleSeconds', 0, false),
    storeArgs: fields.storeArgs === undefined ? true : reader.boolean(fields.storeArgs, '/ledger/storeArgs'),
  };
  if (ledger.settleSeconds > ledger.retryWindowSeconds) {
    reader.fail('/ledger/settleSeconds', `must not exceed retryWindowSeconds (${ledger.retryWindowSeconds})`);
  }
  return ledger;
}

function parseEvidence(reader: Reader, raw: unknown, ctx: ConfigContext): AgentOnceConfig['evidence'] {
  const fields = reader.object(raw ?? {}, '/evidence', ['jsonl']);
  if (fields.jsonl === undefined) return { jsonl: join(dirname(defaultLedgerPath(ctx.env, ctx.homedir)), EVIDENCE_FILE) };
  if (fields.jsonl === null) return { jsonl: null };
  return { jsonl: resolvePath(reader.string(fields.jsonl, '/evidence/jsonl'), ctx.baseDir) };
}

function parseWebhook(reader: Reader, raw: unknown): ApprovalWebhookConfig {
  const fields = reader.object(raw, '/approvalWebhook', ['url', 'timeoutSeconds', 'secretEnv']);
  const url = reader.string(fields.url, '/approvalWebhook/url');
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    reader.fail('/approvalWebhook/url', `expected an http or https URL, got ${describe(url)}`);
  }
  if (protocol !== 'http:' && protocol !== 'https:') reader.fail('/approvalWebhook/url', `expected an http or https URL, got ${describe(url)}`);
  const webhook: ApprovalWebhookConfig = {
    url,
    timeoutSeconds:
      fields.timeoutSeconds === undefined ? DEFAULT_WEBHOOK_TIMEOUT_SECONDS : reader.number(fields.timeoutSeconds, '/approvalWebhook/timeoutSeconds', 0, true),
  };
  if (fields.secretEnv !== undefined) webhook.secretEnv = reader.string(fields.secretEnv, '/approvalWebhook/secretEnv');
  return webhook;
}

function parseIdentity(reader: Reader, raw: unknown, path: string): Exclude<IdentityRule, undefined> {
  const fields = reader.object(raw, path, ['include', 'exclude']);
  if (fields.include !== undefined && fields.exclude !== undefined) reader.fail(path, 'use either include or exclude, not both');
  if (fields.include !== undefined) return { include: reader.strings(fields.include, pointer(path, 'include')) };
  if (fields.exclude !== undefined) return { exclude: reader.strings(fields.exclude, pointer(path, 'exclude')) };
  return reader.fail(path, 'expected include or exclude');
}

function parseReadBack(reader: Reader, raw: unknown, path: string): ReadBackRule {
  const fields = reader.object(raw, path, ['steps', 'happened', 'notHappened']);
  const stepsPath = pointer(path, 'steps');
  if (!Array.isArray(fields.steps)) reader.fail(stepsPath, `expected an array of steps, got ${describe(fields.steps)}`);
  const steps = fields.steps.map((item: unknown, index: number): ReadBackStep => {
    const stepPath = pointer(stepsPath, index);
    const step = reader.object(item, stepPath, ['tool', 'args']);
    const argsPath = pointer(stepPath, 'args');
    const args = reader.json(reader.object(step.args ?? {}, argsPath), argsPath) as Record<string, JsonValue>;
    return { tool: reader.string(step.tool, pointer(stepPath, 'tool')), args };
  });
  const rule: ReadBackRule = { steps };
  if (fields.happened !== undefined) rule.happened = reader.regex(fields.happened, pointer(path, 'happened'));
  if (fields.notHappened !== undefined) rule.notHappened = reader.regex(fields.notHappened, pointer(path, 'notHappened'));
  return rule;
}

function parseToolRule(reader: Reader, raw: unknown, path: string): ToolRule {
  const fields = reader.object(raw, path, ['policy', 'class', 'identity', 'readBack', 'notDispatchedErrors']);
  const rule: ToolRule = {};
  if (fields.policy !== undefined) rule.policy = reader.oneOf(fields.policy, pointer(path, 'policy'), POLICIES);
  if (fields.class !== undefined) rule.class = reader.oneOf(fields.class, pointer(path, 'class'), CLASSES);
  if (fields.identity !== undefined) rule.identity = parseIdentity(reader, fields.identity, pointer(path, 'identity'));
  if (fields.readBack !== undefined) rule.readBack = parseReadBack(reader, fields.readBack, pointer(path, 'readBack'));
  if (fields.notDispatchedErrors !== undefined) rule.notDispatchedErrors = reader.regexes(fields.notDispatchedErrors, pointer(path, 'notDispatchedErrors'));
  return rule;
}

function parseTools(reader: Reader, raw: unknown): Record<string, ToolRule> {
  const fields = reader.object(raw ?? {}, '/tools');
  const tools: Record<string, ToolRule> = {};
  for (const [name, rule] of Object.entries(fields)) {
    const path = pointer('/tools', name);
    if (name === '') reader.fail(path, 'a tool name or glob must not be empty');
    tools[name] = parseToolRule(reader, rule, path);
  }
  return tools;
}

function parseBrowser(reader: Reader, raw: unknown): BrowserConfig {
  const fields = reader.object(raw ?? {}, '/browser');
  const enabled = fields.enabled === undefined ? 'auto' : fields.enabled;
  if (enabled !== 'auto' && typeof enabled !== 'boolean') reader.fail('/browser/enabled', `expected "auto", true or false, got ${describe(enabled)}`);
  return { ...fields, enabled };
}

export function parseConfig(raw: unknown, ctx: ConfigContext): AgentOnceConfig {
  const reader = new Reader(ctx.file);
  const fields = reader.object(raw, '', ['ledger', 'evidence', 'approvalWebhook', 'exposeResolveTool', 'tools', 'browser']);
  const config: AgentOnceConfig = {
    ledger: parseLedger(reader, fields.ledger, ctx),
    evidence: parseEvidence(reader, fields.evidence, ctx),
    exposeResolveTool: fields.exposeResolveTool === undefined ? true : reader.boolean(fields.exposeResolveTool, '/exposeResolveTool'),
    tools: parseTools(reader, fields.tools),
    browser: parseBrowser(reader, fields.browser),
  };
  if (fields.approvalWebhook !== undefined) config.approvalWebhook = parseWebhook(reader, fields.approvalWebhook);
  return config;
}
