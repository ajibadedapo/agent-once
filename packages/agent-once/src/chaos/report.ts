import type { RunRecord } from './runner.js';

export interface RateRow {
  agent: string;
  guard: boolean;
  scenario: string;
  target?: string;
  runs: number;
  duplicates: number;
  missing: number;
  duplicateRate: number;
  missingRate: number;
}

export interface MatrixSummary {
  rows: RateRow[];
  byTarget: RateRow[];
  totals: { runs: number; guardedRuns: number; guardedDuplicates: number; guardedMissing: number };
  failures: RunRecord[];
}

function rateRows(records: RunRecord[], withTarget: boolean): RateRow[] {
  const rows = new Map<string, RateRow>();
  for (const record of records) {
    const key = JSON.stringify([record.agent, record.guard, record.scenario, withTarget ? record.target : null]);
    let row = rows.get(key);
    if (row === undefined) {
      row = { agent: record.agent, guard: record.guard, scenario: record.scenario, ...(withTarget ? { target: record.target } : {}), runs: 0, duplicates: 0, missing: 0, duplicateRate: 0, missingRate: 0 };
      rows.set(key, row);
    }
    row.runs += 1;
    if (record.duplicate) row.duplicates += 1;
    if (record.missing) row.missing += 1;
  }
  return [...rows.values()].map((row) => ({ ...row, duplicateRate: row.duplicates / row.runs, missingRate: row.missing / row.runs }));
}

export function summarize(records: RunRecord[]): MatrixSummary {
  const guarded = records.filter((record) => record.guard);
  return {
    rows: rateRows(records, false),
    byTarget: rateRows(records, true),
    totals: {
      runs: records.length,
      guardedRuns: guarded.length,
      guardedDuplicates: guarded.filter((record) => record.duplicate).length,
      guardedMissing: guarded.filter((record) => record.missing).length,
    },
    failures: guarded.filter((record) => record.duplicate || record.missing),
  };
}

function rate(count: number, runs: number): string {
  return `${((count / runs) * 100).toFixed(1)}% (${count}/${runs})`;
}

function guardLabel(guard: boolean): string {
  return guard ? 'on' : 'off';
}

function cell(text: string): string {
  return text.replaceAll('|', '\\|').replace(/\s+/g, ' ');
}

function failureLine(record: RunRecord): string {
  const kind = record.duplicate ? 'duplicate' : 'missing';
  return `- ${kind}: ${record.agent}, guard ${guardLabel(record.guard)}, ${record.scenario}, ${record.target}, ${record.effects} effects`;
}

export function renderMarkdown(summary: MatrixSummary): string {
  const { totals } = summary;
  const lines = [
    '# agent-once chaos results',
    '',
    `${totals.runs} runs, ${totals.guardedRuns} guarded: ${totals.guardedDuplicates} guarded duplicates, ${totals.guardedMissing} guarded missing effects.`,
    '',
    '| Agent | Guard | Scenario | Runs | Duplicate rate | Missing rate |',
    '|---|---|---|---|---|---|',
    ...summary.rows.map(
      (row) => `| ${cell(row.agent)} | ${guardLabel(row.guard)} | ${row.scenario} | ${row.runs} | ${rate(row.duplicates, row.runs)} | ${rate(row.missing, row.runs)} |`,
    ),
    '',
    '## By target',
    '',
    '| Agent | Guard | Scenario | Target | Runs | Duplicate rate | Missing rate |',
    '|---|---|---|---|---|---|---|',
    ...summary.byTarget.map(
      (row) =>
        `| ${cell(row.agent)} | ${guardLabel(row.guard)} | ${row.scenario} | ${row.target ?? ''} | ${row.runs} | ${rate(row.duplicates, row.runs)} | ${rate(row.missing, row.runs)} |`,
    ),
    '',
    '## Failures',
    '',
    ...(summary.failures.length === 0 ? ['None: no guarded run duplicated or lost an effect.'] : summary.failures.map(failureLine)),
    '',
  ];
  return lines.join('\n');
}
