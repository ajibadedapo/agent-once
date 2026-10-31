import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { loadConfig } from '../src/config/load.js';
import { ConfigError } from '../src/config/schema.js';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-once-config-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeConfig(content: string): { dir: string; file: string } {
  const dir = tempDir();
  const file = join(dir, 'agent-once.json');
  writeFileSync(file, content);
  return { dir, file };
}

function configError(content: string): ConfigError {
  const { dir, file } = writeConfig(content);
  try {
    loadConfig({ path: file, cwd: dir, env: {}, homedir: '/home/user' });
  } catch (error) {
    if (error instanceof ConfigError) return error;
    throw error;
  }
  throw new Error('expected a ConfigError');
}

describe('loadConfig', () => {
  test('zero config yields defaults under AGENT_ONCE_HOME', () => {
    expect(loadConfig({ cwd: '/work', env: { AGENT_ONCE_HOME: '/state/ao' }, homedir: '/home/user' })).toEqual({
      ledger: { path: '/state/ao/ledger.db', expiryHours: 24, retryWindowSeconds: 120, settleSeconds: 10, storeArgs: true },
      evidence: { jsonl: '/state/ao/events.jsonl' },
      exposeResolveTool: true,
      tools: {},
      browser: { enabled: 'auto' },
    });
  });

  test('zero config falls back to ~/.agent-once', () => {
    const config = loadConfig({ cwd: '/work', env: {}, homedir: '/home/user' });
    expect(config.ledger.path).toBe('/home/user/.agent-once/ledger.db');
    expect(config.evidence.jsonl).toBe('/home/user/.agent-once/events.jsonl');
  });

  test('a full config is validated, relative paths resolve from the config file and browser keys pass through', () => {
    const { dir, file } = writeConfig(
      JSON.stringify({
        ledger: { path: 'state/ledger.db', expiryHours: 2, retryWindowSeconds: 60, settleSeconds: 5, storeArgs: false },
        evidence: { jsonl: null },
        approvalWebhook: { url: 'https://approvals.example.test/hook', secretEnv: 'AO_SECRET' },
        exposeResolveTool: false,
        tools: {
          'create_*': {
            policy: 'block-on-doubt',
            class: 'irreversible',
            identity: { include: ['title'] },
            notDispatchedErrors: ['^rejected'],
            readBack: { steps: [{ tool: 'list_tickets', args: { title: '{{args.title}}' } }], happened: '{{args.title}}' },
          },
        },
        browser: { enabled: false, successMarkers: ['Thanks'] },
      }),
    );
    expect(loadConfig({ path: 'agent-once.json', cwd: dir, env: {}, homedir: '/home/user' })).toEqual({
      ledger: { path: join(dir, 'state/ledger.db'), expiryHours: 2, retryWindowSeconds: 60, settleSeconds: 5, storeArgs: false },
      evidence: { jsonl: null },
      approvalWebhook: { url: 'https://approvals.example.test/hook', timeoutSeconds: 120, secretEnv: 'AO_SECRET' },
      exposeResolveTool: false,
      tools: {
        'create_*': {
          policy: 'block-on-doubt',
          class: 'irreversible',
          identity: { include: ['title'] },
          notDispatchedErrors: ['^rejected'],
          readBack: { steps: [{ tool: 'list_tickets', args: { title: '{{args.title}}' } }], happened: '{{args.title}}' },
        },
      },
      browser: { enabled: false, successMarkers: ['Thanks'] },
    });
    expect(file).toBe(join(dir, 'agent-once.json'));
  });

  test('invalid JSON names the file', () => {
    const error = configError('{ "ledger": ');
    expect(error.file).toMatch(/agent-once\.json$/);
    expect(error.path).toBe('');
    expect(error.message).toContain('invalid JSON');
    expect(error.message).toContain(error.file);
  });

  test('an unknown policy names the JSON pointer', () => {
    const error = configError(JSON.stringify({ tools: { 'pay/now': { policy: 'sometimes' } } }));
    expect(error.path).toBe('/tools/pay~1now/policy');
    expect(error.message).toContain('/tools/pay~1now/policy');
    expect(error.message).toContain('sometimes');
  });

  test('an invalid regex names the JSON pointer', () => {
    expect(configError(JSON.stringify({ tools: { submit: { notDispatchedErrors: ['ok', '(unclosed'] } } })).path).toBe(
      '/tools/submit/notDispatchedErrors/1',
    );
    expect(configError(JSON.stringify({ tools: { submit: { readBack: { steps: [], notHappened: '[' } } } })).path).toBe(
      '/tools/submit/readBack/notHappened',
    );
  });

  test('unknown keys are rejected at every level', () => {
    expect(configError(JSON.stringify({ ledgr: {} })).path).toBe('/ledgr');
    expect(configError(JSON.stringify({ ledger: { pth: 'x' } })).path).toBe('/ledger/pth');
    expect(configError(JSON.stringify({ tools: { x: { polcy: 'pass' } } })).path).toBe('/tools/x/polcy');
    expect(configError(JSON.stringify({ tools: { x: { readBack: { steps: [{ tool: 'a', args: {}, extra: 1 }] } } } })).path).toBe(
      '/tools/x/readBack/steps/0/extra',
    );
  });

  test('wrong types, ranges and shapes are rejected', () => {
    expect(configError('[]').path).toBe('');
    expect(configError(JSON.stringify({ ledger: { expiryHours: 0 } })).path).toBe('/ledger/expiryHours');
    expect(configError(JSON.stringify({ ledger: { storeArgs: 'yes' } })).path).toBe('/ledger/storeArgs');
    expect(configError(JSON.stringify({ ledger: { retryWindowSeconds: 5, settleSeconds: 10 } })).path).toBe('/ledger/settleSeconds');
    expect(configError(JSON.stringify({ tools: { x: { class: 'huge' } } })).path).toBe('/tools/x/class');
    expect(configError(JSON.stringify({ tools: { x: { identity: { include: ['a'], exclude: ['b'] } } } })).path).toBe('/tools/x/identity');
    expect(configError(JSON.stringify({ tools: { '': { policy: 'pass' } } })).path).toBe('/tools/');
    expect(configError(JSON.stringify({ approvalWebhook: { url: 'ftp://x' } })).path).toBe('/approvalWebhook/url');
    expect(configError(JSON.stringify({ browser: { enabled: 'maybe' } })).path).toBe('/browser/enabled');
  });

  test('a missing config file is a ConfigError', () => {
    const dir = tempDir();
    expect(() => loadConfig({ path: 'nope.json', cwd: dir, env: {}, homedir: '/home/user' })).toThrow(ConfigError);
  });
});
