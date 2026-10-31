import { CanonicalizationError, canonicalize, type JsonValue } from '../canonical/jcs.js';

export const DEFAULT_MAX_RESULT_BYTES = 262_144;

export function capResult(result: JsonValue, maxBytes: number): { result: JsonValue; truncated: boolean } {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(canonicalize(result), 'utf8');
  } catch (error) {
    if (error instanceof CanonicalizationError) return { result: null, truncated: true };
    throw error;
  }
  return bytes > maxBytes ? { result: null, truncated: true } : { result, truncated: false };
}
