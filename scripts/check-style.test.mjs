import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findCommentViolations, findEmDashViolations } from './check-style.mjs';

const EM_DASH = '\u2014';
const scriptPath = fileURLToPath(new URL('./check-style.mjs', import.meta.url));

test('flags a line comment in a ts file', () => {
  const source = 'const a = 1;\nconst b = 2; // explain b\n';
  assert.deepEqual(findCommentViolations('src/a.ts', source), [
    { path: 'src/a.ts', line: 2, message: 'comment is not allowed' },
  ]);
});

test('flags a block comment', () => {
  const source = 'const a = 1;\n\n/**\n * docs\n */\nexport function f() {}\n';
  assert.deepEqual(findCommentViolations('src/b.mts', source), [
    { path: 'src/b.mts', line: 3, message: 'comment is not allowed' },
  ]);
});

test('flags an em dash in markdown', () => {
  const source = `# Title\n\nFirst line.\nSecond ${EM_DASH} line.\n`;
  assert.deepEqual(findEmDashViolations('docs/x.md', source), [
    { path: 'docs/x.md', line: 4, message: 'em dash (U+2014) is not allowed' },
  ]);
});

test('ignores comment-like text inside string literals', () => {
  const source = [
    "const url = 'https://example.com/a';",
    'const block = "/* not a comment */";',
    'const tpl = `// still text ${url} /* and this */ ${`//nested`}`;',
    'const re = /\\/\\/ not a comment/g;',
    'const ratio = 4 / 2 / 1;',
    '',
  ].join('\n');
  assert.deepEqual(findCommentViolations('src/c.js', source), []);
});

test('allows a shebang on line 1', () => {
  const source = '#!/usr/bin/env node\nconsole.log(1);\n';
  assert.deepEqual(findCommentViolations('bin/cli.mjs', source), []);
});

test('flags a comment after a template literal with a substitution', () => {
  const source = 'const a = `x${1}y`; // trailing\n';
  assert.deepEqual(findCommentViolations('src/d.ts', source), [
    { path: 'src/d.ts', line: 1, message: 'comment is not allowed' },
  ]);
});

test('flags a comment after a non-null assertion followed by division', () => {
  const source = 'const avg = sum! / n; // note\n';
  assert.deepEqual(findCommentViolations('src/e.ts', source), [
    { path: 'src/e.ts', line: 1, message: 'comment is not allowed' },
  ]);
});

test('treats a slash after a prefix not or await as a regex', () => {
  const source = 'const a = !/\\/\\//.test(s);\nconst b = await /\\/\\//.exec(s);\n';
  assert.deepEqual(findCommentViolations('src/f.ts', source), []);
});

test('the command exits 1 and prints path:line: message for each violation', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-once-style-'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'bad.ts'), 'export const a = 1;\n// nope\n');
  writeFileSync(join(root, 'README.md'), `ok\nnot ${EM_DASH} ok\n`);
  writeFileSync(join(root, 'good.ts'), 'export const b = "// fine";\n');
  spawnSync('git', ['init', '-q'], { cwd: root });
  const result = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 1);
  const lines = result.stdout.trim().split('\n').sort();
  assert.deepEqual(lines, [
    'README.md:2: em dash (U+2014) is not allowed',
    'src/bad.ts:2: comment is not allowed',
  ]);
});

test('the command exits 0 on a clean tree', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-once-style-'));
  writeFileSync(join(root, 'good.ts'), 'export const b = "// fine";\n');
  writeFileSync(join(root, 'notes.md'), 'plain - text\n');
  spawnSync('git', ['init', '-q'], { cwd: root });
  const result = spawnSync(process.execPath, [scriptPath], { cwd: root, encoding: 'utf8' });
  assert.equal(result.stdout, '');
  assert.equal(result.status, 0);
});

test('treats a bang after a closing brace or literal as a prefix not', () => {
  const source = 'if (a) {\n}\n!/\\/\\//.test(s);\nconst c = 1 + !/\\/\\//.test(s);\n';
  assert.deepEqual(findCommentViolations('src/g.ts', source), []);
});
