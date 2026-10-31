import type { AgentOnceConfig } from '../../config/schema.js';
import type { HumanResolver } from '../../guard/types.js';
import type { ProxyContext } from '../proxy.js';
import { ChainResolver } from './chain-resolver.js';
import { DEFAULT_ELICITATION_TIMEOUT_MS, ElicitationResolver } from './elicitation-resolver.js';
import { WebhookResolver } from './webhook-resolver.js';

export interface HumanResolverOptions {
  fetchImpl?: typeof fetch;
  log?: (message: string) => void;
}

function webhookSecret(config: AgentOnceConfig, env: NodeJS.ProcessEnv): string | undefined {
  const name = config.approvalWebhook?.secretEnv;
  if (name === undefined) return undefined;
  const secret = env[name];
  if (secret === undefined || secret === '') throw new Error(`approvalWebhook.secretEnv names ${name}, but that environment variable is not set`);
  return secret;
}

export function createHumanResolver(ctx: ProxyContext, config: AgentOnceConfig, env: NodeJS.ProcessEnv, options: HumanResolverOptions = {}): HumanResolver {
  const webhook = config.approvalWebhook;
  if (webhook === undefined) return new ChainResolver([new ElicitationResolver(ctx, DEFAULT_ELICITATION_TIMEOUT_MS, options.log)]);
  const secret = webhookSecret(config, env);
  const resolver = new WebhookResolver(
    { url: webhook.url, timeoutSeconds: webhook.timeoutSeconds, ...(secret === undefined ? {} : { secret }) },
    ctx.clock,
    options.fetchImpl,
    options.log,
  );
  return new ChainResolver([new ElicitationResolver(ctx, webhook.timeoutSeconds * 1000, options.log), resolver]);
}
