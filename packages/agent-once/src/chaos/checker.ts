import { setTimeout as delay } from 'node:timers/promises';
import type { ManualClock } from '../time/clock.js';
import type { RunningTargets } from './targets/server.js';
import type { Effect } from './targets/store.js';

export interface EffectCheck {
  effects: number;
  duplicate: boolean;
  missing: boolean;
}

const REAL_FLUSH_POLL_MS = 50;
const REAL_FLUSH_MARGIN_MS = 1_000;

export function checkEffects(truth: Effect[], expected: 1): EffectCheck {
  return { effects: truth.length, duplicate: truth.length > expected, missing: truth.length < expected };
}

export async function flushPendingCommits(targets: Pick<RunningTargets, 'pendingCommits'>, clock: ManualClock | 'real', maxHoldMs: number): Promise<void> {
  if (clock !== 'real') {
    clock.advance(maxHoldMs + 1);
    return;
  }
  const deadline = Date.now() + maxHoldMs + REAL_FLUSH_MARGIN_MS;
  while (targets.pendingCommits() > 0 && Date.now() < deadline) await delay(REAL_FLUSH_POLL_MS);
}
