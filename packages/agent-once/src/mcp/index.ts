export {
  createProxy,
  type GuardFactory,
  type ProxyContext,
  type ProxyDeps,
  type ProxyExtension,
  type RunningProxy,
} from './proxy.js';
export { UpstreamStdioTransport, type ExitAwareTransport } from './upstream.js';
export { resolveSession, type SessionIdentity } from './session.js';
export { findToolRule, resolveToolPolicy, type ToolPolicyDecision } from './tool-policy.js';
export { RESOLVE_TOOL } from './resolve-tool.js';
export { ChainResolver } from './doubt/chain-resolver.js';
export { DEFAULT_ELICITATION_TIMEOUT_MS, ELICITATION_SCHEMA, ElicitationResolver } from './doubt/elicitation-resolver.js';
export { MAX_WEBHOOK_RESPONSE_BYTES, SIGNATURE_HEADER, WebhookResolver, type WebhookResolverConfig } from './doubt/webhook-resolver.js';
export { createHumanResolver, type HumanResolverOptions } from './doubt/human-resolver.js';
export { blockedToolResult, doubtQuestion, inDoubtToolResult } from './doubt/messages.js';
export { ACTION_META_KEY, INTENT_META_KEY, MANDATE_META_KEY, RESOLVE_TOOL_NAME, SESSION_ENV, SESSION_META_KEY, STATUS_META_KEY } from './meta.js';
export { loadConfig, type LoadConfigOptions } from '../config/load.js';
export {
  ConfigError,
  parseConfig,
  type AgentOnceConfig,
  type ApprovalWebhookConfig,
  type BrowserConfig,
  type ReadBackRule,
  type ReadBackStep,
  type ToolPolicy,
  type ToolRule,
} from '../config/schema.js';
