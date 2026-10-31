import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BenchMatrixOptions, BenchRecord } from '../matrix.js';
import { hasKey, type RealAgent } from './agent-env.js';
import { claudeAgentSdkAgent } from './claude-agent-sdk.js';
import { openAiAgent } from './openai.js';

export const CONFIRM_SPEND_FLAG = '--confirm-spend';
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
}

export function realAgents(): RealAgent[] {
  return [claudeAgentSdkAgent(), openAiAgent()];
}

export async function realCommand(deps: RealDeps): Promise<RealOutcome> {
  if (!deps.argv.includes(CONFIRM_SPEND_FLAG)) {
    deps.log(`bench:real makes paid model API calls; rerun with ${CONFIRM_SPEND_FLAG} once the spend is approved`);
    return { exitCode: 2, records: [], skipped: [] };
  }
  const runnable: RealAgent[] = [];
  const skipped: string[] = [];
  for (const agent of realAgents()) {
    if (hasKey(deps.env, agent.keyEnv)) {
      runnable.push(agent);
    } else {
      skipped.push(agent.name);
      deps.log(`skipped: ${agent.name} needs ${agent.keyEnv}`);
    }
  }
  if (runnable.length === 0) return { exitCode: 0, records: [], skipped };
  const ledgerDir = mkdtempSync(join(tmpdir(), 'agent-once-bench-real-'));
  try {
    const records = await deps.runMatrix({
      agents: runnable.map(({ name, external }) => ({ name, external })),
      paths: ['api', 'browser'],
      runs: REAL_RUNS_PER_CELL,
      ledgerDir,
      log: deps.log,
    });
    return { exitCode: 0, records, skipped };
  } finally {
    rmSync(ledgerDir, { recursive: true, force: true });
  }
}
