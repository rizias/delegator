// Frozen-judge policy (verification-model.md §3). Verification runs inside the
// worker's own worktree, so a patch that edits the files that JUDGE it (tests, test/CI
// config, snapshot/fixture oracles) cannot be trusted as a clean pass — the runner
// forces such a run to `requires-review`. This locks the glob policy that classifies a
// "judge file": which paths count, and — just as important — which deliberately do NOT.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-test-'));
const { touchesSensitive, DEFAULT_JUDGE_GLOBS } = await import('../dist/runner.js');

const isJudge = (file) => touchesSensitive([file], DEFAULT_JUDGE_GLOBS);

test('test sources are judge files (root and nested)', () => {
  for (const f of [
    'foo.test.ts', 'src/foo.test.ts', 'a/b/bar.spec.js',
    'pkg/widget_test.go', 'test_thing.py', 'tests/sensitive-paths.test.mjs',
    'src/__tests__/x.ts', 'spec/models/user.rb',
  ]) {
    assert.equal(isJudge(f), f, `${f} should be a judge file`);
  }
});

test('test/CI runner config is a judge file', () => {
  for (const f of [
    'jest.config.js', 'vitest.config.ts', 'playwright.config.ts', '.mocharc.json',
    'pytest.ini', 'tox.ini', 'conftest.py',
    '.github/workflows/ci.yml', 'pkg/.github/workflows/ci.yml',
    '.gitlab-ci.yml', 'Jenkinsfile',
  ]) {
    assert.equal(isJudge(f), f, `${f} should be a judge file`);
  }
});

test('snapshot/fixture oracles are judge files', () => {
  for (const f of [
    'src/__snapshots__/App.test.js.snap', 'component.snap',
    'fixtures/data.json', 'test/fixtures/in.txt', 'testdata/golden.bin',
  ]) {
    assert.equal(isJudge(f), f, `${f} should be a judge file`);
  }
});

test('ordinary source and docs are NOT judge files', () => {
  for (const f of ['src/index.ts', 'src/runner.ts', 'lib/util.js', 'README.md', 'docs/x.md']) {
    assert.equal(isJudge(f), null, `${f} must not be flagged as a judge file`);
  }
});

test('package manifests + lockfiles ARE judged (build/test scripts + dependency oracle)', () => {
  // A worker that rewrites `package.json` "test" to a no-op or swaps a dependency redefines what
  // "passing" means just like editing a test — so touching one forces requires-review. It is only
  // FLAGGED, not reset, so a legitimate dependency/script change still verifies.
  for (const f of ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'requirements.txt', 'Cargo.toml', 'go.mod', 'Gemfile.lock', 'pom.xml', 'Makefile']) {
    assert.equal(isJudge(f), f, `${f} must be flagged as a judge file`);
  }
});

test('backslash (Windows) judge paths are detected', () => {
  assert.equal(isJudge('src\\foo.test.ts'), 'src\\foo.test.ts');
  assert.equal(isJudge('.github\\workflows\\ci.yml'), '.github\\workflows\\ci.yml');
});
