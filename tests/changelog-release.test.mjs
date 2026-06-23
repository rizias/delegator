// The npm `version` hook's changelog promoter (scripts/changelog-release.mjs): on release it must turn
// "## [Unreleased]" into "## [<version>] — <date>" and leave a fresh empty "## [Unreleased]" on top,
// without touching already-released sections. A non-deterministic date is matched by shape, not value.
// The integration tests drive the real `npm version` to prove the promotion lands in the version
// commit, and that an absent CHANGELOG never aborts the release.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const root = path.resolve('.');
const isWin = process.platform === 'win32';

function runPromoter(file, version) {
  execFileSync(process.execPath, ['scripts/changelog-release.mjs'], {
    cwd: root,
    env: { ...process.env, npm_package_version: version, CHANGELOG_FILE: file },
    stdio: 'pipe',
  });
}

// --- unit: the promotion transform, in isolation (CHANGELOG_FILE override → no git touch) ---------

test('promotes [Unreleased] to a dated version section, keeps a fresh [Unreleased]', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-changelog-')), 'CHANGELOG.md');
  fs.writeFileSync(file,
    '# Changelog\n\n## [Unreleased]\n\n### Added\n- a new thing\n\n## [0.3.22] — 2026-06-22\n\n### Fixed\n- old\n',
    'utf8');

  runPromoter(file, '0.3.23');
  const out = fs.readFileSync(file, 'utf8');

  // Fresh empty [Unreleased] on top, then the dated 0.3.23 carrying the former Unreleased content.
  assert.match(out, /## \[Unreleased\]\s+## \[0\.3\.23\] — \d{4}-\d{2}-\d{2}\s+### Added\s+- a new thing/);
  // Exactly one [Unreleased] heading remains.
  assert.equal((out.match(/^## \[Unreleased\]$/gm) || []).length, 1);
  // The previously-released section is untouched.
  assert.match(out, /## \[0\.3\.22\] — 2026-06-22/);
});

test('is a no-op (exit 0, file unchanged) when there is no [Unreleased] section', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-changelog-noop-')), 'CHANGELOG.md');
  fs.writeFileSync(file, '# Changelog\n\n## [0.3.22] — 2026-06-22\n\n### Fixed\n- old\n', 'utf8');
  const before = fs.readFileSync(file, 'utf8');

  runPromoter(file, '0.3.23'); // must not throw
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

// --- integration: the REAL `npm version` contract in a throwaway git repo ------------------------

function initRepo(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q'); // default branch name is irrelevant here; avoids a git >=2.28 (-b) dependency
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('config', 'commit.gpgsign', 'false');
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.copyFileSync(path.join(root, 'scripts/changelog-release.mjs'), path.join(dir, 'scripts/changelog-release.mjs'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(
    { name: 'tmp-changelog-test', version: '0.0.1', private: true,
      scripts: { version: 'node scripts/changelog-release.mjs' } }, null, 2));
  return { dir, git };
}

const npmVersionPatch = (dir) =>
  execFileSync(isWin ? 'npm.cmd' : 'npm', ['version', 'patch'], { cwd: dir, stdio: 'pipe', shell: isWin });

test('npm version includes the promoted CHANGELOG in the version commit', () => {
  const { dir, git } = initRepo('dlg-changelog-int-');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# Changelog\n\n## [Unreleased]\n\n### Added\n- x\n', 'utf8');
  git('add', '.');
  git('commit', '-qm', 'init');

  npmVersionPatch(dir); // 0.0.1 -> 0.0.2, runs the version hook, commits + tags

  // The committed CHANGELOG (not just the working tree) must carry the promotion.
  const committed = execFileSync('git', ['show', 'HEAD:CHANGELOG.md'], { cwd: dir, stdio: 'pipe' }).toString();
  assert.match(committed, /## \[Unreleased\]/);
  assert.match(committed, /## \[0\.0\.2\] — \d{4}-\d{2}-\d{2}\s+### Added\s+- x/);
  // The bump itself happened.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '0.0.2');
});

test('npm version still succeeds when there is no CHANGELOG (release is never broken)', () => {
  const { dir, git } = initRepo('dlg-changelog-nocl-');
  git('add', '.');
  git('commit', '-qm', 'init');

  npmVersionPatch(dir); // must NOT throw even though there is no CHANGELOG.md to git add

  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version, '0.0.2');
});
