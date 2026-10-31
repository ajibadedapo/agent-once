import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';
import { loadConfig } from '../config/load.js';
import { ConfigError, type AgentOnceConfig } from '../config/schema.js';
import { JsonlEvidenceSink } from '../evidence/jsonl-sink.js';
import type { EvidenceSink } from '../evidence/types.js';
import { LedgerUnavailableError } from '../ledger/errors.js';
import { SqliteLedgerStore } from '../ledger/sqlite-store.js';
import type { Clock } from '../time/clock.js';

export interface CliIo {
  env: NodeJS.ProcessEnv;
  cwd: string;
  homedir: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_CONFIG = 2;
export const EXIT_LEDGER = 3;

export class CliExit extends Error {
  override readonly name: string = 'CliExit';

  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export function readConfig(io: CliIo, path: string | undefined): AgentOnceConfig {
  try {
    return loadConfig({ ...(path === undefined ? {} : { path }), cwd: io.cwd, env: io.env, homedir: io.homedir });
  } catch (error) {
    if (error instanceof ConfigError) throw new CliExit(EXIT_CONFIG, error.message);
    throw error;
  }
}

export function openLedger(config: AgentOnceConfig, clock: Clock): SqliteLedgerStore {
  try {
    return SqliteLedgerStore.open(config.ledger.path, clock);
  } catch (error) {
    if (error instanceof LedgerUnavailableError) throw new CliExit(EXIT_LEDGER, error.message);
    throw error;
  }
}

const NO_EVIDENCE: EvidenceSink = { emit: () => {} };

export function evidenceSink(config: AgentOnceConfig): EvidenceSink {
  return config.evidence.jsonl === null ? NO_EVIDENCE : new JsonlEvidenceSink(config.evidence.jsonl);
}

export function parseCommandArgs<T extends ParseArgsOptionsConfig>(args: string[], options: T, usage: string): { values: Record<string, string | boolean | undefined>; positionals: string[] } {
  try {
    const parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
    return { values: parsed.values as Record<string, string | boolean | undefined>, positionals: parsed.positionals };
  } catch (error) {
    throw new CliExit(EXIT_USAGE, `${error instanceof Error ? error.message : String(error)}\n${usage}`);
  }
}
