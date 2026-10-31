import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { JsonValue } from '../canonical/jcs.js';
import type { ToolClass } from '../ledger/types.js';
import { STATUS_META_KEY } from './meta.js';

export type GuardStatus = 'executed' | 'replayed' | 'in_doubt' | 'blocked' | 'retry_by_agent';

export interface ReplayInfo {
  actionId: string;
  result: JsonValue | null;
  resultTruncated: boolean;
}

function textItem(text: string): CallToolResult['content'][number] {
  return { type: 'text', text };
}

export function errorResult(text: string, meta?: Record<string, unknown>): CallToolResult {
  return { content: [textItem(text)], isError: true, ...(meta === undefined ? {} : { _meta: meta }) };
}

export function statusMeta(status: GuardStatus, actionId: string, toolClass?: ToolClass): Record<string, unknown> {
  return { [STATUS_META_KEY]: { status, action_id: actionId, ...(toolClass === undefined ? {} : { class: toolClass }) } };
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

export function ledgerUnavailableResult(error: string): CallToolResult {
  return errorResult(`${error}. agent-once did not run this call because it cannot record it; read-only tools still work.`);
}

export function unidentifiableCallResult(tool: string, problem: string): CallToolResult {
  return errorResult(`agent-once did not run this ${tool} call because its arguments cannot be identified: ${problem}`);
}

export function upstreamExitedResult(tool: string, actionId: string | undefined, exitCode: number | null, toolClass?: ToolClass): CallToolResult {
  const code = exitCode === null ? 'without an exit code' : `with code ${exitCode}`;
  if (actionId === undefined) return errorResult(`agent-once: the MCP server exited ${code} before answering this ${tool} call.`);
  return errorResult(
    `agent-once: the MCP server exited ${code} while this ${tool} call (action ${actionId}) was in flight, so it may or may not have taken effect. Do not retry it until its outcome is known.`,
    statusMeta('in_doubt', actionId, toolClass),
  );
}

export function retryByAgentResult(tool: string, actionId: string): CallToolResult {
  return {
    content: [
      textItem(
        `agent-once: the earlier ${tool} attempt (action ${actionId}) did not happen, so this call was not run against a page that may have changed. The page has been loaded again: take a fresh snapshot and repeat the action.`,
      ),
    ],
    _meta: statusMeta('retry_by_agent', actionId),
  };
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
  too_soon: (actionId) => `it is too soon to say that action ${actionId} did not happen; its effect may still be arriving. Check again shortly.`,
};

export function resolveRefusedResult(actionId: string, reason: string, error?: string): CallToolResult {
  const explain = REFUSALS[reason];
  return errorResult(`agent-once: ${explain === undefined ? (error ?? reason) : explain(actionId)}`);
}

export function invalidResolveArgsResult(problem: string): CallToolResult {
  return errorResult(`agent-once: agent_once_resolve needs ${problem}.`);
}
