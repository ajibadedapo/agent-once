import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { JsonValue } from '../canonical/jcs.js';
import type { DoubtInfo } from '../guard/types.js';
import { STATUS_META_KEY } from './meta.js';

export type GuardStatus = 'executed' | 'replayed' | 'in_doubt' | 'blocked';

export interface ReplayInfo {
  actionId: string;
  result: JsonValue | null;
  resultTruncated: boolean;
}

function textItem(text: string): CallToolResult['content'][number] {
  return { type: 'text', text };
}

function errorResult(text: string, meta?: Record<string, unknown>): CallToolResult {
  return { content: [textItem(text)], isError: true, ...(meta === undefined ? {} : { _meta: meta }) };
}

function statusMeta(status: GuardStatus, actionId: string): Record<string, unknown> {
  return { [STATUS_META_KEY]: { status, action_id: actionId } };
}

function asCallToolResult(value: JsonValue | null): CallToolResult | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value) || !Array.isArray(value.content)) return undefined;
  return value as unknown as CallToolResult;
}

export function withStatus(result: CallToolResult, status: GuardStatus, actionId: string): CallToolResult {
  return { ...result, _meta: { ...result._meta, ...statusMeta(status, actionId) } };
}

export function replayedResult(replay: ReplayInfo): CallToolResult {
  const notice = textItem(
    `agent-once: this action already happened (action ${replay.actionId}); returning the recorded result instead of repeating it.`,
  );
  const recorded = asCallToolResult(replay.result);
  if (recorded !== undefined) return withStatus({ ...recorded, content: [notice, ...recorded.content] }, 'replayed', replay.actionId);
  const content = [notice];
  if (replay.resultTruncated) content.push(textItem('agent-once: the effect is confirmed, but the recorded result was too large to keep, so it cannot be shown again.'));
  return withStatus({ content }, 'replayed', replay.actionId);
}

export function inDoubtResult(doubt: DoubtInfo, agentMayResolve: boolean): CallToolResult {
  const next = agentMayResolve
    ? `Check whether it happened, then call agent_once_resolve with action_id "${doubt.actionId}" and outcome "happened" or "not_happened".`
    : `Ask the user to run: npx agent-once resolve ${doubt.actionId} --happened (or --not-happened).`;
  return errorResult(
    `agent-once stopped this call: an earlier identical ${doubt.tool} call (action ${doubt.actionId}) may already have taken effect and its outcome is unknown. Do not retry it. ${next}`,
    statusMeta('in_doubt', doubt.actionId),
  );
}

export function blockedResult(doubt: DoubtInfo): CallToolResult {
  return errorResult(
    `agent-once blocked this call: an earlier identical ${doubt.tool} call (action ${doubt.actionId}) may already have taken effect and its outcome is unknown. This is a ${doubt.toolClass} action, so a person must confirm before anything is retried. Ask the user to run: npx agent-once resolve ${doubt.actionId} --happened (or --not-happened).`,
    statusMeta('blocked', doubt.actionId),
  );
}

export function ledgerUnavailableResult(error: string): CallToolResult {
  return errorResult(`${error}. agent-once did not run this call because it cannot record it; read-only tools still work.`);
}

export function unidentifiableCallResult(tool: string, problem: string): CallToolResult {
  return errorResult(`agent-once did not run this ${tool} call because its arguments cannot be identified: ${problem}`);
}

export function upstreamExitedResult(tool: string, actionId: string | undefined, exitCode: number | null): CallToolResult {
  const code = exitCode === null ? 'without an exit code' : `with code ${exitCode}`;
  if (actionId === undefined) return errorResult(`agent-once: the MCP server exited ${code} before answering this ${tool} call.`);
  return errorResult(
    `agent-once: the MCP server exited ${code} while this ${tool} call (action ${actionId}) was in flight, so it may or may not have taken effect. Do not retry it until its outcome is known.`,
    statusMeta('in_doubt', actionId),
  );
}

export function callFailedResult(tool: string, actionId: string | undefined, error: string): CallToolResult {
  const subject = actionId === undefined ? `this ${tool} call` : `this ${tool} call (action ${actionId})`;
  return errorResult(`agent-once: ${subject} failed: ${error}`);
}

export function resolveRecordedResult(actionId: string, outcome: 'happened' | 'not_happened'): CallToolResult {
  const text =
    outcome === 'happened'
      ? `agent-once recorded that action ${actionId} happened. Repeating the identical call returns the recorded outcome instead of running it again.`
      : `agent-once recorded that action ${actionId} did not happen. The identical call may now be retried.`;
  return { content: [textItem(text)] };
}

const REFUSALS: Record<string, (actionId: string) => string> = {
  unknown_action: (actionId) => `agent-once has no record of action ${actionId}.`,
  not_in_doubt: (actionId) => `action ${actionId} is not in doubt, so there is nothing to resolve.`,
  agent_cannot_resolve_class: (actionId) =>
    `action ${actionId} is a money or irreversible action, so only a person can resolve it. Ask the user to run: npx agent-once resolve ${actionId} --happened (or --not-happened).`,
  too_soon: (actionId) => `it is too soon to say that action ${actionId} did not happen; its effect may still be arriving. Check again shortly.`,
};

export function resolveRefusedResult(actionId: string, reason: string, error?: string): CallToolResult {
  const explain = REFUSALS[reason];
  return errorResult(`agent-once: ${explain === undefined ? (error ?? reason) : explain(actionId)}`);
}

export function invalidResolveArgsResult(problem: string): CallToolResult {
  return errorResult(`agent-once: agent_once_resolve needs ${problem}.`);
}
