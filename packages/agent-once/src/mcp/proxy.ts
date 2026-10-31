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
import type { ExecuteContext, GuardResult, GuardedCall, HumanResolver, Reconciler, ToolOutcome } from '../guard/types.js';
import type { Clock } from '../time/clock.js';
import { ACTION_META_KEY, INTENT_META_KEY, metaString } from './meta.js';
import { Correlator, idKey, isNotification, isRequest, isResponse, UpstreamClosedError, type RpcResponse } from './relay.js';
import { handleResolveCall, RESOLVE_TOOL, RESOLVE_TOOL_NAME } from './resolve-tool.js';
import {
  blockedResult,
  callFailedResult,
  inDoubtResult,
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
  requestClient(method: string, params: unknown): Promise<unknown>;
  callUpstreamTool(name: string, args: Record<string, unknown>): Promise<CallToolResult>;
}

export interface ProxyExtension {
  onClientRequest?(msg: JSONRPCRequest, ctx: ProxyContext): void;
  onUpstreamResult?(tool: string, args: Record<string, unknown>, result: CallToolResult, ctx: ProxyContext): void;
  adjustCall?(call: GuardedCall, ctx: ProxyContext): GuardedCall;
  classifyOutcome?(tool: string, result: CallToolResult): ToolOutcome | undefined;
  reconcilerFor?(tool: string, args: Record<string, unknown>, ctx: ProxyContext): Reconciler | undefined;
}

export type GuardFactory = (humanResolver: HumanResolver) => Guard;

export interface ProxyDeps {
  client: Transport;
  upstream: Transport;
  guard: Guard | GuardFactory;
  config: AgentOnceConfig;
  clock: Clock;
  cwd: string;
  env: NodeJS.ProcessEnv;
  extensions?: ProxyExtension[];
  humanResolverFactory?: (ctx: ProxyContext) => HumanResolver | undefined;
  log?: (message: string) => void;
}

export interface RunningProxy {
  closed: Promise<{ upstreamExitCode: number | null }>;
  close(): Promise<void>;
}

type Params = Record<string, unknown>;
type Reply = { kind: 'result'; result: CallToolResult } | { kind: 'error'; error: { code: number; message: string; data?: unknown } };

interface ForwardedRequest {
  id: RequestId;
  method: string;
  tool?: string;
  args?: Params;
}

interface GuardedRequest {
  id: RequestId;
  tool: string;
  actionId?: string;
  controller: AbortController;
  answered: boolean;
}

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

function writeToStderr(message: string): void {
  process.stderr.write(`${message}\n`);
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
  private readonly humanResolverFactory: ((ctx: ProxyContext) => HumanResolver | undefined) | undefined;
  private readonly log: (message: string) => void;
  private readonly upstreamRequests = new Correlator('upstream');
  private readonly clientRequests = new Correlator('client');
  private readonly forwarded = new Map<string, ForwardedRequest>();
  private readonly guarded = new Map<string, GuardedRequest>();
  private readonly annotations = new Map<string, ToolAnnotations | undefined>();
  private readonly rawResponses = new WeakMap<ToolOutcome, RpcResponse>();
  private readonly patterns = new Map<string, RegExp>();
  private routing: Promise<void> = Promise.resolve();
  private listing: Promise<void> | undefined;
  private toolsListed = false;
  private clientCapabilities: ClientCapabilities = {};
  private clientInfo: Implementation | undefined;
  private humanResolver: HumanResolver | undefined;
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
    this.humanResolverFactory = deps.humanResolverFactory;
    this.log = deps.log ?? writeToStderr;
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.context = this.createContext();
    if (typeof deps.guard === 'function') {
      this.guard = deps.guard({ resolve: async (doubt) => (this.humanResolver === undefined ? 'unresolved' : this.humanResolver.resolve(doubt)) });
    } else if (deps.humanResolverFactory !== undefined) {
      throw new TypeError('humanResolverFactory needs guard to be a factory that accepts the human resolver');
    } else {
      this.guard = deps.guard;
    }
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
      requestClient: (method, params) => this.requestClient(method, params),
      callUpstreamTool: (name, args) => this.callUpstreamTool(name, args),
    };
  }

  private fromClient(message: JSONRPCMessage): void {
    if (isResponse(message)) {
      if (!this.clientRequests.settle(message)) this.sendUpstream(message);
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
    this.humanResolver = this.humanResolverFactory?.(this.context);
  }

  private async routeToolCall(request: JSONRPCRequest): Promise<void> {
    const params: Params = request.params ?? {};
    const tool = params.name;
    if (typeof tool !== 'string') {
      this.forward(request);
      return;
    }
    const args = isRecord(params.arguments) ? params.arguments : {};
    if (tool === RESOLVE_TOOL_NAME && this.config.exposeResolveTool) {
      this.sendClient({ jsonrpc: '2.0', id: request.id, result: handleResolveCall(args, this.guard) });
      return;
    }
    const call = await this.buildCall(tool, args, params);
    if (call.policy === 'pass') {
      this.forward(request, tool, args);
      return;
    }
    const entry: GuardedRequest = { id: request.id, tool, controller: new AbortController(), answered: false };
    this.guarded.set(idKey(request.id), entry);
    void this.runGuarded(entry, { ...call, signal: entry.controller.signal }, params);
  }

  private async buildCall(tool: string, args: Params, params: Params): Promise<GuardedCall> {
    const decision = resolveToolPolicy(tool, await this.annotationsFor(tool), this.config);
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
    if (!this.toolsListed) await this.listAllTools();
    return this.annotations.get(tool);
  }

  private listAllTools(): Promise<void> {
    this.listing ??= this.fetchToolPages().finally(() => {
      this.listing = undefined;
    });
    return this.listing;
  }

  private async fetchToolPages(): Promise<void> {
    try {
      let cursor: string | undefined;
      do {
        const page = await this.requestUpstream('tools/list', cursor === undefined ? {} : { cursor });
        this.captureTools(page.tools);
        cursor = typeof page.nextCursor === 'string' ? page.nextCursor : undefined;
      } while (cursor !== undefined);
      this.toolsListed = true;
    } catch (error) {
      this.log(`agent-once: could not list the MCP server's tools, so unknown tools are guarded: ${errorMessage(error)}`);
    }
  }

  private captureTools(tools: unknown): void {
    if (!Array.isArray(tools)) return;
    for (const tool of tools) {
      if (!isRecord(tool) || typeof tool.name !== 'string') continue;
      this.annotations.set(tool.name, isRecord(tool.annotations) ? (tool.annotations as ToolAnnotations) : undefined);
    }
  }

  private async runGuarded(entry: GuardedRequest, call: GuardedCall, params: Params): Promise<void> {
    let reply: Reply;
    try {
      const result = await this.guard.run(call, (context) => this.dispatch(entry, call, params, context));
      reply = this.present(call, result);
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
    const response = this.upstreamRequests.expect(id, { survivesClose: true });
    const meta = { ...(isRecord(params._meta) ? params._meta : {}), [ACTION_META_KEY]: context.idempotencyKey ?? context.actionId };
    try {
      await this.upstream.send({ jsonrpc: '2.0', id, method: 'tools/call', params: { ...params, _meta: meta } });
    } catch (error) {
      this.upstreamRequests.forget(id);
      return { kind: 'not_dispatched', error: `cannot send the call to the MCP server: ${errorMessage(error)}` };
    }
    const reply = await response;
    if (reply.kind === 'error') {
      const outcome: ToolOutcome = { kind: 'error_result', result: { error: reply.error } as unknown as JsonValue };
      this.rawResponses.set(outcome, reply);
      return outcome;
    }
    const result = reply.result as CallToolResult;
    this.notifyResult(call.tool, call.args, result);
    const outcome = this.classify(call.tool, result);
    this.rawResponses.set(outcome, reply);
    return outcome;
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
      if (outcome !== undefined) return { ...outcome };
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

  private present(call: GuardedCall, result: GuardResult): Reply {
    switch (result.status) {
      case 'executed':
      case 'passed': {
        if (result.recorded === false) {
          this.log(`agent-once: the outcome of ${call.tool} action ${result.actionId} could not be written to the ledger; a retry will be treated as in doubt.`);
        }
        const raw = this.rawResponses.get(result.outcome);
        if (raw?.kind === 'error') return raw;
        if (raw?.kind === 'result') {
          const forwarded = raw.result as CallToolResult;
          return { kind: 'result', result: result.actionId === undefined ? forwarded : withStatus(forwarded, 'executed', result.actionId) };
        }
        const error = result.outcome.kind === 'transport_error' || result.outcome.kind === 'not_dispatched' ? result.outcome.error : 'no result';
        return { kind: 'result', result: callFailedResult(call.tool, result.actionId, error) };
      }
      case 'replayed':
        return { kind: 'result', result: replayedResult(result) };
      case 'in_doubt':
        return { kind: 'result', result: inDoubtResult(result.doubt, this.config.exposeResolveTool && result.doubt.toolClass === 'standard') };
      case 'blocked':
        return { kind: 'result', result: blockedResult(result.doubt) };
      case 'ledger_unavailable':
        return { kind: 'result', result: ledgerUnavailableResult(result.error) };
    }
  }

  private answerGuarded(entry: GuardedRequest, reply: Reply): void {
    const key = idKey(entry.id);
    if (this.guarded.get(key) === entry) this.guarded.delete(key);
    if (entry.answered || entry.controller.signal.aborted) return;
    entry.answered = true;
    if (reply.kind === 'error') this.sendClient({ jsonrpc: '2.0', id: entry.id, error: reply.error });
    else this.sendClient({ jsonrpc: '2.0', id: entry.id, result: reply.result });
  }

  private absorbCancel(params: Params | undefined): boolean {
    const requestId = params?.requestId;
    if (typeof requestId !== 'string' && typeof requestId !== 'number') return false;
    const key = idKey(requestId);
    const entry = this.guarded.get(key);
    if (entry === undefined) {
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
      const key = idKey(message.id);
      const request = this.forwarded.get(key);
      this.forwarded.delete(key);
      this.sendClient(request !== undefined && 'result' in message ? { ...message, result: this.adjustResult(request, message.result) } : message);
      return;
    }
    if (isNotification(message) && message.method === TOOLS_CHANGED) {
      this.annotations.clear();
      this.toolsListed = false;
    }
    this.sendClient(message);
  }

  private adjustResult(request: ForwardedRequest, result: Params): Params {
    if (request.method === 'tools/call' && request.tool !== undefined) {
      this.notifyResult(request.tool, request.args ?? {}, result as CallToolResult);
      return result;
    }
    if (request.method !== 'tools/list') return result;
    this.captureTools(result.tools);
    if (!this.config.exposeResolveTool || typeof result.nextCursor === 'string' || !Array.isArray(result.tools)) return result;
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

  private async requestClient(method: string, params: unknown): Promise<unknown> {
    const id = this.clientRequests.nextId();
    const response = this.clientRequests.expect(id);
    try {
      await this.client.send({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params: params as Params }) });
    } catch (error) {
      this.clientRequests.forget(id);
      throw error;
    }
    const reply = await response;
    if (reply.kind === 'error') throw new Error(`${method} failed: ${reply.error.message}`);
    return reply.result;
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
    this.upstreamRequests.close(new UpstreamClosedError('the MCP server exited'));
    const sends: Promise<void>[] = [];
    for (const entry of this.guarded.values()) {
      if (entry.answered || entry.controller.signal.aborted) continue;
      entry.answered = true;
      sends.push(this.sendClientAsync({ jsonrpc: '2.0', id: entry.id, result: upstreamExitedResult(entry.tool, entry.actionId, exitCode) }));
    }
    this.guarded.clear();
    for (const request of this.forwarded.values()) {
      const message: JSONRPCMessage =
        request.method === 'tools/call'
          ? { jsonrpc: '2.0', id: request.id, result: upstreamExitedResult(request.tool ?? 'tool', undefined, exitCode) }
          : { jsonrpc: '2.0', id: request.id, error: { code: UPSTREAM_GONE, message: 'agent-once: the MCP server exited before answering' } };
      sends.push(this.sendClientAsync(message));
    }
    this.forwarded.clear();
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
