export const MANDATE_META_KEY = 'io.github.ajibadedapo.agent-mandates/mandate-id';
export const SESSION_META_KEY = 'io.github.ajibadedapo/agent-once-session';
export const INTENT_META_KEY = 'io.github.ajibadedapo/agent-once-intent';
export const STATUS_META_KEY = 'io.github.ajibadedapo/agent-once';
export const ACTION_META_KEY = 'io.github.ajibadedapo/agent-once-action';
export const SESSION_ENV = 'AGENT_ONCE_SESSION';

export function metaString(meta: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = meta?.[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}
