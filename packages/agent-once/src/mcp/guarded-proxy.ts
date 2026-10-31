import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { AgentOnceConfig } from '../config/schema.js';
import type { EvidenceSink } from '../evidence/types.js';
import { Guard, type GuardDeps } from '../guard/guard.js';
import type { LedgerStore } from '../ledger/types.js';
import type { Clock } from '../time/clock.js';
import { browserExtension } from './browser/extension.js';
import { createHumanResolver } from './doubt/human-resolver.js';
import { createProxy, type ProxyExtension, type RunningProxy } from './proxy.js';
import { readBackExtension } from './read-back-reconciler.js';
import { findToolRule } from './tool-policy.js';

export interface GuardedProxyOptions {
  client: Transport;
  upstream: Transport;
  config: AgentOnceConfig;
  store: LedgerStore;
  clock: Clock;
  runInstance: string;
  evidence: EvidenceSink;
  cwd: string;
  env: NodeJS.ProcessEnv;
  command: string[];
  log?: (message: string) => void;
}

export function guardSettings(config: AgentOnceConfig): Pick<GuardDeps, 'retryWindowMs' | 'expiryMs' | 'settleWindowMs' | 'storeArgs'> {
  return {
    retryWindowMs: Math.round(config.ledger.retryWindowSeconds * 1000),
    expiryMs: Math.round(config.ledger.expiryHours * 3_600_000),
    settleWindowMs: Math.round(config.ledger.settleSeconds * 1000),
    storeArgs: config.ledger.storeArgs,
  };
}

export function proxyExtensions(config: AgentOnceConfig, command: string[]): ProxyExtension[] {
  const extensions = [readBackExtension(config)];
  if (config.browser.enabled !== false) extensions.push(browserExtension(config.browser, { command, toolRule: (tool) => findToolRule(tool, config) }));
  return extensions;
}

export function createGuardedProxy(options: GuardedProxyOptions): Promise<RunningProxy> {
  const { config, store, clock, runInstance, evidence, env, log } = options;
  return createProxy({
    client: options.client,
    upstream: options.upstream,
    guard: (ctx) =>
      new Guard({
        store,
        clock,
        runInstance,
        evidence,
        humanResolver: createHumanResolver(ctx, config, env, log === undefined ? {} : { log }),
        ...guardSettings(config),
      }),
    config,
    clock,
    cwd: options.cwd,
    env,
    extensions: proxyExtensions(config, options.command),
    ...(log === undefined ? {} : { log }),
  });
}
