import { spawn, type ChildProcess } from 'node:child_process';

export interface ExternalAgentEnv {
  AGENT_ONCE_CHAOS_URL: string;
  AGENT_ONCE_CHAOS_MCP: string;
  AGENT_ONCE_TASK: string;
  AGENT_ONCE_SESSION: string;
}

export interface ExternalAgentOptions {
  command: string[];
  env: ExternalAgentEnv & Record<string, string>;
  timeoutMs: number;
}

export interface ExternalAgentRun {
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>;
  kill(): void;
}

export const DEFAULT_EXTERNAL_AGENT_TIMEOUT_MS = 300_000;
const MAX_STDERR_CHARS = 16_384;

function spawnCommand(command: string[], env: Record<string, string>): ChildProcess {
  const [program, ...args] = command;
  if (program === undefined) throw new Error('an external agent needs a command');
  const stdio: ['ignore', 'ignore', 'pipe'] = ['ignore', 'ignore', 'pipe'];
  return args.length === 0 ? spawn(program, { env, stdio, shell: true }) : spawn(program, args, { env, stdio });
}

export function externalAgentName(command: string[]): string {
  return command.join(' ');
}

export function startExternalAgent(options: ExternalAgentOptions): ExternalAgentRun {
  const child = spawnCommand(options.command, { ...stringEnv(process.env), ...options.env });
  let stderr = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    if (stderr.length < MAX_STDERR_CHARS) stderr += chunk.toString('utf8');
  });
  const kill = (): void => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  };
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string }>((resolve, reject) => {
    const timer = setTimeout(kill, options.timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
  return { exited, kill };
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
