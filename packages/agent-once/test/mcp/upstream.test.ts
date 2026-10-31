import { describe, expect, test } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { UpstreamStdioTransport } from '../../src/mcp/upstream.js';
import { FIXTURE } from './proxy-harness.js';

function closedOnce(transport: UpstreamStdioTransport): Promise<void> {
  return new Promise((resolve) => {
    transport.onclose = resolve;
  });
}

describe('UpstreamStdioTransport', () => {
  test('relays MCP messages to a real server and records a clean exit', async () => {
    const transport = new UpstreamStdioTransport({ command: process.execPath, args: [FIXTURE], stderr: 'ignore' });
    const client = new Client({ name: 'upstream-test', version: '1.0.0' });
    await client.connect(transport);
    expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('increment');
    await client.close();
    expect(transport.exitCode).toBe(0);
  });

  test('records the exit code of a process that exits by itself', async () => {
    const transport = new UpstreamStdioTransport({ command: process.execPath, args: ['-e', 'process.exit(5)'], stderr: 'ignore' });
    const closed = closedOnce(transport);
    await transport.start();
    await closed;
    expect(transport.exitCode).toBe(5);
  });

  test('maps a death by signal to 128 plus the signal number', async () => {
    const transport = new UpstreamStdioTransport({ command: process.execPath, args: ['-e', "process.kill(process.pid, 'SIGTERM')"], stderr: 'ignore' });
    const closed = closedOnce(transport);
    await transport.start();
    await closed;
    expect(transport.exitCode).toBe(143);
  });

  test('a command that cannot be spawned rejects start without a close event', async () => {
    const transport = new UpstreamStdioTransport({ command: '/nonexistent/agent-once-upstream', stderr: 'ignore' });
    let closes = 0;
    transport.onclose = () => {
      closes += 1;
    };
    await expect(transport.start()).rejects.toThrow(/ENOENT/);
    expect(closes).toBe(0);
    await expect(transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' })).rejects.toThrow('Not connected');
  });

  test('piped stderr is readable before start and carries the child output', async () => {
    const transport = new UpstreamStdioTransport({ command: process.execPath, args: ['-e', "process.stderr.write('oops')"], stderr: 'pipe' });
    let stderr = '';
    transport.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const closed = closedOnce(transport);
    await transport.start();
    await closed;
    expect(stderr).toBe('oops');
  });
});
