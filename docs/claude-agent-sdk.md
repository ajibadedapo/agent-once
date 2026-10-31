# Claude Agent SDK

`agent-once/claude-agent-sdk` guards the tools of an agent built with `@anthropic-ai/claude-agent-sdk` (0.3.316 or later, an optional peer dependency).

## MCP servers

`guardMcpServers` rewrites your stdio MCP server configs so each one runs behind the agent-once proxy. Remote servers (`http`, `sse`) and in-process SDK servers are returned unchanged and listed in `unguarded`.

```ts
import { query } from '@anthropic-ai/claude-agent-sdk';
import { agentOnceElicitationHandler, guardMcpServers } from 'agent-once/claude-agent-sdk';

const { servers, unguarded } = guardMcpServers(
  { playwright: { command: 'npx', args: ['@playwright/mcp@0.0.83', '--headless'] } },
  { session: 'checkout-run-42' },
);
if (unguarded.length > 0) console.error(`not guarded: ${unguarded.join(', ')}`);

const onElicitation = agentOnceElicitationHandler(async ({ message }) => {
  console.error(message);
  return { outcome: 'unresolved' };
});

for await (const message of query({ prompt: 'Place one order on http://127.0.0.1:4100/checkout', options: { mcpServers: servers, onElicitation } })) {
  if (message.type === 'result') console.log(message.subtype);
}
```

Options: `session` (sets `AGENT_ONCE_SESSION` for the server, so a rerun with the same session replays completed actions for 24 hours), `configPath` (passed as `--config`) and `cliPath` (defaults to the CLI inside the installed package, run with the current Node).

## Answering doubts

When a money or irreversible action is in doubt, the proxy asks through MCP elicitation. `agentOnceElicitationHandler(ask, fallback?)` turns that into a plain question for your code: `ask` receives `{ message, serverName }` and returns `{ outcome: 'happened' | 'not_happened', by: 'human' }` or `{ outcome: 'unresolved' }`. Elicitations that are not from agent-once go to `fallback`, or are declined when there is none. [examples/claude-agent-sdk/checkout.ts](../examples/claude-agent-sdk/checkout.ts) asks on the terminal.

## In-process SDK tools

Tools you define with the SDK's `tool()` run in your process, so there is no proxy in between. Wrap them with `guardSdkTool`:

```ts
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { Guard, JsonlEvidenceSink, SqliteLedgerStore, defaultLedgerPath, systemClock } from 'agent-once';
import { guardSdkTool } from 'agent-once/claude-agent-sdk';
import * as z from 'zod';

const guard = new Guard({
  store: SqliteLedgerStore.open(defaultLedgerPath(process.env, homedir()), systemClock),
  clock: systemClock,
  runInstance: randomUUID(),
  evidence: new JsonlEvidenceSink('agent-once-events.jsonl'),
});

const placeOrder = tool('place_order', 'Place an order in the shop', { item: z.string(), qty: z.number() }, async ({ item, qty }) => ({
  content: [{ type: 'text', text: `Ordered ${qty} x ${item}` }],
}));

export const shop = createSdkMcpServer({
  name: 'shop',
  version: '1.0.0',
  tools: [guardSdkTool(guard, placeOrder, { sessionKey: 'checkout-run-42' })],
});
```

`guardSdkTool(guard, tool, { sessionKey, policy?, toolClass?, identityRule?, reconciler? })` keeps the tool's name, description and schema. Without `toolClass`, the class comes from the tool's name and description ("place_order" is `money`), and the policy from the class. The session is always explicit. The handler returns:

- the tool's own result when it runs;
- the recorded result with an "already happened" notice on a replay;
- an error result explaining the doubt or the block otherwise, with the action id.

A handler that throws is recorded as a transport error, so the action is in doubt, and the error is rethrown.

## Playwright MCP preset

```ts
import { playwrightMcpServer } from 'agent-once/playwright-mcp';

export const playwright = playwrightMcpServer({ headless: true, session: 'checkout-run-42' });
```

returns `{ command: 'npx', args: ['agent-once', 'mcp', '--session', 'checkout-run-42', '--', 'npx', '@playwright/mcp@0.0.83', '--headless'] }`, usable as an MCP server config in any client. Options: `version` (default `0.0.83`, the version agent-once is measured with), `headless`, `config` and `session`.
