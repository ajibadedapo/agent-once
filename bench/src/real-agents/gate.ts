import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BenchMatrixOptions, BenchRecord } from '../matrix.js';
import { hasKey, type RealAgent } from './agent-env.js';
import { SpendBudget } from './budget.js';
import { claudeAgentSdkAgent } from './claude-agent-sdk.js';
import { openAiAgent } from './openai.js';

export const CONFIRM_SPEND_FLAG = '--confirm-spend';
export const MAX_SPEND_FLAG = '--max-spend-usd';
export const REAL_RUNS_PER_CELL = 3;

export interface RealDeps {
  env: NodeJS.ProcessEnv;
  argv: string[];
  runMatrix: (options: BenchMatrixOptions) => Promise<BenchRecord[]>;
  log: (line: string) => void;
}

export interface RealOutcome {
  exitCode: number;
  records: BenchRecord[];
  skipped: string[];
  limitUsd?: number;
  stoppedAtLimit?: boolean;
}

export function realAgents(): RealAgent[] {
  return [claudeAgentSdkAgent(), openAiAgent()];
}

function spendLimit(argv: string[]): number | undefined {
  const index = argv.indexOf(MAX_SPEND_FLAG);
  const value = index === -1 ? undefined : argv[index + 1];
  if (value === undefined || !/^\d+(\.\d+)?$/.test(value)) return undefined;
  const limit = Number(value);
  return limit > 0 ? limit : undefined;
}

function missingEnv(env: NodeJS.ProcessEnv, agent: RealAgent): string[] {
  if (!hasKey(env, agent.keyEnv)) return [agent.keyEnv];
  return agent.requiredEnv.filter((name) => !hasKey(env, name));
}

export async function realCommand(deps: RealDeps): Promise<RealOutcome> {
  if (!deps.argv.includes(CONFIRM_SPEND_FLAG)) {
    deps.log(`bench:real makes paid model API calls; rerun with ${CONFIRM_SPEND_FLAG} once the spend is approved`);
    return { exitCode: 2, records: [], skipped: [] };
  }
  const limitUsd = spendLimit(deps.argv);
  if (limitUsd === undefined) {
    deps.log(`bench:real needs ${MAX_SPEND_FLAG} <dollars> with ${CONFIRM_SPEND_FLAG}`);
    return { exitCode: 2, records: [], skipped: [] };
  }
  const runnable: RealAgent[] = [];
  const skipped: string[] = [];
  for (const agent of realAgents()) {
    const missing = missingEnv(deps.env, agent);
    if (missing.length === 0) {
      runnable.push(agent);
    } else {
      skipped.push(agent.name);
      deps.log(`skipped: ${agent.name} needs ${missing.join(' and ')}`);
    }
  }
  if (runnable.length === 0) return { exitCode: 0, records: [], skipped, limitUsd, stoppedAtLimit: false };
  const budget = new SpendBudget(limitUsd);
  const ledgerDir = mkdtempSync(join(tmpdir(), 'agent-once-bench-real-'));
  try {
    const records = await deps.runMatrix({
      agents: runnable.map(({ name, external }) => ({ name, external })),
      paths: ['api', 'browser'],
      runs: REAL_RUNS_PER_CELL,
      ledgerDir,
      budget,
      log: deps.log,
    });
    return { exitCode: 0, records, skipped, limitUsd, stoppedAtLimit: budget.stoppedAtLimit };
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
}
