import type { BrowserConfig, ReadBackRule } from '../../config/schema.js';
import { compiled } from './compiled.js';

export function browserReadBackRule(cfg: BrowserConfig, url: string | undefined): ReadBackRule | undefined {
  if (url === undefined) return undefined;
  return compiled(cfg).readBack.find((entry) => entry.url.test(url))?.rule;
}
