import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { escapeRegExp, STATUS_META_KEY } from 'agent-once/mcp';
import { TARGETS, type TargetName } from 'agent-once/chaos';

export type ToolCaller = (name: string, args: Record<string, unknown>) => Promise<CallToolResult>;

export type Wait = (ms: number) => Promise<void>;

export interface BrowserTask {
  url: string;
  target: TargetName;
}

export interface BrowserAgentRun {
  confirmed: boolean;
  clicks: number;
  calls: number;
  blockedOrDoubt: number;
  responseChars: number;
  snapshotChars: number[];
}

export const BROWSER_RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 4_000];

function textOf(result: CallToolResult): string {
  return result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
}

function statusOf(result: CallToolResult): string | undefined {
  const status: unknown = result._meta?.[STATUS_META_KEY];
  if (typeof status !== 'object' || status === null) return undefined;
  const value = (status as { status?: unknown }).status;
  return typeof value === 'string' ? value : undefined;
}

export async function naiveBrowserAgent(callTool: ToolCaller, task: BrowserTask, wait: Wait): Promise<BrowserAgentRun> {
  const run: BrowserAgentRun = { confirmed: false, clicks: 0, calls: 0, blockedOrDoubt: 0, responseChars: 0, snapshotChars: [] };
  const call = async (name: string, args: Record<string, unknown>): Promise<CallToolResult> => {
    run.calls += 1;
    const result = await callTool(name, args);
    run.responseChars += textOf(result).length;
    return result;
  };
  const { button, confirmedHeading } = TARGETS[task.target];
  const buttonRef = new RegExp(`button "${escapeRegExp(button)}" \\[ref=([^\\]]+)\\]`);
  const delays = [...BROWSER_RETRY_DELAYS_MS];
  for (;;) {
    await call('browser_navigate', { url: `${task.url}/${task.target}` });
    const snapshot = textOf(await call('browser_snapshot', {}));
    run.snapshotChars.push(snapshot.length);
    const ref = buttonRef.exec(snapshot)?.[1];
    if (ref === undefined) throw new Error(`no "${button}" button in the snapshot:\n${snapshot}`);
    const click = await call('browser_click', { element: `${button} button`, target: ref });
    run.clicks += 1;
    const status = statusOf(click);
    if (status === 'replayed' || (click.isError !== true && textOf(click).includes(`Page Title: ${confirmedHeading}`))) {
      run.confirmed = true;
      return run;
    }
    if (status === 'in_doubt' || status === 'blocked') run.blockedOrDoubt += 1;
    const delayMs = delays.shift();
    if (delayMs === undefined) return run;
    await wait(delayMs);
  }
}
