import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, test } from 'vitest';
import { chaosTargetsPreset } from '../../src/chaos/presets.js';
import { startTargets, type RunningTargets } from '../../src/chaos/targets/server.js';
import { guardMcpServers } from '../../src/integrations/claude-agent-sdk.js';
import { systemClock } from '../../src/time/clock.js';

const PACKAGE_DIR = fileURLToPath(new URL('../..', import.meta.url));
const BUILT_CLI = join(PACKAGE_DIR, 'dist/cli/main.js');
const PLAYWRIGHT_MCP_CLI = join(createRequire(import.meta.url).resolve('@playwright/mcp/package.json'), '..', 'cli.js');
const SETTLE_SECONDS = 0.2;
const MAX_ATTEMPTS = 3;
const CALL_TIMEOUT_MS = 20_000;
const PLACE_ORDER = /button "Place order" \[ref=([^\]]+)\]/;

interface Stdio {
  command: string;
  args: string[];
  env: Record<string, string>;
}

interface AgentRun {
  clicks: CallToolResult[];
  confirmed: boolean;
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-once-browser-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function checkoutTarget(): Promise<RunningTargets> {
  const targets = await startTargets({ clock: systemClock });
  cleanups.push(() => targets.close());
  targets.setFaults([{ target: 'checkout', nth: 1, kind: 'lost_response_after_commit', holdMs: 0 }]);
  return targets;
}

function playwrightServer(outputDir: string): Stdio {
  return {
    command: process.execPath,
    args: [PLAYWRIGHT_MCP_CLI, '--headless', '--isolated', '--browser', 'chromium', '--output-dir', outputDir],
    env: {},
  };
}

function guardedServer(home: string, outputDir: string): Stdio {
  const configPath = join(home, 'agent-once.json');
  writeFileSync(configPath, JSON.stringify({ ...chaosTargetsPreset(), ledger: { settleSeconds: SETTLE_SECONDS }, evidence: { jsonl: null } }));
  const { servers, unguarded } = guardMcpServers({ playwright: playwrightServer(outputDir) }, { session: 'browser-e2e', configPath, cliPath: BUILT_CLI });
  const wrapped = servers.playwright;
  if (unguarded.length > 0 || wrapped === undefined || !('command' in wrapped)) throw new Error('the Playwright server was not wrapped');
  return { command: wrapped.command, args: wrapped.args ?? [], env: wrapped.env ?? {} };
}

async function connect(server: Stdio, home: string): Promise<Client> {
  const client = new Client({ name: 'scripted-browser-agent', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args,
    env: { ...(process.env as Record<string, string>), ...server.env, AGENT_ONCE_HOME: home },
    cwd: home,
    stderr: 'ignore',
  });
  cleanups.push(() => client.close());
  await client.connect(transport);
  return client;
}

function textOf(result: CallToolResult): string {
  return result.content.map((item) => (item.type === 'text' ? item.text : '')).join('\n');
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<CallToolResult> {
  return (await client.callTool({ name, arguments: args }, undefined, { timeout: CALL_TIMEOUT_MS })) as CallToolResult;
}

async function naiveCheckout(client: Client, url: string): Promise<AgentRun> {
  const clicks: CallToolResult[] = [];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await call(client, 'browser_navigate', { url: `${url}/checkout` });
    const snapshot = textOf(await call(client, 'browser_snapshot', {}));
    const ref = PLACE_ORDER.exec(snapshot)?.[1];
    if (ref === undefined) throw new Error(`no Place order button in the snapshot:\n${snapshot}`);
    const click = await call(client, 'browser_click', { element: 'Place order button', target: ref });
    clicks.push(click);
    const text = textOf(click);
    if (text.includes('already happened')) return { clicks, confirmed: false };
    if (click.isError !== true && text.includes('Page Title: Order confirmed')) return { clicks, confirmed: true };
  }
  return { clicks, confirmed: false };
}

describe('Playwright MCP behind the proxy', () => {
  test('Playwright MCP behind the proxy: scripted browser agent hits lost_response_after_commit on checkout and the target records one order', async () => {
    const targets = await checkoutTarget();
    const home = tempDir();
    const client = await connect(guardedServer(home, join(home, 'playwright')), home);
    const run = await naiveCheckout(client, targets.url);
    expect(run.clicks).toHaveLength(2);
    expect(textOf(run.clicks[0] as CallToolResult)).toContain('Page Title: 504 Gateway Timeout');
    const status = (run.clicks[1]?._meta?.['io.github.ajibadedapo/agent-once'] as { status: string } | undefined)?.status;
    expect(status).toBe('replayed');
    expect(targets.truth().checkout).toHaveLength(1);
  }, 60_000);

  test('Playwright MCP without the proxy: the same scripted browser agent records two orders', async () => {
    const targets = await checkoutTarget();
    const home = tempDir();
    const client = await connect(playwrightServer(join(home, 'playwright')), home);
    const run = await naiveCheckout(client, targets.url);
    expect(run).toMatchObject({ confirmed: true });
    expect(run.clicks).toHaveLength(2);
    expect(textOf(run.clicks[0] as CallToolResult)).toContain('Page Title: 504 Gateway Timeout');
    expect(targets.truth().checkout).toHaveLength(2);
  }, 60_000);
});
