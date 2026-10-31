import type { CallToolResult, Implementation } from '@modelcontextprotocol/sdk/types.js';
import type { JsonValue } from '../../canonical/jcs.js';
import type { BrowserConfig, ToolRule } from '../../config/schema.js';
import type { GuardedCall, Reconciler, ToolOutcome } from '../../guard/types.js';
import { BROWSER_VOLATILE_KEYS } from '../../identity/project-args.js';
import type { ToolClass } from '../../ledger/types.js';
import { resultText, type ProxyContext, type ProxyExtension } from '../proxy.js';
import { ReadBackReconciler } from '../read-back-reconciler.js';
import { classifyBrowserOutcome } from './outcome.js';
import { pageOrigin, PageState } from './page-state.js';
import { detectBrowserProfile, type BrowserProfile } from './profile.js';
import { browserReadBackRule } from './read-back.js';
import {
  browserCallRule,
  browserIdentity,
  isKnownBrowserTool,
  isNavigationTool,
  isSideEffectCall,
  isSideEffectTool,
  NAVIGATE_TOOL,
  observesPage,
  profileForTool,
  SNAPSHOT_TOOL,
} from './rules.js';
import { isSnapshotText } from './snapshot-labels.js';

export interface BrowserExtensionOptions {
  command?: string[];
  toolRule?: (tool: string) => ToolRule | undefined;
}

type Args = Record<string, unknown>;

function guardPolicy(toolClass: ToolClass): GuardedCall['policy'] {
  return toolClass === 'standard' ? 'guard' : 'block-on-doubt';
}

function pageArgs(profile: BrowserProfile, args: Args): Args {
  return profile === 'chrome-devtools' && typeof args.pageId === 'number' ? { pageId: args.pageId } : {};
}

class BrowserRules {
  private readonly page = new PageState();
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

  observe(profile: BrowserProfile, tool: string, args: Args, result: CallToolResult): void {
    if (result.isError !== true && observesPage(profile, tool)) this.page.observe(tool, args, resultText(result));
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

  reconciler(profile: BrowserProfile, ctx: ProxyContext): Reconciler | undefined {
    const url = this.page.url();
    const rule = browserReadBackRule(this.cfg, url);
    if (url === undefined || rule === undefined) return undefined;
    const origin = pageOrigin(url);
    const readBack = new ReadBackReconciler(rule, ctx, origin === undefined ? {} : { origin });
    if (!rule.steps.some((step) => isNavigationTool(step.tool))) return readBack.reconcile;
    return async (reconcileCtx) => {
      const outcome = await readBack.reconcile(reconcileCtx);
      if (outcome.outcome !== 'not_happened') return outcome;
      await this.returnTo(profile, url, reconcileCtx.args, ctx);
      return { outcome: 'not_happened', retryByAgent: true };
    };
  }

  async classify(profile: BrowserProfile, args: Args, result: CallToolResult, ctx: ProxyContext): Promise<ToolOutcome> {
    const isError = result.isError === true;
    let text = resultText(result);
    if (!isError && !isSnapshotText(text)) text = `${text}\n${await this.snapshotText(profile, args, ctx)}`;
    const kind = classifyBrowserOutcome(text, isError, this.cfg);
    if (kind === 'not_dispatched') return { kind, error: resultText(result) };
    return { kind, result: result as unknown as JsonValue };
  }

  private async snapshotText(profile: BrowserProfile, args: Args, ctx: ProxyContext): Promise<string> {
    try {
      const snapshot = await ctx.callUpstreamTool(SNAPSHOT_TOOL[profile], pageArgs(profile, args));
      return snapshot.isError === true ? '' : resultText(snapshot);
    } catch {
      return '';
    }
  }

  private async returnTo(profile: BrowserProfile, url: string, args: Args, ctx: ProxyContext): Promise<void> {
    const navigate = profile === 'chrome-devtools' ? { ...pageArgs(profile, args), type: 'url', url } : { url };
    try {
      await ctx.callUpstreamTool(NAVIGATE_TOOL[profile], navigate);
    } catch {
      return;
    }
  }
}

export function browserExtension(cfg: BrowserConfig, options: BrowserExtensionOptions = {}): ProxyExtension {
  const rules = new BrowserRules(cfg, options);
  return {
    onUpstreamResult(tool, args, result, ctx) {
      const profile = rules.profileFor(tool, ctx.serverInfo);
      if (profile !== undefined) rules.observe(profile, tool, args, result);
    },
    reconcilerFor(tool, _args, ctx) {
      const profile = rules.profileFor(tool, ctx.serverInfo);
      if (profile === undefined || !isSideEffectTool(profile, tool)) return undefined;
      return rules.reconciler(profile, ctx);
    },
    adjustCall(call, ctx) {
      const profile = rules.profileFor(call.tool, ctx.serverInfo);
      return profile === undefined ? call : rules.adjust(profile, call);
    },
    async classifyOutcome(tool, args, result, ctx) {
      const profile = rules.profileFor(tool, ctx.serverInfo);
      if (profile === undefined || !isSideEffectCall(profile, tool, args)) return undefined;
      return rules.classify(profile, args, result, ctx);
    },
  };
}
