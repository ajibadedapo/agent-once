import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { parse } from 'yaml';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = fileURLToPath(new URL('../packages/agent-once/dist/cli/main.js', import.meta.url));
const INPUTS_WITHOUT_FLAG = ['agent-once-version', 'artifact-name'];
const REPOSITORY = 'https://github.com/ajibadedapo/agent-once';
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
  assert.deepEqual(inputs.sort(), ['agent-command', 'agent-once-version', 'artifact-name', 'fail-on-duplicates', 'guard', 'runs', 'scenarios', 'targets']);
  for (const input of inputs.filter((name) => !INPUTS_WITHOUT_FLAG.includes(name))) {
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
  assert.deepEqual(defaults, { scenarios: 'all', targets: 'all', guard: 'on', runs: '3', 'fail-on-duplicates': 'true', 'agent-once-version': 'latest', 'artifact-name': 'agent-once-chaos' });
  for (const step of definition.runs.steps.filter((candidate) => typeof candidate.run === 'string')) {
    assert.doesNotMatch(step.run, /\$\{\{/, `step ${step.name} interpolates an expression into its script`);
  }
  const script = runScripts(definition);
  assert.match(script, /npx --yes "agent-once@\$/);
  assert.match(script, /--markdown "\$GITHUB_STEP_SUMMARY"/);
  assert.match(script, /--json "\$ARTIFACT_NAME\.json"/);
  const upload = definition.runs.steps.find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/upload-artifact@'));
  assert.ok(upload, 'the action must upload the JSON report');
  assert.equal(upload.with.name, '${{ inputs.artifact-name }}');
  assert.equal(upload.with.path, '${{ inputs.artifact-name }}.json');
});

test('package metadata names the source repository for npm provenance and PyPI', () => {
  const manifest = JSON.parse(readFileSync(new URL('../packages/agent-once/package.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.repository, { type: 'git', url: `git+${REPOSITORY}.git`, directory: 'packages/agent-once' });
  assert.equal(manifest.homepage, REPOSITORY);
  assert.deepEqual(manifest.bugs, { url: `${REPOSITORY}/issues` });
  const pyproject = readFileSync(new URL('../python/pyproject.toml', import.meta.url), 'utf8');
  const urls = /\[project\.urls\]\n((?:[^\[\n][^\n]*\n)+)/.exec(pyproject)?.[1] ?? '';
  for (const line of [`Homepage = "${REPOSITORY}"`, `Repository = "${REPOSITORY}"`, `Issues = "${REPOSITORY}/issues"`]) assert.ok(urls.includes(line), `pyproject [project.urls] lacks ${line}`);
});

test('the ts job builds before running tests and releases are gated on main', () => {
  const ci = parse(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.ok(ci.jobs.ts.steps.some((step) => step.run === 'npm run build'), 'the ts job must build explicitly');
  const release = parse(readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  assert.deepEqual(release.jobs['publish-pypi'].needs, ['build', 'publish-npm']);
  for (const [name, job] of Object.entries(release.jobs)) {
    for (const step of job.steps.filter((candidate) => typeof candidate.uses === 'string' && candidate.uses.startsWith('actions/setup-node@'))) {
      assert.equal(step.with?.cache, undefined, `release job ${name} must not restore an npm cache`);
    }
  }
  const build = release.jobs.build.steps;
  assert.equal(build[0].with['fetch-depth'], 0);
  assert.ok(build.some((step) => typeof step.run === 'string' && step.run.includes('git merge-base --is-ancestor "$GITHUB_SHA" origin/main')), 'the build job must check the tag commit is on main');
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
