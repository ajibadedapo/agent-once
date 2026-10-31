import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createTargetsMcpServer, DEFAULT_TARGETS_TIMEOUT_MS } from '../../chaos/targets-mcp/server.js';
import { startTargets } from '../../chaos/targets/server.js';
import { systemClock } from '../../time/clock.js';
import { CliExit, EXIT_OK, EXIT_USAGE, parseCommandArgs, type CliIo } from '../io.js';

export const CHAOS_USAGE =
  'Usage: agent-once chaos serve [--port <n>] [--honour-idempotency-key] | agent-once chaos targets-mcp --url <targets url> [--timeout-ms <n>]';

const SHUTDOWN_SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];

const MAX_TIMER_MS = 2_147_483_647;

function wholeNumber(value: string | boolean | undefined, flag: string, fallback: number, range: { min: number; max: number }): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!(parsed >= range.min && parsed <= range.max)) {
    const expected = range.min > 0 ? 'a positive whole number' : 'a whole number';
    throw new CliExit(EXIT_USAGE, `${flag} expects ${expected} up to ${range.max}, got ${String(value)}\n${CHAOS_USAGE}`);
  }
  return parsed;
}

async function untilShutdown(closed?: Promise<void>): Promise<void> {
  let stop: () => void = () => {};
  const signalled = new Promise<void>((resolve) => {
    stop = resolve;
  });
  for (const signal of SHUTDOWN_SIGNALS) process.once(signal, stop);
  try {
    await (closed === undefined ? signalled : Promise.race([signalled, closed]));
  } finally {
    for (const signal of SHUTDOWN_SIGNALS) process.off(signal, stop);
  }
}

async function serve(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parseCommandArgs(args, { port: { type: 'string' }, 'honour-idempotency-key': { type: 'boolean' } }, CHAOS_USAGE);
  if (positionals.length > 0) throw new CliExit(EXIT_USAGE, CHAOS_USAGE);
  const port = wholeNumber(values.port, '--port', 0, { min: 0, max: 65_535 });
  const targets = await startTargets({ clock: systemClock, port, honourIdempotencyKey: values['honour-idempotency-key'] === true });
  io.stdout(`agent-once chaos targets listening on ${targets.url}\n`);
  await untilShutdown();
  await targets.close();
  return EXIT_OK;
}

async function targetsMcp(args: string[]): Promise<number> {
  const { values, positionals } = parseCommandArgs(args, { url: { type: 'string' }, 'timeout-ms': { type: 'string' } }, CHAOS_USAGE);
  if (positionals.length > 0 || typeof values.url !== 'string') throw new CliExit(EXIT_USAGE, CHAOS_USAGE);
  const timeoutMs = wholeNumber(values['timeout-ms'], '--timeout-ms', DEFAULT_TARGETS_TIMEOUT_MS, { min: 1, max: MAX_TIMER_MS });
  const server = createTargetsMcpServer({ url: values.url, timeoutMs, clock: systemClock });
  const closed = new Promise<void>((resolve) => {
    server.onclose = resolve;
  });
  const transport = new StdioServerTransport();
  const stdinEnded = (): void => {
    void server.close();
  };
  process.stdin.once('end', stdinEnded);
  await server.connect(transport);
  await untilShutdown(closed);
  process.stdin.off('end', stdinEnded);
  await server.close();
  return EXIT_OK;
}

export async function runChaos(args: string[], io: CliIo): Promise<number> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case 'serve':
      return serve(rest, io);
    case 'targets-mcp':
      return targetsMcp(rest);
    default:
      throw new CliExit(EXIT_USAGE, CHAOS_USAGE);
  }
}
