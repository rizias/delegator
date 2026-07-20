// Regression: `reapWorktrees()` must clean the workspace-policy heavy dirs (workspace + pristine),
// not only the git worktree. The containment guard added to `removeWorktree` (basename must be
// `worktree`) rejects the workspace/pristine paths, so reaping them must go through the lock-tolerant
// `removeWorkspace` — never an unguarded `fs.rmSync` that a lock could throw straight out of, and
// never following a reparse point (a pnpm/junction link) out of the copy into real source.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-reapws-home-'));

const { createRun, reapWorktrees } = await import('../dist/runstore.js');
const { workspaceDir, pristineDir } = await import('../dist/paths.js');

function git(cwd, ...args) { execFileSync('git', args, { cwd, stdio: 'pipe' }); }

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-reapws-repo-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  return dir;
}

let seq = 0;
function mkMeta(repo, overrides = {}) {
  seq += 1;
  const id = `dlg_reapws${String(seq).padStart(2, '0')}`;
  return {
    id,
    createdAt: new Date(0).toISOString(),
    state: 'done', // terminal so listRuns()'s orphan reaper leaves it alone; reapWorktrees still cleans it
    request: { workerId: 'w', cwd: repo, policy: 'workspace', budget: { wallClockMs: 1 } },
    workerId: 'w', providerId: 'p', runtime: 'api', worktree: '', baseCommit: 'no-git',
    ownerPid: process.pid,
    ...overrides,
  };
}

test('reapWorktrees cleans workspace + pristine and never follows a reparse point into real source', () => {
  const repo = makeRepo();
  // Real source that MUST survive — the target a workspace link points at.
  const realSrc = path.join(repo, 'packages', 'ui');
  fs.mkdirSync(realSrc, { recursive: true });
  const sentinel = path.join(realSrc, 'tokens.css');
  fs.writeFileSync(sentinel, 'body{}\n');

  const meta = mkMeta(repo);
  createRun(meta, 'brief');

  // Materialize the workspace-policy heavy dirs on disk (createRun does not).
  const ws = workspaceDir(repo, meta.id);
  const pr = pristineDir(repo, meta.id);
  fs.mkdirSync(ws, { recursive: true });
  fs.mkdirSync(pr, { recursive: true });
  fs.writeFileSync(path.join(ws, 'file.txt'), 'work\n');
  fs.writeFileSync(path.join(pr, 'file.txt'), 'orig\n');
  // A workspace link pointing OUT to real repo source (the shape teardown must not follow).
  fs.symlinkSync(realSrc, path.join(ws, 'link-to-src'), process.platform === 'win32' ? 'junction' : 'dir');

  const res = reapWorktrees(); // must not throw

  assert.ok(!fs.existsSync(ws), 'workspace dir is removed');
  assert.ok(!fs.existsSync(pr), 'pristine dir is removed');
  assert.ok(fs.existsSync(sentinel), 'real repo source a workspace link pointed at MUST survive');
  assert.ok(res.dropped >= 2, 'both workspace and pristine counted as dropped');
});
