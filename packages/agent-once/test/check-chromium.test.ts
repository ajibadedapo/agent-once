import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';

const SCRIPT = fileURLToPath(new URL('../scripts/check-chromium.mjs', import.meta.url));
const require = createRequire(import.meta.url);
const MCP_PACKAGE = require.resolve('@playwright/mcp/package.json');
const BROWSERS = JSON.parse(readFileSync(join(require.resolve('playwright-core/package.json', { paths: [MCP_PACKAGE] }), '..', 'browsers.json'), 'utf8')) as { browsers: { name: string; revision: string }[] };
const REVISION = BROWSERS.browsers.find((browser) => browser.name === 'chromium-headless-shell')?.revision ?? 'unknown';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function check(browsersPath: string) {
  return spawnSync(process.execPath, [SCRIPT], { env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsersPath }, encoding: 'utf8' });
}

describe('pretest:browser Chromium check', () => {
  test('fails with the install command when the pinned headless shell revision is missing, and passes once it is there', () => {
    const browsersPath = mkdtempSync(join(tmpdir(), 'agent-once-browsers-'));
    dirs.push(browsersPath);
    mkdirSync(join(browsersPath, 'chromium_headless_shell-1000'));
    const missing = check(browsersPath);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toBe(
      `npm run test:browser needs Chromium headless shell revision ${REVISION} (used by @playwright/mcp 0.0.83), which is not in ${browsersPath}.\nInstall it from the repository root with: npx playwright install chromium\n`,
    );
    mkdirSync(join(browsersPath, `chromium_headless_shell-${REVISION}`));
    const present = check(browsersPath);
    expect([present.status, present.stdout, present.stderr]).toEqual([0, '', '']);
  });
});
