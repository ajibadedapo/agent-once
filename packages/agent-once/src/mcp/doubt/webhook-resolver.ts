import { createHmac } from 'node:crypto';
import type { DoubtInfo, HumanResolution, HumanResolver } from '../../guard/types.js';
import type { Clock } from '../../time/clock.js';

export interface WebhookResolverConfig {
  url: string;
  timeoutSeconds: number;
  secret?: string;
}

export const SIGNATURE_HEADER = 'X-Agent-Once-Signature';
export const MAX_WEBHOOK_RESPONSE_BYTES = 4096;
const UNRESOLVED: HumanResolution = { outcome: 'unresolved' };

type Attempt = { answer: HumanResolution } | { problem: string } | { cancelled: true };

class ResponseTooLargeError extends Error {}

function answerOf(body: unknown): HumanResolution | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const outcome = (body as { outcome?: unknown }).outcome;
  if (outcome === 'happened' || outcome === 'not_happened') return { outcome, by: 'webhook' };
  return outcome === 'unresolved' ? UNRESOLVED : undefined;
}

function problemOf(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown error';
}

async function readCapped(response: Response): Promise<string> {
  if (response.body === null) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_WEBHOOK_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new ResponseTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class WebhookResolver implements HumanResolver {
  constructor(
    private readonly cfg: WebhookResolverConfig,
    private readonly clock: Clock,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly log: (message: string) => void = () => {},
  ) {}

  async resolve(doubt: DoubtInfo, signal?: AbortSignal): Promise<HumanResolution> {
    if (signal?.aborted === true) return UNRESOLVED;
    const controller = new AbortController();
    let timer: { cancel(): void } | undefined;
    let onCancel: (() => void) | undefined;
    const stopped = new Promise<Attempt>((settle) => {
      timer = this.clock.setTimer(this.cfg.timeoutSeconds * 1000, () => {
        settle({ problem: `no answer within ${this.cfg.timeoutSeconds} s` });
        controller.abort();
      });
      onCancel = () => {
        settle({ cancelled: true });
        controller.abort();
      };
      signal?.addEventListener('abort', onCancel, { once: true });
    });
    try {
      const attempt = await Promise.race([this.ask(doubt, controller.signal), stopped]);
      if ('answer' in attempt) return attempt.answer;
      if ('problem' in attempt) this.log(`agent-once: the approval webhook gave no usable answer for action ${doubt.actionId}: ${attempt.problem}`);
      return UNRESOLVED;
    } finally {
      timer?.cancel();
      if (onCancel !== undefined) signal?.removeEventListener('abort', onCancel);
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
      if (response.status !== 200) {
        await response.body?.cancel().catch(() => {});
        return { problem: `HTTP ${response.status}` };
      }
      text = await readCapped(response);
    } catch (error) {
      if (error instanceof ResponseTooLargeError) return { problem: `the response is larger than ${MAX_WEBHOOK_RESPONSE_BYTES / 1024} KiB` };
      return { problem: `the request failed (${problemOf(error)})` };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { problem: 'the response is not JSON' };
    }
    const answer = answerOf(parsed);
    return answer === undefined ? { problem: 'the response has no outcome of happened, not_happened or unresolved' } : { answer };
  }
}
