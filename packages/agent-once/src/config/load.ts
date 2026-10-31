import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { ConfigError, parseConfig, type AgentOnceConfig } from './schema.js';

export interface LoadConfigOptions {
  path?: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  homedir: string;
}

const DEFAULTS_SOURCE = '(defaults)';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function loadConfig(opts: LoadConfigOptions): AgentOnceConfig {
  if (opts.path === undefined) return parseConfig({}, { file: DEFAULTS_SOURCE, baseDir: opts.cwd, env: opts.env, homedir: opts.homedir });
  const file = resolve(opts.cwd, opts.path);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new ConfigError(file, '', `cannot read the file: ${errorMessage(error)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(file, '', `invalid JSON: ${errorMessage(error)}`);
  }
  return parseConfig(raw, { file, baseDir: dirname(file), env: opts.env, homedir: opts.homedir });
}
