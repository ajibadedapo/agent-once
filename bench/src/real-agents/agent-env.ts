import type { ExternalBenchAgent } from '../matrix.js';

export interface RealAgent extends ExternalBenchAgent {
  keyEnv: string;
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
