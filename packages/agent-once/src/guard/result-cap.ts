import { CanonicalizationError, canonicalize, type JsonValue } from '../canonical/jcs.js';

export const DEFAULT_MAX_RESULT_BYTES = 262_144;

export type CappedResult = { result: JsonValue; truncated: boolean } | { result: null; truncated: false; error: string };

export function capResult(result: JsonValue, maxBytes: number): CappedResult {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(canonicalize(result), 'utf8');
  } catch (error) {
    if (error instanceof CanonicalizationError) return { result: null, truncated: false, error: error.message };
    throw error;
  }
  return bytes > maxBytes ? { result: null, truncated: true } : { result, truncated: false };
}

export function storedResultDetail(result: JsonValue, maxBytes: number): Record<string, JsonValue> {
  const capped = capResult(result, maxBytes);
  const detail: Record<string, JsonValue> = { result: capped.result, result_truncated: capped.truncated };
  if ('error' in capped) detail.result_error = capped.error;
  return detail;
}
