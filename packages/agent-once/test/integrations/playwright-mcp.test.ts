import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { chaosTargetsPreset } from '../../src/chaos/presets.js';
import { loadConfig } from '../../src/config/load.js';
import { PLAYWRIGHT_MCP_VERSION, playwrightMcpServer } from '../../src/integrations/playwright-mcp.js';

describe('playwrightMcpServer', () => {
  test('playwrightMcpServer builds the expected command', () => {
    expect(PLAYWRIGHT_MCP_VERSION).toBe('0.0.83');
    expect(playwrightMcpServer()).toEqual({ command: 'npx', args: ['agent-once', 'mcp', '--', 'npx', '@playwright/mcp@0.0.83'] });
    expect(playwrightMcpServer({ version: '0.0.90', headless: true, config: './agent-once.json', session: 'nightly-checkout' })).toEqual({
      command: 'npx',
      args: ['agent-once', 'mcp', '--config', './agent-once.json', '--session', 'nightly-checkout', '--', 'npx', '@playwright/mcp@0.0.90', '--headless'],
    });
    expect(playwrightMcpServer({ headless: false }).args).toEqual(['agent-once', 'mcp', '--', 'npx', '@playwright/mcp@0.0.83']);
  });

  test('the example Playwright config loads and carries the chaos checkout rules', () => {
    const path = fileURLToPath(new URL('../../../../examples/playwright-mcp/agent-once.config.json', import.meta.url));
    const config = loadConfig({ path, cwd: '/', env: {}, homedir: '/home/example' });
    expect(config.browser).toEqual(chaosTargetsPreset().browser);
    expect(config.tools).toEqual({});
    expect(config.exposeResolveTool).toBe(true);
  });
});
