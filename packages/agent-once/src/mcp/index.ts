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
export { RESOLVE_TOOL, RESOLVE_TOOL_NAME } from './resolve-tool.js';
export { ACTION_META_KEY, INTENT_META_KEY, MANDATE_META_KEY, SESSION_ENV, SESSION_META_KEY, STATUS_META_KEY } from './meta.js';
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
