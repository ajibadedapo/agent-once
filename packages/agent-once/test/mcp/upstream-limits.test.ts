import { describe, expect, test } from 'vitest';
import { UpstreamStdioTransport } from '../../src/mcp/upstream.js';
import { ManualClock } from '../../src/time/clock.js';
import { START_MS } from './proxy-harness.js';

class TimerWatchingClock extends ManualClock {
  private created = 0;
  private readonly waiters: { count: number; wake: () => void }[] = [];

  override setTimer(ms: number, fn: () => void): { cancel(): void } {
    const timer = super.setTimer(ms, fn);
    this.created += 1;
    for (const waiter of [...this.waiters]) {
      if (this.created < waiter.count) continue;
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.wake();
    }
    return timer;
  }

  timers(count: number): Promise<void> {
    if (this.created >= count) return Promise.resolve();
    return new Promise((wake) => this.waiters.push({ count, wake }));
  }
}

function collectStderr(transport: UpstreamStdioTransport): () => string {
  let text = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    text += chunk.toString('utf8');
  });
  return () => text;
}

describe('UpstreamStdioTransport limits', () => {
  test('an oversized message is reported, the child is killed and close follows', async () => {
    const transport = new UpstreamStdioTransport({
      command: process.execPath,
      args: ['-e', "process.stdout.write('x'.repeat(4096)); setInterval(() => {}, 1000)"],
      stderr: 'ignore',
      maxBufferSize: 1024,
    });
    const errors: string[] = [];
    transport.onerror = (error) => errors.push(error.message);
    const closed = new Promise<void>((resolve) => {
      transport.onclose = resolve;
    });
    await transport.start();
    await closed;
    expect(errors.some((message) => message.includes('exceeded maximum size'))).toBe(true);
    expect(transport.exitCode).toBe(137);
  });

  test('a send waiting for drain rejects when the child goes away', async () => {
    const clock = new TimerWatchingClock(START_MS);
    const transport = new UpstreamStdioTransport({ command: process.execPath, args: ['-e', 'setInterval(() => {}, 1000)'], stderr: 'ignore', clock });
    await transport.start();
    const sending = transport.send({ jsonrpc: '2.0', method: 'notifications/message', params: { data: 'x'.repeat(1024 * 1024) } });
    const closing = transport.close();
    await clock.timers(1);
    clock.advance(2000);
    await expect(sending).rejects.toThrow();
    await closing;
  });

  test('close is bounded when a grandchild keeps stdout open after the child is killed', async () => {
    const clock = new TimerWatchingClock(START_MS);
    const script = [
      "process.on('SIGTERM', () => {});",
      "const grandchild = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'ignore'] });",
      "process.stderr.write(String(grandchild.pid) + '\\n');",
      'setInterval(() => {}, 1000);',
    ].join('\n');
    const transport = new UpstreamStdioTransport({ command: process.execPath, args: ['-e', script], stderr: 'pipe', clock });
    const stderr = collectStderr(transport);
    let closes = 0;
    transport.onclose = () => {
      closes += 1;
    };
    await transport.start();
    const exited = new Promise<void>((resolve) => {
      const poll = (): void => {
        if (/\d+\n/.test(stderr())) resolve();
        else transport.stderr?.once('data', poll);
      };
      poll();
    });
    await exited;
    const grandchildPid = Number(stderr().trim());
    try {
      const closing = transport.close();
      await clock.timers(1);
      clock.advance(2000);
      await clock.timers(2);
      clock.advance(2000);
      await clock.timers(3);
      clock.advance(2000);
      await closing;
      expect(closes).toBe(1);
      expect(transport.exitCode).toBe(137);
    } finally {
      process.kill(grandchildPid, 'SIGKILL');
    }
  });

  test('a partial env keeps PATH and HOME from the default environment', async () => {
    const transport = new UpstreamStdioTransport({
      command: process.execPath,
      args: ['-e', 'process.stderr.write(JSON.stringify({ path: Boolean(process.env.PATH), home: Boolean(process.env.HOME), extra: process.env.AO_EXTRA }))'],
      env: { AO_EXTRA: 'yes' },
      stderr: 'pipe',
    });
    const stderr = collectStderr(transport);
    const closed = new Promise<void>((resolve) => {
      transport.onclose = resolve;
    });
    await transport.start();
    await closed;
    expect(JSON.parse(stderr())).toEqual({ path: true, home: true, extra: 'yes' });
  });
});
