import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { renderMarkdown, summarize } from '../../chaos/report.js';
import { runMatrix, type AgentKind, type MatrixOptions, type RunRecord } from '../../chaos/runner.js';
import { isRunnableScenario, SCENARIO_NAMES, type RunnableScenario } from '../../chaos/scenarios.js';
import { isTargetName, TARGET_NAMES, type TargetName } from '../../chaos/targets/catalog.js';
import { createTargetsMcpServer, DEFAULT_TARGETS_TIMEOUT_MS } from '../../chaos/targets-mcp/server.js';
import { startTargets } from '../../chaos/targets/server.js';
import { systemClock } from '../../time/clock.js';
import { CliExit, EXIT_FAILED, EXIT_OK, EXIT_USAGE, parseCommandArgs, type CliIo } from '../io.js';

export const CHAOS_USAGE = [
  'Usage: agent-once chaos serve [--port <n>] [--honour-idempotency-key]',
  'agent-once chaos targets-mcp --url <targets url> [--timeout-ms <n>]',
  'agent-once chaos run [--agent scripted:naive|scripted:obedient|"<command>"] [--scenarios a,b] [--targets a,b] [--guard on|off|both] [--runs <n>] [--json <file>] [--markdown <file>] [--fail-on-duplicates]',
].join(' | ');

export interface ChaosDeps {
  runMatrix: (options: MatrixOptions) => Promise<RunRecord[]>;
}

const DEFAULT_DEPS: ChaosDeps = { runMatrix };

const DEFAULT_AGENTS: readonly AgentKind[] = ['scripted:naive', 'scripted:obedient'];

const GUARD_MODES: readonly MatrixOptions['guard'][] = ['on', 'off', 'both'];

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

function parseAgent(value: string): AgentKind {
  if (value === 'scripted:naive' || value === 'scripted:obedient') return value;
  if (value.startsWith('scripted:')) throw new CliExit(EXIT_USAGE, `unknown scripted agent ${value}; expected scripted:naive or scripted:obedient\n${CHAOS_USAGE}`);
  if (value.trim() === '') throw new CliExit(EXIT_USAGE, `--agent expects a scripted agent or a command\n${CHAOS_USAGE}`);
  return { external: [value] };
}

function parseList<T extends string>(value: string | boolean | undefined, fallback: readonly T[], accept: (item: string) => item is T, noun: string, known: readonly string[]): T[] {
  if (typeof value !== 'string') return [...fallback];
  return value.split(',').map((item) => {
    const name = item.trim();
    if (!accept(name)) throw new CliExit(EXIT_USAGE, `unknown ${noun} ${name}; expected one of ${known.join(', ')}\n${CHAOS_USAGE}`);
    return name;
  });
}

function parseGuard(value: string | boolean | undefined): MatrixOptions['guard'] {
  if (value === undefined) return 'both';
  if (typeof value === 'string' && (GUARD_MODES as readonly string[]).includes(value)) return value as MatrixOptions['guard'];
  throw new CliExit(EXIT_USAGE, `--guard expects on, off or both, got ${String(value)}\n${CHAOS_USAGE}`);
}

async function run(args: string[], io: CliIo, deps: ChaosDeps): Promise<number> {
  const { values, positionals } = parseCommandArgs(
    args,
    {
      agent: { type: 'string', multiple: true },
      scenarios: { type: 'string' },
      targets: { type: 'string' },
      guard: { type: 'string' },
      runs: { type: 'string' },
      json: { type: 'string' },
      markdown: { type: 'string' },
      'fail-on-duplicates': { type: 'boolean' },
    },
    CHAOS_USAGE,
  );
  if (positionals.length > 0) throw new CliExit(EXIT_USAGE, CHAOS_USAGE);
  const agentValues = values.agent as unknown as string[] | undefined;
  const agents = agentValues === undefined ? [...DEFAULT_AGENTS] : agentValues.map(parseAgent);
  const scenarios = parseList<RunnableScenario>(values.scenarios, SCENARIO_NAMES, isRunnableScenario, 'scenario', [...SCENARIO_NAMES, 'no_fault']);
  const targets = parseList<TargetName>(values.targets, TARGET_NAMES, (item): item is TargetName => isTargetName(item), 'target', TARGET_NAMES);
  const guard = parseGuard(values.guard);
  const runs = wholeNumber(values.runs, '--runs', 1, { min: 1, max: 1_000_000 });
  const ledgerDir = mkdtempSync(join(tmpdir(), 'agent-once-chaos-'));
  let records: RunRecord[];
  try {
    records = await deps.runMatrix({ agents, scenarios, targets, guard, runs, ledgerDir, log: (message) => io.stderr(`${message}\n`) });
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
  const summary = summarize(records);
  const markdown = renderMarkdown(summary);
  io.stdout(markdown);
  if (typeof values.markdown === 'string') writeFileSync(values.markdown, markdown);
  if (typeof values.json === 'string') writeFileSync(values.json, `${JSON.stringify({ summary, records }, null, 2)}\n`);
  const duplicates = summary.totals.guardedDuplicates;
  if (values['fail-on-duplicates'] === true && duplicates > 0) {
    io.stderr(`agent-once chaos: ${duplicates} guarded run${duplicates === 1 ? '' : 's'} duplicated an effect\n`);
    return EXIT_FAILED;
  }
  return EXIT_OK;
}

export async function runChaos(args: string[], io: CliIo, deps: ChaosDeps = DEFAULT_DEPS): Promise<number> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case 'run':
      return run(rest, io, deps);
    case 'serve':
      return serve(rest, io);
    case 'targets-mcp':
      return targetsMcp(rest);
    default:
      throw new CliExit(EXIT_USAGE, CHAOS_USAGE);
  }
}
