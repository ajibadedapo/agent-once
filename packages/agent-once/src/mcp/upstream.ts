import type { ChildProcess } from 'node:child_process';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export interface ExitAwareTransport extends Transport {
  readonly exitCode?: number | null;
}

function isChildProcess(value: unknown): value is ChildProcess {
  return typeof value === 'object' && value !== null && 'once' in value && typeof value.once === 'function';
}

export class UpstreamStdioTransport extends StdioClientTransport implements ExitAwareTransport {
  private recordedExitCode: number | null = null;

  get exitCode(): number | null {
    return this.recordedExitCode;
  }

  override async start(): Promise<void> {
    await super.start();
    const child: unknown = Reflect.get(this, '_process');
    if (isChildProcess(child)) {
      child.once('exit', (code) => {
        this.recordedExitCode = code;
      });
    }
  }
}
