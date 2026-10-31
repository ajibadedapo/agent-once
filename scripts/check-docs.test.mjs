import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { absoluteLinks } from '../packages/agent-once/scripts/prepack.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIRST_LINE = 'Stop your AI agent from charging, booking or sending twice.';
const FORBIDDEN_NAMES = [['spec', 'vista'], ['thank', 'yu']].map((parts) => parts.join(''));
const TOP_LEVEL_DOCS = ['README.md', 'SECURITY.md', 'CONTRIBUTING.md', 'CODE_OF_CONDUCT.md', 'CHANGELOG.md', 'python/README.md'];
const SKIPPED_DOC_DIRS = new Set(['plans']);
const FENCE = /^```([^\n`]*)\n([\s\S]*?)^```[ \t]*$/gm;
const INLINE_LINK = /!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const REFERENCE_LINK = /^\s*\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+"[^"]*")?\s*$/gm;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const TS_LANGS = new Set(['ts', 'typescript']);
const BLOB = 'https://github.com/ajibadedapo/agent-once/blob/main/';

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8');
}

function markdownUnder(dir) {
  return readdirSync(join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return SKIPPED_DOC_DIRS.has(entry.name) ? [] : markdownUnder(path);
    return entry.name.endsWith('.md') ? [path] : [];
  });
}

function docFiles() {
  return [...TOP_LEVEL_DOCS, ...markdownUnder('docs')];
}

function withoutFences(text) {
  return text.replace(FENCE, '');
}

function relativeTargets(text) {
  const prose = withoutFences(text).replace(/`[^`\n]*`/g, '');
  const targets = [...prose.matchAll(INLINE_LINK), ...prose.matchAll(REFERENCE_LINK)].map((match) => match[1]);
  return targets.filter((target) => !SCHEME.test(target) && !target.startsWith('#'));
}

function codeBlocks(text, langs) {
  return [...text.matchAll(FENCE)].filter((match) => langs.has(match[1].trim().split(/\s+/)[0])).map((match) => match[2]);
}

function p50Figures(text) {
  return [...text.matchAll(/\b(core|proxy|Python) p50 (\d+\.\d+) ms/g)].map((match) => `${match[1]} p50 ${match[2]} ms`);
}

function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}\n`);
  if (start === -1) return undefined;
  const next = text.indexOf('\n## ', start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

function candidateFiles() {
  const listed = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' });
  return [...new Set(listed.split('\0').filter((path) => path !== ''))].filter((path) => existsSync(join(ROOT, path)) && statSync(join(ROOT, path)).isFile());
}

test('README line 1 is exactly the agreed sentence', () => {
  assert.equal(read('README.md').split('\n')[0], FIRST_LINE);
});

test('every relative link in README and docs resolves to a file', () => {
  const broken = [];
  const files = docFiles();
  assert.ok(files.length > TOP_LEVEL_DOCS.length, 'expected guides under docs/');
  for (const file of files) {
    for (const target of relativeTargets(read(file))) {
      const path = decodeURIComponent(target.split('#')[0].split('?')[0]);
      if (path === '') continue;
      if (!existsSync(resolve(ROOT, dirname(file), path))) broken.push(`${file}: ${target}`);
    }
  }
  assert.deepEqual(broken, []);
});

test('every code block tagged ts in docs typechecks', () => {
  const blocks = docFiles().flatMap((file) =>
    codeBlocks(read(file), TS_LANGS).map((code, index) => ({ name: `${file.replace(/[^A-Za-z0-9]+/g, '-')}-${index + 1}.ts`, code })),
  );
  assert.ok(blocks.length > 0, 'expected at least one ts code block in the docs');
  assert.ok(existsSync(join(ROOT, 'packages/agent-once/dist/index.d.ts')), 'build the package first: npm run build');
  const dir = mkdtempSync(join(ROOT, '.check-docs-'));
  try {
    writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ type: 'module', private: true })}\n`);
    const base = relative(dir, join(ROOT, 'tsconfig.base.json'));
    const compilerOptions = { noEmit: true, declaration: false, declarationMap: false, sourceMap: false };
    writeFileSync(join(dir, 'tsconfig.json'), `${JSON.stringify({ extends: base, compilerOptions, include: ['*.ts'] }, null, 2)}\n`);
    for (const block of blocks) writeFileSync(join(dir, block.name), `${block.code}\nexport {};\n`);
    const tsc = join(ROOT, 'node_modules/typescript/bin/tsc');
    const result = spawnSync(process.execPath, [tsc, '-p', join(dir, 'tsconfig.json')], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(result.status, 0, `ts blocks in the docs do not typecheck:\n${result.stdout}${result.stderr}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('README overhead figure equals the one in RESULTS.md', () => {
  const measured = p50Figures(read('RESULTS.md').split('\n').find((line) => line.startsWith('Target: p50')) ?? '');
  assert.ok(measured.length > 0, 'RESULTS.md has no p50 overhead figures');
  const quoted = p50Figures(read('README.md'));
  for (const figure of measured.slice(0, 2)) assert.ok(quoted.includes(figure), `README does not quote ${figure} from RESULTS.md`);
  for (const figure of quoted) assert.ok(measured.includes(figure), `README quotes ${figure}, which RESULTS.md does not contain`);
});

test('README results rows are copied verbatim from RESULTS.md', () => {
  const results = read('RESULTS.md');
  const excerpt = section(read('README.md'), 'Results');
  assert.ok(excerpt !== undefined, 'README has no Results section');
  const rows = excerpt.split('\n').filter((line) => line.startsWith('| ') && !line.startsWith('| Agent |'));
  assert.ok(rows.length > 0, 'README Results section has no rows from RESULTS.md');
  for (const row of rows) assert.ok(results.includes(`${row}\n`), `README row is not in RESULTS.md: ${row}`);
  const totals = excerpt.split('\n').filter((line) => line.startsWith('Totals: '));
  for (const line of totals) assert.ok(results.includes(line), `README totals line is not in RESULTS.md: ${line}`);
});

test('the packed README links to the repository instead of relative paths', () => {
  const packed = absoluteLinks(read('README.md'));
  assert.deepEqual(relativeTargets(packed), []);
  const linked = [...withoutFences(packed).matchAll(INLINE_LINK)].map((match) => match[1]).filter((target) => target.startsWith(BLOB));
  assert.ok(linked.length > 0, 'expected repository links in the packed README');
  for (const target of linked) assert.ok(existsSync(join(ROOT, target.slice(BLOB.length).split('#')[0])), `packed README links to a missing file: ${target}`);
  assert.equal(packed.split('\n')[0], FIRST_LINE);
});

test('the Python distribution ships the same licence as the repository', () => {
  assert.equal(read('python/LICENSE'), read('LICENSE'));
});

test('no company or employer names anywhere in tracked files', () => {
  const hits = [];
  for (const path of candidateFiles()) {
    const bytes = readFileSync(join(ROOT, path));
    if (bytes.includes(0)) continue;
    const text = bytes.toString('utf8').toLowerCase();
    for (const name of FORBIDDEN_NAMES) if (text.includes(name)) hits.push(`${path}: ${name}`);
  }
  assert.deepEqual(hits, []);
});
