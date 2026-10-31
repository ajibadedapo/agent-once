import type { BrowserConfig } from '../../config/schema.js';
import { compiled, matchesAny } from './compiled.js';

export type BrowserOutcomeKind = 'ok' | 'error_result' | 'not_dispatched';

export function classifyBrowserOutcome(resultText: string, isError: boolean, cfg: BrowserConfig): BrowserOutcomeKind {
  const patterns = compiled(cfg);
  if (isError) return matchesAny(resultText, patterns.notDispatchedErrors) ? 'not_dispatched' : 'error_result';
  if (matchesAny(resultText, patterns.failureMarkers)) return 'error_result';
  return matchesAny(resultText, patterns.successMarkers) ? 'ok' : 'error_result';
}
