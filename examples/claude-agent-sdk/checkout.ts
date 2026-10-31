import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { agentOnceElicitationHandler, guardMcpServers } from 'agent-once/claude-agent-sdk';
import { PLAYWRIGHT_MCP_VERSION } from 'agent-once/playwright-mcp';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (apiKey === undefined || apiKey === '') {
  process.stderr.write(
    'This example calls Claude, so it needs ANTHROPIC_API_KEY. Set it and run again, for example:\n' +
      '  npx agent-once chaos serve --port 4100\n' +
      '  ANTHROPIC_API_KEY=... node examples/claude-agent-sdk/checkout.ts http://127.0.0.1:4100/checkout [session]\n',
  );
  process.exit(1);
}

const checkoutUrl = process.argv[2] ?? 'http://127.0.0.1:4100/checkout';
const session = process.argv[3] ?? `checkout-example-${Date.now()}`;
const configPath = fileURLToPath(new URL('../playwright-mcp/agent-once.config.json', import.meta.url));

const { servers, unguarded } = guardMcpServers(
  { playwright: { command: 'npx', args: [`@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}`, '--headless', '--isolated'] } },
  { session, configPath },
);
if (unguarded.length > 0) {
  process.stderr.write(
    `agent-once guards stdio MCP servers only, so these run unguarded: ${unguarded.join(', ')}. Wrap in-process SDK tools with guardSdkTool instead.\n`,
  );
}
process.stderr.write(`agent-once session: ${session}. Rerunning with the same session within 24 h replays completed orders instead of placing them again.\n`);

const terminal = createInterface({ input: process.stdin, output: process.stderr });

const onElicitation = agentOnceElicitationHandler(async ({ message }) => {
  const answer = (await terminal.question(`${message} [yes/no/skip] `)).trim().toLowerCase();
  if (answer === 'yes' || answer === 'y') return { outcome: 'happened', by: 'human' };
  if (answer === 'no' || answer === 'n') return { outcome: 'not_happened', by: 'human' };
  return { outcome: 'unresolved' };
});

const prompt = [
  `Open ${checkoutUrl} in the browser and place one order for the item on the page.`,
  'Report the order number from the confirmation page.',
  'If a step fails or the page is unclear, follow any agent-once instructions in the tool result before trying again.',
].join(' ');

try {
  for await (const message of query({ prompt, options: { mcpServers: servers, onElicitation, allowedTools: ['mcp__playwright__*'] } })) {
    if (message.type === 'result') process.stdout.write(`${message.subtype === 'success' ? message.result : `The run ended without a result (${message.subtype}).`}\n`);
  }
} finally {
  terminal.close();
}
