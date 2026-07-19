// Regression (DLG-APPLY data-loss): `dlg apply` → removeWorktree must NEVER follow a reparse point
// (junction / symlink) out of the worktree. After a worker runs `pnpm install`, worktree/node_modules
// becomes a REAL directory full of workspace symlinks that point at REAL source (packages/*). On
// git-for-Windows, `git worktree remove --force` walks those links and DELETES the target files in
// the MAIN repo — hundreds of real sources gone, working-tree only (index intact). unlinkNodeModules
// only scrubbed the single ROOT node_modules and only if it was still a symlink, so it missed this.
// Teardown must scrub EVERY reparse point (never recursing into one) before removing the tree, and
// must refuse any path that is not a delegator worktree.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-wt-scrub-home-'));
process.env.DELEGATOR_HOME = home;
const { createWorktree, removeWorktree } = await import('../dist/worktree.js');

function git(cwd, ...args) { execFileSync('git', args, { cwd, stdio: 'pipe' }); }

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-wt-scrub-repo-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  return dir;
}

const adminEntries = (repo) => {
  const admin = path.join(repo, '.git', 'worktrees');
  return fs.existsSync(admin) ? fs.readdirSync(admin).length : 0;
};

// The exact incident shape: a directory reparse point INSIDE a materialized node_modules, targeting
// real source in the main repo. Teardown must not follow it — and must still prune git admin state.
test('removeWorktree never follows a nested directory junction into the real repo (pnpm workspace link)', () => {
  const repo = makeRepo();
  // Real source that MUST survive — stands in for packages/ui / README / tokens.css.
  const realSrc = path.join(repo, 'packages', 'ui');
  fs.mkdirSync(realSrc, { recursive: true });
  const sentinel = path.join(realSrc, 'tokens.css');
  fs.writeFileSync(sentinel, 'body{}\n');

  const { dir } = createWorktree(repo, 'dlg_scrub');

  // Simulate the post-`pnpm install` shape: worktree/node_modules is a REAL directory (not our
  // junction) holding a workspace link to the REAL source in main. unlinkNodeModules skipped a real
  // dir, so without a full reparse-point scrub `git worktree remove --force` walks this link into main.
  const nm = path.join(dir, 'node_modules');
  fs.rmSync(nm, { recursive: true, force: true }); // drop our junction if createWorktree made one
  fs.mkdirSync(path.join(nm, '@x'), { recursive: true });
  fs.symlinkSync(realSrc, path.join(nm, '@x', 'ui'), process.platform === 'win32' ? 'junction' : 'dir');

  removeWorktree(repo, dir);

  assert.ok(fs.existsSync(sentinel), 'real repo source MUST survive worktree teardown');
  assert.ok(!fs.existsSync(dir), 'worktree dir is gone');
  assert.equal(adminEntries(repo), 0, 'git worktree admin entry is pruned');
});

// A FILE symlink pointing at a real file outside the worktree must not be followed either. File
// symlinks need privilege / Developer Mode on Windows, so skip gracefully where we cannot create one.
test('removeWorktree never follows a FILE symlink pointing outside the worktree', (t) => {
  const repo = makeRepo();
  const realFile = path.join(repo, 'packages', 'ui', 'tokens.css');
  fs.mkdirSync(path.dirname(realFile), { recursive: true });
  fs.writeFileSync(realFile, 'body{}\n');

  const { dir } = createWorktree(repo, 'dlg_filelink');
  const link = path.join(dir, 'evil-link.css');
  try {
    fs.symlinkSync(realFile, link, 'file');
  } catch {
    t.skip('cannot create a file symlink on this host (no privilege / Developer Mode off)');
    return;
  }

  removeWorktree(repo, dir);

  assert.ok(fs.existsSync(realFile), 'the real file a worktree symlink pointed at MUST survive teardown');
  assert.ok(!fs.existsSync(dir), 'worktree dir is gone');
});

// Fail-closed containment: teardown must refuse any path that is not a delegator worktree, so a
// mis-passed argument can never turn the recursive delete loose on a real tree.
test('removeWorktree refuses a path that is not a delegator worktree', () => {
  const repo = makeRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-not-a-worktree-'));
  const sentinel = path.join(outside, 'keep.txt');
  fs.writeFileSync(sentinel, 'keep\n');

  assert.throws(() => removeWorktree(repo, outside), /not a delegator worktree/);
  assert.ok(fs.existsSync(sentinel), 'a non-worktree path is left completely untouched');

  fs.rmSync(outside, { recursive: true, force: true });
});
