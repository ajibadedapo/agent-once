import { MANDATE_META_KEY, SESSION_ENV, SESSION_META_KEY, metaString } from './meta.js';

export interface SessionIdentity {
  key: string;
  explicit: boolean;
  source: 'mandate' | 'meta' | 'env' | 'default';
}

const UNKNOWN_CLIENT = 'unknown-client';

export function resolveSession(
  meta: Record<string, unknown> | undefined,
  env: NodeJS.ProcessEnv,
  clientName: string | undefined,
  cwd: string,
): SessionIdentity {
  const mandate = metaString(meta, MANDATE_META_KEY);
  if (mandate !== undefined) return { key: mandate, explicit: true, source: 'mandate' };
  const session = metaString(meta, SESSION_META_KEY);
  if (session !== undefined) return { key: session, explicit: true, source: 'meta' };
  const fromEnv = env[SESSION_ENV];
  if (fromEnv !== undefined && fromEnv !== '') return { key: fromEnv, explicit: true, source: 'env' };
  const name = clientName !== undefined && clientName !== '' ? clientName : UNKNOWN_CLIENT;
  return { key: `${name}:${cwd}`, explicit: false, source: 'default' };
}
