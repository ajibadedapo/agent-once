import type { JsonValue } from '../../canonical/jcs.js';
import type { LedgerEvent } from '../../ledger/types.js';
import { systemClock } from '../../time/clock.js';
import { CliExit, EXIT_OK, EXIT_USAGE, openLedger, parseCommandArgs, readConfig, type CliIo } from '../io.js';

export const LEDGER_USAGE = 'Usage: agent-once ledger list [--in-doubt] [--json] [--config <file>]';

interface ActionRow {
  action_id: string;
  state: string;
  tool: string;
  tool_class: string;
  policy: string;
  occurrence: number;
  session_key: string;
  at_ms: number;
  args: JsonValue;
}

function toRow(event: LedgerEvent): ActionRow {
  return {
    action_id: event.actionId,
    state: event.state,
    tool: event.tool,
    tool_class: event.toolClass,
    policy: event.policy,
    occurrence: event.occurrence,
    session_key: event.sessionKey,
    at_ms: event.atMs,
    args: event.argsJson === null ? null : (JSON.parse(event.argsJson) as JsonValue),
  };
}

function table(rows: ActionRow[]): string {
  const header = ['ACTION', 'STATE', 'TOOL', 'CLASS', 'AT', 'SESSION'];
  const lines = rows.map((row) => [row.action_id, row.state, row.tool, row.tool_class, new Date(row.at_ms).toISOString(), row.session_key]);
  const widths = header.map((title, index) => Math.max(title.length, ...lines.map((line) => line[index]?.length ?? 0)));
  return [header, ...lines].map((line) => line.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('  ').trimEnd()).join('\n') + '\n';
}

export function runLedger(args: string[], io: CliIo): number {
  const { values, positionals } = parseCommandArgs(
    args,
    { 'in-doubt': { type: 'boolean' }, json: { type: 'boolean' }, config: { type: 'string' } },
    LEDGER_USAGE,
  );
  if (positionals.length !== 1 || positionals[0] !== 'list') throw new CliExit(EXIT_USAGE, LEDGER_USAGE);
  const inDoubt = values['in-doubt'] === true;
  const config = readConfig(io, typeof values.config === 'string' ? values.config : undefined);
  const store = openLedger(config, systemClock);
  let rows: ActionRow[];
  try {
    const nowMs = systemClock.nowMs();
    rows = (inDoubt ? store.listInDoubt(nowMs) : store.listActions(nowMs)).map(toRow);
  } finally {
    store.close();
  }
  if (values.json === true) io.stdout(`${JSON.stringify(rows, null, 2)}\n`);
  else if (rows.length === 0) io.stdout(inDoubt ? 'No actions in doubt.\n' : 'No actions recorded.\n');
  else io.stdout(table(rows));
  return EXIT_OK;
}
