import { readFileSync } from 'node:fs';
import type { CallToolResult, Implementation } from '@modelcontextprotocol/sdk/types.js';

export type FixtureProfile = 'playwright' | 'chrome-devtools';

export type FixtureName =
  | 'navigate'
  | 'snapshot'
  | 'snapshot-again'
  | 'click'
  | 'click-stale'
  | 'click-error-page'
  | 'products-snapshot'
  | 'navigate-orders'
  | 'orders-snapshot'
  | 'done-snapshot'
  | 'form-snapshot'
  | 'type-submit';

function read(profile: FixtureProfile, name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../fixtures/browser/${profile}-${name}.json`, import.meta.url), 'utf8'));
}

export function fixture(profile: FixtureProfile, name: FixtureName): CallToolResult {
  return read(profile, name) as CallToolResult;
}

export function fixtureText(profile: FixtureProfile, name: FixtureName): string {
  return fixture(profile, name)
    .content.map((item) => (item.type === 'text' ? item.text : ''))
    .join('\n');
}

export function serverInfo(profile: FixtureProfile): Implementation {
  return read(profile, 'server-info') as Implementation;
}

export function originOf(profile: FixtureProfile): string {
  const match = /http:\/\/127\.0\.0\.1:\d+/.exec(fixtureText(profile, 'snapshot'));
  if (match === null) throw new Error(`no origin in the ${profile} snapshot fixture`);
  return match[0];
}

export function refFor(profile: FixtureProfile, name: FixtureName, label: string): string {
  const text = fixtureText(profile, name);
  const pattern = profile === 'playwright' ? new RegExp(`"${label}" \\[ref=([^\\]]+)\\]`) : new RegExp(`uid=(\\S+) \\S+ "${label}"`);
  const match = pattern.exec(text);
  if (match?.[1] === undefined) throw new Error(`no ref for ${label} in ${profile}-${name}`);
  return match[1];
}
