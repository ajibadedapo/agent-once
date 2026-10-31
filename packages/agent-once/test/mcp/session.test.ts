import { describe, expect, test } from 'vitest';
import { resolveSession } from '../../src/mcp/session.js';

const MANDATE = 'io.github.ajibadedapo.agent-mandates/mandate-id';
const SESSION = 'io.github.ajibadedapo/agent-once-session';

describe('resolveSession', () => {
  test('a mandate id in meta wins over the session meta and the environment', () => {
    expect(resolveSession({ [MANDATE]: 'mandate-42', [SESSION]: 'meta-session' }, { AGENT_ONCE_SESSION: 'env-session' }, 'claude', '/work')).toEqual({
      key: 'mandate-42',
      explicit: true,
      source: 'mandate',
    });
  });

  test('the session meta wins over the environment', () => {
    expect(resolveSession({ [SESSION]: 'meta-session' }, { AGENT_ONCE_SESSION: 'env-session' }, 'claude', '/work')).toEqual({
      key: 'meta-session',
      explicit: true,
      source: 'meta',
    });
  });

  test('AGENT_ONCE_SESSION is used when meta names no session', () => {
    expect(resolveSession({ other: 'x' }, { AGENT_ONCE_SESSION: 'env-session' }, 'claude', '/work')).toEqual({
      key: 'env-session',
      explicit: true,
      source: 'env',
    });
  });

  test('the default is the client name and working directory and is not explicit', () => {
    expect(resolveSession(undefined, {}, 'claude', '/work')).toEqual({ key: 'claude:/work', explicit: false, source: 'default' });
  });

  test('an unnamed client still gets a stable default', () => {
    expect(resolveSession(undefined, {}, undefined, '/work')).toEqual({ key: 'unknown-client:/work', explicit: false, source: 'default' });
  });

  test('empty and non-string values are ignored', () => {
    expect(resolveSession({ [MANDATE]: '', [SESSION]: 7 }, { AGENT_ONCE_SESSION: '' }, 'claude', '/work')).toEqual({
      key: 'claude:/work',
      explicit: false,
      source: 'default',
    });
  });
});
