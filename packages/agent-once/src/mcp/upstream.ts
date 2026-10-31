import { spawn, type ChildProcess } from 'node:child_process';
import { constants } from 'node:os';
import { PassThrough, type Readable } from 'node:stream';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import { systemClock, type Clock } from '../time/clock.js';

export interface ExitAwareTransport extends Transport {
  readonly exitCode?: number | null;
}

export interface UpstreamOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  stderr?: 'inherit' | 'pipe' | 'ignore';
  clock?: Clock;
  closeGraceMs?: number;
}

const DEFAULT_CLOSE_GRACE_MS = 2000;
const SIGNAL_EXIT_BASE = 128;

function signalExitCode(signal: NodeJS.Signals | null): number | null {
  if (signal === null) return null;
  return SIGNAL_EXIT_BASE + (constants.signals[signal] ?? 0);
}

export class UpstreamStdioTransport implements ExitAwareTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child: ChildProcess | undefined;
  private started = false;
  private recordedExitCode: number | null = null;
  private readonly buffer = new ReadBuffer();
  private readonly stderrStream: PassThrough | null;
  private readonly clock: Clock;
  private readonly closeGraceMs: number;
  private markClosed: () => void = () => {};
  private readonly closedPromise: Promise<void>;

  constructor(private readonly options: UpstreamOptions) {
    this.stderrStream = options.stderr === 'pipe' ? new PassThrough() : null;
    this.clock = options.clock ?? systemClock;
    this.closeGraceMs = options.closeGraceMs ?? DEFAULT_CLOSE_GRACE_MS;
    this.closedPromise = new Promise((resolve) => {
      this.markClosed = resolve;
    });
  }

  get exitCode(): number | null {
    return this.recordedExitCode;
  }

  get stderr(): Readable | null {
    return this.stderrStream;
  }

  start(): Promise<void> {
    if (this.started) return Promise.reject(new Error('the upstream transport is already started'));
    this.started = true;
    return new Promise((resolve, reject) => {
      let spawned = false;
      const child = spawn(this.options.command, this.options.args ?? [], {
        env: this.options.env ?? process.env,
        cwd: this.options.cwd,
        stdio: ['pipe', 'pipe', this.options.stderr ?? 'inherit'],
        windowsHide: true,
      });
      this.child = child;
      child.on('error', (error) => {
        if (spawned) this.onerror?.(error);
        else reject(error);
      });
      child.once('spawn', () => {
        spawned = true;
        resolve();
      });
      child.once('exit', (code, signal) => {
        this.recordedExitCode = code ?? signalExitCode(signal);
      });
      child.once('close', () => {
        this.child = undefined;
        this.buffer.clear();
        this.markClosed();
        if (spawned) this.onclose?.();
      });
      child.stdout?.on('data', (chunk: Buffer) => this.receive(chunk));
      child.stdout?.on('error', (error) => this.onerror?.(error));
      child.stdin?.on('error', (error) => this.onerror?.(error));
      if (this.stderrStream !== null) child.stderr?.pipe(this.stderrStream);
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (stdin === undefined || stdin === null || !stdin.writable) return Promise.reject(new Error('Not connected'));
    return new Promise((resolve) => {
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once('drain', resolve);
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (child === undefined) return;
    child.stdin?.end();
    if (await this.closesWithin(this.closeGraceMs)) return;
    child.kill('SIGTERM');
    if (await this.closesWithin(this.closeGraceMs)) return;
    child.kill('SIGKILL');
    await this.closedPromise;
  }

  private closesWithin(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = this.clock.setTimer(ms, () => resolve(false));
      void this.closedPromise.then(() => {
        timer.cancel();
        resolve(true);
      });
    });
  }

  private receive(chunk: Buffer): void {
    this.buffer.append(chunk);
    for (;;) {
      let message: JSONRPCMessage | null;
      try {
        message = this.buffer.readMessage();
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        continue;
      }
      if (message === null) return;
      this.onmessage?.(message);
    }
  }
}
