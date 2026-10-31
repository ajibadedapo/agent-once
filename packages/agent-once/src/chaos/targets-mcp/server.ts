import { request } from 'node:http';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { ACTION_META_KEY, metaString } from '../../mcp/meta.js';
import { systemClock, type Clock } from '../../time/clock.js';
import { TARGETS, type TargetName } from '../targets/catalog.js';

export interface TargetsMcpOptions {
  url: string;
  timeoutMs?: number;
  clock?: Clock;
}

export const DEFAULT_TARGETS_TIMEOUT_MS = 5000;

interface TargetTool {
  target: TargetName;
  mutating: boolean;
  description: string;
}

const TOOLS: Readonly<Record<string, TargetTool>> = {
  place_order: { target: 'checkout', mutating: true, description: 'Places an order on the checkout target.' },
  book_slot: { target: 'booking', mutating: true, description: 'Books a slot on the booking target.' },
  send_email: { target: 'email', mutating: true, description: 'Sends an email through the email target.' },
  create_ticket: { target: 'ticket', mutating: true, description: 'Creates a support ticket on the ticket target.' },
  list_orders: { target: 'checkout', mutating: false, description: 'Lists the orders the checkout target has committed.' },
  list_bookings: { target: 'booking', mutating: false, description: 'Lists the bookings the booking target has committed.' },
  list_sent_emails: { target: 'email', mutating: false, description: 'Lists the emails the email target has sent.' },
  list_tickets: { target: 'ticket', mutating: false, description: 'Lists the tickets the ticket target has created.' },
};

function inputSchema(tool: TargetTool): Tool['inputSchema'] {
  if (!tool.mutating) return { type: 'object', properties: {} };
  const fields = TARGETS[tool.target].fields;
  const properties = Object.fromEntries(
    fields.map((field) => [field.name, field.name === 'qty' ? { type: 'integer', minimum: 1, description: field.label } : { type: 'string', description: field.label }]),
  );
  return { type: 'object', properties, required: fields.map((field) => field.name) };
}

function describeTool(name: string, tool: TargetTool): Tool {
  return {
    name,
    description: tool.description,
    inputSchema: inputSchema(tool),
    annotations: tool.mutating ? { destructiveHint: true, idempotentHint: false } : { readOnlyHint: true },
  };
}

function text(value: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text: value }], ...(isError ? { isError: true } : {}) };
}

function errorText(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === 'object' && parsed !== null && typeof (parsed as { error?: unknown }).error === 'string') return (parsed as { error: string }).error;
  } catch {
    return body;
  }
  return body;
}

interface HttpCall {
  method: 'GET' | 'POST';
  url: string;
  body?: string;
  idempotencyKey?: string;
}

function exchange(call: HttpCall, clock: Clock, timeoutMs: number): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (call.body !== undefined) headers['content-type'] = 'application/json';
    if (call.idempotencyKey !== undefined) headers['idempotency-key'] = call.idempotencyKey;
    const outgoing = request(call.url, { method: call.method, headers, agent: false });
    const timer = clock.setTimer(timeoutMs, () => outgoing.destroy(new Error(`timed out after ${timeoutMs} ms`)));
    const settle = <T>(finish: (value: T) => void) => (value: T) => {
      timer.cancel();
      finish(value);
    };
    outgoing.on('error', settle(reject));
    outgoing.on('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('error', settle(reject));
      response.on('end', () => settle(resolve)({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    outgoing.end(call.body);
  });
}

function requestBody(tool: TargetTool, args: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(TARGETS[tool.target].fields.filter((field) => args[field.name] !== undefined).map((field) => [field.name, args[field.name]])));
}

export function createTargetsMcpServer(options: TargetsMcpOptions): Server {
  const clock = options.clock ?? systemClock;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TARGETS_TIMEOUT_MS;
  const base = options.url.replace(/\/+$/, '');
  const server = new Server({ name: 'agent-once-chaos-targets', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: Object.entries(TOOLS).map(([name, tool]) => describeTool(name, tool)) }));
  server.setRequestHandler(CallToolRequestSchema, async (call): Promise<CallToolResult> => {
    const name = call.params.name;
    const tool = Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
    if (tool === undefined) return text(`unknown tool ${name}`, true);
    const idempotencyKey = metaString(call.params._meta, ACTION_META_KEY);
    const http: HttpCall = tool.mutating
      ? { method: 'POST', url: `${base}/api/${tool.target}`, body: requestBody(tool, call.params.arguments ?? {}), ...(idempotencyKey === undefined ? {} : { idempotencyKey }) }
      : { method: 'GET', url: `${base}/api/${tool.target}` };
    let reply: { status: number; body: string };
    try {
      reply = await exchange(http, clock, timeoutMs);
    } catch (error) {
      return text(`request failed: ${error instanceof Error ? error.message : String(error)}`, true);
    }
    if (reply.status >= 200 && reply.status < 300) return text(reply.body);
    return text(errorText(reply.body), true);
  });
  return server;
}
