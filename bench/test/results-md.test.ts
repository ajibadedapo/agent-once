import { describe, expect, test } from 'vitest';
import type { LatencyReport } from '../src/latency.js';
import type { BenchRecord } from '../src/matrix.js';
import { renderResults, type CostEstimate, type ResultsInput } from '../src/results-md.js';

const LATENCY: LatencyReport = {
  core: { p50Ms: 0.213, p99Ms: 0.912, meanMs: 0.301, overThreshold: 97 },
  proxy: { p50Ms: 0.481, p99Ms: 1.734, meanMs: 0.552, overThreshold: 120 },
  python: { p50Ms: 0.377, p99Ms: 1.204, meanMs: 0.418, overThreshold: 88 },
  tail: { thresholdMs: 1, probe: { defaultCheckpoint: [97, 102, 99], noAutocheckpoint: [58, 16, 11], memoryLedger: [10, 0, 2], samples: 5_000 } },
  iterations: 5_000,
  warmup: 500,
  machine: { node: 'v22.23.4', cpu: 'Test CPU (8 cores)', os: 'darwin 25.6.0 arm64', sqlite: '3.53.4', python: '3.12.9' },
};

function record(overrides: Partial<BenchRecord>): BenchRecord {
  return {
    path: 'api',
    scenario: 'lost_response_after_commit',
    target: 'checkout',
    agent: 'scripted:naive',
    guard: true,
    effects: 1,
    duplicate: false,
    missing: false,
    agentCalls: 2,
    blockedOrDoubt: 1,
    durationMs: 2_001,
    responseChars: null,
    ...overrides,
  };
}

const RECORDS: BenchRecord[] = [
  record({ guard: false, effects: 2, duplicate: true }),
  record({}),
  record({ agent: 'scripted:obedient', scenario: 'no_fault', target: 'email', guard: false, agentCalls: 1, blockedOrDoubt: 0 }),
  record({ agent: 'scripted:obedient', scenario: 'no_fault', target: 'email', agentCalls: 1, blockedOrDoubt: 0 }),
  record({ path: 'browser', agent: 'scripted-browser:naive', scenario: 'slow_commit', target: 'booking', guard: false, effects: 2, duplicate: true, agentCalls: 6, responseChars: 4_800 }),
  record({ path: 'browser', agent: 'scripted-browser:naive', scenario: 'slow_commit', target: 'booking', agentCalls: 9, responseChars: 7_200, snapshotChars: [400, 600, 800] }),
  record({ path: 'browser', agent: 'scripted-browser:naive', scenario: 'slow_commit', target: 'booking', agentCalls: 9, responseChars: 7_200, snapshotChars: [1_000, 1_200, 1_400] }),
];

function input(overrides: Partial<ResultsInput> = {}): ResultsInput {
  return {
    command: 'npm run bench && npm run bench:browser',
    generatedAt: '2026-10-31T21:15:42.678Z',
    latency: LATENCY,
    records: RECORDS,
    notRun: ['Claude via the Claude Agent SDK: no API key in the environment; needs approval'],
    realRunPlan: { agents: ['claude-agent-sdk', 'openai'], runsPerCell: 3, apiCells: 48, browserCells: 24 },
    ...overrides,
  };
}

function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`## ${heading}\n`);
  expect(start, `missing section ${heading}`).toBeGreaterThanOrEqual(0);
  const next = markdown.indexOf('\n## ', start + 1);
  return markdown.slice(start, next === -1 ? undefined : next);
}

describe('renderResults', () => {
  test('renderResults includes the overhead table, every cell with run counts, the Not run section and the Failures section', () => {
    const markdown = renderResults(input());
    expect(markdown).toContain('npm run bench && npm run bench:browser');
    const overhead = section(markdown, 'Guard overhead');
    expect(overhead).toMatch(/\| Core: Guard\.run on SQLite WAL \| 0\.213 \| 0\.912 \| 0\.301 \| 1\.9% \(97\/5000\) \| 5000 \|/);
    expect(overhead).toMatch(/\| Proxy: guarded tools\/call through the in-process MCP proxy \| 0\.481 \| 1\.734 \| 0\.552 \| 2\.4% \(120\/5000\) \| 5000 \|/);
    expect(overhead).toMatch(/\| Python: Guard\.run on sqlite3 WAL \| 0\.377 \| 1\.204 \| 0\.418 \| 1\.8% \(88\/5000\) \| 5000 \|/);
    expect(overhead).toContain('under 5 ms');
    expect(overhead).toContain('Met: yes');
    expect(overhead).toContain('Test CPU (8 cores)');
    expect(overhead).toContain('SQLite 3.53.4');
    const api = section(markdown, 'API path');
    expect(api).toContain('deterministic');
    expect(api).toMatch(/\| scripted:naive \| lost_response_after_commit \| checkout \| 1 \| 100\.0% \(1\/1\) \| 0\.0% \(0\/1\) \| 1 \| 0\.0% \(0\/1\) \| 0\.0% \(0\/1\) \|/);
    expect(api).toMatch(/\| scripted:obedient \| no_fault \| email \| 1 \| 0\.0% \(0\/1\) \| 0\.0% \(0\/1\) \| 1 \| 0\.0% \(0\/1\) \| 0\.0% \(0\/1\) \|/);
    const browser = section(markdown, 'Browser path');
    expect(browser).toMatch(/\| scripted-browser:naive \| slow_commit \| booking \| 1 \| 100\.0% \(1\/1\) \| 0\.0% \(0\/1\) \| 2 \| 0\.0% \(0\/2\) \| 0\.0% \(0\/2\) \|/);
    expect(section(markdown, 'Not run')).toContain('Claude via the Claude Agent SDK: no API key in the environment; needs approval');
    expect(section(markdown, 'Failures')).toContain('None');
  });

  test('a guarded duplicate appears under Failures', () => {
    const duplicate = record({ path: 'browser', agent: 'scripted-browser:naive', scenario: 'timeout_before_commit', target: 'ticket', effects: 2, duplicate: true });
    const missing = record({ scenario: 'crash_mid_run', target: 'email', effects: 0, missing: true });
    const failures = section(renderResults(input({ records: [...RECORDS, duplicate, missing] })), 'Failures');
    expect(failures).toContain('duplicate: browser path, scripted-browser:naive, guard on, timeout_before_commit, ticket, 2 effects');
    expect(failures).toContain('missing: API path, scripted:naive, guard on, crash_mid_run, email, 0 effects');
    expect(failures).not.toContain('None');
  });

  test('the browser connection reset is published as a known limitation with its reason', () => {
    const reset = [false, true].map((guard) =>
      record({ path: 'browser', agent: 'scripted-browser:naive', scenario: 'connection_reset_after_commit', guard, effects: 2, duplicate: true }),
    );
    const markdown = renderResults(input({ records: [...RECORDS, ...reset] }));
    expect(section(markdown, 'Failures')).toMatch(/duplicate: browser path, scripted-browser:naive, guard on, connection_reset_after_commit, checkout, 2 effects \(known limitation: Chromium re-sends the POST below the MCP layer/);
    expect(section(markdown, 'Known limitations')).toContain('connection_reset_after_commit');
    expect(section(markdown, 'Browser path')).toContain('with the guard 1 duplicate, 1 of which is the known limitation connection_reset_after_commit, and 0 missing effects in 3 runs');
  });

  test('nothing unmeasured is given a number', () => {
    const markdown = renderResults(input({ latency: { ...LATENCY, python: null, machine: { ...LATENCY.machine, python: null } }, records: RECORDS.filter((row) => row.path === 'api') }));
    expect(section(markdown, 'Guard overhead')).toMatch(/\| Python: Guard\.run on sqlite3 WAL \| not measured \| not measured \| not measured \| not measured \| not measured \|/);
    expect(section(markdown, 'Browser path')).toContain('Not run in this results file');
    expect(renderResults(input({ latency: null }))).toContain('Guard overhead was not measured');
  });

  test('the real-model estimate lists its token assumptions from measured browser and API runs', () => {
    const estimate = section(renderResults(input()), 'Not run');
    expect(estimate).toContain('Cost estimate: to be filled in');
    expect(estimate).toContain('3 runs per cell');
    expect(estimate).toMatch(/API path: 48 cells x 3 runs x 2 agents = 288 runs/);
    expect(estimate).toMatch(/browser path: 24 cells x 3 runs x 2 agents = 144 runs/);
    expect(estimate).toMatch(/browser tool calls per run: mean 8\.0, max 9 \(scripted browser agent\)/);
    expect(estimate).toMatch(/browser tool response size: mean 800 characters per call, about 200 tokens/);
    expect(estimate).toMatch(/browser_snapshot size: mean 900 characters, about 225 tokens at the same assumed ratio; largest 1400 characters, about 350 tokens, over 6 snapshots/);
  });

  test('a cost estimate from the harness input is priced per model, labelled as an estimate and dated', () => {
    const costEstimate: CostEstimate = {
      agent: 'claude-agent-sdk',
      priceSource: 'Test price table cached 2026-10-06',
      prices: [
        { model: 'Model A', inputUsdPerMTok: 2, outputUsdPerMTok: 10, cacheReadUsdPerMTok: 0.2 },
        { model: 'Model B', inputUsdPerMTok: 4, outputUsdPerMTok: 20, cacheReadUsdPerMTok: 0.2 },
      ],
      turnsPerRun: 8,
      fixedTokensPerTurn: 20_000,
      conversationTokensPerTurn: 2_000,
      outputTokensPerTurn: 500,
      notes: ['openai is not estimated here.'],
    };
    const markdown = renderResults(input({ costEstimate }));
    const estimate = section(markdown, 'Not run');
    expect(estimate).not.toContain('to be filled in');
    expect(estimate).toContain('Cost estimate (an estimate, not a measurement) for the claude-agent-sdk share of the planned runs: 216 runs (API path 144, browser path 72).');
    expect(estimate).toContain('Prices: Test price table cached 2026-10-06.');
    expect(estimate).toContain('8 model turns per run, 20000 tokens of system prompt and tool definitions per turn');
    expect(estimate).toMatch(/\| Model A \| \$2\.00 \| \$10\.00 \| \$0\.20 \| \$0\.14 \| \$0\.39 \| \$30 \| \$85 \|/);
    expect(estimate).toMatch(/\| Model B \| \$4\.00 \| \$20\.00 \| \$0\.20 \| \$0\.25 \| \$0\.78 \| \$54 \| \$169 \|/);
    expect(estimate).toContain('- openai is not estimated here.');
    expect(estimate).toContain('- output tokens per model turn: assumed 500 (the tool call, its arguments and any text around it), as in the cost estimate above; not measured');
    expect(estimate).not.toMatch(/output tokens per model call/);
    expect(markdown.split('\n')[2]).toBe(
      'Generated 2026-10-31T21:15:42.678Z. Every measured number in this file comes from this run, made with the commands below on the machine listed under Guard overhead. The cost estimate under Not run is not a measurement: it uses a dated price table (Test price table cached 2026-10-06) and the token-usage assumptions listed with it.',
    );
  });

  test('without a cost estimate the opening says the measured numbers come from this run and names no price table', () => {
    expect(renderResults(input()).split('\n')[2]).toBe(
      'Generated 2026-10-31T21:15:42.678Z. Every measured number in this file comes from this run, made with the commands below on the machine listed under Guard overhead. The token-usage assumptions under Not run are assumptions, not measurements.',
    );
  });

  test('real-model runs get their own section and stay out of the scripted tables and estimates', () => {
    const real = [false, true].map((guard) => record({ agent: 'claude-agent-sdk', guard, agentCalls: null, blockedOrDoubt: null, durationMs: 41_234 }));
    const markdown = renderResults(input({ records: [...RECORDS, ...real] }));
    expect(section(markdown, 'API path')).not.toContain('claude-agent-sdk');
    expect(section(markdown, 'Real-model runs')).toMatch(/\| claude-agent-sdk \| lost_response_after_commit \| checkout \| 1 \| 0\.0% \(0\/1\) \| 0\.0% \(0\/1\) \| 1 \| 0\.0% \(0\/1\) \| 0\.0% \(0\/1\) \|/);
    expect(section(markdown, 'Not run')).toMatch(/API tool calls per run: mean 1\.5, max 2 \(scripted agents\)/);
  });

  test('the overhead tail is counted per row and attributed only as far as the probe measured', () => {
    const overhead = section(renderResults(input()), 'Guard overhead');
    expect(overhead).toMatch(/\| Core: Guard\.run on SQLite WAL \| 0\.213 \| 0\.912 \| 0\.301 \| 1\.9% \(97\/5000\) \| 5000 \|/);
    expect(overhead).toContain('Tail probe, core only, 3 interleaved repeats of 5000 guarded calls per mode, calls over 1 ms: default WAL auto-checkpoint 97, 102, 99; wal_autocheckpoint = 0: 58, 16, 11; in-memory ledger: 10, 0, 2.');
    expect(overhead).toContain('In every repeat turning off WAL auto-checkpoint left fewer slow calls (at most 58, against at least 97), so that difference is attributed to WAL auto-checkpoint. The slow calls that remain with it off are not attributed to a cause.');
    const unexplained = renderResults(input({ latency: { ...LATENCY, tail: { thresholdMs: 1, probe: { defaultCheckpoint: [50, 30, 61], noAutocheckpoint: [40, 52, 12], memoryLedger: [0, 0, 0], samples: 5_000 } } } }));
    expect(section(unexplained, 'Guard overhead')).toContain('The repeats overlap, so no cause is given for the tail.');
    expect(unexplained).not.toContain('attributed to WAL auto-checkpoint');
  });

  test('each cell shows its mean duration with and without the guard', () => {
    const stale = [
      record({ path: 'browser', agent: 'scripted-browser:naive', scenario: 'stale_element', guard: false, durationMs: 2_800 }),
      record({ path: 'browser', agent: 'scripted-browser:naive', scenario: 'stale_element', durationMs: 9_100 }),
      record({ path: 'browser', agent: 'scripted-browser:naive', scenario: 'stale_element', durationMs: 9_300 }),
    ];
    expect(section(renderResults(input({ records: [...RECORDS, ...stale] })), 'Browser path')).toMatch(/\| stale_element \| checkout \| 1 \| 0\.0% \(0\/1\) \| 0\.0% \(0\/1\) \| 2 \| 0\.0% \(0\/2\) \| 0\.0% \(0\/2\) \| 2\.8 s \| 9\.2 s \|/);
  });

  test('real-model rows show the recorded spend and the spend limit', () => {
    const spent = (guard: boolean, costUsd: number | null): BenchRecord =>
      record({ agent: 'claude-agent-sdk', guard, agentCalls: null, blockedOrDoubt: null, spend: { inputTokens: 6_000, outputTokens: 400, costUsd } });
    const markdown = renderResults(input({ records: [...RECORDS, spent(false, 0.021), spent(true, 0.0213)], realSpend: { limitUsd: 5, stoppedAtLimit: false } }));
    const real = section(markdown, 'Real-model runs');
    expect(real).toContain('Recorded spend, all stored real-model runs: $0.0423 over 2 runs (12000 input and 800 output tokens). Spend limit of the latest bench:real run: $5.00; the limit did not stop any run.');
    expect(real).toMatch(/\| claude-agent-sdk \| lost_response_after_commit \| checkout \| .* \| \$0\.0210 \| \$0\.0213 \|/);
    const unpriced = renderResults(input({ records: [...RECORDS, spent(true, null)], realSpend: { limitUsd: 5, stoppedAtLimit: true } }));
    expect(section(unpriced, 'Real-model runs')).toContain('1 run did not report a cost');
    expect(section(unpriced, 'Real-model runs')).toContain('stopped launching runs at the limit');
  });

  test('a cell with unpriced runs says how many of its runs the spend covers', () => {
    const runs = [0.01, null, null].map((costUsd) => record({ agent: 'openai', spend: { inputTokens: 100, outputTokens: 10, costUsd } }));
    expect(section(renderResults(input({ records: [...RECORDS, ...runs] })), 'Real-model runs')).toMatch(/\| \$0\.0100 \(1 of 3 runs priced\) \|/);
  });
});
