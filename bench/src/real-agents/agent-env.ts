import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { ExternalBenchAgent, RunSpend } from '../matrix.js';

export interface RealAgent extends ExternalBenchAgent {
  keyEnv: string;
  requiredEnv: string[];
}

export interface UsageEntry {
  agent: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export const USAGE_FILE_ENV = 'AGENT_ONCE_USAGE_FILE';
export const MAX_RUN_USD_ENV = 'AGENT_ONCE_MAX_RUN_USD';

export function positiveNumberEnv(env: NodeJS.ProcessEnv, name: string, agent: string): number {
  const value = Number(env[name]);
  if (env[name] === undefined || env[name]?.trim() === '' || !(value > 0) || !Number.isFinite(value)) {
    throw new Error(`${agent} needs ${name} as a positive number; refusing to call the model without it`);
  }
  return value;
}

export function recordUsage(env: NodeJS.ProcessEnv, entry: UsageEntry): void {
  const file = env[USAGE_FILE_ENV];
  if (file !== undefined && file !== '') appendFileSync(file, `${JSON.stringify(entry)}\n`);
}

export function readUsage(file: string): RunSpend | undefined {
  if (!existsSync(file)) return undefined;
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
  const entries = lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as UsageEntry];
    } catch {
      return [];
    }
  });
  if (lines.length === 0) return undefined;
  const priced = entries.length === lines.length && entries.every((entry) => typeof entry.costUsd === 'number');
  return {
    inputTokens: entries.reduce((sum, entry) => sum + entry.inputTokens, 0),
    outputTokens: entries.reduce((sum, entry) => sum + entry.outputTokens, 0),
    costUsd: priced ? entries.reduce((sum, entry) => sum + (entry.costUsd ?? 0), 0) : null,
  };
}

export interface AgentTask {
  key: string;
  task: string;
  command: string;
  args: string[];
  serverEnv: Record<string, string>;
}

const PASSED_TO_SERVER = /^(AGENT_ONCE_|PATH$|HOME$|PLAYWRIGHT_)/;

export function hasKey(env: NodeJS.ProcessEnv, keyEnv: string): boolean {
  return (env[keyEnv] ?? '').trim() !== '';
}

export function agentTask(name: string, keyEnv: string, env: NodeJS.ProcessEnv): AgentTask {
  if (!hasKey(env, keyEnv)) throw new Error(`${name} needs ${keyEnv}; refusing to call the model without it`);
  const task = env.AGENT_ONCE_TASK;
  if (task === undefined || task.trim() === '') throw new Error(`${name} needs AGENT_ONCE_TASK`);
  const parsed: unknown = JSON.parse(env.AGENT_ONCE_CHAOS_MCP ?? 'null');
  if (!Array.isArray(parsed) || parsed.length === 0 || !parsed.every((part): part is string => typeof part === 'string')) {
    throw new Error(`${name} needs AGENT_ONCE_CHAOS_MCP as a JSON array of strings`);
  }
  const [command, ...args] = parsed as [string, ...string[]];
  const serverEnv = Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && PASSED_TO_SERVER.test(entry[0])));
  return { key: (env[keyEnv] as string).trim(), task, command, args, serverEnv };
}
