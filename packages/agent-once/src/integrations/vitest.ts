import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { targetsMcpCommand, writeExternalPreset } from '../chaos/external-run.js';
import { defaultCli } from '../chaos/runner.js';
import { isTargetName, TARGET_NAMES, type TargetName } from '../chaos/targets/catalog.js';
import { parseFaultPlan, type FaultPlan } from '../chaos/targets/faults.js';
import { startTargets, type RunningTargets } from '../chaos/targets/server.js';
import type { Effect } from '../chaos/targets/store.js';
import { systemClock, type Clock } from '../time/clock.js';

export interface StartChaosTargetsOptions {
  faults?: FaultPlan;
  clock?: Clock;
  cli?: string[];
}

export interface ChaosHandle {
  url: string;
  mcpCommand(guard: boolean): string[];
  truth(): Promise<Record<TargetName, Effect[]>>;
  close(): Promise<void>;
}

declare module 'vitest' {
  interface Matchers<R extends void | Promise<void> = void | Promise<void>, T = unknown> {
    toHaveNoDuplicateEffects(): R;
    toHaveExactlyOneEffect(target: TargetName): R;
  }
}

const running = new WeakMap<object, RunningTargets>();

export async function startChaosTargets(options: StartChaosTargetsOptions = {}): Promise<ChaosHandle> {
  const faults = parseFaultPlan(options.faults ?? []);
  const cli = options.cli ?? defaultCli();
  const targets = await startTargets({ clock: options.clock ?? systemClock });
  targets.setFaults(faults);
  const dir = mkdtempSync(join(tmpdir(), 'agent-once-vitest-'));
  let configPath: string | undefined;
  let closing: Promise<void> | undefined;
  const handle: ChaosHandle = {
    url: targets.url,
    mcpCommand(guard) {
      const bare = targetsMcpCommand(cli, targets.url);
      if (!guard) return bare;
      configPath ??= writeExternalPreset(dir);
      return [...cli, 'mcp', '--config', configPath, '--', ...bare];
    },
    truth: () => Promise.resolve(targets.truth()),
    close() {
      closing ??= targets.close().finally(() => rmSync(dir, { recursive: true, force: true }));
      return closing;
    },
  };
  running.set(handle, targets);
  return handle;
}

function stableJson(fields: Record<string, string>): string {
  return JSON.stringify(Object.fromEntries(Object.keys(fields).sort().map((key) => [key, fields[key]])));
}

function ids(effects: readonly Effect[]): string {
  return effects.map((effect) => effect.id).join(', ');
}

function duplicateEffects(truth: Record<TargetName, Effect[]>): string[] {
  const problems: string[] = [];
  for (const target of TARGET_NAMES) {
    const groups = new Map<string, Effect[]>();
    for (const effect of truth[target]) {
      const key = stableJson(effect.fields);
      groups.set(key, [...(groups.get(key) ?? []), effect]);
    }
    for (const [fields, effects] of groups) {
      if (effects.length > 1) problems.push(`${target} has ${effects.length} effects with the same fields ${fields}: ${ids(effects)}`);
    }
  }
  return problems;
}

function targetsOf(received: unknown): RunningTargets {
  const targets = typeof received === 'object' && received !== null ? running.get(received) : undefined;
  if (targets === undefined) throw new TypeError('expected a handle from startChaosTargets');
  return targets;
}

expect.extend({
  toHaveNoDuplicateEffects(received: unknown) {
    const problems = duplicateEffects(targetsOf(received).truth());
    return {
      pass: problems.length === 0,
      message: () => (problems.length === 0 ? 'expected duplicate effects, found none' : problems.join('\n')),
    };
  },
  toHaveExactlyOneEffect(received: unknown, target: TargetName) {
    if (!isTargetName(target)) throw new TypeError(`unknown target ${String(target)}; expected one of ${TARGET_NAMES.join(', ')}`);
    const effects = targetsOf(received).truth()[target];
    return {
      pass: effects.length === 1,
      message: () => (effects.length === 1 ? `expected ${target} not to have exactly one effect, found ${ids(effects)}` : `expected exactly one ${target} effect, found ${effects.length}${effects.length === 0 ? '' : `: ${ids(effects)}`}`),
    };
  },
});
