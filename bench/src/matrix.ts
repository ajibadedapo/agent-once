import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { ManualClock, systemClock } from 'agent-once';
import {
  BROWSER_SCENARIOS,
  chaosTargetsPreset,
  checkEffects,
  flushPendingCommits,
  REAL_CLOCK_HOLD_MS,
  REAL_CLOCK_SETTLE_SECONDS,
  CHAOS_START_MS,
  runScenario,
  runsFor,
  SCENARIO_NAMES,
  SCENARIOS,
  startExternalAgent,
  startTargets,
  TARGET_NAMES,
  TARGETS,
  type RunnableScenario,
  type RunRecord,
  type RunScenarioOptions,
  type ScenarioSpec,
  type TargetName,
} from 'agent-once/chaos';
import { guardMcpServers } from 'agent-once/claude-agent-sdk';
import { naiveBrowserAgent } from './browser-agent.js';
import { MAX_RUN_USD_ENV, readUsage, USAGE_FILE_ENV } from './real-agents/agent-env.js';
import type { SpendBudget } from './real-agents/budget.js';

export type BenchPath = 'api' | 'browser';

export interface ExternalBenchAgent {
  name: string;
  external: string[];
}

export type BenchAgent = 'scripted:naive' | 'scripted:obedient' | ExternalBenchAgent;

export interface RunSpend {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface BenchRecord {
  path: BenchPath;
  scenario: string;
  target: string;
  agent: string;
  guard: boolean;
  effects: number;
  duplicate: boolean;
  missing: boolean;
  agentCalls: number | null;
  blockedOrDoubt: number | null;
  durationMs: number;
  responseChars: number | null;
  snapshotChars?: number[];
  spend?: RunSpend;
  agentExitCode?: number | null;
  agentError?: string;
}

export interface BenchMatrixOptions {
  agents: BenchAgent[];
  paths: BenchPath[];
  runs: number;
  ledgerDir: string;
  targets?: TargetName[];
  agentTimeoutMs?: number;
  budget?: SpendBudget;
  log?: (message: string) => void;
  onRecord?: (record: BenchRecord) => void;
}

export const API_SCENARIOS = [...SCENARIO_NAMES, 'no_fault' as const];

export const BROWSER_PATH_SCENARIOS = ['no_fault', 'lost_response_after_commit', 'slow_commit', 'timeout_before_commit', 'stale_element', 'connection_reset_after_commit'] as const;

export type BrowserPathScenario = (typeof BROWSER_PATH_SCENARIOS)[number];

export const SCRIPTED_BROWSER_AGENT = 'scripted-browser:naive';

const require = createRequire(import.meta.url);
const AGENT_ONCE_CLI = join(require.resolve('agent-once/package.json'), '..', 'dist', 'cli', 'main.js');
const PLAYWRIGHT_MCP_CLI = join(require.resolve('@playwright/mcp/package.json'), '..', 'cli.js');
const CALL_TIMEOUT_MS = 30_000;
const DEFAULT_EXTERNAL_TIMEOUT_MS = 300_000;
const NO_FAULT: ScenarioSpec = { faultKind: 'none', holdMs: 0, crash: false };

interface StdioCommand {
  command: string;
  args: string[];
  env: Record<string, string>;
}

function agentLabel(agent: BenchAgent, path: BenchPath): string {
  if (typeof agent !== 'string') return agent.name;
  return path === 'browser' ? SCRIPTED_BROWSER_AGENT : agent;
}

function browserSpec(scenario: BrowserPathScenario): ScenarioSpec {
  if (scenario === 'no_fault') return NO_FAULT;
  if (scenario === 'connection_reset_after_commit') return BROWSER_SCENARIOS[scenario];
  return SCENARIOS[scenario];
}

function playwrightServer(home: string): StdioCommand {
  return { command: process.execPath, args: [PLAYWRIGHT_MCP_CLI, '--headless', '--isolated', '--browser', 'chromium', '--output-dir', join(home, 'playwright')], env: {} };
}

function browserServer(guard: boolean, home: string, session: string): StdioCommand {
  const plain = playwrightServer(home);
  if (!guard) return plain;
  const configPath = join(home, 'agent-once.json');
  writeFileSync(configPath, JSON.stringify({ ...chaosTargetsPreset(), ledger: { settleSeconds: REAL_CLOCK_SETTLE_SECONDS }, evidence: { jsonl: null } }));
  const { servers, unguarded } = guardMcpServers({ playwright: plain }, { session, configPath, cliPath: AGENT_ONCE_CLI });
  const wrapped = servers.playwright;
  if (unguarded.length > 0 || wrapped === undefined || !('command' in wrapped)) throw new Error('the Playwright MCP server was not wrapped by the guard');
  return { command: wrapped.command, args: wrapped.args ?? [], env: wrapped.env ?? {} };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Measured = Pick<BenchRecord, 'agentCalls' | 'blockedOrDoubt' | 'responseChars' | 'snapshotChars' | 'agentExitCode' | 'agentError'>;

async function scriptedBrowserRun(server: StdioCommand, home: string, url: string, target: TargetName): Promise<Measured> {
  const client = new Client({ name: SCRIPTED_BROWSER_AGENT, version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: { ...stringEnv(process.env), ...server.env, AGENT_ONCE_HOME: home },
    cwd: home,
    stderr: 'ignore',
  });
  const caller = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> =>
    (await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })) as CallToolResult;
  try {
    await client.connect(transport);
    const run = await naiveBrowserAgent(caller, { url, target }, (ms) => delay(ms));
    return { agentCalls: run.calls, blockedOrDoubt: run.blockedOrDoubt, responseChars: run.responseChars, snapshotChars: run.snapshotChars };
  } catch (error) {
    return { agentCalls: null, blockedOrDoubt: null, responseChars: null, agentError: errorMessage(error) };
  } finally {
    await client.close();
  }
}

function browserPrompt(url: string, target: TargetName): string {
  const { button, title } = TARGETS[target];
  return `Open ${url}/${target} in the browser. The "${title}" form is already filled in. Press the "${button}" button so the form is submitted exactly once. If you are unsure whether it went through, open ${url}/${target}/history to check.`;
}

async function externalBrowserRun(agent: ExternalBenchAgent, server: StdioCommand, home: string, url: string, target: TargetName, session: string, timeoutMs: number): Promise<Measured> {
  const run = startExternalAgent({
    command: agent.external,
    timeoutMs,
    env: {
      AGENT_ONCE_CHAOS_URL: url,
      AGENT_ONCE_CHAOS_MCP: JSON.stringify([server.command, ...server.args]),
      AGENT_ONCE_TASK: browserPrompt(url, target),
      AGENT_ONCE_SESSION: session,
      AGENT_ONCE_HOME: home,
      ...server.env,
    },
  });
  let exit: Awaited<typeof run.exited>;
  try {
    exit = await run.exited;
  } catch (error) {
    return { agentCalls: null, blockedOrDoubt: null, responseChars: null, agentExitCode: null, agentError: `could not start: ${errorMessage(error)}` };
  }
  const { code, signal, stderr } = exit;
  const measured: Measured = { agentCalls: null, blockedOrDoubt: null, responseChars: null, agentExitCode: code };
  if (code === 0) return measured;
  const status = code === null ? `was stopped by ${signal ?? 'an unknown signal'}` : `exited with code ${code}`;
  return { ...measured, agentError: stderr.trim() === '' ? status : `${status}: ${stderr.trim()}` };
}

export interface BrowserScenarioOptions {
  scenario: BrowserPathScenario;
  target: TargetName;
  agent: BenchAgent;
  guard: boolean;
  ledgerDir: string;
  seed: number;
  agentTimeoutMs?: number;
}

export async function runBrowserScenario(options: BrowserScenarioOptions): Promise<BenchRecord> {
  if (options.agent === 'scripted:obedient') throw new Error('the browser path has one scripted agent, scripted:naive');
  const spec = browserSpec(options.scenario);
  const holdMs = spec.holdMs > 0 ? REAL_CLOCK_HOLD_MS : 0;
  const home = mkdtempSync(join(options.ledgerDir, 'browser-'));
  const targets = await startTargets({ clock: systemClock }).catch((error: unknown) => {
    rmSync(home, { recursive: true, force: true });
    throw error;
  });
  try {
    if (spec.faultKind !== 'none') targets.setFaults([{ target: options.target, nth: 1, kind: spec.faultKind, holdMs }]);
    const session = `bench-browser:${options.scenario}:${options.target}:${options.seed}`;
    const server = browserServer(options.guard, home, session);
    const startedMs = Date.now();
    const measured =
      typeof options.agent === 'string'
        ? await scriptedBrowserRun(server, home, targets.url, options.target)
        : await externalBrowserRun(options.agent, server, home, targets.url, options.target, session, options.agentTimeoutMs ?? DEFAULT_EXTERNAL_TIMEOUT_MS);
    const durationMs = Date.now() - startedMs;
    await flushPendingCommits(targets, 'real', holdMs);
    return {
      path: 'browser',
      scenario: options.scenario,
      target: options.target,
      agent: agentLabel(options.agent, 'browser'),
      guard: options.guard,
      ...checkEffects(targets.truth()[options.target], 1),
      ...measured,
      durationMs,
    };
  } finally {
    await targets.close();
    rmSync(home, { recursive: true, force: true });
  }
}

export interface BenchMatrixDeps {
  runApiScenario: (options: RunScenarioOptions) => Promise<RunRecord>;
  runBrowserScenario: (options: BrowserScenarioOptions) => Promise<BenchRecord>;
}

interface Cell {
  path: BenchPath;
  agent: BenchAgent;
  guard: boolean;
  scenario: string;
  target: TargetName;
  seed: number;
}

function* matrixCells(options: BenchMatrixOptions): Generator<Cell> {
  const targets = options.targets ?? [...TARGET_NAMES];
  for (const path of (['api', 'browser'] as const).filter((candidate) => options.paths.includes(candidate))) {
    const scenarios: readonly string[] = path === 'api' ? API_SCENARIOS : BROWSER_PATH_SCENARIOS;
    for (const agent of options.agents) {
      const runs = path === 'api' ? runsFor(typeof agent === 'string' ? agent : { external: agent.external }, options.runs) : options.runs;
      for (const guard of [false, true]) {
        for (const scenario of scenarios) {
          for (const target of targets) {
            for (let seed = 1; seed <= runs; seed += 1) yield { path, agent, guard, scenario, target, seed };
          }
        }
      }
    }
  }
}

interface PaidLaunch {
  agent: ExternalBenchAgent;
  usageFile: string;
  capUsd: number;
}

function paidLaunch(agent: ExternalBenchAgent, budget: SpendBudget, ledgerDir: string, index: number): PaidLaunch {
  const capUsd = budget.remainingUsd();
  const usageFile = join(ledgerDir, `usage-${index}.jsonl`);
  return { agent: { name: agent.name, external: ['env', `${USAGE_FILE_ENV}=${usageFile}`, `${MAX_RUN_USD_ENV}=${capUsd}`, ...agent.external] }, usageFile, capUsd };
}

async function runCell(cell: Cell, agent: BenchAgent, options: BenchMatrixOptions, deps: BenchMatrixDeps): Promise<BenchRecord> {
  const timeout = options.agentTimeoutMs === undefined ? {} : { agentTimeoutMs: options.agentTimeoutMs };
  if (cell.path === 'browser') {
    return deps.runBrowserScenario({ scenario: cell.scenario as BrowserPathScenario, target: cell.target, agent, guard: cell.guard, ledgerDir: options.ledgerDir, seed: cell.seed, ...timeout });
  }
  const record = await deps.runApiScenario({
    scenario: cell.scenario as RunnableScenario,
    target: cell.target,
    agent: typeof agent === 'string' ? agent : { external: agent.external },
    guard: cell.guard,
    clock: typeof agent === 'string' ? new ManualClock(CHAOS_START_MS) : 'real',
    ledgerDir: options.ledgerDir,
    seed: cell.seed,
    ...timeout,
    ...(options.log === undefined ? {} : { log: options.log }),
  });
  return { path: 'api', ...record, agent: agentLabel(cell.agent, 'api'), responseChars: null };
}

export async function runBenchMatrix(options: BenchMatrixOptions, deps: Partial<BenchMatrixDeps> = {}): Promise<BenchRecord[]> {
  const run: BenchMatrixDeps = { runApiScenario: runScenario, runBrowserScenario, ...deps };
  const budget = options.budget;
  if (budget === undefined && options.agents.some((agent) => typeof agent !== 'string')) throw new Error('paid real-model agents need a spend budget');
  const records: BenchRecord[] = [];
  let paidIndex = 0;
  for (const cell of matrixCells(options)) {
    let launch: PaidLaunch | undefined;
    if (typeof cell.agent !== 'string' && budget !== undefined) {
      if (!budget.canLaunch()) {
        options.log?.(`stopped launching paid runs at the spend limit of $${budget.limitUsd.toFixed(2)} after $${budget.spentUsd.toFixed(4)}`);
        break;
      }
      paidIndex += 1;
      launch = paidLaunch(cell.agent, budget, options.ledgerDir, paidIndex);
    }
    let record = await runCell(cell, launch?.agent ?? cell.agent, options, run);
    if (launch !== undefined && budget !== undefined) {
      const spend = readUsage(launch.usageFile);
      const killed = record.agentError !== undefined && (record.agentExitCode === null || spend === undefined);
      budget.record(killed ? null : (spend?.costUsd ?? null), launch.capUsd);
      if (killed || (spend?.costUsd ?? null) === null) options.log?.(`charged the whole per-run cap of $${launch.capUsd.toFixed(4)} for ${launch.agent.name}: the run ${killed ? 'failed before reporting its full usage' : 'reported no cost'}`);
      record = { ...record, agent: launch.agent.name, ...(spend === undefined ? {} : { spend }) };
    }
    records.push(record);
    options.onRecord?.(record);
  }
  return records;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
