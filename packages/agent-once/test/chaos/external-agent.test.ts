import { mkdtempSync, readFileSync, rmSync, watch } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import { startExternalAgent } from '../../src/chaos/agents/external-agent.js';

const WRAPPER = fileURLToPath(new URL('../fixtures/chaos-wrapper-agent.mjs', import.meta.url));
const ENV = { AGENT_ONCE_CHAOS_URL: 'http://127.0.0.1:9', AGENT_ONCE_CHAOS_MCP: '[]', AGENT_ONCE_TASK: 'nothing', AGENT_ONCE_SESSION: 'chaos:test' };

const dirs: string[] = [];
const strays: number[] = [];

afterEach(() => {
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      continue;
    }
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fileAppears(dir: string, name: string): Promise<void> {
  return new Promise((resolve) => {
    const watcher = watch(dir, () => {
      try {
        readFileSync(join(dir, name), 'utf8');
      } catch {
        return;
      }
      watcher.close();
      resolve();
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number): Promise<boolean> {
  for (let turn = 0; turn < 10_000; turn += 1) {
    if (!alive(pid)) return true;
    await nextTurn();
  }
  return false;
}

describe('external agent', () => {
  test('killing a shell-wrapped agent kills the whole process group, grandchild included', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-once-ext-'));
    dirs.push(dir);
    const pidFile = join(dir, 'grandchild.pid');
    const started = fileAppears(dir, 'grandchild.pid');
    const agent = startExternalAgent({ command: [`"${process.execPath}" "${WRAPPER}" wrapper "${pidFile}"`], env: ENV, timeoutMs: 60_000 });
    await started;
    const grandchild = Number(readFileSync(pidFile, 'utf8'));
    strays.push(grandchild);
    expect(alive(grandchild)).toBe(true);
    agent.kill();
    await agent.exited;
    expect(await gone(grandchild)).toBe(true);
  }, 20_000);
});
