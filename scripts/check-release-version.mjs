import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const [tag, rootArgument] = process.argv.slice(2);
const root = resolve(rootArgument ?? fileURLToPath(new URL('..', import.meta.url)));

function read(relative) {
  return readFileSync(join(root, relative), 'utf8');
}

function pyprojectVersion(text) {
  const section = /^\[project\]\n([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(text)?.[1] ?? '';
  return /^version\s*=\s*"([^"]+)"/m.exec(section)?.[1];
}

const sources = [
  ['packages/agent-once/package.json', (text) => JSON.parse(text).version],
  ['python/pyproject.toml', pyprojectVersion],
  ['python/src/agent_once/__init__.py', (text) => /^__version__\s*=\s*"([^"]+)"/m.exec(text)?.[1]],
];

if (tag === undefined || tag === '') {
  console.log('::error::usage: node scripts/check-release-version.mjs <tag> [root]');
  process.exit(2);
}

const mismatches = sources
  .map(([file, versionOf]) => [file, versionOf(read(file))])
  .filter(([, version]) => tag !== `v${version}`)
  .map(([file, version]) => `${file} has ${version ?? 'no version'}`);

if (mismatches.length > 0) {
  console.log(`::error::tag ${tag} does not match: ${mismatches.join(', ')}`);
  process.exit(1);
}
console.log(`tag ${tag} matches ${sources.map(([file]) => file).join(', ')}`);
