import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { JSONRPCMessage, RequestId } from '@modelcontextprotocol/sdk/types.js';
import { ManualClock } from '../../src/time/clock.js';

export type Message = JSONRPCMessage & { id?: RequestId; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { code: number; message: string } };

export class ScriptedPeer {
  readonly transport: InMemoryTransport;
  private readonly peer: InMemoryTransport;
  private readonly inbox: Message[] = [];
  private readonly waiters: ((message: Message) => void)[] = [];

  constructor(private readonly autoInitialize: boolean) {
    [this.transport, this.peer] = InMemoryTransport.createLinkedPair();
    this.peer.onmessage = (message) => this.receive(message as Message);
  }

  static upstream(): ScriptedPeer {
    return new ScriptedPeer(true);
  }

  static client(): ScriptedPeer {
    return new ScriptedPeer(false);
  }

  async start(): Promise<void> {
    await this.peer.start();
  }

  next(): Promise<Message> {
    const queued = this.inbox.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  async expectRequest(method: string): Promise<Message & { id: RequestId; params: Record<string, unknown> }> {
    const message = await this.next();
    if (message.method !== method || message.id === undefined) throw new Error(`expected a ${method} request, got ${JSON.stringify(message)}`);
    return message as Message & { id: RequestId; params: Record<string, unknown> };
  }

  send(message: Record<string, unknown>): Promise<void> {
    return this.peer.send({ jsonrpc: '2.0', ...message } as JSONRPCMessage);
  }

  reply(id: RequestId, result: Record<string, unknown>): Promise<void> {
    return this.send({ id, result });
  }

  replyError(id: RequestId, code: number, message: string): Promise<void> {
    return this.send({ id, error: { code, message } });
  }

  notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    return this.send({ method, params });
  }

  private receive(message: Message): void {
    if (this.autoInitialize && message.method === 'initialize' && message.id !== undefined) {
      void this.reply(message.id, {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'scripted', version: '1.0.0' },
      });
      return;
    }
    if (this.autoInitialize && message.method === 'notifications/initialized') return;
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.inbox.push(message);
    else waiter(message);
  }
}

export class SignallingClock extends ManualClock {
  private armed: (() => void) | undefined;
  readonly timerSet: Promise<void>;

  constructor(startMs: number) {
    super(startMs);
    this.timerSet = new Promise((resolve) => {
      this.armed = resolve;
    });
  }

  override setTimer(ms: number, fn: () => void): { cancel(): void } {
    this.armed?.();
    return super.setTimer(ms, fn);
  }
}

export function toolResult(text: string): Record<string, unknown> {
  return { content: [{ type: 'text', text }] };
}
