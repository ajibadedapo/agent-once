import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { measureLatency, overheadStats } from '../src/latency.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function steppingTimer(stepMs: number): () => number {
  let now = 1_761_912_345_678.25;
  return () => {
    now += stepMs;
    return now;
  };
}

describe('latency statistics', () => {
  test('overhead is the paired difference, with nearest-rank p50 and p99 and the mean', () => {
    const guarded = Array.from({ length: 100 }, (_, index) => 1 + (index + 1) * 0.01);
    const direct = Array.from({ length: 100 }, () => 1);
    const stats = overheadStats(guarded, direct);
    expect(stats.p50Ms).toBeCloseTo(0.5, 9);
    expect(stats.p99Ms).toBeCloseTo(0.99, 9);
    expect(stats.meanMs).toBeCloseTo(0.505, 9);
  });

  test('samples must pair up and must not be empty', () => {
    expect(() => overheadStats([1, 2], [1])).toThrow('paired');
    expect(() => overheadStats([], [])).toThrow('no samples');
  });

  test('measureLatency runs every guarded call through the ledger and the proxy and reports each one', async () => {
    const ledgerDir = mkdtempSync(join(tmpdir(), 'agent-once-bench-'));
    dirs.push(ledgerDir);
    const report = await measureLatency({ iterations: 20, warmup: 3, ledgerDir, now: steppingTimer(0.125), python: false });
    expect(report.iterations).toBe(20);
    expect(report.warmup).toBe(3);
    expect(report.python).toBeNull();
    expect(report.core.p50Ms).toBeGreaterThanOrEqual(0);
    expect(report.proxy.p50Ms).toBeGreaterThanOrEqual(0);
    expect(report.machine.sqlite).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.machine.node).toBe(process.version);
  });
});
