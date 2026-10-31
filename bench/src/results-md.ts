import type { LatencyReport, OverheadStats, TailReport } from './latency.js';
import type { BenchPath, BenchRecord } from './matrix.js';

export interface RealRunPlan {
  agents: string[];
  runsPerCell: number;
  apiCells: number;
  browserCells: number;
}

export interface ResultsInput {
  command: string;
  generatedAt: string;
  latency: LatencyReport | null;
  records: BenchRecord[];
  notRun: string[];
  realRunPlan: RealRunPlan;
  measuredAt?: Partial<Record<'latency' | 'real' | BenchPath, string>>;
  browserSetup?: string;
  realSpend?: RealSpend;
}

export interface RealSpend {
  limitUsd: number;
  stoppedAtLimit: boolean;
}

export const LATENCY_TARGET_MS = 5;

const CHARS_PER_TOKEN = 4;

const KNOWN_LIMITATIONS: Readonly<Record<string, string>> = {
  'browser:connection_reset_after_commit':
    'Chromium re-sends the POST below the MCP layer when the connection resets after the commit, so the server sees two submissions from one click. The guard only sees one browser_click and cannot stop a retry it never receives.',
};

const PATH_LABELS: Readonly<Record<BenchPath, string>> = { api: 'API path', browser: 'browser path' };

function isScripted(record: BenchRecord): boolean {
  return record.agent.startsWith('scripted');
}

function knownLimitation(record: Pick<BenchRecord, 'path' | 'scenario'>): string | undefined {
  return KNOWN_LIMITATIONS[`${record.path}:${record.scenario}`];
}

function ms(value: number): string {
  return value.toFixed(3);
}

function rate(count: number, runs: number): string {
  return `${((count / runs) * 100).toFixed(1)}% (${count}/${runs})`;
}

function cell(text: string): string {
  return text.replaceAll('|', '\\|').replace(/\s+/g, ' ');
}

function measuredLine(input: ResultsInput, key: 'latency' | 'real' | BenchPath): string[] {
  const at = input.measuredAt?.[key];
  return at === undefined ? [] : [`Measured at ${at}.`, ''];
}

function overheadRow(label: string, stats: OverheadStats | null, iterations: number): string {
  if (stats === null) return `| ${label} | not measured | not measured | not measured | not measured | not measured |`;
  return `| ${label} | ${ms(stats.p50Ms)} | ${ms(stats.p99Ms)} | ${ms(stats.meanMs)} | ${rate(stats.overThreshold, iterations)} | ${iterations} |`;
}

function tailLines(tail: TailReport): string[] {
  const probe = tail.probe;
  if (probe === null) return [];
  const { defaultCheckpoint, noAutocheckpoint, memoryLedger, samples } = probe;
  const list = (values: number[]): string => values.join(', ');
  const counts = `Tail probe, core only, ${defaultCheckpoint.length} interleaved repeats of ${samples} guarded calls per mode, calls over ${tail.thresholdMs} ms: default WAL auto-checkpoint ${list(defaultCheckpoint)}; wal_autocheckpoint = 0: ${list(noAutocheckpoint)}; in-memory ledger: ${list(memoryLedger)}.`;
  const separated = defaultCheckpoint.length > 0 && noAutocheckpoint.length > 0 && Math.max(...noAutocheckpoint) < Math.min(...defaultCheckpoint);
  const attribution = separated
    ? `In every repeat turning off WAL auto-checkpoint left fewer slow calls (at most ${Math.max(...noAutocheckpoint)}, against at least ${Math.min(...defaultCheckpoint)}), so that difference is attributed to WAL auto-checkpoint. The slow calls that remain with it off are not attributed to a cause.`
    : 'The repeats overlap, so no cause is given for the tail.';
  return [`${counts} ${attribution}`, ''];
}

function overheadSection(input: ResultsInput): string[] {
  const latency = input.latency;
  if (latency === null) return ['## Guard overhead', '', 'Guard overhead was not measured in this results file. Run `npm run bench` to measure it.', ''];
  const measured: [string, OverheadStats][] = [
    ['core', latency.core],
    ['proxy', latency.proxy],
    ...(latency.python === null ? [] : [['Python', latency.python] as [string, OverheadStats]]),
  ];
  const met = measured.every(([, stats]) => stats.p50Ms < LATENCY_TARGET_MS);
  const p50s = measured.map(([name, stats]) => `${name} p50 ${ms(stats.p50Ms)} ms`).join(', ');
  const { machine } = latency;
  const python = machine.python === null ? 'Python not measured' : `Python ${machine.python}, SQLite ${machine.pythonSqlite ?? 'unknown'} (sqlite3)`;
  return [
    '## Guard overhead',
    '',
    ...measuredLine(input, 'latency'),
    `Target: p50 under ${LATENCY_TARGET_MS} ms per guarded call on SQLite WAL with synchronous NORMAL. Met: ${met ? 'yes' : 'no'} (${p50s}).`,
    '',
    `Overhead is the paired difference between a guarded call and the same call without the guard, over ${latency.iterations} iterations after ${latency.warmup} warm-up calls. Every guarded call is a new action, so each one writes intended, sent and confirmed to a ledger file. Core and Python wrap a no-op; the proxy row compares a guarded tool with a pass tool on the same in-process proxy and upstream.`,
    '',
    `| Measurement | p50 ms | p99 ms | mean ms | Over ${latency.tail.thresholdMs} ms | Iterations |`,
    '|---|---|---|---|---|---|',
    overheadRow('Core: Guard.run on SQLite WAL', latency.core, latency.iterations),
    overheadRow('Proxy: guarded tools/call through the in-process MCP proxy', latency.proxy, latency.iterations),
    overheadRow('Python: Guard.run on sqlite3 WAL', latency.python, latency.iterations),
    '',
    ...tailLines(latency.tail),
    `Machine: ${machine.cpu}, ${machine.os}. Node ${machine.node}, SQLite ${machine.sqlite} (node:sqlite). ${python}.`,
    '',
  ];
}

interface Cell {
  agent: string;
  scenario: string;
  target: string;
  off: BenchRecord[];
  on: BenchRecord[];
}

function cells(records: BenchRecord[]): Cell[] {
  const byKey = new Map<string, Cell>();
  for (const record of records) {
    const key = JSON.stringify([record.agent, record.scenario, record.target]);
    let entry = byKey.get(key);
    if (entry === undefined) {
      entry = { agent: record.agent, scenario: record.scenario, target: record.target, off: [], on: [] };
      byKey.set(key, entry);
    }
    (record.guard ? entry.on : entry.off).push(record);
  }
  return [...byKey.values()];
}

function modeColumns(runs: BenchRecord[]): string {
  if (runs.length === 0) return '0 | not run | not run';
  const duplicates = runs.filter((record) => record.duplicate).length;
  const missing = runs.filter((record) => record.missing).length;
  return `${runs.length} | ${rate(duplicates, runs.length)} | ${rate(missing, runs.length)}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function modeTotals(rows: BenchRecord[]): string {
  const duplicates = rows.filter((record) => record.duplicate);
  const limited = duplicates.filter((record) => knownLimitation(record) !== undefined);
  const scenarios = [...new Set(limited.map((record) => record.scenario))].join(', ');
  const note = limited.length === 0 ? '' : `, ${limited.length} of which ${limited.length === 1 ? 'is' : 'are'} the known limitation ${scenarios},`;
  return `${plural(duplicates.length, 'duplicate')}${note} and ${plural(rows.filter((record) => record.missing).length, 'missing effect')} in ${plural(rows.length, 'run')}`;
}

function totalsLine(records: BenchRecord[]): string {
  return `Totals: without the guard ${modeTotals(records.filter((record) => !record.guard))}; with the guard ${modeTotals(records.filter((record) => record.guard))}.`;
}

function runsPerCell(records: BenchRecord[]): string {
  const counts = new Set(cells(records).flatMap((entry) => [entry.off.length, entry.on.length].filter((count) => count > 0)));
  return [...counts].sort((a, b) => a - b).join(' or ');
}

function timesText(runs: string): string {
  return runs === '1' ? 'once' : `${runs} times`;
}

function meanDuration(runs: BenchRecord[]): string {
  if (runs.length === 0) return 'not run';
  return `${(runs.reduce((sum, record) => sum + record.durationMs, 0) / runs.length / 1000).toFixed(1)} s`;
}

function spendText(runs: BenchRecord[]): string {
  const costs = runs.map((record) => record.spend?.costUsd).filter((cost): cost is number => typeof cost === 'number');
  if (costs.length === 0) return runs.length === 0 ? 'not run' : 'not recorded';
  const total = usd(costs.reduce((sum, cost) => sum + cost, 0));
  return costs.length === runs.length ? total : `${total} (${costs.length} of ${runs.length} runs priced)`;
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

function matrixTable(records: BenchRecord[], withSpend = false): string[] {
  const spendHeader = withSpend ? ' Spend, guard off | Spend, guard on |' : '';
  const spendRule = withSpend ? '---|---|' : '';
  return [
    `| Agent | Scenario | Target | Runs, guard off | Duplicate rate, guard off | Missing rate, guard off | Runs, guard on | Duplicate rate, guard on | Missing rate, guard on | Mean duration, guard off | Mean duration, guard on |${spendHeader}`,
    `|---|---|---|---|---|---|---|---|---|---|---|${spendRule}`,
    ...cells(records).map((entry) => {
      const spend = withSpend ? ` ${spendText(entry.off)} | ${spendText(entry.on)} |` : '';
      return `| ${cell(entry.agent)} | ${entry.scenario} | ${entry.target} | ${modeColumns(entry.off)} | ${modeColumns(entry.on)} | ${meanDuration(entry.off)} | ${meanDuration(entry.on)} |${spend}`;
    }),
  ];
}

function spendSummary(records: BenchRecord[], limit: RealSpend | undefined): string {
  const priced = records.filter((record) => typeof record.spend?.costUsd === 'number');
  const total = priced.reduce((sum, record) => sum + (record.spend?.costUsd ?? 0), 0);
  const input = records.reduce((sum, record) => sum + (record.spend?.inputTokens ?? 0), 0);
  const output = records.reduce((sum, record) => sum + (record.spend?.outputTokens ?? 0), 0);
  const unpriced = records.length - priced.length;
  const parts = [`Recorded spend, all stored real-model runs: ${usd(total)} over ${plural(records.length, 'run')} (${input} input and ${output} output tokens).`];
  if (unpriced > 0) parts.push(`${plural(unpriced, 'run')} did not report a cost.`);
  if (limit !== undefined) parts.push(`Spend limit of the latest bench:real run: $${limit.limitUsd.toFixed(2)}; ${limit.stoppedAtLimit ? 'bench:real stopped launching runs at the limit, so some planned runs are missing.' : 'the limit did not stop any run.'}`);
  return parts.join(' ');
}

function apiSection(input: ResultsInput): string[] {
  const records = input.records.filter((record) => record.path === 'api' && isScripted(record));
  const heading = ['## API path', ''];
  if (records.length === 0) return [...heading, 'Not run in this results file. Run `npm run bench`.', ''];
  return [
    ...heading,
    ...measuredLine(input, 'api'),
    `Scripted agents call the four reference targets through the targets MCP server, with and without the guard, on a manual clock, so the mean durations are simulated time. The scripted agents are deterministic, so each cell runs ${timesText(runsPerCell(records))}: repeating a cell gives the same result. scripted:naive retries every error after a growing delay of simulated time; scripted:obedient checks the list tool and resolves the action when the guard reports doubt.`,
    '',
    totalsLine(records),
    '',
    ...matrixTable(records),
    '',
  ];
}

function browserSection(input: ResultsInput): string[] {
  const records = input.records.filter((record) => record.path === 'browser' && isScripted(record));
  const heading = ['## Browser path', ''];
  if (records.length === 0) return [...heading, 'Not run in this results file. Run `npm run bench:browser`.', ''];
  return [
    ...heading,
    ...measuredLine(input, 'browser'),
    ...(input.browserSetup === undefined ? [] : [input.browserSetup, '']),
    `Runs per cell: ${runsPerCell(records)}.`,
    '',
    totalsLine(records),
    '',
    ...matrixTable(records),
    '',
  ];
}

function realSection(input: ResultsInput): string[] {
  const records = input.records.filter((record) => !isScripted(record));
  if (records.length === 0) return [];
  const paths: BenchPath[] = ['api', 'browser'];
  return [
    '## Real-model runs',
    '',
    ...measuredLine(input, 'real'),
    'Real models called through bench:real. Unlike the scripted agents they are not deterministic, so every cell reports its own run count. Spend is what each adapter recorded from the provider response.',
    '',
    spendSummary(records, input.realSpend),
    '',
    ...paths.flatMap((path) => {
      const rows = records.filter((record) => record.path === path);
      if (rows.length === 0) return [];
      return [`### ${PATH_LABELS[path]}`, '', totalsLine(rows), '', ...matrixTable(rows, true), ''];
    }),
  ];
}

function limitationsSection(input: ResultsInput): string[] {
  const groups = new Map<string, BenchRecord[]>();
  for (const record of input.records) {
    if (!isScripted(record) || knownLimitation(record) === undefined) continue;
    const key = `${record.path}:${record.scenario}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  if (groups.size === 0) return [];
  const lines = [...groups.entries()].map(([key, records]) => {
    const [first] = records as [BenchRecord];
    const off = records.filter((record) => !record.guard);
    const on = records.filter((record) => record.guard);
    const duplicates = (rows: BenchRecord[]): number => rows.filter((record) => record.duplicate).length;
    const measured = `measured duplicate rate ${off.length === 0 ? 'not run' : rate(duplicates(off), off.length)} without the guard and ${on.length === 0 ? 'not run' : rate(duplicates(on), on.length)} with it`;
    return `- ${first.scenario} on the ${PATH_LABELS[first.path]}, scripted agents: ${measured}. ${KNOWN_LIMITATIONS[key] ?? ''}`;
  });
  return ['## Known limitations', '', ...lines, ''];
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function callsLine(label: string, records: BenchRecord[], who: string): string {
  const calls = records.map((record) => record.agentCalls).filter((value): value is number => value !== null);
  if (calls.length === 0) return `- ${label} tool calls per run: not measured`;
  return `- ${label} tool calls per run: mean ${mean(calls).toFixed(1)}, max ${Math.max(...calls)} (${who})`;
}

function responseLine(records: BenchRecord[]): string {
  const measured = records.filter((record): record is BenchRecord & { responseChars: number; agentCalls: number } => record.responseChars !== null && record.agentCalls !== null && record.agentCalls > 0);
  if (measured.length === 0) return '- browser tool response size: not measured';
  const chars = measured.reduce((sum, record) => sum + record.responseChars, 0);
  const calls = measured.reduce((sum, record) => sum + record.agentCalls, 0);
  const perCall = Math.round(chars / calls);
  const largest = Math.max(...measured.map((record) => record.responseChars));
  return `- browser tool response size: mean ${perCall} characters per call, about ${tokens(perCall)} tokens at an assumed ${CHARS_PER_TOKEN} characters per token; the largest run returned ${largest} characters in total`;
}

function tokens(chars: number): number {
  return Math.round(chars / CHARS_PER_TOKEN);
}

function snapshotLine(records: BenchRecord[]): string {
  const sizes = records.flatMap((record) => record.snapshotChars ?? []);
  if (sizes.length === 0) return '- browser_snapshot size: not measured';
  const average = Math.round(mean(sizes));
  const largest = Math.max(...sizes);
  return `- browser_snapshot size: mean ${average} characters, about ${tokens(average)} tokens at the same assumed ratio; largest ${largest} characters, about ${tokens(largest)} tokens, over ${sizes.length} snapshots of the reference pages (small forms; snapshots of other sites were not measured)`;
}

function realRunEstimate(input: ResultsInput): string[] {
  const plan = input.realRunPlan;
  const agents = plan.agents.length;
  const scripted = input.records.filter((record) => isScripted(record) && record.agentError === undefined);
  return [
    `Real-model runs planned: ${plan.agents.join(', ')}, ${plan.runsPerCell} runs per cell, with and without the guard.`,
    '',
    'Cost estimate: to be filled in before approval. Token-usage assumptions for that estimate:',
    '',
    `- runs: API path: ${plan.apiCells} cells x ${plan.runsPerCell} runs x ${agents} agents = ${plan.apiCells * plan.runsPerCell * agents} runs; browser path: ${plan.browserCells} cells x ${plan.runsPerCell} runs x ${agents} agents = ${plan.browserCells * plan.runsPerCell * agents} runs`,
    callsLine('API', scripted.filter((record) => record.path === 'api'), 'scripted agents'),
    callsLine('browser', scripted.filter((record) => record.path === 'browser'), 'scripted browser agent'),
    responseLine(scripted.filter((record) => record.path === 'browser')),
    snapshotLine(scripted.filter((record) => record.path === 'browser')),
    '- input tokens per model call: the system prompt and tool definitions (not measured here) plus the whole conversation so far, so call k of a run re-sends the k - 1 earlier tool results; per run that is about C x B + R x C x (C - 1) / 2 tokens for C calls, B fixed tokens and R tokens per tool result',
    '- output tokens per model call: assumed about 100 (one tool call with short arguments); not measured',
    '- a real model may call more or fewer tools than the scripted agents; the scripted counts above are a starting point, not a measurement of any model',
    '',
  ];
}

function failureLine(record: BenchRecord): string {
  const where = `${PATH_LABELS[record.path]}, ${record.agent}, guard ${record.guard ? 'on' : 'off'}, ${record.scenario}, ${record.target}`;
  if (record.agentError !== undefined) return `- agent error: ${where}: ${cell(record.agentError)}`;
  const kind = record.duplicate ? 'duplicate' : 'missing';
  const limitation = knownLimitation(record);
  const note = limitation === undefined ? '' : ` (known limitation: ${limitation.split('. ')[0] ?? limitation})`;
  return `- ${kind}: ${where}, ${record.effects} effects${note}`;
}

function failuresSection(input: ResultsInput): string[] {
  const failures = input.records.filter((record) => record.agentError !== undefined || (record.guard && (record.duplicate || record.missing)));
  return [
    '## Failures',
    '',
    'Every guarded run that duplicated or lost an effect, and every run whose agent failed. Unguarded duplicates are the problem the guard exists to stop and are reported in the tables above, not here.',
    '',
    ...(failures.length === 0 ? ['None: no guarded run duplicated or lost an effect, and every agent run completed.'] : failures.map(failureLine)),
    '',
  ];
}

export function renderResults(input: ResultsInput): string {
  return [
    '# agent-once benchmark results',
    '',
    `Generated ${input.generatedAt}. Every result in this file was measured by the commands below on the machine listed under Guard overhead. Nothing here is taken from another source. The only figures that are not measurements are the token-usage assumptions under Not run, and each is marked as an assumption.`,
    '',
    `Reproduce with one command from the repository root: \`${input.command}\``,
    '',
    ...overheadSection(input),
    ...apiSection(input),
    ...browserSection(input),
    ...realSection(input),
    ...limitationsSection(input),
    '## Not run',
    '',
    ...input.notRun.map((line) => `- ${line}`),
    '',
    ...realRunEstimate(input),
    ...failuresSection(input),
  ].join('\n');
}
