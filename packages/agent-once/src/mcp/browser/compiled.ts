import type { BrowserConfig, ReadBackRule } from '../../config/schema.js';

export interface CompiledBrowserConfig {
  notDispatchedErrors: RegExp[];
  successMarkers: RegExp[];
  failureMarkers: RegExp[];
  capture: { url: RegExp; regex: RegExp }[];
  readBack: { url: RegExp; rule: ReadBackRule }[];
}

const cache = new WeakMap<BrowserConfig, CompiledBrowserConfig>();

function all(patterns: readonly string[]): RegExp[] {
  return patterns.map((pattern) => new RegExp(pattern, 'i'));
}

export function compiled(cfg: BrowserConfig): CompiledBrowserConfig {
  const known = cache.get(cfg);
  if (known !== undefined) return known;
  const fresh: CompiledBrowserConfig = {
    notDispatchedErrors: all(cfg.notDispatchedErrors),
    successMarkers: all(cfg.successMarkers),
    failureMarkers: all(cfg.failureMarkers),
    capture: cfg.capture.map((rule) => ({ url: new RegExp(rule.urlPattern, 'i'), regex: new RegExp(rule.regex, 'm') })),
    readBack: cfg.readBack.map(({ urlPattern, ...rule }) => ({ url: new RegExp(urlPattern, 'i'), rule })),
  };
  cache.set(cfg, fresh);
  return fresh;
}

export function matchesAny(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(text));
}
