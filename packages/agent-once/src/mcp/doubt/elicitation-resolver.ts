import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';
import type { DoubtInfo, HumanResolution, HumanResolver } from '../../guard/types.js';
import type { ProxyContext } from '../proxy.js';
import { doubtQuestion } from './messages.js';

export const DEFAULT_ELICITATION_TIMEOUT_MS = 300_000;
const OUTCOME_FIELD = 'agent_once_outcome';

export const ELICITATION_SCHEMA = {
  type: 'object',
  properties: {
    [OUTCOME_FIELD]: {
      type: 'string',
      title: 'Did it happen?',
      enum: ['happened', 'not_happened'],
      enumNames: ['Yes, it happened', 'No, it did not happen'],
    },
  },
  required: [OUTCOME_FIELD],
} as const;

function supportsForm(capabilities: ClientCapabilities): boolean {
  const elicitation = capabilities.elicitation;
  if (elicitation === undefined || elicitation === null) return false;
  return elicitation.form !== undefined || elicitation.url === undefined;
}

function outcomeOf(reply: unknown): HumanResolution {
  if (typeof reply !== 'object' || reply === null) return 'unresolved';
  const { action, content } = reply as { action?: unknown; content?: unknown };
  if (action !== 'accept' || typeof content !== 'object' || content === null) return 'unresolved';
  const value = (content as Record<string, unknown>)[OUTCOME_FIELD];
  return value === 'happened' || value === 'not_happened' ? value : 'unresolved';
}

export class ElicitationResolver implements HumanResolver {
  constructor(
    private readonly ctx: ProxyContext,
    private readonly timeoutMs: number = DEFAULT_ELICITATION_TIMEOUT_MS,
  ) {}

  async resolve(doubt: DoubtInfo): Promise<HumanResolution> {
    if (!supportsForm(this.ctx.clientCapabilities)) return 'unresolved';
    const controller = new AbortController();
    let timer: { cancel(): void } | undefined;
    const timedOut = new Promise<HumanResolution>((settle) => {
      timer = this.ctx.clock.setTimer(this.timeoutMs, () => {
        controller.abort(new Error(`no answer within ${this.timeoutMs / 1000} s`));
        settle('unresolved');
      });
    });
    const asked = this.ctx
      .requestClient('elicitation/create', { message: doubtQuestion(doubt), requestedSchema: ELICITATION_SCHEMA }, { signal: controller.signal })
      .then(outcomeOf, (): HumanResolution => 'unresolved');
    try {
      return await Promise.race([asked, timedOut]);
    } finally {
      timer?.cancel();
    }
  }
}
