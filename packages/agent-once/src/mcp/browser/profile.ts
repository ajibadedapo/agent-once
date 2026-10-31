import type { Implementation } from '@modelcontextprotocol/sdk/types.js';

export type BrowserProfile = 'playwright' | 'chrome-devtools';

const SERVER_NAMES: ReadonlyMap<string, BrowserProfile> = new Map([
  ['Playwright', 'playwright'],
  ['chrome_devtools', 'chrome-devtools'],
]);

const COMMAND_MARKERS: readonly [string, BrowserProfile][] = [
  ['@playwright/mcp', 'playwright'],
  ['chrome-devtools-mcp', 'chrome-devtools'],
];

export function detectBrowserProfile(serverInfo: Implementation | undefined, command: string[]): BrowserProfile | undefined {
  const named = serverInfo === undefined ? undefined : SERVER_NAMES.get(serverInfo.name);
  if (named !== undefined) return named;
  for (const part of command) {
    const marker = COMMAND_MARKERS.find(([text]) => part.includes(text));
    if (marker !== undefined) return marker[1];
  }
  return undefined;
}
