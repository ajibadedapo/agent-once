import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { RESOLVE_TOOL_NAME, STATUS_META_KEY } from '../../mcp/meta.js';
import { resultText } from '../../mcp/proxy.js';
import type { ChaosTask } from '../scenarios.js';

export type ScriptedAgentKind = 'naive' | 'obedient';

export type Wait = (ms: number) => Promise<void>;

export interface AgentStats {
  calls: number;
  blockedOrDoubt: number;
}

export const NAIVE_RETRY_DELAYS_MS: readonly number[] = [2_000, 4_000, 8_000];

export const OBEDIENT_UNKNOWN_WAIT_MS = 15_000;

export const OBEDIENT_MAX_DOUBT_CHECKS = 4;

interface GuardStatus {
  status: string;
  actionId: string;
}

function guardStatus(result: CallToolResult): GuardStatus | undefined {
  const status: unknown = result._meta?.[STATUS_META_KEY];
  if (typeof status !== 'object' || status === null) return undefined;
  const { status: value, action_id: actionId } = status as { status?: unknown; action_id?: unknown };
  return typeof value === 'string' && typeof actionId === 'string' ? { status: value, actionId } : undefined;
}

function isDoubt(status: GuardStatus | undefined): status is GuardStatus {
  return status?.status === 'in_doubt' || status?.status === 'blocked';
}

function sawEffect(listed: CallToolResult, args: ChaosTask['args']): boolean {
  if (listed.isError === true) return false;
  let effects: unknown;
  try {
    effects = JSON.parse(resultText(listed));
  } catch {
    return false;
  }
  if (!Array.isArray(effects)) return false;
  return effects.some((effect: unknown) => {
    const fields = (effect as { fields?: Record<string, unknown> } | null)?.fields;
    return fields !== undefined && Object.entries(args).every(([name, value]) => fields[name] === String(value));
  });
}

export class ScriptedApiAgent {
  readonly stats: AgentStats = { calls: 0, blockedOrDoubt: 0 };

  constructor(
    private readonly kind: ScriptedAgentKind,
    private readonly client: Client,
    private readonly task: ChaosTask,
    private readonly wait: Wait,
  ) {}

  async run(): Promise<void> {
    const plainRetries = [...NAIVE_RETRY_DELAYS_MS];
    let doubtChecks = 0;
    for (;;) {
      const result = await this.call(this.task.tool, this.task.args);
      if (result.isError !== true) return;
      const status = guardStatus(result);
      if (isDoubt(status)) this.stats.blockedOrDoubt += 1;
      if (this.kind === 'obedient' && isDoubt(status)) {
        if (doubtChecks >= OBEDIENT_MAX_DOUBT_CHECKS) return;
        doubtChecks += 1;
        await this.resolveDoubt(status.actionId);
        continue;
      }
      const delayMs = plainRetries.shift();
      if (delayMs === undefined) return;
      await this.wait(delayMs);
    }
  }

  private async resolveDoubt(actionId: string): Promise<void> {
    const listed = await this.call(this.task.listTool, {});
    const outcome = sawEffect(listed, this.task.args) ? 'happened' : 'not_happened';
    const resolved = await this.call(RESOLVE_TOOL_NAME, { action_id: actionId, outcome });
    if (resolved.isError === true) await this.wait(OBEDIENT_UNKNOWN_WAIT_MS);
  }

  private async call(name: string, args: Record<string, unknown>): Promise<CallToolResult> {
    this.stats.calls += 1;
    return (await this.client.callTool({ name, arguments: args })) as CallToolResult;
  }
}
