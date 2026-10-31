import { fileURLToPath } from 'node:url';
import type { ElicitationRequest, ElicitationResult, McpServerConfig, McpStdioServerConfig, OnElicitation } from '@anthropic-ai/claude-agent-sdk';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { CanonicalizationError, type JsonValue } from '../canonical/jcs.js';
import { DEFAULT_IRREVERSIBLE_PATTERNS, DEFAULT_MONEY_PATTERNS, classifyTool } from '../guard/classify.js';
import type { Guard } from '../guard/guard.js';
import type { GuardResult, HumanResolution, Reconciler, ToolOutcome } from '../guard/types.js';
import type { IdentityRule } from '../identity/project-args.js';
import type { GuardPolicy, ToolClass } from '../ledger/types.js';
import { ELICITATION_OUTCOME_FIELD } from '../mcp/doubt/elicitation-resolver.js';
import { blockedToolResult, checkThenRetryToolResult, inDoubtToolResult } from '../mcp/doubt/messages.js';
import { SESSION_ENV } from '../mcp/meta.js';
import { callFailedResult, ledgerUnavailableResult, replayedResult, unidentifiableCallResult } from '../mcp/result-format.js';

export interface GuardMcpServersOptions {
  session?: string;
  configPath?: string;
  cliPath?: string;
}

export interface GuardedMcpServers {
  servers: Record<string, McpServerConfig>;
  unguarded: string[];
}

export interface SdkToolGuard {
  sessionKey: string;
  policy?: 'pass' | GuardPolicy;
  toolClass?: ToolClass;
  identityRule?: IdentityRule;
  reconciler?: Reconciler;
}

export interface GuardableSdkTool {
  name: string;
  description?: string;
  handler(args: Record<string, unknown>, extra: unknown): Promise<CallToolResult>;
}

export interface ElicitationQuestion {
  message: string;
  serverName: string;
}

const DECLINE: ElicitationResult = { action: 'decline' };

function bundledCliPath(): string {
  return fileURLToPath(new URL('../cli/main.js', import.meta.url));
}

function isStdio(config: McpServerConfig): config is McpStdioServerConfig {
  return (config.type === undefined || config.type === 'stdio') && 'command' in config;
}

function wrapStdio(config: McpStdioServerConfig, cliPath: string, options: GuardMcpServersOptions): McpStdioServerConfig {
  const env = options.session === undefined ? config.env : { ...config.env, [SESSION_ENV]: options.session };
  const configArgs = options.configPath === undefined ? [] : ['--config', options.configPath];
  return {
    ...config,
    command: process.execPath,
    args: [cliPath, 'mcp', ...configArgs, '--', config.command, ...(config.args ?? [])],
    ...(env === undefined ? {} : { env }),
  };
}

export function guardMcpServers(servers: Record<string, McpServerConfig>, options: GuardMcpServersOptions = {}): GuardedMcpServers {
  const cliPath = options.cliPath ?? bundledCliPath();
  const unguarded: string[] = [];
  const guarded: Record<string, McpServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    if (isStdio(config)) {
      guarded[name] = wrapStdio(config, cliPath, options);
    } else {
      guarded[name] = config;
      unguarded.push(name);
    }
  }
  return { servers: guarded, unguarded };
}

function asOutcome(reply: CallToolResult): ToolOutcome {
  const result = reply as unknown as JsonValue;
  return reply.isError === true ? { kind: 'error_result', result } : { kind: 'ok', result };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function executedReply(tool: string, result: GuardResult & { status: 'executed' | 'passed' }, thrown: { error: unknown } | undefined): CallToolResult {
  const { outcome } = result;
  switch (outcome.kind) {
    case 'ok':
    case 'error_result':
      return outcome.result as unknown as CallToolResult;
    case 'transport_error':
    case 'not_dispatched':
      if (thrown !== undefined) throw thrown.error;
      return callFailedResult(tool, result.actionId, outcome.error);
    case 'abandoned':
      return callFailedResult(tool, result.actionId, 'the call was abandoned before its outcome was known');
  }
}

function guardedReply(tool: string, result: GuardResult, thrown: { error: unknown } | undefined): CallToolResult {
  switch (result.status) {
    case 'executed':
    case 'passed':
      return executedReply(tool, result, thrown);
    case 'replayed':
      return replayedResult(result);
    case 'in_doubt':
      return inDoubtToolResult(result.doubt, false);
    case 'blocked':
      return blockedToolResult(result.doubt);
    case 'ledger_unavailable':
      return ledgerUnavailableResult(result.error);
    case 'retry_by_agent':
      return checkThenRetryToolResult({ actionId: result.actionId, tool });
  }
}

export function guardSdkTool<T extends GuardableSdkTool>(guard: Guard, tool: T, meta: SdkToolGuard): T {
  const toolClass =
    meta.toolClass ?? classifyTool(tool.name, tool.description ?? '', { money: [...DEFAULT_MONEY_PATTERNS], irreversible: [...DEFAULT_IRREVERSIBLE_PATTERNS] });
  const policy = meta.policy ?? (toolClass === 'standard' ? 'guard' : 'block-on-doubt');
  const original = tool.handler;
  const handler = async (args: Record<string, unknown>, extra: unknown): Promise<CallToolResult> => {
    let thrown: { error: unknown } | undefined;
    let result: GuardResult;
    try {
      result = await guard.run(
        {
          tool: tool.name,
          args,
          sessionKey: meta.sessionKey,
          sessionExplicit: true,
          policy,
          toolClass,
          ...(meta.identityRule === undefined ? {} : { identityRule: meta.identityRule }),
          ...(meta.reconciler === undefined ? {} : { reconciler: meta.reconciler }),
        },
        async () => {
          try {
            return asOutcome(await original.call(tool, args, extra));
          } catch (error) {
            thrown = { error };
            return { kind: 'transport_error', error: messageOf(error) };
          }
        },
      );
    } catch (error) {
      if (error instanceof CanonicalizationError) return unidentifiableCallResult(tool.name, error.message);
      throw error;
    }
    return guardedReply(tool.name, result, thrown);
  };
  return { ...tool, handler };
}

function isAgentOnceRequest(request: ElicitationRequest): boolean {
  if (request.mode === 'url') return false;
  const properties = request.requestedSchema?.properties;
  return typeof properties === 'object' && properties !== null && Object.hasOwn(properties, ELICITATION_OUTCOME_FIELD);
}

export function agentOnceElicitationHandler(ask: (question: ElicitationQuestion) => Promise<HumanResolution>, fallback?: OnElicitation): OnElicitation {
  return async (request, options) => {
    if (!isAgentOnceRequest(request)) return fallback === undefined ? DECLINE : fallback(request, options);
    const answer = await ask({ message: request.message, serverName: request.serverName });
    if (answer.outcome === 'unresolved') return DECLINE;
    return { action: 'accept', content: { [ELICITATION_OUTCOME_FIELD]: answer.outcome } };
  };
}
