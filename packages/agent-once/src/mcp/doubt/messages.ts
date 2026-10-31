import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { DoubtInfo } from '../../guard/types.js';
import type { ToolClass } from '../../ledger/types.js';
import { RESOLVE_TOOL_NAME } from '../meta.js';
import { errorResult, statusMeta } from '../result-format.js';

const REPEAT_VERBS: Record<ToolClass, string> = { money: 'charge', irreversible: 'send', standard: 'act' };

type DoubtSubject = Pick<DoubtInfo, 'actionId' | 'tool' | 'toolClass'>;

function earlierCall(d: DoubtSubject): string {
  return `an earlier identical ${d.tool} call (action ${d.actionId}) may already have taken effect and its outcome is unknown.`;
}

function askThePerson(d: Pick<DoubtInfo, 'actionId'>): string {
  return `Ask the user to run: npx agent-once resolve ${d.actionId} --happened (or --not-happened).`;
}

export function doubtQuestion(d: DoubtSubject): string {
  return `agent-once: an earlier ${d.tool} call (action ${d.actionId}) may already have happened, and repeating it could ${REPEAT_VERBS[d.toolClass]} twice. Did it happen?`;
}

export function inDoubtToolResult(d: DoubtSubject, agentMayResolve: boolean): CallToolResult {
  const next = agentMayResolve
    ? `Check whether it happened (for example, read the page or list the records), then call ${RESOLVE_TOOL_NAME} with action_id "${d.actionId}" and outcome "happened" or "not_happened".`
    : askThePerson(d);
  return errorResult(`agent-once stopped this call: ${earlierCall(d)} Do not retry it. ${next}`, statusMeta('in_doubt', d.actionId, d.toolClass));
}

export function blockedToolResult(d: DoubtSubject): CallToolResult {
  return errorResult(
    `agent-once blocked this call: ${earlierCall(d)} This is a ${d.toolClass} action, so a person must confirm before anything is retried. ${askThePerson(d)}`,
    statusMeta('blocked', d.actionId, d.toolClass),
  );
}

export function checkThenRetryToolResult(d: Pick<DoubtInfo, 'actionId' | 'tool'>): CallToolResult {
  return {
    content: [
      {
        type: 'text',
        text: `agent-once: the earlier ${d.tool} attempt (action ${d.actionId}) did not happen, so it was not repeated blindly. Check the current state, then call ${d.tool} again if it is still needed.`,
      },
    ],
    _meta: statusMeta('retry_by_agent', d.actionId),
  };
}
