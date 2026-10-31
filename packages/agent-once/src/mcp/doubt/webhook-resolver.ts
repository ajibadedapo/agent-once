import { createHmac } from 'node:crypto';
import type { DoubtInfo, HumanResolution, HumanResolver } from '../../guard/types.js';
import type { Clock } from '../../time/clock.js';

export interface WebhookResolverConfig {
  url: string;
  timeoutSeconds: number;
  secret?: string;
}

export const SIGNATURE_HEADER = 'X-Agent-Once-Signature';

type Attempt = { outcome: HumanResolution } | { problem: string };

function outcomeOf(body: unknown): HumanResolution | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const outcome = (body as { outcome?: unknown }).outcome;
  return outcome === 'happened' || outcome === 'not_happened' || outcome === 'unresolved' ? outcome : undefined;
}

function problemOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}

export class WebhookResolver implements HumanResolver {
  constructor(
    private readonly cfg: WebhookResolverConfig,
    private readonly clock: Clock,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly log: (message: string) => void = () => {},
  ) {}

  async resolve(doubt: DoubtInfo): Promise<HumanResolution> {
    const controller = new AbortController();
    let timer: { cancel(): void } | undefined;
    const timedOut = new Promise<Attempt>((settle) => {
      timer = this.clock.setTimer(this.cfg.timeoutSeconds * 1000, () => {
        controller.abort();
        settle({ problem: `no answer within ${this.cfg.timeoutSeconds} s` });
      });
    });
    try {
      const attempt = await Promise.race([this.ask(doubt, controller.signal), timedOut]);
      if ('outcome' in attempt) return attempt.outcome;
      this.log(`agent-once: the approval webhook gave no usable answer for action ${doubt.actionId}: ${attempt.problem}`);
      return 'unresolved';
    } finally {
      timer?.cancel();
    }
  }

  private async ask(doubt: DoubtInfo, signal: AbortSignal): Promise<Attempt> {
    const body = JSON.stringify({
      type: 'agent-once.approval_request',
      action_id: doubt.actionId,
      tool: doubt.tool,
      args: doubt.args,
      class: doubt.toolClass,
      reason: doubt.reason,
      since_ms: doubt.sinceMs,
    });
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cfg.secret !== undefined) headers[SIGNATURE_HEADER] = `sha256=${createHmac('sha256', this.cfg.secret).update(body).digest('hex')}`;
    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(this.cfg.url, { method: 'POST', headers, body, signal, redirect: 'error' });
      text = await response.text();
    } catch (error) {
      return { problem: `the request failed (${problemOf(error)})` };
    }
    if (response.status !== 200) return { problem: `HTTP ${response.status}` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { problem: 'the response is not JSON' };
    }
    const outcome = outcomeOf(parsed);
    return outcome === undefined ? { problem: 'the response has no outcome of happened, not_happened or unresolved' } : { outcome };
  }
}
