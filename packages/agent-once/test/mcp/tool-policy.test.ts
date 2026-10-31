import { describe, expect, test } from 'vitest';
import { loadConfig } from '../../src/config/load.js';
import type { AgentOnceConfig, ToolRule } from '../../src/config/schema.js';
import { findToolRule, resolveToolPolicy } from '../../src/mcp/tool-policy.js';

function config(tools: Record<string, ToolRule> = {}): AgentOnceConfig {
  return { ...loadConfig({ cwd: '/work', env: { AGENT_ONCE_HOME: '/state' }, homedir: '/home/user' }), tools };
}

describe('resolveToolPolicy', () => {
  test('readOnlyHint passes', () => {
    expect(resolveToolPolicy('list_orders', { readOnlyHint: true }, config())).toEqual({ policy: 'pass', toolClass: 'standard' });
  });

  test('non-destructive idempotent tools pass', () => {
    expect(resolveToolPolicy('set_flag', { destructiveHint: false, idempotentHint: true }, config())).toEqual({ policy: 'pass', toolClass: 'standard' });
  });

  test('idempotent alone is not enough to pass because destructive defaults to true', () => {
    expect(resolveToolPolicy('set_flag', { idempotentHint: true }, config())).toEqual({ policy: 'guard', toolClass: 'standard' });
  });

  test('unannotated tools are guarded', () => {
    expect(resolveToolPolicy('create_ticket', undefined, config())).toEqual({ policy: 'guard', toolClass: 'standard' });
  });

  test('money and irreversible tools default to block-on-doubt', () => {
    expect(resolveToolPolicy('charge_card', { destructiveHint: true }, config())).toEqual({ policy: 'block-on-doubt', toolClass: 'money' });
    expect(resolveToolPolicy('send_email', undefined, config())).toEqual({ policy: 'block-on-doubt', toolClass: 'irreversible' });
  });

  test('the annotation title also classifies', () => {
    expect(resolveToolPolicy('do_it', { title: 'Place order' }, config())).toEqual({ policy: 'block-on-doubt', toolClass: 'money' });
  });

  test('a config rule wins over annotations', () => {
    expect(resolveToolPolicy('list_orders', { readOnlyHint: true }, config({ list_orders: { policy: 'guard' } }))).toEqual({
      policy: 'guard',
      toolClass: 'standard',
    });
    expect(resolveToolPolicy('charge_card', undefined, config({ 'charge_*': { policy: 'pass' } }))).toEqual({ policy: 'pass', toolClass: 'money' });
  });

  test('a rule with only a class keeps the annotation logic', () => {
    expect(resolveToolPolicy('notify', undefined, config({ notify: { class: 'irreversible' } }))).toEqual({
      policy: 'block-on-doubt',
      toolClass: 'irreversible',
    });
    expect(resolveToolPolicy('notify', { readOnlyHint: true }, config({ notify: { class: 'irreversible' } }))).toEqual({
      policy: 'pass',
      toolClass: 'irreversible',
    });
  });
});

describe('findToolRule', () => {
  test('an exact name wins over an earlier glob', () => {
    const rules = config({ 'browser_*': { policy: 'pass' }, browser_click: { policy: 'guard' } });
    expect(findToolRule('browser_click', rules)).toEqual({ policy: 'guard' });
    expect(findToolRule('browser_hover', rules)).toEqual({ policy: 'pass' });
  });

  test('globs match the whole name and treat other characters literally', () => {
    const rules = config({ 'a.c?': { policy: 'pass' } });
    expect(findToolRule('a.cd', rules)).toEqual({ policy: 'pass' });
    expect(findToolRule('abcd', rules)).toBeUndefined();
    expect(findToolRule('a.cde', rules)).toBeUndefined();
  });
});
