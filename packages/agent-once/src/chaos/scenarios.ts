import { TARGETS, type TargetName } from './targets/catalog.js';
import type { FaultKind } from './targets/faults.js';

export type ScenarioName = 'lost_response_after_commit' | 'slow_commit' | 'timeout_before_commit' | 'stale_element' | 'crash_mid_run';

export type RunnableScenario = ScenarioName | 'no_fault';

export interface ScenarioSpec {
  faultKind: FaultKind;
  holdMs: number;
  crash: boolean;
}

export const SCENARIOS: Readonly<Record<ScenarioName, ScenarioSpec>> = {
  lost_response_after_commit: { faultKind: 'lost_response_after_commit', holdMs: 0, crash: false },
  slow_commit: { faultKind: 'slow_commit', holdMs: 5_000, crash: false },
  timeout_before_commit: { faultKind: 'timeout_before_commit', holdMs: 5_000, crash: false },
  stale_element: { faultKind: 'stale_element', holdMs: 0, crash: false },
  crash_mid_run: { faultKind: 'slow_commit', holdMs: 5_000, crash: true },
};

export type BrowserScenarioName = 'connection_reset_after_commit';

export const BROWSER_SCENARIOS: Readonly<Record<BrowserScenarioName, ScenarioSpec>> = {
  connection_reset_after_commit: { faultKind: 'connection_reset_after_commit', holdMs: 0, crash: false },
};

export const SCENARIO_NAMES = Object.keys(SCENARIOS) as ScenarioName[];

export const NO_FAULT: ScenarioSpec = Object.freeze({ faultKind: 'none', holdMs: 0, crash: false });

export const CRASH_RERUN_AFTER_MS = 6_000;

export const REAL_CLOCK_HOLD_MS = 2_000;

export const REAL_CLOCK_SETTLE_SECONDS = 3;

export function scenarioSpec(scenario: RunnableScenario): ScenarioSpec {
  return scenario === 'no_fault' ? NO_FAULT : SCENARIOS[scenario];
}

export function isRunnableScenario(value: string): value is RunnableScenario {
  return value === 'no_fault' || Object.hasOwn(SCENARIOS, value);
}

export interface ChaosTask {
  tool: string;
  listTool: string;
  args: Record<string, string | number>;
  prompt: string;
}

function exampleArgs(target: TargetName): Record<string, string | number> {
  return Object.fromEntries(TARGETS[target].fields.map((field) => [field.name, field.name === 'qty' ? Number(field.example) : field.example]));
}

function task(target: TargetName, tool: string, listTool: string, goal: string): ChaosTask {
  const args = exampleArgs(target);
  return { tool, listTool, args, prompt: `${goal} exactly once with the ${tool} tool, arguments ${JSON.stringify(args)}. Check with ${listTool} if unsure.` };
}

export const CHAOS_TASKS: Readonly<Record<TargetName, ChaosTask>> = {
  checkout: task('checkout', 'place_order', 'list_orders', 'Place the order'),
  booking: task('booking', 'book_slot', 'list_bookings', 'Book the slot'),
  email: task('email', 'send_email', 'list_sent_emails', 'Send the email'),
  ticket: task('ticket', 'create_ticket', 'list_tickets', 'Create the support ticket'),
};
