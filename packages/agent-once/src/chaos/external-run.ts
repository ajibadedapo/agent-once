import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startExternalAgent, type ExternalAgentOptions, type ExternalAgentRun } from './agents/external-agent.js';
import { chaosTargetsPreset } from './presets.js';
import { REAL_CLOCK_SETTLE_SECONDS, type ChaosTask } from './scenarios.js';
import type { RunningTargets } from './targets/server.js';

export interface ExternalRunOptions {
  command: string[];
  cli: string[];
  targets: RunningTargets;
  task: ChaosTask;
  session: string;
  runDir: string;
  guard: boolean;
  crash: boolean;
  rerunAfterMs: number;
  timeoutMs: number;
}

export interface ExternalRunOutcome {
  exitCode: number | null;
  error?: string;
}

const DISPATCH_POLL_MS = 20;

export function targetsMcpCommand(cli: string[], url: string): string[] {
  return [...cli, 'chaos', 'targets-mcp', '--url', url];
}

export function writeExternalPreset(runDir: string): string {
  const configPath = join(runDir, 'agent-once.json');
  writeFileSync(configPath, JSON.stringify({ ...chaosTargetsPreset(), ledger: { path: join(runDir, 'ledger.db'), settleSeconds: REAL_CLOCK_SETTLE_SECONDS } }));
  return configPath;
}

function agentEnv(options: ExternalRunOptions, mcp: string[]): ExternalAgentOptions['env'] {
  return {
    AGENT_ONCE_CHAOS_URL: options.targets.url,
    AGENT_ONCE_CHAOS_MCP: JSON.stringify(mcp),
    AGENT_ONCE_TASK: options.task.prompt,
    AGENT_ONCE_SESSION: options.session,
    AGENT_ONCE_HOME: options.runDir,
  };
}

async function untilDispatched(targets: RunningTargets, agent: ExternalAgentRun): Promise<boolean> {
  let exited = false;
  const stop = (): void => {
    exited = true;
  };
  void agent.exited.then(stop, stop);
  while (!exited && targets.pendingCommits() === 0) await delay(DISPATCH_POLL_MS);
  return targets.pendingCommits() > 0;
}

function failure(code: number | null, signal: NodeJS.Signals | null, stderr: string): string {
  const status = code === null ? `was stopped by ${signal ?? 'an unknown signal'}` : `exited with code ${code}`;
  const detail = stderr.trim();
  return detail === '' ? status : `${status}: ${detail}`;
}

async function life(options: ExternalRunOptions, mcp: string[], crash: boolean): Promise<ExternalRunOutcome> {
  const agent = startExternalAgent({ command: options.command, env: agentEnv(options, mcp), timeoutMs: options.timeoutMs });
  const crashed = crash && (await untilDispatched(options.targets, agent));
  if (crashed) agent.kill();
  const { code, signal, stderr } = await agent.exited;
  if (crashed || code === 0) return { exitCode: code };
  return { exitCode: code, error: failure(code, signal, stderr) };
}

export async function runExternalAgent(options: ExternalRunOptions): Promise<ExternalRunOutcome> {
  const targetsMcp = targetsMcpCommand(options.cli, options.targets.url);
  const mcp = options.guard ? [...options.cli, 'mcp', '--config', writeExternalPreset(options.runDir), '--', ...targetsMcp] : targetsMcp;
  const first = await life(options, mcp, options.crash);
  if (!options.crash || first.error !== undefined) return first;
  await delay(options.rerunAfterMs);
  return life(options, mcp, false);
}
