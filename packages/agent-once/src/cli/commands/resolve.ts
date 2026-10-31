import { randomUUID } from 'node:crypto';
import { Guard } from '../../guard/guard.js';
import type { ResolveResult } from '../../guard/types.js';
import { systemClock } from '../../time/clock.js';
import { guardSettings } from '../../mcp/guarded-proxy.js';
import { CliExit, EXIT_FAILED, EXIT_LEDGER, EXIT_OK, EXIT_USAGE, evidenceSink, openLedger, parseCommandArgs, readConfig, type CliIo } from '../io.js';

export const RESOLVE_USAGE = 'Usage: agent-once resolve <action_id> --happened|--not-happened [--config <file>]';

function refusal(result: Exclude<ResolveResult, { ok: true }>, actionId: string, ledgerPath: string): string {
  switch (result.reason) {
    case 'unknown_action':
      return `no action ${actionId} in ${ledgerPath}`;
    case 'not_in_doubt':
      return `action ${actionId} is not in doubt, so there is nothing to resolve`;
    case 'agent_cannot_resolve_class':
      return `action ${actionId} can only be resolved by a person`;
    case 'too_soon':
      return `it is too soon to resolve action ${actionId}`;
    case 'ledger_unavailable':
      return result.error;
  }
}

export function runResolve(args: string[], io: CliIo): number {
  const { values, positionals } = parseCommandArgs(
    args,
    { happened: { type: 'boolean' }, 'not-happened': { type: 'boolean' }, config: { type: 'string' } },
    RESOLVE_USAGE,
  );
  const [actionId, ...extra] = positionals;
  if (actionId === undefined || extra.length > 0 || values.happened === values['not-happened']) throw new CliExit(EXIT_USAGE, RESOLVE_USAGE);
  const outcome = values.happened === true ? 'happened' : 'not_happened';
  const config = readConfig(io, typeof values.config === 'string' ? values.config : undefined);
  const store = openLedger(config, systemClock);
  try {
    const guard = new Guard({ store, clock: systemClock, runInstance: randomUUID(), evidence: evidenceSink(config), ...guardSettings(config) });
    const result = guard.resolve(actionId, outcome, 'human');
    if (result.ok) {
      io.stdout(`Recorded that action ${actionId} ${outcome === 'happened' ? 'happened' : 'did not happen'}.\n`);
      return EXIT_OK;
    }
    throw new CliExit(result.reason === 'ledger_unavailable' ? EXIT_LEDGER : EXIT_FAILED, `agent-once: cannot resolve: ${refusal(result, actionId, config.ledger.path)}`);
  } finally {
    store.close();
  }
}
