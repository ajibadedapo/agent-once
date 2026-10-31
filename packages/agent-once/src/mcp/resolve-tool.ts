import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Guard } from '../guard/guard.js';
import { invalidResolveArgsResult, resolveRecordedResult, resolveRefusedResult } from './result-format.js';

export const RESOLVE_TOOL_NAME = 'agent_once_resolve';

export const RESOLVE_TOOL: Tool = {
  name: RESOLVE_TOOL_NAME,
  title: 'Resolve an action agent-once reported as in doubt',
  description:
    'agent-once stops a repeated call when an earlier identical call may already have taken effect. Check whether that action happened (for example by reading the page or listing the records), then record the answer here with the action_id from the agent-once message. Money and irreversible actions can only be resolved by a person.',
  inputSchema: {
    type: 'object',
    properties: {
      action_id: { type: 'string', description: 'The action id from the agent-once message, for example ao_1234abcd.' },
      outcome: { type: 'string', enum: ['happened', 'not_happened'], description: 'Whether the earlier action actually took effect.' },
    },
    required: ['action_id', 'outcome'],
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export function handleResolveCall(args: Record<string, unknown>, guard: Guard): CallToolResult {
  const actionId = args.action_id;
  const outcome = args.outcome;
  if (typeof actionId !== 'string' || actionId === '') return invalidResolveArgsResult('a non-empty action_id string');
  if (outcome !== 'happened' && outcome !== 'not_happened') return invalidResolveArgsResult('outcome "happened" or "not_happened"');
  const resolved = guard.resolve(actionId, outcome, 'agent');
  if (resolved.ok) return resolveRecordedResult(actionId, outcome);
  return resolveRefusedResult(actionId, resolved.reason, 'error' in resolved ? resolved.error : undefined);
}
