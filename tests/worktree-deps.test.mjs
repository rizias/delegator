// Verify can only run if the worktree has the project's deps — node_modules is gitignored, so a
// `git worktree` lacks it. createWorktree links it in; removeWorktree must remove ONLY the link,
// never the real node_modules (Windows junction footgun).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-wt-deps-home-'));
process.env.DELEGATOR_HOME = home;
const { createWorktree, removeWorktree } = await import('../dist/worktree.js');

function git(cwd, ...args) { execFileSync('git', args, { cwd, stdio: 'pipe' }); }

function makeRepo() {
  // realpathSync canonicalizes the temp path so it matches what `git worktree list` prints. On macOS
  // os.tmpdir() is /var/... but /var is a symlink to /private/var, which git resolves — without this
  // the deep-equal against git's output fails on macOS only. No-op on Linux/Windows.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-wt-deps-repo-')));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  return dir;
}

test('worktree links node_modules in, and removing it NEVER deletes the real node_modules', () => {
  const repo = makeRepo();
  const sentinel = path.join(repo, 'node_modules', 'pkg', 'index.js');
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, 'module.exports = 1;\n');

  const { dir } = createWorktree(repo, 'dlg_depslink');
  // deps are visible inside the worktree, so a verify command (npm test, tsc, ...) can resolve them
  assert.ok(fs.existsSync(path.join(dir, 'node_modules', 'pkg', 'index.js')), 'deps visible in worktree');

  removeWorktree(repo, dir);
  // CRITICAL: tearing down the worktree must leave the real node_modules untouched
  assert.ok(fs.existsSync(sentinel), 'the real node_modules survives worktree removal');
  assert.ok(!fs.existsSync(dir), 'worktree dir is gone');
});

test('a RELATIVE repo path (dlg run --cwd .) still links the real node_modules, not a self-loop', () => {
  const repo = makeRepo();
  const sentinel = path.join(repo, 'node_modules', 'pkg', 'index.js');
  fs.mkdirSync(path.dirname(sentinel), { recursive: true });
  fs.writeFileSync(sentinel, 'module.exports = 1;\n');

  // Reproduce `dlg run --cwd .`: cwd = the repo, repo passed as ".". A junction with a relative
  // target would resolve to the worktree itself — this guards that regression.
  const prev = process.cwd();
  process.chdir(repo);
  try {
    const { dir } = createWorktree('.', 'dlg_relrepo');
    assert.ok(fs.existsSync(path.join(dir, 'node_modules', 'pkg', 'index.js')),
      'a relative repo must link the REAL node_modules (not point the link at itself)');
    removeWorktree('.', dir);
    assert.ok(fs.existsSync(sentinel), 'real node_modules survives');
  } finally {
    process.chdir(prev);
  }
});

test('parallel worktree add/remove leaves only the main tree registered', async () => {
  const repo = makeRepo();
  const created = await Promise.all(
    Array.from({ length: 4 }, (_, i) => Promise.resolve().then(() => createWorktree(repo, `dlg_parallel_${i}`))),
  );

  await Promise.all(created.map(({ dir }) => Promise.resolve().then(() => removeWorktree(repo, dir))));

  const list = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: repo, encoding: 'utf8' });
  const worktrees = list
    .split(/\r?\n/)
    .filter((line) => line.startsWith('worktree '))
    .map((line) => line.replace(/\\/g, '/'));
  assert.deepEqual(worktrees, [`worktree ${repo.replace(/\\/g, '/')}`]);
  const adminDir = path.join(repo, '.git', 'worktrees');
  assert.equal(fs.existsSync(adminDir) ? fs.readdirSync(adminDir).length : 0, 0);
});
