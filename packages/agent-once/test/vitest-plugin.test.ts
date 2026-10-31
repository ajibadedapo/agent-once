import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { afterEach, describe, expect, test } from 'vitest';
import { startChaosTargets, type ChaosHandle } from '../src/integrations/vitest.js';
import { UpstreamStdioTransport } from '../src/mcp/upstream.js';
import { ManualClock } from '../src/time/clock.js';
import { ADMIN_TOKEN_HEADER } from '../src/chaos/targets/server.js';
import { postJson, send } from './chaos/chaos-harness.js';

const START_MS = 1_761_912_345_678;
const CLI = [process.execPath, fileURLToPath(new URL('../dist/cli/main.js', import.meta.url))];
const ORDER = { item: 'Blue mug', qty: '1' };

const handles: ChaosHandle[] = [];

afterEach(async () => {
  await Promise.all(handles.splice(0).map((handle) => handle.close()));
});

async function started(options: Parameters<typeof startChaosTargets>[0] = {}): Promise<ChaosHandle> {
  const handle = await startChaosTargets({ clock: new ManualClock(START_MS), cli: CLI, ...options });
  handles.push(handle);
  return handle;
}

describe('agent-once/vitest', () => {
  test('matchers pass on one effect and fail with a readable message on two', async () => {
    const handle = await started();
    expect((await postJson(`${handle.url}/api/checkout`, ORDER)).status).toBe(201);
    expect(handle).toHaveNoDuplicateEffects();
    expect(handle).toHaveExactlyOneEffect('checkout');
    expect(handle).not.toHaveExactlyOneEffect('booking');

    expect((await postJson(`${handle.url}/api/checkout`, ORDER)).status).toBe(201);
    expect(() => expect(handle).toHaveNoDuplicateEffects()).toThrow('checkout has 2 effects with the same fields {"item":"Blue mug","qty":"1"}: ORD-1, ORD-2');
    expect(() => expect(handle).toHaveExactlyOneEffect('checkout')).toThrow('expected exactly one checkout effect, found 2: ORD-1, ORD-2');
    expect((await handle.truth()).checkout).toHaveLength(2);
    expect((await send(`${handle.url}/__truth`)).status).toBe(403);
    expect(JSON.parse((await send(`${handle.url}/__truth`, { headers: { [ADMIN_TOKEN_HEADER]: handle.adminToken } })).body).checkout).toHaveLength(2);
  });

  test('two different effects on one target are not duplicates', async () => {
    const handle = await started();
    await postJson(`${handle.url}/api/checkout`, ORDER);
    await postJson(`${handle.url}/api/checkout`, { item: 'Red mug', qty: '1' });
    expect(handle).toHaveNoDuplicateEffects();
    expect(() => expect(handle).toHaveExactlyOneEffect('checkout')).toThrow('found 2');
  });

  test('matchers reject a value that is not a chaos handle and an unknown target', async () => {
    expect(() => expect({ url: 'http://127.0.0.1:9' }).toHaveNoDuplicateEffects()).toThrow('expected a handle from startChaosTargets');
    const handle = await started();
    expect(() => expect(handle).toHaveExactlyOneEffect('invoice' as 'checkout')).toThrow('unknown target invoice; expected one of checkout, booking, email, ticket');
  });

  test('an invalid fault plan is rejected before anything starts', async () => {
    await expect(started({ faults: [{ target: 'checkout', nth: 0, kind: 'none', holdMs: 0 }] })).rejects.toThrow('nth must be a positive integer');
  });

  test('faults passed at start apply to the first matching call', async () => {
    const handle = await started({ faults: [{ target: 'ticket', nth: 1, kind: 'stale_element', holdMs: 0 }] });
    expect((await postJson(`${handle.url}/api/ticket`, { title: 'Printer jam', body: 'Jammed.' })).status).toBe(409);
    expect((await postJson(`${handle.url}/api/ticket`, { title: 'Printer jam', body: 'Jammed.' })).status).toBe(201);
    expect(handle).toHaveExactlyOneEffect('ticket');
  });

  test('mcpCommand wraps with the proxy when guard is true', async () => {
    const handle = await started();
    const bare = handle.mcpCommand(false);
    expect(bare).toEqual([...CLI, 'chaos', 'targets-mcp', '--url', handle.url]);
    const guarded = handle.mcpCommand(true);
    const separator = guarded.indexOf('--');
    expect(guarded.slice(0, CLI.length + 2)).toEqual([...CLI, 'mcp', '--config']);
    expect(guarded.slice(separator + 1)).toEqual(bare);
    const configPath = guarded[CLI.length + 2] ?? '';
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as { tools: Record<string, unknown>; ledger: { path: string } };
    expect(Object.keys(config.tools)).toContain('place_order');
    expect(config.ledger.path).toBe(join(configPath, '..', 'ledger.db'));

    const [command = '', ...args] = guarded;
    const client = new Client({ name: 'vitest-plugin-test', version: '1.0.0' });
    try {
      await client.connect(new UpstreamStdioTransport({ command, args, env: process.env as Record<string, string>, cwd: process.cwd(), stderr: 'ignore' }));
      const names = (await client.listTools()).tools.map((tool) => tool.name);
      expect(names).toContain('place_order');
      expect(names).toContain('agent_once_resolve');
    } finally {
      await client.close();
    }
    await handle.close();
    expect(existsSync(configPath)).toBe(false);
  }, 30_000);
});
