import { createHash } from 'node:crypto';
import { canonicalize, type JsonValue } from '../canonical/jcs.js';

const ARGS_DOMAIN = 'agent-once/v1';
const INTENT_KEY_DOMAIN = 'agent-once/v1/intent';
const ACTION_ID_PREFIX = 'ao_';
const ACTION_ID_HEX_LENGTH = 24;

function sha256Hex(value: JsonValue): string {
  return createHash('sha256').update(canonicalize(value), 'utf8').digest('hex');
}

export function intentHash(input: { sessionKey: string; tool: string; projectedArgs: JsonValue; intentKey?: string }): string {
  if (input.intentKey !== undefined) return sha256Hex([INTENT_KEY_DOMAIN, input.sessionKey, input.tool, input.intentKey]);
  return sha256Hex([ARGS_DOMAIN, input.sessionKey, input.tool, input.projectedArgs]);
}

export function actionId(intentHash: string, occurrence: number, intendedAtMs: number): string {
  return ACTION_ID_PREFIX + sha256Hex([intentHash, occurrence, intendedAtMs]).slice(0, ACTION_ID_HEX_LENGTH);
}
