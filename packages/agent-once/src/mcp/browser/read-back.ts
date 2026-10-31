import type { BrowserConfig, ReadBackRule } from '../../config/schema.js';

export function browserReadBackRule(cfg: BrowserConfig, url: string | undefined): ReadBackRule | undefined {
  if (url === undefined) return undefined;
  return cfg.readBack.find((rule) => new RegExp(rule.urlPattern, 'i').test(url));
}
