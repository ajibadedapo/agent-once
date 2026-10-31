import type { CallToolResult, Implementation } from '@modelcontextprotocol/sdk/types.js';
import type { JsonValue } from '../../canonical/jcs.js';
import type { BrowserConfig, ToolRule } from '../../config/schema.js';
import type { GuardedCall, ToolOutcome } from '../../guard/types.js';
import { BROWSER_VOLATILE_KEYS } from '../../identity/project-args.js';
import type { ToolClass } from '../../ledger/types.js';
import { resultText, type ProxyContext, type ProxyExtension } from '../proxy.js';
import { ReadBackReconciler } from '../read-back-reconciler.js';
import { classifyBrowserOutcome } from './outcome.js';
import { pageOrigin, PageState } from './page-state.js';
import { detectBrowserProfile, type BrowserProfile } from './profile.js';
import { browserReadBackRule } from './read-back.js';
import { browserCallRule, browserIdentity, isKnownBrowserTool, isSideEffectTool, profileForTool } from './rules.js';

export interface BrowserExtensionOptions {
  command?: string[];
  toolRule?: (tool: string) => ToolRule | undefined;
}

const REMEMBERED_CAPTURES = 10_000;

function guardPolicy(toolClass: ToolClass): GuardedCall['policy'] {
  return toolClass === 'standard' ? 'guard' : 'block-on-doubt';
}

class BrowserRules {
  private readonly page = new PageState();
  private readonly captures = new Map<string, string>();
  private detected: BrowserProfile | undefined;

  constructor(
    private readonly cfg: BrowserConfig,
    private readonly options: BrowserExtensionOptions,
  ) {}

  profileFor(tool: string, serverInfo: Implementation | undefined): BrowserProfile | undefined {
    if (this.cfg.enabled === false) return undefined;
    this.detected ??= detectBrowserProfile(serverInfo, this.options.command ?? []);
    if (this.detected !== undefined) return isKnownBrowserTool(this.detected, tool) ? this.detected : undefined;
    return this.cfg.enabled === true ? profileForTool(tool) : undefined;
  }

  observe(tool: string, args: Record<string, unknown>, result: CallToolResult): void {
    if (result.isError !== true) this.page.observe(tool, args, resultText(result));
  }

  adjust(profile: BrowserProfile, call: GuardedCall): GuardedCall {
    const rule = browserCallRule(profile, call.tool, call.args, this.page, this.cfg);
    const explicit = this.options.toolRule?.(call.tool);
    const toolClass = explicit?.class ?? rule.toolClass;
    const policy = explicit?.policy ?? (rule.policy === 'pass' ? 'pass' : guardPolicy(toolClass));
    if (policy === 'pass') return { ...call, policy };
    const identity = rule.extraIdentity ?? browserIdentity(profile, call.args, this.page);
    return {
      ...call,
      policy,
      toolClass,
      volatileKeys: BROWSER_VOLATILE_KEYS,
      extraIdentity: { ...call.extraIdentity, ...identity },
      ...(rule.captured === undefined ? {} : { captured: rule.captured }),
    };
  }

  reconciler(ctx: ProxyContext): ReadBackReconciler | undefined {
    const url = this.page.url();
    const rule = browserReadBackRule(this.cfg, url);
    if (rule === undefined) return undefined;
    const origin = url === undefined ? undefined : pageOrigin(url);
    return new ReadBackReconciler(rule, ctx, { ...(origin === undefined ? {} : { origin }), capturedFor: (actionId) => this.captures.get(actionId) });
  }

  remember(actionId: string, captured: string): void {
    this.captures.set(actionId, captured);
    if (this.captures.size <= REMEMBERED_CAPTURES) return;
    const oldest = this.captures.keys().next();
    if (oldest.done !== true) this.captures.delete(oldest.value);
  }

  classify(tool: string, result: CallToolResult): ToolOutcome | undefined {
    const profile = this.detected ?? (this.cfg.enabled === true ? profileForTool(tool) : undefined);
    if (profile === undefined || !isSideEffectTool(profile, tool)) return undefined;
    const kind = classifyBrowserOutcome(resultText(result), result.isError === true, this.cfg);
    if (kind === 'not_dispatched') return { kind, error: resultText(result) };
    return { kind, result: result as unknown as JsonValue };
  }
}

export function browserExtension(cfg: BrowserConfig, options: BrowserExtensionOptions = {}): ProxyExtension {
  const rules = new BrowserRules(cfg, options);
  return {
    onUpstreamResult(tool, args, result, ctx) {
      if (rules.profileFor(tool, ctx.serverInfo) !== undefined) rules.observe(tool, args, result);
    },
    reconcilerFor(tool, _args, ctx) {
      const profile = rules.profileFor(tool, ctx.serverInfo);
      if (profile === undefined || !isSideEffectTool(profile, tool)) return undefined;
      return rules.reconciler(ctx)?.reconcile;
    },
    adjustCall(call, ctx) {
      const profile = rules.profileFor(call.tool, ctx.serverInfo);
      return profile === undefined ? call : rules.adjust(profile, call);
    },
    onDispatch(call, actionId) {
      if (call.captured !== undefined) rules.remember(actionId, call.captured);
    },
    classifyOutcome(tool, result) {
      return rules.classify(tool, result);
    },
  };
}
