// Sensitive-path glob matching (security). Regression for the bug where
// `globToRegex` required a leading slash, so a `**/<file>` pattern matched only
// NESTED files and silently let a ROOT-level sensitive file through the guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Some transitively-imported modules read DELEGATOR_HOME at load; point it at a temp dir.
process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-test-'));
const { touchesSensitive } = await import('../dist/runner.js');

test('**/<file> matches the file at the repo ROOT, not only nested', () => {
  // The regression: a root package.json previously slipped past the guard.
  assert.equal(touchesSensitive(['package.json'], ['**/package.json']), 'package.json');
  assert.equal(touchesSensitive(['sub/package.json'], ['**/package.json']), 'sub/package.json');
  assert.equal(touchesSensitive(['a/b/package.json'], ['**/package.json']), 'a/b/package.json');
});

test('**/<dir>/** matches workflow files at root and nested', () => {
  assert.equal(touchesSensitive(['.github/workflows/ci.yml'], ['**/.github/workflows/**']), '.github/workflows/ci.yml');
  assert.equal(touchesSensitive(['pkg/.github/workflows/ci.yml'], ['**/.github/workflows/**']), 'pkg/.github/workflows/ci.yml');
});

test('lockfile pattern matches at root', () => {
  assert.equal(touchesSensitive(['package-lock.json'], ['**/*.lock', '**/package-lock.json']), 'package-lock.json');
});

test('non-matching files return null', () => {
  assert.equal(touchesSensitive(['src/index.ts'], ['**/package.json']), null);
  assert.equal(touchesSensitive(['readme.md'], ['**/.github/workflows/**']), null);
});

test('backslash (Windows) paths are normalized before matching', () => {
  assert.equal(touchesSensitive(['sub\\package.json'], ['**/package.json']), 'sub\\package.json');
});
