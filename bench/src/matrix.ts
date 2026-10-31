import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { systemClock } from 'agent-once';
import {
  BROWSER_SCENARIOS,
  chaosTargetsPreset,
  checkEffects,
  flushPendingCommits,
  REAL_CLOCK_HOLD_MS,
  REAL_CLOCK_SETTLE_SECONDS,
  runMatrix,
  SCENARIO_NAMES,
  SCENARIOS,
  startExternalAgent,
  startTargets,
  TARGET_NAMES,
  TARGETS,
  type RunRecord,
  type ScenarioSpec,
  type TargetName,
} from 'agent-once/chaos';
import { guardMcpServers } from 'agent-once/claude-agent-sdk';
import { naiveBrowserAgent } from './browser-agent.js';

export type BenchPath = 'api' | 'browser';

export interface ExternalBenchAgent {
  name: string;
  external: string[];
}

export type BenchAgent = 'scripted:naive' | 'scripted:obedient' | ExternalBenchAgent;

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

async function runApiPath(options: BenchMatrixOptions): Promise<BenchRecord[]> {
  const names = new Map<string, string>();
  const agents = options.agents.map((agent) => {
    if (typeof agent === 'string') return agent;
    names.set(agent.external.join(' '), agent.name);
    return { external: agent.external };
  });
  const toBench = (record: RunRecord): BenchRecord => ({ path: 'api', ...record, agent: names.get(record.agent) ?? record.agent, responseChars: null });
  const records = await runMatrix({
    agents,
    scenarios: API_SCENARIOS,
    targets: options.targets ?? [...TARGET_NAMES],
    guard: 'both',
    runs: options.runs,
    ledgerDir: options.ledgerDir,
    ...(options.agentTimeoutMs === undefined ? {} : { agentTimeoutMs: options.agentTimeoutMs }),
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.onRecord === undefined ? {} : { onRecord: (record: RunRecord) => options.onRecord?.(toBench(record)) }),
  });
  return records.map(toBench);
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

async function runBrowserPath(options: BenchMatrixOptions): Promise<BenchRecord[]> {
  const records: BenchRecord[] = [];
  for (const agent of options.agents) {
    for (const guard of [false, true]) {
      for (const scenario of BROWSER_PATH_SCENARIOS) {
        for (const target of options.targets ?? TARGET_NAMES) {
          for (let seed = 1; seed <= options.runs; seed += 1) {
            const record = await runBrowserScenario({
              scenario,
              target,
              agent,
              guard,
              ledgerDir: options.ledgerDir,
              seed,
              ...(options.agentTimeoutMs === undefined ? {} : { agentTimeoutMs: options.agentTimeoutMs }),
            });
            records.push(record);
            options.onRecord?.(record);
          }
        }
      }
    }
  }
  return records;
}

export async function runBenchMatrix(options: BenchMatrixOptions): Promise<BenchRecord[]> {
  const records: BenchRecord[] = [];
  if (options.paths.includes('api')) records.push(...(await runApiPath(options)));
  if (options.paths.includes('browser')) records.push(...(await runBrowserPath(options)));
  return records;
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
