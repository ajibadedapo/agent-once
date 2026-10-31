import type { ClientCapabilities } from '@modelcontextprotocol/sdk/types.js';
import type { DoubtInfo, HumanResolution, HumanResolver } from '../../guard/types.js';
import type { ProxyContext } from '../proxy.js';
import { doubtQuestion } from './messages.js';

export const DEFAULT_ELICITATION_TIMEOUT_MS = 300_000;
export const ELICITATION_OUTCOME_FIELD = 'agent_once_outcome';
const UNRESOLVED: HumanResolution = { outcome: 'unresolved' };

export const ELICITATION_SCHEMA = {
  type: 'object',
  properties: {
    [ELICITATION_OUTCOME_FIELD]: {
      type: 'string',
      title: 'Did it happen?',
      enum: ['happened', 'not_happened'],
      enumNames: ['Yes, it happened', 'No, it did not happen'],
    },
  },
  required: [ELICITATION_OUTCOME_FIELD],
} as const;

type Attempt = { answer: HumanResolution } | { problem: string } | { cancelled: true };

function supportsForm(capabilities: ClientCapabilities): boolean {
  const elicitation = capabilities.elicitation;
  if (elicitation === undefined || elicitation === null) return false;
  return elicitation.form !== undefined || elicitation.url === undefined;
}

function answerOf(reply: unknown): HumanResolution {
  if (typeof reply !== 'object' || reply === null) return UNRESOLVED;
  const { action, content } = reply as { action?: unknown; content?: unknown };
  if (action !== 'accept' || typeof content !== 'object' || content === null) return UNRESOLVED;
  const value = (content as Record<string, unknown>)[ELICITATION_OUTCOME_FIELD];
  return value === 'happened' || value === 'not_happened' ? { outcome: value, by: 'human' } : UNRESOLVED;
}

function problemOf(error: unknown): string {
  return `the request failed (${error instanceof Error ? error.name : 'unknown error'})`;
}

export class ElicitationResolver implements HumanResolver {
  constructor(
    private readonly ctx: ProxyContext,
    private readonly timeoutMs: number = DEFAULT_ELICITATION_TIMEOUT_MS,
    private readonly log: (message: string) => void = () => {},
  ) {}

  async resolve(doubt: DoubtInfo, signal?: AbortSignal): Promise<HumanResolution> {
    if (signal?.aborted === true || !supportsForm(this.ctx.clientCapabilities)) return UNRESOLVED;
    const controller = new AbortController();
    let timer: { cancel(): void } | undefined;
    let onCancel: (() => void) | undefined;
    const stopped = new Promise<Attempt>((settle) => {
      timer = this.ctx.clock.setTimer(this.timeoutMs, () => {
        settle({ problem: `no answer within ${this.timeoutMs / 1000} s` });
        controller.abort();
      });
      onCancel = () => {
        settle({ cancelled: true });
        controller.abort();
      };
      signal?.addEventListener('abort', onCancel, { once: true });
    });
    const asked = this.ctx
      .requestClient('elicitation/create', { message: doubtQuestion(doubt), requestedSchema: ELICITATION_SCHEMA }, { signal: controller.signal })
      .then(
        (reply): Attempt => ({ answer: answerOf(reply) }),
        (error: unknown): Attempt => (controller.signal.aborted ? { cancelled: true } : { problem: problemOf(error) }),
      );
    try {
      const attempt = await Promise.race([asked, stopped]);
      if ('answer' in attempt) return attempt.answer;
      if ('problem' in attempt) this.log(`agent-once: the client gave no answer to the question about action ${doubt.actionId}: ${attempt.problem}`);
      return UNRESOLVED;
    } finally {
      timer?.cancel();
      if (onCancel !== undefined) signal?.removeEventListener('abort', onCancel);
    }
  }
}
