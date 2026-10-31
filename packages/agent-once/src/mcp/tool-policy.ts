import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { AgentOnceConfig, ToolRule } from '../config/schema.js';
import { DEFAULT_IRREVERSIBLE_PATTERNS, DEFAULT_MONEY_PATTERNS, classifyTool } from '../guard/classify.js';
import type { GuardPolicy, ToolClass } from '../ledger/types.js';

export interface ToolPolicyDecision {
  policy: 'pass' | GuardPolicy;
  toolClass: ToolClass;
}

const GLOB_SPECIAL = /[.+^${}()|[\]\\]/g;

function globToRegExp(glob: string): RegExp {
  const source = glob.replace(GLOB_SPECIAL, '\\$&').replaceAll('*', '.*').replaceAll('?', '.');
  return new RegExp(`^${source}$`);
}

export function findToolRule(name: string, config: AgentOnceConfig): ToolRule | undefined {
  if (Object.hasOwn(config.tools, name)) return config.tools[name];
  for (const [pattern, rule] of Object.entries(config.tools)) {
    if (globToRegExp(pattern).test(name)) return rule;
  }
  return undefined;
}

export function resolveToolPolicy(name: string, annotations: ToolAnnotations | undefined, config: AgentOnceConfig): ToolPolicyDecision {
  const rule = findToolRule(name, config);
  const toolClass =
    rule?.class ?? classifyTool(name, annotations?.title ?? '', { money: [...DEFAULT_MONEY_PATTERNS], irreversible: [...DEFAULT_IRREVERSIBLE_PATTERNS] });
  if (rule?.policy !== undefined) return { policy: rule.policy, toolClass };
  if (annotations?.readOnlyHint === true) return { policy: 'pass', toolClass };
  if (annotations?.destructiveHint === false && annotations.idempotentHint === true) return { policy: 'pass', toolClass };
  return { policy: toolClass === 'standard' ? 'guard' : 'block-on-doubt', toolClass };
}
