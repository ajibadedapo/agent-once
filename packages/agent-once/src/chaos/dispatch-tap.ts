import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export class DispatchTap implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly dispatched: Promise<void>;
  private markDispatched: () => void = () => {};
  private readonly mutatingIds = new Set<string | number>();
  private swallowed = false;

  constructor(
    private readonly inner: Transport,
    private readonly tool: string,
    private readonly crash: boolean,
  ) {
    this.dispatched = new Promise((resolve) => {
      this.markDispatched = resolve;
    });
    inner.onclose = () => this.onclose?.();
    inner.onerror = (error) => this.onerror?.(error);
    inner.onmessage = (message) => this.receive(message);
  }

  start(): Promise<void> {
    return this.inner.start();
  }

  send(message: JSONRPCMessage): Promise<void> {
    if ('method' in message && 'id' in message && message.method === 'tools/call' && message.params?.name === this.tool) this.mutatingIds.add(message.id);
    return this.inner.send(message);
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  private receive(message: JSONRPCMessage): void {
    const id = 'method' in message ? undefined : (message as { id?: unknown }).id;
    const answersMutation = (typeof id === 'string' || typeof id === 'number') && this.mutatingIds.has(id);
    if (answersMutation && this.crash && !this.swallowed) {
      this.swallowed = true;
      this.markDispatched();
      return;
    }
    this.onmessage?.(message);
  }
}
