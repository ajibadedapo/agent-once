import { randomUUID } from 'node:crypto';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Guard } from '../../guard/guard.js';
import { createProxy, type RunningProxy } from '../../mcp/proxy.js';
import { UpstreamStdioTransport } from '../../mcp/upstream.js';
import { SESSION_ENV } from '../../mcp/meta.js';
import { systemClock } from '../../time/clock.js';
import { CliExit, EXIT_FAILED, EXIT_USAGE, evidenceSink, guardSettings, openLedger, parseCommandArgs, readConfig, type CliIo } from '../io.js';

export const MCP_USAGE = 'Usage: agent-once mcp [--config <file>] [--session <key>] -- <command> [args...]';

const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function splitAtSeparator(args: string[]): { options: string[]; server: string[] } {
  const separator = args.indexOf('--');
  if (separator === -1) throw new CliExit(EXIT_USAGE, MCP_USAGE);
  return { options: args.slice(0, separator), server: args.slice(separator + 1) };
}

function closeOnShutdown(proxy: RunningProxy): () => void {
  const shutdown = (): void => {
    void proxy.close();
  };
  process.stdin.once('end', shutdown);
  for (const signal of SHUTDOWN_SIGNALS) process.once(signal, shutdown);
  return () => {
    process.stdin.off('end', shutdown);
    for (const signal of SHUTDOWN_SIGNALS) process.off(signal, shutdown);
  };
}

export async function runMcp(args: string[], io: CliIo): Promise<number> {
  const { options, server } = splitAtSeparator(args);
  const { values, positionals } = parseCommandArgs(options, { config: { type: 'string' }, session: { type: 'string' } }, MCP_USAGE);
  const [command, ...commandArgs] = server;
  if (command === undefined || positionals.length > 0) throw new CliExit(EXIT_USAGE, MCP_USAGE);
  const env = typeof values.session === 'string' ? { ...io.env, [SESSION_ENV]: values.session } : io.env;
  const config = readConfig({ ...io, env }, typeof values.config === 'string' ? values.config : undefined);
  const store = openLedger(config, systemClock);
  const runInstance = randomUUID();
  const upstream = new UpstreamStdioTransport({ command, args: commandArgs, env: stringEnv(env), cwd: io.cwd, stderr: 'inherit' });
  let proxy: RunningProxy;
  try {
    proxy = await createProxy({
      client: new StdioServerTransport(),
      upstream,
      guard: () => new Guard({ store, clock: systemClock, runInstance, evidence: evidenceSink(config), ...guardSettings(config) }),
      config,
      clock: systemClock,
      cwd: io.cwd,
      env,
    });
  } catch (error) {
    store.close();
    throw new CliExit(EXIT_FAILED, `agent-once: cannot start ${command}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const detach = closeOnShutdown(proxy);
  try {
    const { upstreamExitCode } = await proxy.closed;
    return upstreamExitCode ?? EXIT_FAILED;
  } finally {
    detach();
    store.close();
    process.stdin.destroy();
  }
}
