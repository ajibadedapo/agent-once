import type { ToolClass } from '../ledger/types.js';

export const DEFAULT_SIDE_EFFECT_PATTERNS: readonly string[] = Object.freeze([
  'pay',
  'buy',
  'checkout',
  'book',
  'confirm',
  'submit',
  'send',
  'delete',
  'publish',
  'order',
  'purchase',
  'place',
  'create',
  'post',
]);

export const DEFAULT_MONEY_PATTERNS: readonly string[] = Object.freeze([
  'pay',
  'buy',
  'checkout',
  'purchase',
  'charge',
  'order',
  'payment',
  'transfer',
]);

export const DEFAULT_IRREVERSIBLE_PATTERNS: readonly string[] = Object.freeze(['delete', 'publish', 'send', 'deploy']);

function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0);
}

function asPhrase(text: string): string {
  return ` ${words(text).join(' ')} `;
}

function containsPattern(phrase: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => {
    const wanted = words(pattern);
    return wanted.length > 0 && phrase.includes(` ${wanted.join(' ')} `);
  });
}

export function matchesAnyPattern(name: string, text: string, patterns: readonly string[]): boolean {
  return containsPattern(asPhrase(name), patterns) || containsPattern(asPhrase(text), patterns);
}

export function classifyTool(name: string, text: string, patterns: { money: string[]; irreversible: string[] }): ToolClass {
  if (matchesAnyPattern(name, text, patterns.money)) return 'money';
  if (matchesAnyPattern(name, text, patterns.irreversible)) return 'irreversible';
  return 'standard';
}
