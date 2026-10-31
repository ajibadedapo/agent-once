import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/sdk/types.js';

export const PROXY_ID_PREFIX = 'agent-once:';

export type RpcResponse = { kind: 'result'; result: Record<string, unknown> } | { kind: 'error'; error: { code: number; message: string; data?: unknown } };

export type ClosedResponse = RpcResponse | { kind: 'abandoned' };

interface Pending {
  settle: (response: ClosedResponse) => void;
  fail: (error: Error) => void;
  abandonOnClose: boolean;
}

export class UpstreamClosedError extends Error {
  override readonly name: string = 'UpstreamClosedError';
}

export function isRequest(message: JSONRPCMessage): message is JSONRPCMessage & { id: RequestId; method: string; params?: Record<string, unknown> } {
  return 'method' in message && 'id' in message;
}

export function isNotification(message: JSONRPCMessage): message is JSONRPCMessage & { method: string; params?: Record<string, unknown> } {
  return 'method' in message && !('id' in message);
}

export function isResponse(message: JSONRPCMessage): message is JSONRPCMessage & { id: RequestId } {
  return !('method' in message) && 'id' in message && ('result' in message || 'error' in message);
}

export function responseOf(message: JSONRPCMessage): RpcResponse {
  if ('error' in message) return { kind: 'error', error: message.error };
  if ('result' in message) return { kind: 'result', result: message.result };
  return { kind: 'error', error: { code: -32603, message: 'malformed response' } };
}

export function isReservedId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith(PROXY_ID_PREFIX);
}

export function idKey(id: RequestId): string {
  return typeof id === 'string' ? `s:${id}` : `n:${id}`;
}

export class Correlator {
  private next = 0;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly channel: string) {}

  nextId(): string {
    this.next += 1;
    return `${PROXY_ID_PREFIX}${this.channel}-${this.next}`;
  }

  expect(id: string): Promise<RpcResponse> {
    return new Promise((settle, fail) => {
      this.pending.set(id, { settle: settle as (response: ClosedResponse) => void, fail, abandonOnClose: false });
    });
  }

  expectOrAbandon(id: string): Promise<ClosedResponse> {
    return new Promise((settle, fail) => {
      this.pending.set(id, { settle, fail, abandonOnClose: true });
    });
  }

  forget(id: string): void {
    this.pending.delete(id);
  }

  settle(message: JSONRPCMessage & { id: RequestId }): boolean {
    if (typeof message.id !== 'string') return false;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return false;
    this.pending.delete(message.id);
    pending.settle(responseOf(message));
    return true;
  }

  close(error: Error): void {
    const closing = [...this.pending.values()];
    this.pending.clear();
    for (const pending of closing) {
      if (pending.abandonOnClose) pending.settle({ kind: 'abandoned' });
      else pending.fail(error);
    }
  }
}
