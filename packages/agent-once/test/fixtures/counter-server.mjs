import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import * as z from 'zod';

const ACTION_META_KEY = 'io.github.ajibadedapo/agent-once-action';
const statePath = process.env.COUNTER_STATE;
const pageSize = Number(process.env.COUNTER_PAGE_SIZE ?? '0');
const crashCode = Number(process.env.COUNTER_CRASH_CODE ?? '7');

function emptyState() {
  return { count: 0, rejections: 0, cancelledSeen: 0, cancelNotices: 0, rootsChanged: 0, actionKeys: [] };
}

let memoryState = emptyState();

function load() {
  if (statePath === undefined) return memoryState;
  if (!existsSync(statePath)) return emptyState();
  return { ...emptyState(), ...JSON.parse(readFileSync(statePath, 'utf8')) };
}

function save(state) {
  if (statePath === undefined) memoryState = state;
  else writeFileSync(statePath, JSON.stringify(state));
}

function update(change) {
  const state = load();
  change(state);
  save(state);
  return state;
}

function text(value, isError = false) {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

function recordAction(state, extra) {
  state.actionKeys.push(extra._meta?.[ACTION_META_KEY] ?? null);
}

let released = false;
const releaseWaiters = [];
const startWaiters = [];
let slowInProgress = 0;

const server = new McpServer(
  { name: 'counter-fixture', version: '1.2.3' },
  { capabilities: { logging: {} }, instructions: 'A counter used to test agent-once.' },
);

server.registerTool(
  'increment',
  {
    description: 'Adds one to the counter.',
    inputSchema: { fail: z.boolean().optional(), reject: z.boolean().optional(), note: z.string().optional(), amount: z.number().optional() },
  },
  async ({ fail, reject }, extra) => {
    if (reject === true) {
      update((state) => {
        state.rejections += 1;
      });
      return text('rejected before anything happened', true);
    }
    const state = update((current) => {
      current.count += 1;
      recordAction(current, extra);
    });
    return fail === true ? text(`counted to ${state.count} but reported a failure`, true) : text(`count=${state.count}`);
  },
);

server.registerTool('read_count', { description: 'Reads the counter.', annotations: { readOnlyHint: true } }, async () =>
  text(`count=${load().count}`),
);

server.registerTool(
  'charge',
  {
    description: 'Charges a card.',
    inputSchema: { amount: z.number(), fail: z.boolean().optional() },
    annotations: { destructiveHint: true },
  },
  async ({ amount, fail }, extra) => {
    const state = update((current) => {
      current.count += 1;
      recordAction(current, extra);
    });
    return fail === true ? text(`charged ${amount} but reported a failure`, true) : text(`charged ${amount}; count=${state.count}`);
  },
);

server.registerTool('crash_during', { description: 'Counts and then exits before answering.' }, async (extra) => {
  update((state) => {
    state.count += 1;
    recordAction(state, extra);
  });
  process.exit(crashCode);
});

server.registerTool('slow', { description: 'Counts and answers once released.' }, async (extra) => {
  update((state) => {
    state.count += 1;
    recordAction(state, extra);
  });
  slowInProgress += 1;
  for (const wake of startWaiters.splice(0)) wake();
  if (!released) await new Promise((resolve) => releaseWaiters.push(resolve));
  slowInProgress -= 1;
  if (extra.signal.aborted) {
    update((state) => {
      state.cancelledSeen += 1;
    });
  }
  return text('slow done');
});

server.registerTool('slow_started', { description: 'Answers once a slow call is running.', annotations: { readOnlyHint: true } }, async () => {
  if (slowInProgress === 0) await new Promise((resolve) => startWaiters.push(resolve));
  return text('started');
});

server.registerTool('release', { description: 'Lets slow calls finish.', annotations: { readOnlyHint: true } }, async () => {
  released = true;
  for (const wake of releaseWaiters.splice(0)) wake();
  return text('released');
});

server.registerTool('stats', { description: 'Reports fixture state.', annotations: { readOnlyHint: true } }, async () =>
  text(JSON.stringify(load())),
);

server.registerTool('emit_log', { description: 'Sends a log notification.', annotations: { readOnlyHint: true } }, async () => {
  await server.sendLoggingMessage({ level: 'info', data: 'hello from the counter' });
  return text('logged');
});

server.registerResource('about', 'counter://about', { mimeType: 'text/plain' }, async (uri) => ({
  contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'counter fixture' }],
}));

server.server.setNotificationHandler(RootsListChangedNotificationSchema, async () => {
  update((state) => {
    state.rootsChanged += 1;
  });
});

const onCancelled = server.server['_notificationHandlers'].get('notifications/cancelled');
server.server['_notificationHandlers'].set('notifications/cancelled', async (notification) => {
  update((state) => {
    state.cancelNotices += 1;
  });
  return onCancelled?.(notification);
});

if (pageSize > 0) {
  const listTools = server.server['_requestHandlers'].get('tools/list');
  server.server['_requestHandlers'].set('tools/list', async (request, extra) => {
    const all = await listTools(request, extra);
    const start = Number(request.params?.cursor ?? '0');
    const end = start + pageSize;
    return { tools: all.tools.slice(start, end), ...(end < all.tools.length ? { nextCursor: String(end) } : {}) };
  });
}

await server.connect(new StdioServerTransport());
