import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../../../', import.meta.url);
const PACKAGE = new URL('../', import.meta.url);
const BLOB = 'https://github.com/ajibadedapo/agent-once/blob/main/';
const RELATIVE_LINK = /(\]\()(?![a-z][a-z0-9+.-]*:|#)([^)\s]+)/gi;

export function absoluteLinks(markdown) {
  return markdown.replace(RELATIVE_LINK, (_match, open, target) => `${open}${BLOB}${target.replace(/^\.\//, '')}`);
}

export function prepack() {
  const readme = readFileSync(new URL('README.md', ROOT), 'utf8');
  writeFileSync(new URL('README.md', PACKAGE), absoluteLinks(readme));
  copyFileSync(new URL('LICENSE', ROOT), new URL('LICENSE', PACKAGE));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) prepack();
