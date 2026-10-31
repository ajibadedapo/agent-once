import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool, type ElicitationRequest, type McpServerConfig, type OnElicitation } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ElicitRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import * as z from 'zod';
import { Guard } from '../../src/guard/guard.js';
import type { HumanResolution } from '../../src/guard/types.js';
import { actionId } from '../../src/identity/identity.js';
import { agentOnceElicitationHandler, guardMcpServers, guardSdkTool } from '../../src/integrations/claude-agent-sdk.js';
import type { LedgerStore } from '../../src/ledger/types.js';
import { MemoryLedgerStore } from '../../src/ledger/memory-store.js';
import { ELICITATION_SCHEMA } from '../../src/mcp/doubt/elicitation-resolver.js';
import { createHumanResolver } from '../../src/mcp/doubt/human-resolver.js';
import { blockedToolResult, doubtQuestion, inDoubtToolResult } from '../../src/mcp/doubt/messages.js';
import { RESOLVE_TOOL_NAME } from '../../src/mcp/meta.js';
import { ManualClock } from '../../src/time/clock.js';
import { RecordingSink, START_MS } from '../guard-harness.js';
import { FIXTURE, startProxy, stats, statusOf, textOf, Workspace } from '../mcp/proxy-harness.js';

const PACKAGE_DIR = fileURLToPath(new URL('../..', import.meta.url));
const BUILT_CLI = join(PACKAGE_DIR, 'dist/cli/main.js');
const SIGNAL_OPTIONS = { signal: new AbortController().signal, requestId: 'req-1' };

function guardOn(store: LedgerStore, clock: ManualClock, runInstance: string): Guard {
  return new Guard({ store, clock, runInstance, evidence: new RecordingSink() });
}

function counted(name: string, behaviour: (count: number) => CallToolResult) {
  const calls = { count: 0 };
  const definition = tool(name, `${name} for the test shop`, { item: z.string(), qty: z.number() }, async () => {
    calls.count += 1;
    return behaviour(calls.count);
  });
  return { calls, definition };
}

function failing(name: string) {
  const calls = { count: 0 };
  const definition = tool(name, `${name} for the test shop`, { item: z.string(), qty: z.number() }, async () => {
    calls.count += 1;
    throw new Error('connection reset after the order was written');
  });
  return { calls, definition };
}

function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

describe('guardMcpServers', () => {
  test('guardMcpServers wraps stdio servers and reports http servers as unguarded', () => {
    const remote: McpServerConfig = { type: 'http', url: 'https://mcp.example.test/mcp', headers: { authorization: 'Bearer x' } };
    const events: McpServerConfig = { type: 'sse', url: 'https://mcp.example.test/sse' };
    const { servers, unguarded } = guardMcpServers(
      {
        shop: { command: 'node', args: ['shop.js', '--port', '0'], env: { SHOP_MODE: 'test' }, timeout: 5000 },
        browser: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@0.0.83'] },
        remote,
        events,
      },
      { session: 'nightly-checkout', configPath: '/etc/agent-once.json', cliPath: '/opt/agent-once/cli/main.js' },
    );
    expect(servers.shop).toEqual({
      command: process.execPath,
      args: ['/opt/agent-once/cli/main.js', 'mcp', '--config', '/etc/agent-once.json', '--', 'node', 'shop.js', '--port', '0'],
      env: { SHOP_MODE: 'test', AGENT_ONCE_SESSION: 'nightly-checkout' },
      timeout: 5000,
    });
    expect(servers.browser).toEqual({
      type: 'stdio',
      command: process.execPath,
      args: ['/opt/agent-once/cli/main.js', 'mcp', '--config', '/etc/agent-once.json', '--', 'npx', '@playwright/mcp@0.0.83'],
      env: { AGENT_ONCE_SESSION: 'nightly-checkout' },
    });
    expect(servers.remote).toBe(remote);
    expect(servers.events).toBe(events);
    expect(unguarded).toEqual(['remote', 'events']);
  });

  test('without options the wrapper runs the bundled CLI and leaves the server env alone', () => {
    const { servers, unguarded } = guardMcpServers({ shop: { command: 'node', args: ['shop.js'] } });
    expect(servers.shop).toEqual({
      command: process.execPath,
      args: [fileURLToPath(new URL('../../src/cli/main.js', import.meta.url)), 'mcp', '--', 'node', 'shop.js'],
    });
    expect(unguarded).toEqual([]);
  });

  describe('a wrapped config', () => {
    let workspace: Workspace;
    let client: Client | undefined;

    beforeEach(() => {
      workspace = new Workspace();
    });

    afterEach(async () => {
      await client?.close();
      client = undefined;
      await workspace.dispose();
    });

    test('wrapped config launches a working proxy', async () => {
      const { servers } = guardMcpServers(
        { counter: { command: process.execPath, args: [FIXTURE], env: { COUNTER_STATE: workspace.statePath } } },
        { session: 'wrapped-counter', cliPath: BUILT_CLI },
      );
      const wrapped = servers.counter;
      if (wrapped === undefined || !('command' in wrapped)) throw new Error('counter was not wrapped as a stdio server');
      client = new Client({ name: 'wrapped-test', version: '1.0.0' });
      await client.connect(
        new StdioClientTransport({
          command: wrapped.command,
          args: wrapped.args ?? [],
          env: { ...(process.env as Record<string, string>), ...wrapped.env, AGENT_ONCE_HOME: workspace.dir },
          cwd: workspace.dir,
          stderr: 'ignore',
        }),
      );
      const names = (await client.listTools()).tools.map((listed) => listed.name);
      expect(names).toContain('increment');
      expect(names).toContain(RESOLVE_TOOL_NAME);
      const charged = await client.callTool({ name: 'charge', arguments: { amount: 10 } });
      expect(statusOf(charged)?.status).toBe('executed');
      expect((await stats(client)).count).toBe(1);
    }, 30_000);
  });
});

describe('guardSdkTool', () => {
  test('guardSdkTool dedupes a retried handler', async () => {
    const clock = new ManualClock(START_MS);
    const store = new MemoryLedgerStore(clock);
    const { calls, definition } = counted('place_order', (count) => textResult(`Order ORD-${count} confirmed`));
    const first = guardSdkTool(guardOn(store, clock, 'run-1'), definition, { sessionKey: 'shopper' });
    const rerun = guardSdkTool(guardOn(store, clock, 'run-2'), definition, { sessionKey: 'shopper' });
    expect(first.name).toBe('place_order');
    expect(first.inputSchema).toBe(definition.inputSchema);
    expect(await first.handler({ item: 'Blue mug', qty: 1 }, {})).toEqual(textResult('Order ORD-1 confirmed'));
    clock.advance(1_000);
    const replayed = await rerun.handler({ item: 'Blue mug', qty: 1 }, {});
    expect(replayed.isError).toBeUndefined();
    expect(replayed.content.map((item) => (item.type === 'text' ? item.text : ''))).toEqual([
      expect.stringContaining('agent-once: this action already happened'),
      'Order ORD-1 confirmed',
    ]);
    expect(calls.count).toBe(1);
  });

  test('parallel identical calls run the handler once', async () => {
    const clock = new ManualClock(START_MS);
    const { calls, definition } = counted('create_ticket', (count) => textResult(`Ticket TCK-${count} created`));
    const guarded = guardSdkTool(guardOn(new MemoryLedgerStore(clock), clock, 'run-1'), definition, { sessionKey: 'helpdesk' });
    const results = await Promise.all([guarded.handler({ item: 'Printer', qty: 1 }, {}), guarded.handler({ item: 'Printer', qty: 1 }, {})]);
    expect(results).toEqual([textResult('Ticket TCK-1 created'), textResult('Ticket TCK-1 created')]);
    expect(calls.count).toBe(1);
  });

  test('a retry after a lost result gets the in-doubt copy for standard tools and the blocked copy for money tools', async () => {
    const clock = new ManualClock(START_MS);
    const store = new MemoryLedgerStore(clock);
    const guard = guardOn(store, clock, 'run-1');
    const ticket = failing('create_ticket');
    const order = failing('place_order');
    const guardedTicket = guardSdkTool(guard, ticket.definition, { sessionKey: 'helpdesk' });
    const guardedOrder = guardSdkTool(guard, order.definition, { sessionKey: 'helpdesk' });
    await expect(guardedTicket.handler({ item: 'Printer', qty: 1 }, {})).rejects.toThrow('connection reset after the order was written');
    await expect(guardedOrder.handler({ item: 'Blue mug', qty: 1 }, {})).rejects.toThrow('connection reset after the order was written');
    clock.advance(1_000);
    const ticketRetry = await guardedTicket.handler({ item: 'Printer', qty: 1 }, {});
    const orderRetry = await guardedOrder.handler({ item: 'Blue mug', qty: 1 }, {});
    const ticketAction = statusOf(ticketRetry)?.action_id ?? '';
    const orderAction = statusOf(orderRetry)?.action_id ?? '';
    expect(ticketAction).toMatch(/^ao_[0-9a-f]{24}$/);
    expect(ticketRetry).toEqual(inDoubtToolResult({ actionId: ticketAction, tool: 'create_ticket', toolClass: 'standard' }, false));
    expect(orderRetry).toEqual(blockedToolResult({ actionId: orderAction, tool: 'place_order', toolClass: 'money' }));
    expect([ticket.calls.count, order.calls.count]).toEqual([1, 1]);
  });

  test('explicit policy and class override the name based defaults', async () => {
    const clock = new ManualClock(START_MS);
    const guard = guardOn(new MemoryLedgerStore(clock), clock, 'run-1');
    const order = failing('place_order');
    const guarded = guardSdkTool(guard, order.definition, { sessionKey: 'shopper', policy: 'guard', toolClass: 'standard', identityRule: { include: ['item'] } });
    await expect(guarded.handler({ item: 'Blue mug', qty: 1 }, {})).rejects.toThrow();
    const retry = await guarded.handler({ item: 'Blue mug', qty: 2 }, {});
    expect(retry).toEqual(inDoubtToolResult({ actionId: statusOf(retry)?.action_id ?? '', tool: 'place_order', toolClass: 'standard' }, false));
    expect(order.calls.count).toBe(1);
  });

  test('a reconciler that says retry gets a non-error instruction to check and call again', async () => {
    const clock = new ManualClock(START_MS);
    const guard = guardOn(new MemoryLedgerStore(clock), clock, 'run-1');
    const ticket = failing('create_ticket');
    const guarded = guardSdkTool(guard, ticket.definition, {
      sessionKey: 'helpdesk',
      reconciler: async () => ({ outcome: 'not_happened', retryByAgent: true }),
    });
    await expect(guarded.handler({ item: 'Printer', qty: 1 }, {})).rejects.toThrow();
    clock.advance(10_000);
    const retry = await guarded.handler({ item: 'Printer', qty: 1 }, {});
    expect(retry.isError).toBeUndefined();
    expect(statusOf(retry)?.status).toBe('retry_by_agent');
    expect(textOf(retry)).toBe(
      `agent-once: the earlier create_ticket attempt (action ${statusOf(retry)?.action_id ?? ''}) did not happen, so it was not repeated blindly. Check the current state, then call create_ticket again if it is still needed.`,
    );
    expect(ticket.calls.count).toBe(1);
  });

  test('pass policy runs every call and arguments that cannot be identified are refused without running', async () => {
    const clock = new ManualClock(START_MS);
    const guard = guardOn(new MemoryLedgerStore(clock), clock, 'run-1');
    const { calls, definition } = counted('place_order', (count) => textResult(`Order ORD-${count} confirmed`));
    const passed = guardSdkTool(guard, definition, { sessionKey: 'shopper', policy: 'pass' });
    await passed.handler({ item: 'Blue mug', qty: 1 }, {});
    await passed.handler({ item: 'Blue mug', qty: 1 }, {});
    expect(calls.count).toBe(2);
    const guarded = guardSdkTool(guard, definition, { sessionKey: 'shopper' });
    const refused = await guarded.handler({ item: 'Blue mug', qty: Number.NaN }, {});
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('agent-once did not run this place_order call because its arguments cannot be identified');
    expect(calls.count).toBe(2);
  });
});

describe('agentOnceElicitationHandler', () => {
  const agentOnceRequest = (message: string): ElicitationRequest => ({ serverName: 'shop', message, mode: 'form', requestedSchema: ELICITATION_SCHEMA });

  test('elicitation handler answers agent-once requests and delegates others', async () => {
    const questions: { message: string; serverName: string }[] = [];
    const answers: HumanResolution[] = [{ outcome: 'happened', by: 'human' }, { outcome: 'not_happened', by: 'human' }, { outcome: 'unresolved' }];
    const delegated: ElicitationRequest[] = [];
    const fallback: OnElicitation = async (request) => {
      delegated.push(request);
      return { action: 'accept', content: { token: 'abc' } };
    };
    const handler = agentOnceElicitationHandler(async (question) => {
      questions.push(question);
      const answer = answers.shift();
      if (answer === undefined) throw new Error('asked too often');
      return answer;
    }, fallback);
    const question = doubtQuestion({ actionId: actionId('a'.repeat(64), 0, START_MS), tool: 'place_order', toolClass: 'money' });
    expect(await handler(agentOnceRequest(question), SIGNAL_OPTIONS)).toEqual({ action: 'accept', content: { agent_once_outcome: 'happened' } });
    expect(await handler(agentOnceRequest(question), SIGNAL_OPTIONS)).toEqual({ action: 'accept', content: { agent_once_outcome: 'not_happened' } });
    expect(await handler(agentOnceRequest(question), SIGNAL_OPTIONS)).toEqual({ action: 'decline' });
    expect(questions).toEqual(Array(3).fill({ message: question, serverName: 'shop' }));
    const login: ElicitationRequest = { serverName: 'shop', message: 'Sign in', mode: 'form', requestedSchema: { type: 'object', properties: { token: { type: 'string' } } } };
    const auth: ElicitationRequest = { serverName: 'shop', message: 'Open the page', mode: 'url', url: 'https://shop.example.test/auth', elicitationId: 'e-1' };
    expect(await handler(login, SIGNAL_OPTIONS)).toEqual({ action: 'accept', content: { token: 'abc' } });
    expect(await handler(auth, SIGNAL_OPTIONS)).toEqual({ action: 'accept', content: { token: 'abc' } });
    expect(delegated).toEqual([login, auth]);
    expect(questions).toHaveLength(3);
  });

  test('requests that are not from agent-once are declined when there is no fallback', async () => {
    let asked = 0;
    const handler = agentOnceElicitationHandler(async () => {
      asked += 1;
      return { outcome: 'happened', by: 'human' };
    });
    expect(await handler({ serverName: 'shop', message: 'Pick a size', requestedSchema: { type: 'object', properties: { size: { type: 'string' } } } }, SIGNAL_OPTIONS)).toEqual({
      action: 'decline',
    });
    expect(await handler({ serverName: 'shop', message: 'No schema' }, SIGNAL_OPTIONS)).toEqual({ action: 'decline' });
    expect(asked).toBe(0);
  });

  describe('through the proxy', () => {
    let workspace: Workspace;

    beforeEach(() => {
      workspace = new Workspace();
    });

    afterEach(async () => {
      await workspace.dispose();
    });

    test('the handler answer resolves a blocked money action so the retry replays', async () => {
      const { client } = await startProxy(workspace, {
        capabilities: { elicitation: {} },
        humanResolver: (ctx) => createHumanResolver(ctx, workspace.config(), {}),
      });
      const asked: { message: string; serverName: string }[] = [];
      const handler = agentOnceElicitationHandler(async (question) => {
        asked.push(question);
        return { outcome: 'happened', by: 'human' };
      });
      client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
        const params = request.params;
        const forwarded: ElicitationRequest =
          params.mode === 'url'
            ? { serverName: 'counter', message: params.message, mode: 'url', url: params.url, elicitationId: params.elicitationId }
            : { serverName: 'counter', message: params.message, mode: 'form', requestedSchema: params.requestedSchema };
        const answer = await handler(forwarded, { signal: extra.signal, requestId: String(extra.requestId) });
        return answer ?? { action: 'cancel' };
      });
      const first = await client.callTool({ name: 'charge', arguments: { amount: 10, fail: true } });
      const retry = await client.callTool({ name: 'charge', arguments: { amount: 10, fail: true } });
      expect(statusOf(retry)?.status).toBe('replayed');
      expect(asked).toEqual([{ message: doubtQuestion({ actionId: statusOf(first)?.action_id ?? '', tool: 'charge', toolClass: 'money' }), serverName: 'counter' }]);
      expect((await stats(client)).count).toBe(1);
    });
  });
});
