import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, test } from 'vitest';
import { BROWSER_RETRY_DELAYS_MS, naiveBrowserAgent, type ToolCaller } from '../src/browser-agent.js';

const URL_BASE = 'http://127.0.0.1:4100';
const FORM = '- generic [ref=e1]:\n  - heading "Checkout" [level=1] [ref=e2]\n  - button "Place order" [ref=e9]';
const STATUS_KEY = 'io.github.ajibadedapo/agent-once';

function text(value: string, extra: Partial<CallToolResult> = {}): CallToolResult {
  return { content: [{ type: 'text', text: value }], ...extra };
}

function withStatus(value: string, status: string, isError: boolean): CallToolResult {
  return text(value, { isError, _meta: { [STATUS_KEY]: { status, action_id: 'ao_1' } } });
}

function scripted(clicks: CallToolResult[]): { caller: ToolCaller; calls: [string, Record<string, unknown>][] } {
  const calls: [string, Record<string, unknown>][] = [];
  const caller: ToolCaller = async (name, args) => {
    calls.push([name, args]);
    if (name === 'browser_navigate') return text('### Page\n- Page Title: Checkout');
    if (name === 'browser_snapshot') return text(FORM);
    const next = clicks.shift();
    if (next === undefined) throw new Error('unexpected click');
    return next;
  };
  return { caller, calls };
}

describe('scripted browser agent', () => {
  test('clicks the target button and retries a gateway timeout until the order is confirmed', async () => {
    const waits: number[] = [];
    const { caller, calls } = scripted([text('- Page Title: 504 Gateway Timeout'), text('- Page Title: Order confirmed')]);
    const run = await naiveBrowserAgent(caller, { url: URL_BASE, target: 'checkout' }, async (ms) => {
      waits.push(ms);
    });
    expect(calls.map(([name]) => name)).toEqual(['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_navigate', 'browser_snapshot', 'browser_click']);
    expect(calls[0]?.[1]).toEqual({ url: `${URL_BASE}/checkout` });
    expect(calls[2]?.[1]).toEqual({ element: 'Place order button', target: 'e9' });
    expect(waits).toEqual([BROWSER_RETRY_DELAYS_MS[0]]);
    expect(run).toMatchObject({ confirmed: true, clicks: 2, calls: 6, blockedOrDoubt: 0 });
  });

  test('stops when the guard replays the earlier result', async () => {
    const { caller } = scripted([withStatus('- Page Title: 504 Gateway Timeout', 'executed', false), withStatus('agent-once: this action already happened', 'replayed', false)]);
    const run = await naiveBrowserAgent(caller, { url: URL_BASE, target: 'checkout' }, async () => {});
    expect(run).toMatchObject({ confirmed: true, clicks: 2 });
  });

  test('counts doubt answers and gives up after the last retry delay', async () => {
    const waits: number[] = [];
    const doubts = Array.from({ length: BROWSER_RETRY_DELAYS_MS.length + 1 }, () => withStatus('agent-once: blocked', 'blocked', true));
    const { caller } = scripted(doubts);
    const run = await naiveBrowserAgent(caller, { url: URL_BASE, target: 'checkout' }, async (ms) => {
      waits.push(ms);
    });
    expect(waits).toEqual([...BROWSER_RETRY_DELAYS_MS]);
    expect(run).toMatchObject({ confirmed: false, clicks: BROWSER_RETRY_DELAYS_MS.length + 1, blockedOrDoubt: BROWSER_RETRY_DELAYS_MS.length + 1 });
  });

  test('measures the characters of every tool response', async () => {
    const { caller } = scripted([text('- Page Title: Order confirmed')]);
    const run = await naiveBrowserAgent(caller, { url: URL_BASE, target: 'checkout' }, async () => {});
    expect(run.responseChars).toBe('### Page\n- Page Title: Checkout'.length + FORM.length + '- Page Title: Order confirmed'.length);
    expect(run.snapshotChars).toEqual([FORM.length]);
  });

  test('a page without the target button is an error, not a silent pass', async () => {
    const caller: ToolCaller = async (name) => text(name === 'browser_snapshot' ? '- heading "Oops"' : '');
    await expect(naiveBrowserAgent(caller, { url: URL_BASE, target: 'checkout' }, async () => {})).rejects.toThrow('no "Place order" button');
  });
});
