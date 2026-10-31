import { describe, expect, test } from 'vitest';
import { checkEffects, flushPendingCommits } from '../../src/chaos/checker.js';
import type { Effect } from '../../src/chaos/targets/store.js';
import { START_MS, postJson, targetsOnManualClock } from './chaos-harness.js';

function effect(id: string): Effect {
  return { id, target: 'ticket', fields: { title: 'Printer jam', body: 'Jammed.' }, clientRef: null, atMs: START_MS };
}

describe('checker', () => {
  test('checker flags duplicate and missing', () => {
    expect(checkEffects([], 1)).toEqual({ effects: 0, duplicate: false, missing: true });
    expect(checkEffects([effect('TCK-1')], 1)).toEqual({ effects: 1, duplicate: false, missing: false });
    expect(checkEffects([effect('TCK-1'), effect('TCK-2')], 1)).toEqual({ effects: 2, duplicate: true, missing: false });
    expect(checkEffects([effect('TCK-1'), effect('TCK-2'), effect('TCK-3')], 1)).toEqual({ effects: 3, duplicate: true, missing: false });
  });

  test('flushing advances the injected clock past every hold so slow commits count', async () => {
    const { clock, targets } = await targetsOnManualClock();
    targets.setFaults([{ target: 'ticket', nth: 1, kind: 'slow_commit', holdMs: 5_000 }]);
    await postJson(`${targets.url}/api/ticket`, { title: 'Printer jam', body: 'Jammed.' }).catch(() => undefined);
    expect(targets.pendingCommits()).toBe(1);
    expect(targets.truth().ticket).toHaveLength(0);
    await flushPendingCommits(targets, clock, 5_000);
    expect(targets.pendingCommits()).toBe(0);
    expect(targets.truth().ticket).toHaveLength(1);
    expect(clock.nowMs()).toBeGreaterThan(START_MS + 5_000);
  });
});
