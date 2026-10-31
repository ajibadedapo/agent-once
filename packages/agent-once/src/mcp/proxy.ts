import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type {
  CallToolResult,
  ClientCapabilities,
  Implementation,
  JSONRPCMessage,
  JSONRPCRequest,
  RequestId,
  ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { CanonicalizationError, type JsonValue } from '../canonical/jcs.js';
import type { AgentOnceConfig } from '../config/schema.js';
import type { Guard } from '../guard/guard.js';
import type { ExecuteContext, GuardResult, GuardedCall, Reconciler, ToolOutcome } from '../guard/types.js';
import type { ToolClass } from '../ledger/types.js';
import type { Clock } from '../time/clock.js';
import { ACTION_META_KEY, INTENT_META_KEY, metaString } from './meta.js';
import { Correlator, idKey, isNotification, isRequest, isReservedId, isResponse, UpstreamClosedError, type RpcResponse } from './relay.js';
import { handleResolveCall, RESOLVE_TOOL, RESOLVE_TOOL_NAME } from './resolve-tool.js';
import { blockedToolResult, inDoubtToolResult } from './doubt/messages.js';
import {
  callFailedResult,
  ledgerUnavailableResult,
  replayedResult,
  unidentifiableCallResult,
  upstreamExitedResult,
  withStatus,
} from './result-format.js';
import { resolveSession } from './session.js';
import { findToolRule, resolveToolPolicy } from './tool-policy.js';
import type { ExitAwareTransport } from './upstream.js';

export interface ProxyContext {
  readonly clientCapabilities: ClientCapabilities;
  readonly clientInfo?: Implementation;
  readonly clock: Clock;
  requestClient(method: string, params: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  callUpstreamTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

export interface ProxyExtension {
  onClientRequest?(msg: JSONRPCRequest, ctx: ProxyContext): void;
  onUpstreamResult?(tool: string, args: Record<string, unknown>, result: CallToolResult, ctx: ProxyContext): void;
  adjustCall?(call: GuardedCall, ctx: ProxyContext): GuardedCall;
  classifyOutcome?(tool: string, result: CallToolResult): ToolOutcome | undefined;
  reconcilerFor?(tool: string, args: Record<string, unknown>, ctx: ProxyContext): Reconciler | undefined;
}

export type GuardFactory = (ctx: ProxyContext) => Guard;

export interface ProxyDeps {
  client: Transport;
  upstream: Transport;
  guard: GuardFactory;
  config: AgentOnceConfig;
  clock: Clock;
  cwd: string;
  env: NodeJS.ProcessEnv;
  extensions?: ProxyExtension[];
  log?: (message: string) => void;
}

export interface RunningProxy {
  closed: Promise<{ upstreamExitCode: number | null }>;
  close(): Promise<void>;
}

type Params = Record<string, unknown>;
type RpcError = { code: number; message: string; data?: unknown };
type Reply = { kind: 'result'; result: CallToolResult } | { kind: 'error'; error: RpcError };
type ToolsState = 'unknown' | 'listed' | 'backoff';

interface ForwardedRequest {
  id: RequestId;
  method: string;
  tool?: string;
  args?: Params;
}

interface GuardedRequest {
  id: RequestId;
  tool: string;
  toolClass: ToolClass;
  actionId?: string;
  raw?: RpcResponse;
  controller: AbortController;
  answered: boolean;
}

export const PREFETCH_TIMEOUT_MS = 30_000;
export const MAX_TOOL_PAGES = 1000;
const REMEMBERED_GUARDED_IDS = 10_000;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;
const UPSTREAM_GONE = -32000;
const CANCELLED = 'notifications/cancelled';
const TOOLS_CHANGED = 'notifications/tools/list_changed';

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Params {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resultText(result: CallToolResult): string {
  return (Array.isArray(result.content) ? result.content : [])
    .map((item) => (item.type === 'text' ? item.text : ''))
    .filter((text) => text !== '')
    .join('\n');
}

function recordedReply(result: JsonValue): Reply | undefined {
  if (!isRecord(result)) return undefined;
  if (Array.isArray(result.content)) return { kind: 'result', result: result as unknown as CallToolResult };
  if (isRecord(result.error)) return { kind: 'error', error: result.error as unknown as RpcError };
  return undefined;
}

function writeToStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function reservedIdError(id: RequestId): JSONRPCMessage {
  return { jsonrpc: '2.0', id, error: { code: INVALID_REQUEST, message: 'agent-once: request ids starting with "agent-once:" are reserved for the proxy' } };
}

class McpProxy implements RunningProxy {
  readonly closed: Promise<{ upstreamExitCode: number | null }>;
  readonly context: ProxyContext;
  private resolveClosed: (value: { upstreamExitCode: number | null }) => void = () => {};
  private readonly client: Transport;
  private readonly upstream: Transport;
  private readonly guard: Guard;
  private readonly config: AgentOnceConfig;
  private readonly clock: Clock;
  private readonly cwd: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly extensions: ProxyExtension[];
  private readonly log: (message: string) => void;
  private readonly upstreamRequests = new Correlator('upstream');
  private readonly clientRequests = new Correlator('client');
  private readonly forwarded = new Map<string, ForwardedRequest>();
  private readonly guarded = new Map<string, GuardedRequest>();
  private readonly answeredGuarded = new Set<string>();
  private readonly annotations = new Map<string, ToolAnnotations | undefined>();
  private readonly patterns = new Map<string, RegExp>();
  private routing: Promise<void> = Promise.resolve();
  private listing: Promise<void> | undefined;
  private toolsState: ToolsState = 'unknown';
  private toolsGeneration = 0;
  private clientCapabilities: ClientCapabilities = {};
  private clientInfo: Implementation | undefined;
  private upstreamClosed = false;
  private closing = false;

  constructor(deps: ProxyDeps) {
    this.client = deps.client;
    this.upstream = deps.upstream;
    this.config = deps.config;
    this.clock = deps.clock;
    this.cwd = deps.cwd;
    this.env = deps.env;
    this.extensions = deps.extensions ?? [];
    this.log = deps.log ?? writeToStderr;
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.context = this.createContext();
    this.guard = deps.guard(this.context);
  }

  async start(): Promise<void> {
    this.upstream.onmessage = (message) => this.fromUpstream(message);
    this.upstream.onclose = () => void this.onUpstreamClosed();
    this.upstream.onerror = (error) => this.log(`agent-once: MCP server transport error: ${error.message}`);
    this.client.onmessage = (message) => this.fromClient(message);
    this.client.onclose = () => void this.onClientClosed();
    this.client.onerror = (error) => this.log(`agent-once: client transport error: ${error.message}`);
    await this.upstream.start();
    await this.client.start();
  }

  async close(): Promise<void> {
    this.closing = true;
    if (!this.upstreamClosed) await this.upstream.close();
    await this.closed;
  }

  private createContext(): ProxyContext {
    const proxy = this;
    return {
      get clientCapabilities() {
        return proxy.clientCapabilities;
      },
      get clientInfo() {
        return proxy.clientInfo;
      },
      get clock() {
        return proxy.clock;
      },
      requestClient: (method, params, options) => this.requestClient(method, params, options?.signal),
      callUpstreamTool: (name, args) => this.callUpstreamTool(name, args),
    };
  }

  private fromClient(message: JSONRPCMessage): void {
    if (isResponse(message)) {
      if (this.clientRequests.settle(message)) return;
      if (isReservedId(message.id)) this.log(`agent-once: dropped a client response for unknown proxy id ${String(message.id)}`);
      else this.sendUpstream(message);
      return;
    }
    if (isRequest(message) && isReservedId(message.id)) {
      this.sendClient(reservedIdError(message.id));
      return;
    }
    this.routing = this.routing.then(() => this.routeClient(message));
  }

  private async routeClient(message: JSONRPCMessage): Promise<void> {
    if (isNotification(message)) {
      if (message.method === CANCELLED && this.absorbCancel(message.params)) return;
      this.sendUpstream(message);
      return;
    }
    if (!isRequest(message)) {
      this.sendUpstream(message);
      return;
    }
    try {
      await this.routeRequest(message);
    } catch (error) {
      this.log(`agent-once: could not handle ${message.method}: ${errorMessage(error)}`);
      this.sendClient({ jsonrpc: '2.0', id: message.id, error: { code: INTERNAL_ERROR, message: `agent-once: ${errorMessage(error)}` } });
    }
  }

  private async routeRequest(request: JSONRPCRequest): Promise<void> {
    for (const extension of this.extensions) extension.onClientRequest?.(request, this.context);
    if (request.method === 'initialize') this.captureInitialize(request.params);
    if (request.method === 'tools/call') {
      await this.routeToolCall(request);
      return;
    }
    this.forward(request);
  }

  private captureInitialize(params: Params | undefined): void {
    this.clientCapabilities = isRecord(params?.capabilities) ? (params.capabilities as ClientCapabilities) : {};
    this.clientInfo = isRecord(params?.clientInfo) ? (params.clientInfo as Implementation) : undefined;
  }

  private async routeToolCall(request: JSONRPCRequest): Promise<void> {
    const params: Params = request.params ?? {};
    const tool = params.name;
    if (typeof tool !== 'string') {
      this.forward(request);
      return;
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    const annotations = await this.annotationsFor(tool);
    if (tool === RESOLVE_TOOL_NAME && this.config.exposeResolveTool && !this.annotations.has(RESOLVE_TOOL_NAME)) {
      this.sendClient({ jsonrpc: '2.0', id: request.id, result: handleResolveCall(args, this.guard) });
      return;
    }
    const call = this.buildCall(tool, args, params, annotations);
    if (call.policy === 'pass') {
      this.forward(request, tool, args);
      return;
    }
    const entry: GuardedRequest = { id: request.id, tool, toolClass: call.toolClass, controller: new AbortController(), answered: false };
    this.guarded.set(idKey(request.id), entry);
    void this.runGuarded(entry, { ...call, signal: entry.controller.signal }, params);
  }

  private buildCall(tool: string, args: Params, params: Params, annotations: ToolAnnotations | undefined): GuardedCall {
    const decision = resolveToolPolicy(tool, annotations, this.config);
    const rule = findToolRule(tool, this.config);
    const meta = isRecord(params._meta) ? params._meta : undefined;
    const session = resolveSession(meta, this.env, this.clientInfo?.name, this.cwd);
    const intentKey = metaString(meta, INTENT_META_KEY);
    let call: GuardedCall = {
      tool,
      args,
      sessionKey: session.key,
      sessionExplicit: session.explicit,
      policy: decision.policy,
      toolClass: decision.toolClass,
      ...(intentKey === undefined ? {} : { intentKey }),
      ...(rule?.identity === undefined ? {} : { identityRule: rule.identity }),
    };
    for (const extension of this.extensions) {
      const reconciler = extension.reconcilerFor?.(tool, args, this.context);
      if (reconciler !== undefined) {
        call.reconciler = reconciler;
        break;
      }
    }
    for (const extension of this.extensions) call = extension.adjustCall?.(call, this.context) ?? call;
    return call;
  }

  private async annotationsFor(tool: string): Promise<ToolAnnotations | undefined> {
    if (this.annotations.has(tool)) return this.annotations.get(tool);
    if (this.toolsState === 'unknown') await this.prefetchTools();
    return this.annotations.get(tool);
  }

  private prefetchTools(): Promise<void> {
    if (this.listing !== undefined) return this.listing;
    const generation = this.toolsGeneration;
    const listing = new Promise<void>((resolve) => {
      const timer = this.clock.setTimer(PREFETCH_TIMEOUT_MS, () => {
        if (generation === this.toolsGeneration && this.toolsState === 'unknown') {
          this.toolsState = 'backoff';
          this.log(`agent-once: tools/list did not finish within ${PREFETCH_TIMEOUT_MS / 1000} s, so tools without known annotations are guarded`);
        }
        resolve();
      });
      void this.fetchToolPages(generation).then(() => {
        timer.cancel();
        resolve();
      });
    }).finally(() => {
      if (this.listing === listing) this.listing = undefined;
    });
    this.listing = listing;
    return listing;
  }

  private async fetchToolPages(generation: number): Promise<void> {
    const seen = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    try {
      do {
        const page = await this.requestUpstream('tools/list', cursor === undefined ? {} : { cursor });
        if (generation !== this.toolsGeneration) return;
        this.captureTools(page.tools);
        pages += 1;
        cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
        if (cursor !== undefined && (seen.has(cursor) || pages >= MAX_TOOL_PAGES)) {
          this.toolsState = 'backoff';
          this.log(`agent-once: stopped reading tools/list after ${pages} pages (repeated cursor or page limit), so unlisted tools are guarded`);
          return;
        }
        if (cursor !== undefined) seen.add(cursor);
      } while (cursor !== undefined);
      this.toolsState = 'listed';
    } catch (error) {
      if (generation !== this.toolsGeneration) return;
      this.toolsState = 'backoff';
      this.log(`agent-once: could not list the MCP server's tools, so tools without known annotations are guarded: ${errorMessage(error)}`);
    }
  }

  private captureTools(tools: unknown): void {
    if (!Array.isArray(tools)) return;
    for (const tool of tools) {
      if (!isRecord(tool) || typeof tool.name !== 'string') continue;
      this.annotations.set(tool.name, isRecord(tool.annotations) ? (tool.annotations as ToolAnnotations) : undefined);
    }
  }

  private toolsChanged(): void {
    this.toolsGeneration += 1;
    this.annotations.clear();
    this.toolsState = 'unknown';
    this.listing = undefined;
  }

  private async runGuarded(entry: GuardedRequest, call: GuardedCall, params: Params): Promise<void> {
    let reply: Reply;
    try {
      const result = await this.guard.run(call, (context) => this.dispatch(entry, call, params, context));
      reply = this.present(entry, call, result);
    } catch (error) {
      const result =
        error instanceof CanonicalizationError ? unidentifiableCallResult(call.tool, error.message) : callFailedResult(call.tool, entry.actionId, errorMessage(error));
      reply = { kind: 'result', result };
    }
    this.answerGuarded(entry, reply);
  }

  private async dispatch(entry: GuardedRequest, call: GuardedCall, params: Params, context: ExecuteContext): Promise<ToolOutcome> {
    entry.actionId = context.actionId;
    if (this.upstreamClosed) return { kind: 'not_dispatched', error: 'the MCP server is not running' };
    const id = this.upstreamRequests.nextId();
    const response = this.upstreamRequests.expectOrAbandon(id);
    const meta = { ...(isRecord(params._meta) ? params._meta : {}), [ACTION_META_KEY]: context.idempotencyKey ?? context.actionId };
    try {
      await this.upstream.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { ...params, _meta: meta } });
    } catch (error) {
      this.upstreamRequests.forget(id);
      return { kind: 'not_dispatched', error: `cannot send the call to the MCP server: ${errorMessage(error)}` };
    }
    const reply = await response;
    if (reply.kind === 'abandoned') return reply;
    entry.raw = reply;
    if (reply.kind === 'error') return { kind: 'error_result', result: { error: reply.error } as unknown as JsonValue };
    const result = reply.result as CallToolResult;
    this.notifyResult(call.tool, call.args, result);
    return this.classify(call.tool, result);
  }

  private classify(tool: string, result: CallToolResult): ToolOutcome {
    const isError = result.isError === true;
    if (isError) {
      const text = resultText(result);
      const patterns = findToolRule(tool, this.config)?.notDispatchedErrors ?? [];
      if (patterns.some((pattern) => this.regex(pattern).test(text))) return { kind: 'not_dispatched', error: text };
    }
    for (const extension of this.extensions) {
      const outcome = extension.classifyOutcome?.(tool, result);
      if (outcome !== undefined) return outcome;
    }
    return isError ? { kind: 'error_result', result: result as JsonValue } : { kind: 'ok', result: result as JsonValue };
  }

  private regex(pattern: string): RegExp {
    let compiled = this.patterns.get(pattern);
    if (compiled === undefined) {
      compiled = new RegExp(pattern, 'i');
      this.patterns.set(pattern, compiled);
    }
    return compiled;
  }

  private present(entry: GuardedRequest, call: GuardedCall, result: GuardResult): Reply {
    switch (result.status) {
      case 'executed':
      case 'passed':
        return this.presentExecuted(entry, call, result);
      case 'replayed':
        return { kind: 'result', result: replayedResult(result) };
      case 'in_doubt':
        return { kind: 'result', result: inDoubtToolResult(result.doubt, this.config.exposeResolveTool && result.doubt.toolClass === 'standard') };
      case 'blocked':
        return { kind: 'result', result: blockedToolResult(result.doubt) };
      case 'ledger_unavailable':
        return { kind: 'result', result: ledgerUnavailableResult(result.error) };
    }
  }

  private presentExecuted(entry: GuardedRequest, call: GuardedCall, result: GuardResult & { status: 'executed' | 'passed' }): Reply {
    if (result.recorded === false) {
      this.log(`agent-once: the outcome of ${call.tool} action ${result.actionId} could not be written to the ledger; a retry will be treated as in doubt.`);
    }
    const outcome = result.outcome;
    const reply = entry.raw ?? (outcome.kind === 'ok' || outcome.kind === 'error_result' ? recordedReply(outcome.result) : undefined);
    if (reply === undefined) {
      const error = outcome.kind === 'transport_error' || outcome.kind === 'not_dispatched' ? outcome.error : 'the MCP server did not answer';
      return { kind: 'result', result: callFailedResult(call.tool, result.actionId, error) };
    }
    if (reply.kind === 'error') return reply;
    const forwarded = reply.result as CallToolResult;
    return { kind: 'result', result: result.actionId === undefined ? forwarded : withStatus(forwarded, 'executed', result.actionId) };
  }

  private answerGuarded(entry: GuardedRequest, reply: Reply): void {
    const key = idKey(entry.id);
    if (this.guarded.get(key) === entry) this.guarded.delete(key);
    this.rememberAnswered(key);
    if (entry.answered || entry.controller.signal.aborted) return;
    entry.answered = true;
    if (reply.kind === 'error') this.sendClient({ jsonrpc: '2.0', id: entry.id, error: reply.error });
    else this.sendClient({ jsonrpc: '2.0', id: entry.id, result: reply.result });
  }

  private rememberAnswered(key: string): void {
    this.answeredGuarded.add(key);
    if (this.answeredGuarded.size <= REMEMBERED_GUARDED_IDS) return;
    const oldest = this.answeredGuarded.values().next();
    if (oldest.done !== true) this.answeredGuarded.delete(oldest.value);
  }

  private absorbCancel(params: Params | undefined): boolean {
    const requestId = params?.requestId;
    if (typeof requestId !== 'string' && typeof requestId !== 'number') return false;
    const key = idKey(requestId);
    const entry = this.guarded.get(key);
    if (entry === undefined) {
      if (this.answeredGuarded.has(key)) return true;
      this.forwarded.delete(key);
      return false;
    }
    entry.controller.abort();
    const subject = entry.actionId === undefined ? entry.tool : `${entry.tool} action ${entry.actionId}`;
    this.log(`agent-once: the client cancelled ${subject}; the cancel was not forwarded, the call runs to completion and its outcome is recorded as undelivered.`);
    return true;
  }

  private forward(request: JSONRPCRequest, tool?: string, args?: Params): void {
    if (this.upstreamClosed) {
      this.sendClient({ jsonrpc: '2.0', id: request.id, error: { code: UPSTREAM_GONE, message: 'agent-once: the MCP server is not running' } });
      return;
    }
    this.forwarded.set(idKey(request.id), { id: request.id, method: request.method, ...(tool === undefined ? {} : { tool, args }) });
    this.sendUpstream(request);
  }

  private fromUpstream(message: JSONRPCMessage): void {
    if (isResponse(message)) {
      if (this.upstreamRequests.settle(message)) return;
      if (isReservedId(message.id)) {
        this.log(`agent-once: dropped an MCP server response for unknown proxy id ${String(message.id)}`);
        return;
      }
      const key = idKey(message.id);
      const request = this.forwarded.get(key);
      this.forwarded.delete(key);
      this.sendClient(request !== undefined && 'result' in message ? { ...message, result: this.adjustResult(request, message.result) } : message);
      return;
    }
    if (isRequest(message) && isReservedId(message.id)) {
      this.sendUpstream(reservedIdError(message.id));
      return;
    }
    if (isNotification(message) && message.method === TOOLS_CHANGED) this.toolsChanged();
    this.sendClient(message);
  }

  private adjustResult(request: ForwardedRequest, result: Params): Params {
    if (request.method === 'tools/call' && request.tool !== undefined) {
      this.notifyResult(request.tool, request.args ?? {}, result as CallToolResult);
      return result;
    }
    if (request.method !== 'tools/list') return result;
    this.captureTools(result.tools);
    if (this.toolsState === 'backoff') this.toolsState = 'unknown';
    if (!this.config.exposeResolveTool || typeof result.nextCursor === 'string' || !Array.isArray(result.tools)) return result;
    if (this.annotations.has(RESOLVE_TOOL_NAME)) {
      this.log(`agent-once: the MCP server already has a tool named ${RESOLVE_TOOL_NAME}, so the agent-once resolve tool is not added and calls to that name go to the server`);
      return result;
    }
    return { ...result, tools: [...(result.tools as unknown[]), RESOLVE_TOOL] };
  }

  private notifyResult(tool: string, args: Params, result: CallToolResult): void {
    for (const extension of this.extensions) {
      try {
        extension.onUpstreamResult?.(tool, args, result, this.context);
      } catch (error) {
        this.log(`agent-once: an extension failed on the ${tool} result: ${errorMessage(error)}`);
      }
    }
  }

  private async requestUpstream(method: string, params: Params): Promise<Params> {
    if (this.upstreamClosed) throw new UpstreamClosedError('the MCP server is not running');
    const id = this.upstreamRequests.nextId();
    const response = this.upstreamRequests.expect(id);
    try {
      await this.upstream.send({ jsonrpc: '2.0', id, method, params });
    } catch (error) {
      this.upstreamRequests.forget(id);
      throw error;
    }
    const reply = await response;
    if (reply.kind === 'error') throw new Error(`${method} failed: ${reply.error.message}`);
    return reply.result;
  }

  private async callUpstreamTool(name: string, args: Params): Promise<CallToolResult> {
    const result = (await this.requestUpstream('tools/call', { name, arguments: args })) as CallToolResult;
    this.notifyResult(name, args, result);
    return result;
  }

  private async requestClient(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    const id = this.clientRequests.nextId();
    const response = this.clientRequests.expect(id);
    try {
      await this.client.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params: params as Params }) });
    } catch (error) {
      this.clientRequests.forget(id);
      throw error;
    }
    const reply = await (signal === undefined ? response : this.untilAborted(id, response, signal));
    if (reply.kind === 'error') throw new Error(`${method} failed: ${reply.error.message}`);
    return reply.result;
  }

  private untilAborted(id: string, response: Promise<RpcResponse>, signal: AbortSignal): Promise<RpcResponse> {
    return new Promise((settle, fail) => {
      const onAbort = (): void => {
        if (!this.clientRequests.forget(id)) return;
        this.sendClient({ jsonrpc: '2.0', method: CANCELLED, params: { requestId: id, reason: 'agent-once stopped waiting for an answer' } });
        fail(signal.reason);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
      response.then(settle, fail).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  private sendUpstream(message: JSONRPCMessage): void {
    this.upstream.send(message).catch((error: unknown) => this.log(`agent-once: could not send to the MCP server: ${errorMessage(error)}`));
  }

  private sendClient(message: JSONRPCMessage): void {
    void this.sendClientAsync(message);
  }

  private async sendClientAsync(message: JSONRPCMessage): Promise<void> {
    try {
      await this.client.send(message);
    } catch (error) {
      this.log(`agent-once: could not send to the client: ${errorMessage(error)}`);
    }
  }

  private async onClientClosed(): Promise<void> {
    this.clientRequests.close(new Error('the client disconnected'));
    if (this.closing || this.upstreamClosed) return;
    this.closing = true;
    await this.upstream.close();
  }

  private async onUpstreamClosed(): Promise<void> {
    if (this.upstreamClosed) return;
    this.upstreamClosed = true;
    const exitCode = (this.upstream as ExitAwareTransport).exitCode ?? null;
    const sends: Promise<void>[] = [];
    for (const entry of this.guarded.values()) {
      if (entry.answered || entry.controller.signal.aborted) continue;
      entry.answered = true;
      sends.push(this.sendClientAsync({ jsonrpc: '2.0', id: entry.id, result: upstreamExitedResult(entry.tool, entry.actionId, exitCode, entry.toolClass) }));
    }
    for (const request of this.forwarded.values()) {
      const message: JSONRPCMessage =
        request.method === 'tools/call'
          ? { jsonrpc: '2.0', id: request.id, result: upstreamExitedResult(request.tool ?? 'tool', undefined, exitCode) }
          : { jsonrpc: '2.0', id: request.id, error: { code: UPSTREAM_GONE, message: 'agent-once: the MCP server exited before answering' } };
      sends.push(this.sendClientAsync(message));
    }
    this.forwarded.clear();
    this.upstreamRequests.close(new UpstreamClosedError('the MCP server exited'));
    await Promise.all(sends);
    this.closing = true;
    try {
      await this.client.close();
    } catch (error) {
      this.log(`agent-once: could not close the client transport: ${errorMessage(error)}`);
    }
    this.resolveClosed({ upstreamExitCode: exitCode });
  }
}

export async function createProxy(deps: ProxyDeps): Promise<RunningProxy> {
  const proxy = new McpProxy(deps);
  await proxy.start();
  return proxy;
}
