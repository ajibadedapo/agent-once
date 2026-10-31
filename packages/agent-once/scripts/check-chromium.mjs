import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const mcpPackage = require.resolve('@playwright/mcp/package.json');
const mcpVersion = JSON.parse(readFileSync(mcpPackage, 'utf8')).version;
const corePackage = require.resolve('playwright-core/package.json', { paths: [mcpPackage] });
const browsers = JSON.parse(readFileSync(join(dirname(corePackage), 'browsers.json'), 'utf8')).browsers;
const revision = browsers.find((browser) => browser.name === 'chromium-headless-shell')?.revision;

function defaultBrowsersPath() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'ms-playwright');
  if (process.platform === 'win32') return join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ms-playwright');
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'), 'ms-playwright');
}

const browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH || defaultBrowsersPath();

if (revision === undefined || !existsSync(join(browsersPath, `chromium_headless_shell-${revision}`))) {
  process.stderr.write(
    `npm run test:browser needs Chromium headless shell revision ${revision ?? 'unknown'} (used by @playwright/mcp ${mcpVersion}), which is not in ${browsersPath}.\n` +
      'Install it from the repository root with: npx playwright install chromium\n',
  );
  process.exit(1);
}
