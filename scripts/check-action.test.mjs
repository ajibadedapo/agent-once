import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse } from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = fileURLToPath(new URL('../packages/agent-once/dist/cli/main.js', import.meta.url));
const VERSION_INPUT = 'agent-once-version';
const FLAG_FOR_INPUT = { 'agent-command': '--agent' };

function action() {
  return parse(readFileSync(new URL('../action.yml', import.meta.url), 'utf8'));
}

function runHelpFlags() {
  const result = spawnSync(process.execPath, [CLI, 'chaos', 'run', '--help'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(result.status, 0, `chaos run --help failed: ${result.stderr}`);
  const runLine = result.stdout.split(/ \| |\n/).find((line) => line.includes('chaos run'));
  assert.ok(runLine, `no chaos run usage in ${result.stdout}`);
  return new Set(runLine.match(/--[a-z][a-z-]*/g));
}

function runScripts(definition) {
  return definition.runs.steps.filter((step) => typeof step.run === 'string').map((step) => step.run).join('\n');
}

test('action.yml inputs match the chaos run flags', () => {
  const definition = action();
  const flags = runHelpFlags();
  const script = runScripts(definition);
  const inputs = Object.keys(definition.inputs);
  assert.deepEqual(inputs.sort(), ['agent-command', 'agent-once-version', 'fail-on-duplicates', 'guard', 'runs', 'scenarios', 'targets']);
  for (const input of inputs.filter((name) => name !== VERSION_INPUT)) {
    const flag = FLAG_FOR_INPUT[input] ?? `--${input}`;
    assert.ok(flags.has(flag), `input ${input} maps to ${flag}, which chaos run --help does not list`);
    assert.ok(script.includes(flag), `the action never passes ${flag} for input ${input}`);
  }
  for (const flag of ['--json', '--markdown']) assert.ok(flags.has(flag) && script.includes(flag), `the action must pass ${flag}`);
});

test('action.yml declares the documented defaults and keeps inputs out of the shell source', () => {
  const definition = action();
  assert.equal(definition.runs.using, 'composite');
  assert.equal(definition.inputs['agent-command'].required, true);
  const defaults = Object.fromEntries(Object.entries(definition.inputs).filter(([, spec]) => 'default' in spec).map(([name, spec]) => [name, spec.default]));
  assert.deepEqual(defaults, { scenarios: 'all', targets: 'all', guard: 'on', runs: '3', 'fail-on-duplicates': 'true', 'agent-once-version': 'latest' });
  for (const step of definition.runs.steps.filter((candidate) => typeof candidate.run === 'string')) {
    assert.doesNotMatch(step.run, /\$\{\{/, `step ${step.name} interpolates an expression into its script`);
  }
  const script = runScripts(definition);
  assert.match(script, /npx --yes "agent-once@\$/);
  assert.match(script, /--markdown "\$GITHUB_STEP_SUMMARY"/);
  assert.match(script, /--json agent-once-chaos\.json/);
  const upload = definition.runs.steps.find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/upload-artifact@'));
  assert.ok(upload, 'the action must upload the JSON report');
  assert.equal(upload.with.path, 'agent-once-chaos.json');
});

test('every third-party action in the repository is pinned to a full commit SHA', () => {
  const files = ['action.yml', '.github/workflows/ci.yml', '.github/workflows/release.yml'];
  for (const file of files) {
    const text = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    const uses = [...text.matchAll(/uses:\s*(\S+)/g)].map((match) => match[1]);
    assert.ok(uses.length > 0, `${file} uses no actions`);
    for (const reference of uses) {
      if (reference.startsWith('./')) continue;
      assert.match(reference, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${file} uses ${reference} without a full SHA pin`);
    }
  }
});
