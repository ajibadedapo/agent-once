import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REAL_CLOCK_HOLD_MS, REAL_CLOCK_SETTLE_SECONDS, TARGET_NAMES, type TargetName } from 'agent-once/chaos';
import { BROWSER_RETRY_DELAYS_MS } from './browser-agent.js';
import { FULL_LATENCY, measureLatency, SMOKE_LATENCY, type LatencyReport } from './latency.js';
import { API_SCENARIOS, BROWSER_PATH_SCENARIOS, runBenchMatrix, type BenchRecord } from './matrix.js';
import { CONFIRM_SPEND_FLAG, MAX_SPEND_FLAG, realAgents, realCommand, REAL_RUNS_PER_CELL } from './real-agents/gate.js';
import { renderResults, type CostEstimate, type RealSpend } from './results-md.js';

interface RealStore {
  records: BenchRecord[];
  spend: RealSpend;
}

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const RESULTS_DIR = join(ROOT, 'bench', 'results');
const RESULTS_MD = join(ROOT, 'RESULTS.md');
const REPRODUCE = 'npm ci && npm run build && npx playwright install chromium && npm run bench && npm run bench:browser';
const BROWSER_RUNS_PER_CELL = 3;
const API_RUNS_PER_CELL = 1;
const NEEDS_APPROVAL = "no API key in the environment; needs Hammed's approval";
const REAL_AGENT_LABELS: Readonly<Record<string, string>> = {
  'claude-agent-sdk': 'Claude via the Claude Agent SDK (claude-agent-sdk)',
  openai: 'OpenAI via the Chat Completions API (openai)',
};

const CLAUDE_COST_ESTIMATE: CostEstimate = {
  agent: 'claude-agent-sdk',
  priceSource: "Anthropic's model pricing table as cached on 2026-10-06; re-verify before running",
  prices: [
    { model: 'Claude Sonnet 5.5', inputUsdPerMTok: 2, outputUsdPerMTok: 10, cacheReadUsdPerMTok: 0.2 },
    { model: 'Claude Opus 5.5', inputUsdPerMTok: 4, outputUsdPerMTok: 20, cacheReadUsdPerMTok: 0.2 },
  ],
  turnsPerRun: 8,
  fixedTokensPerTurn: 20_000,
  conversationTokensPerTurn: 2_000,
  outputTokensPerTurn: 500,
  notes: [
    'openai: the cost depends on the model and the prices set in AGENT_ONCE_OPENAI_INPUT_USD_PER_MTOK and AGENT_ONCE_OPENAI_OUTPUT_USD_PER_MTOK, so it is not estimated here.',
    'Suggested first step: a capped pilot on Claude Sonnet 5.5. Set AGENT_ONCE_CLAUDE_MODEL to its model id and run `npm run bench:real -- --confirm-spend --max-spend-usd 25`; bench:real stops launching runs once the cap is reached and this file reports the runs that finished.',
  ],
};

interface Stored<T> {
  measuredAt: string;
  command: string;
  data: T;
}

type StoreName = 'latency' | 'api' | 'browser' | 'real';

function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

function save<T>(name: StoreName, command: string, data: T): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const stored: Stored<T> = { measuredAt: new Date().toISOString(), command, data };
  writeFileSync(join(RESULTS_DIR, `${name}.json`), `${JSON.stringify(stored, null, 2)}\n`);
}

function load<T>(name: StoreName): Stored<T> | undefined {
  const path = join(RESULTS_DIR, `${name}.json`);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Stored<T>) : undefined;
}

function flag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

function targetsArg(argv: string[]): TargetName[] {
  const value = flag(argv, '--targets');
  if (value === undefined) return [...TARGET_NAMES];
  return value.split(',').map((name) => {
    if (!(TARGET_NAMES as readonly string[]).includes(name)) throw new Error(`unknown target ${name}; expected one of ${TARGET_NAMES.join(', ')}`);
    return name as TargetName;
  });
}

function runsArg(argv: string[], fallback: number): number {
  const value = flag(argv, '--runs');
  if (value === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`--runs expects a positive whole number, got ${value}`);
  return Number(value);
}

function packageVersion(name: string, from?: string): string {
  const require = createRequire(from ?? import.meta.url);
  return (JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as { version: string }).version;
}

function browserSetup(): string {
  const require = createRequire(import.meta.url);
  const mcpPackage = require.resolve('@playwright/mcp/package.json');
  const corePackage = createRequire(mcpPackage).resolve('playwright-core/package.json');
  const browsers = (JSON.parse(readFileSync(join(dirname(corePackage), 'browsers.json'), 'utf8')) as { browsers: { name: string; revision: string; browserVersion?: string }[] }).browsers;
  const shell = browsers.find((browser) => browser.name === 'chromium-headless-shell');
  const delays = BROWSER_RETRY_DELAYS_MS.map((delayMs) => delayMs / 1000).join(', ');
  return [
    `A scripted browser agent (scripted-browser:naive) drives the real @playwright/mcp ${packageVersion('@playwright/mcp')} server (playwright-core ${packageVersion('playwright-core', mcpPackage)}) with headless Chromium ${shell?.browserVersion ?? ''} (revision ${shell?.revision ?? 'unknown'}) against the four reference targets on the real clock.`,
    `Each attempt navigates to the form, takes a snapshot, and clicks the submit button; after anything but a confirmation page or a guard replay it waits ${delays} s and tries again (a naive retry).`,
    `Faults that hold a commit hold it for ${REAL_CLOCK_HOLD_MS} ms and the guard's settle window is ${REAL_CLOCK_SETTLE_SECONDS} s, so a run stays short.`,
    'With the guard on, the agent talks to the agent-once proxy wrapping the same Playwright MCP command, configured with the chaos targets preset (browser read-back from each history page).',
  ].join(' ');
}

function notRun(realRecords: BenchRecord[]): string[] {
  const ran = new Set(realRecords.map((record) => record.agent));
  const lines = realAgents()
    .filter((agent) => !ran.has(agent.name))
    .map((agent) => `${REAL_AGENT_LABELS[agent.name] ?? agent.name}, API and browser paths: ${NEEDS_APPROVAL} (run \`npm run bench:real -- ${CONFIRM_SPEND_FLAG} ${MAX_SPEND_FLAG} <dollars>\` with ${[agent.keyEnv, ...agent.requiredEnv].join(', ')} set)`);
  return [
    ...lines,
    'crash_mid_run on the browser path: there is no crash harness for the browser path in this release; it is measured on the API path only.',
    'Postgres and Redis ledgers: not part of v1, so not measured. Every overhead number above is SQLite.',
  ];
}

function writeResults(): void {
  const latency = load<LatencyReport>('latency');
  const api = load<BenchRecord[]>('api');
  const browser = load<BenchRecord[]>('browser');
  const real = load<RealStore>('real');
  const records = [...(api?.data ?? []), ...(browser?.data ?? []), ...(real?.data.records ?? [])];
  const markdown = renderResults({
    command: REPRODUCE,
    generatedAt: new Date().toISOString(),
    latency: latency?.data ?? null,
    records,
    notRun: notRun(real?.data.records ?? []),
    realRunPlan: {
      agents: realAgents().map((agent) => agent.name),
      runsPerCell: REAL_RUNS_PER_CELL,
      apiCells: API_SCENARIOS.length * TARGET_NAMES.length * 2,
      browserCells: BROWSER_PATH_SCENARIOS.length * TARGET_NAMES.length * 2,
    },
    measuredAt: {
      ...(latency === undefined ? {} : { latency: `${latency.measuredAt} by \`${latency.command}\`` }),
      ...(api === undefined ? {} : { api: `${api.measuredAt} by \`${api.command}\`` }),
      ...(browser === undefined ? {} : { browser: `${browser.measuredAt} by \`${browser.command}\`` }),
      ...(real === undefined ? {} : { real: `${real.measuredAt} by \`${real.command}\`` }),
    },
    browserSetup: browserSetup(),
    ...(real === undefined ? {} : { realSpend: real.data.spend }),
    costEstimate: CLAUDE_COST_ESTIMATE,
  });
  writeFileSync(RESULTS_MD, markdown);
  log(`wrote ${RESULTS_MD}`);
}

async function withLedgerDir<T>(run: (ledgerDir: string) => Promise<T>): Promise<T> {
  const ledgerDir = mkdtempSync(join(tmpdir(), 'agent-once-bench-'));
  try {
    return await run(ledgerDir);
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
}

function progress(record: BenchRecord): void {
  const verdict = record.agentError !== undefined ? `agent error: ${record.agentError}` : `${record.effects} effect(s)`;
  log(`${record.path} ${record.agent} guard ${record.guard ? 'on' : 'off'} ${record.scenario} ${record.target}: ${verdict} in ${record.durationMs} ms`);
}

async function latencyCommand(argv: string[]): Promise<number> {
  const smoke = argv.includes('--smoke');
  const sizes = smoke ? SMOKE_LATENCY : FULL_LATENCY;
  const report = await withLedgerDir((ledgerDir) => measureLatency({ ...sizes, ledgerDir }));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (smoke) return 0;
  save('latency', 'npm run bench:latency', report);
  writeResults();
  return 0;
}

async function apiCommand(): Promise<number> {
  const report = await withLedgerDir((ledgerDir) => measureLatency({ ...FULL_LATENCY, ledgerDir }));
  log(`latency: core p50 ${report.core.p50Ms.toFixed(3)} ms, proxy p50 ${report.proxy.p50Ms.toFixed(3)} ms, python p50 ${report.python?.p50Ms.toFixed(3) ?? 'not measured'} ms`);
  save('latency', 'npm run bench', report);
  const records = await withLedgerDir((ledgerDir) =>
    runBenchMatrix({ agents: ['scripted:naive', 'scripted:obedient'], paths: ['api'], runs: API_RUNS_PER_CELL, ledgerDir, onRecord: progress }),
  );
  save('api', 'npm run bench', records);
  writeResults();
  return 0;
}

async function browserCommand(argv: string[]): Promise<number> {
  const runs = runsArg(argv, BROWSER_RUNS_PER_CELL);
  const targets = targetsArg(argv);
  const records = await withLedgerDir((ledgerDir) => runBenchMatrix({ agents: ['scripted:naive'], paths: ['browser'], runs, targets, ledgerDir, onRecord: progress }));
  save('browser', 'npm run bench:browser', records);
  writeResults();
  return 0;
}

async function realRun(argv: string[]): Promise<number> {
  const runRecords: BenchRecord[] = [];
  const outcome = await realCommand({
    env: process.env,
    argv,
    runMatrix: (options) => {
      const agentsInRun = new Set(options.agents.map((agent) => (typeof agent === 'string' ? agent : agent.name)));
      const earlier = (load<RealStore>('real')?.data.records ?? []).filter((record) => !agentsInRun.has(record.agent));
      const limitUsd = options.budget?.limitUsd ?? 0;
      return runBenchMatrix({
        ...options,
        onRecord: (record) => {
          progress(record);
          runRecords.push(record);
          save<RealStore>('real', 'npm run bench:real', { records: [...earlier, ...runRecords], spend: { limitUsd, stoppedAtLimit: options.budget?.stoppedAtLimit ?? false } });
        },
      });
    },
    log,
  });
  const stored = load<RealStore>('real');
  if (runRecords.length > 0 && stored !== undefined && outcome.limitUsd !== undefined) {
    save<RealStore>('real', 'npm run bench:real', { records: stored.data.records, spend: { limitUsd: outcome.limitUsd, stoppedAtLimit: outcome.stoppedAtLimit ?? false } });
    writeResults();
  }
  return outcome.exitCode;
}

const USAGE = 'usage: node dist/main.js latency [--smoke] | api | browser [--runs <n>] [--targets a,b] | real --confirm-spend --max-spend-usd <dollars> | results';

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'latency':
      return latencyCommand(rest);
    case 'api':
      return apiCommand();
    case 'browser':
      return browserCommand(rest);
    case 'real':
      return realRun(rest);
    case 'results':
      writeResults();
      return 0;
    default:
      log(USAGE);
      return 2;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    log(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  },
);
