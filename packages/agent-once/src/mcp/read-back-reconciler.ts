import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { JsonValue } from '../canonical/jcs.js';
import type { AgentOnceConfig, ReadBackRule } from '../config/schema.js';
import type { ReconcileContext, ReconcileOutcome, Reconciler } from '../guard/types.js';
import { resultText, type ProxyContext, type ProxyExtension } from './proxy.js';
import { renderArgs, renderPattern, TemplateError, type TemplateVars } from './template.js';
import { findToolRule } from './tool-policy.js';

export interface ReadBackOptions {
  origin?: string;
  capturedFor?: (actionId: string) => string | undefined;
}

type UpstreamCaller = Pick<ProxyContext, 'callUpstreamTool'>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function capturedOf(ctx: ReconcileContext, options: ReadBackOptions): string | undefined {
  const recorded = ctx.event.detail.captured;
  return typeof recorded === 'string' ? recorded : options.capturedFor?.(ctx.actionId);
}

export class ReadBackReconciler {
  private readonly rule: ReadBackRule;
  private readonly upstream: UpstreamCaller;
  private readonly options: ReadBackOptions;

  constructor(rule: ReadBackRule, ctx: UpstreamCaller, options: ReadBackOptions = {}) {
    this.rule = rule;
    this.upstream = ctx;
    this.options = options;
  }

  readonly reconcile: Reconciler = async (ctx) => {
    const captured = capturedOf(ctx, this.options);
    const vars: TemplateVars = {
      args: ctx.args,
      actionId: ctx.actionId,
      ...(captured === undefined ? {} : { captured }),
      ...(this.options.origin === undefined ? {} : { origin: this.options.origin }),
    };
    let plan: { steps: { tool: string; args: Record<string, unknown> }[]; happened?: RegExp; notHappened?: RegExp };
    try {
      plan = {
        steps: this.rule.steps.map((step) => ({ tool: step.tool, args: renderArgs(step.args, vars) as Record<string, JsonValue> })),
        ...(this.rule.happened === undefined ? {} : { happened: new RegExp(renderPattern(this.rule.happened, vars), 'i') }),
        ...(this.rule.notHappened === undefined ? {} : { notHappened: new RegExp(renderPattern(this.rule.notHappened, vars), 'i') }),
      };
    } catch (error) {
      if (error instanceof TemplateError) return { outcome: 'unknown', reason: error.message };
      throw error;
    }
    return this.run(plan);
  };

  private async run(plan: { steps: { tool: string; args: Record<string, unknown> }[]; happened?: RegExp; notHappened?: RegExp }): Promise<ReconcileOutcome> {
    const texts: string[] = [];
    for (const step of plan.steps) {
      let result: CallToolResult;
      try {
        result = await this.upstream.callUpstreamTool(step.tool, step.args);
      } catch (error) {
        return { outcome: 'unknown', reason: `read-back step ${step.tool} failed: ${errorMessage(error)}` };
      }
      const text = resultText(result);
      if (result.isError === true) return { outcome: 'unknown', reason: `read-back step ${step.tool} returned an error: ${text}` };
      texts.push(text);
    }
    const text = texts.join('\n');
    if (plan.happened?.test(text) === true) return { outcome: 'happened' };
    if (plan.notHappened?.test(text) === true) return { outcome: 'not_happened' };
    return { outcome: 'unknown', reason: 'the read-back matched neither pattern' };
  }
}

export function readBackExtension(config: AgentOnceConfig): ProxyExtension {
  return {
    reconcilerFor(tool, _args, ctx) {
      const rule = findToolRule(tool, config)?.readBack;
      return rule === undefined ? undefined : new ReadBackReconciler(rule, ctx).reconcile;
    },
  };
}
