import type { BrowserConfig } from '../../config/schema.js';

export type BrowserOutcomeKind = 'ok' | 'error_result' | 'not_dispatched';

function matchesAny(text: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => new RegExp(pattern, 'i').test(text));
}

export function classifyBrowserOutcome(resultText: string, isError: boolean, cfg: BrowserConfig): BrowserOutcomeKind {
  if (isError) return matchesAny(resultText, cfg.notDispatchedErrors) ? 'not_dispatched' : 'error_result';
  if (matchesAny(resultText, cfg.failureMarkers)) return 'error_result';
  return matchesAny(resultText, cfg.successMarkers) ? 'ok' : 'error_result';
}
