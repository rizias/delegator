import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, pristineDir, tailOf, workspaceDir, worktreeDir } from './paths.js';

function runGit(args: string[], cwd: string): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = result.stderr ?? '';
    throw new Error(`git ${args[0]} failed: ${tailOf(stderr, 500)}`);
  }
  return result.stdout ?? '';
}

function runGitNoIndex(args: string[], cwd: string): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && result.status !== 1) {
    const stderr = result.stderr ?? '';
    throw new Error(`git ${args[0]} failed: ${tailOf(stderr, 500)}`);
  }
  return result.stdout ?? '';
}

// Concurrency note for `git worktree` ADMIN commands (add/remove/prune) under council fan-out:
// `runGit` is execFileSync — fully synchronous — so two in-process callers can never interleave
// one of these commands; cross-process safety rests on git's own .git/worktrees locking. A JS-level
// mutex here would be dead code (a Promise chain cannot gate a synchronous section anyway).

export function assertGitRepo(cwd: string): void {
  try {
    runGit(['rev-parse', '--is-inside-work-tree'], cwd);
  } catch {
    throw new Error(
      'delegator requires a git repository (run git init)',
    );
  }
}

export function currentCommit(cwd: string): string {
  try {
    return runGit(['rev-parse', 'HEAD'], cwd).trim();
  } catch (e) {
    throw new Error(
      'repository has no commits yet; make an initial commit first',
    );
  }
}

export function createWorktree(
  repo: string,
  runId: string,
): { dir: string; baseCommit: string } {
  const dir = worktreeDir(repo, runId);
  ensureDir(path.dirname(dir));
  runGit(['worktree', 'add', '--detach', dir, 'HEAD'], repo);
  linkNodeModules(repo, dir);
  const baseCommit = currentCommit(repo);
  return { dir, baseCommit };
}

/** Make the repo's installed deps available in a fresh worktree so verify commands (`npm test`,
 *  etc.) can actually run there. `node_modules` is gitignored → absent from a `git worktree`; we
 *  LINK (junction on Windows, symlink on POSIX) the main repo's copy. The link is removed before
 *  the worktree is deleted (unlinkNodeModules) so cleanup can never touch the real node_modules.
 *  Best-effort: if linking fails, verify may skip/fail — it must never crash run setup. */
function linkNodeModules(repo: string, worktree: string): void {
  try {
    // MUST be absolute: a junction with a relative target is resolved relative to the LINK's own
    // directory (the worktree), which would make node_modules point at itself. (repo can arrive as
    // ".", e.g. `dlg run --cwd .`.)
    const src = path.resolve(repo, 'node_modules');
    const dest = path.resolve(worktree, 'node_modules');
    if (!fs.existsSync(src) || fs.existsSync(dest)) return;
    fs.symlinkSync(src, dest, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    // best-effort
  }
}

/** Remove ONLY the node_modules link we created (never its target). A Windows junction is a
 *  directory reparse point removed via rmdir; a POSIX symlink via unlink — neither deletes the
 *  real node_modules. A real directory (a worker that installed its own deps) is left for the
 *  normal worktree removal. */
function unlinkNodeModules(worktree: string): void {
  const dest = path.join(worktree, 'node_modules');
  try {
    const st = fs.lstatSync(dest); // lstat — never follow the link
    if (!st.isSymbolicLink()) return; // a real dir (or absent) — not our link
    if (process.platform === 'win32') {
      try { fs.rmdirSync(dest); } catch { fs.unlinkSync(dest); }
    } else {
      fs.unlinkSync(dest);
    }
  } catch {
    // absent, or removal failed — better to leave a stray link than risk the real node_modules
  }
}

export function diffHash(wt: string): string {
  try {
    const status = runGit(['status', '--porcelain'], wt);
    const unstaged = runGit(['diff'], wt);
    const staged = runGit(['diff', '--cached'], wt); // staged edits are invisible to plain `git diff`
    const h = createHash('sha1')
      .update(status).update('\0')
      .update(unstaged).update('\0')
      .update(staged);
    // `status --porcelain` lists untracked files by NAME only — a worker editing an untracked
    // file's content (same name) would otherwise look idle and trip a false no-progress kill.
    // Fold in each untracked file's size+mtime (cheap, no full read) so edits register.
    const others = runGit(['ls-files', '--others', '--exclude-standard', '-z'], wt).split('\0').filter(Boolean);
    for (const f of others) {
      try {
        const st = fs.statSync(path.join(wt, f));
        h.update('\0').update(f).update(':').update(String(st.size)).update(':').update(String(Math.round(st.mtimeMs)));
      } catch {
        h.update('\0').update(f);
      }
    }
    return h.digest('hex');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `err:${msg}`;
  }
}

export function extractPatch(wt: string): {
  patch: string;
  diffStat: string;
  filesTouched: string[];
} {
  runGit(['add', '-A'], wt);
  const patch = runGit(['diff', '--cached', '--binary', 'HEAD'], wt);
  const rawStat = runGit(['diff', '--cached', '--stat', 'HEAD'], wt);
  const statLines = rawStat
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  const diffStat = statLines.length > 0
    ? statLines[statLines.length - 1]!.trim()
    : '';
  const nameOnly = runGit(['diff', '--cached', '--name-only', 'HEAD'], wt);
  const filesTouched = nameOnly
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  return { patch, diffStat, filesTouched };
}

export function removeWorktree(repo: string, dir: string): void {
  unlinkNodeModules(dir); // remove our deps link FIRST so neither git nor rmSync can follow it
  try {
    runGit(['worktree', 'remove', '--force', dir], repo);
  } catch {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    try {
      runGit(['worktree', 'prune'], repo);
    } catch {
      // ignore prune failures
    }
  }
}

/** Clear stale admin entries in <repo>/.git/worktrees left by manually-deleted worktrees. */
export function pruneWorktreeAdmin(repo: string): void {
  try {
    runGit(['worktree', 'prune'], repo);
  } catch {
    // best-effort — never fail cleanup over a prune
  }
}

function shouldCopyEntry(src: string, root: string): boolean {
  if (path.resolve(src) === root) return true;
  const name = path.basename(src);
  return name !== '.git' && name !== 'node_modules' && name !== '.delegator';
}

function copyWorkspaceTree(src: string, dest: string): void {
  const root = path.resolve(src);
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (entry) => shouldCopyEntry(entry, root),
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalizeDiffPath(p: string): string {
  return p.replace(/\\/g, '/');
}

function rewriteWorkspacePatchPaths(patch: string, pristine: string, workspace: string): string {
  const pristineName = normalizeDiffPath(path.basename(pristine));
  const workspaceName = normalizeDiffPath(path.basename(workspace));
  const pristineAbs = normalizeDiffPath(path.resolve(pristine));
  const workspaceAbs = normalizeDiffPath(path.resolve(workspace));
  const tokenPrefixes: Array<[string, string]> = [
    [`a/${pristineAbs}/`, 'a/'],
    [`a/${workspaceAbs}/`, 'a/'],
    [`b/${pristineAbs}/`, 'b/'],
    [`b/${workspaceAbs}/`, 'b/'],
    [`${pristineAbs}/`, ''],
    [`${workspaceAbs}/`, ''],
    [`a/${pristineName}/`, 'a/'],
    [`a/${workspaceName}/`, 'a/'],
    [`b/${pristineName}/`, 'b/'],
    [`b/${workspaceName}/`, 'b/'],
    [`${pristineName}/`, ''],
    [`${workspaceName}/`, ''],
  ];
  const rewriteToken = (token: string): string => {
    const normalized = normalizeDiffPath(token);
    for (const [from, to] of tokenPrefixes) {
      if (normalized.startsWith(from)) return to + normalized.slice(from.length);
    }
    return normalized;
  };
  const rewriteBinaryLine = (line: string): string => {
    let rewritten = normalizeDiffPath(line);
    for (const [from, to] of tokenPrefixes) {
      rewritten = rewritten.replace(new RegExp(escapeRegex(from), 'g'), to);
    }
    return rewritten;
  };
  return normalizeDiffPath(patch)
    .split('\n')
    .map((line) => {
      const diff = line.match(/^diff --git (.+) (.+)$/);
      if (diff) return `diff --git ${rewriteToken(diff[1]!)} ${rewriteToken(diff[2]!)}`;
      const fileHeader = line.match(/^(---|\+\+\+) (.+)$/);
      if (fileHeader) return `${fileHeader[1]!} ${rewriteToken(fileHeader[2]!)}`;
      const moveHeader = line.match(/^((?:rename|copy) (?:from|to)) (.+)$/);
      if (moveHeader) return `${moveHeader[1]!} ${rewriteToken(moveHeader[2]!)}`;
      if (line.startsWith('Binary files ')) return rewriteBinaryLine(line);
      return line;
    })
    .join('\n');
}

function filesTouchedFromPatch(patch: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();
  for (const line of patch.split(/\r?\n/)) {
    const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (!m) continue;
    const file = m[2] !== '/dev/null' ? m[2] : m[1];
    if (file === undefined || file === '/dev/null' || seen.has(file)) continue;
    seen.add(file);
    files.push(file);
  }
  return files;
}

export function createWorkspace(
  srcDir: string,
  runId: string,
): { dir: string; baseCommit: string } {
  const workspace = workspaceDir(srcDir, runId);
  const pristine = pristineDir(srcDir, runId);
  ensureDir(path.dirname(workspace));
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.rmSync(pristine, { recursive: true, force: true });
  copyWorkspaceTree(srcDir, workspace);
  copyWorkspaceTree(srcDir, pristine);
  return { dir: workspace, baseCommit: 'no-git' };
}

export function extractWorkspacePatch(pristine: string, workspace: string): {
  patch: string;
  diffStat: string;
  filesTouched: string[];
} {
  const cwd = path.dirname(pristine);
  const pristineArg = path.basename(pristine);
  const workspaceArg = path.basename(workspace);
  const patch = rewriteWorkspacePatchPaths(
    runGitNoIndex(['diff', '--no-index', '--binary', '--', pristineArg, workspaceArg], cwd),
    pristine,
    workspace,
  );
  const rawStat = runGitNoIndex(['diff', '--no-index', '--stat', '--', pristineArg, workspaceArg], cwd);
  const statLines = rawStat
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  const diffStat = statLines.length > 0
    ? statLines[statLines.length - 1]!.trim()
    : '';
  return { patch, diffStat, filesTouched: filesTouchedFromPatch(patch) };
}

export function workspaceDiffHash(pristine: string, workspace: string): string {
  try {
    const cwd = path.dirname(pristine);
    const pristineArg = path.basename(pristine);
    const workspaceArg = path.basename(workspace);
    const diff = runGitNoIndex(['diff', '--no-index', '--', pristineArg, workspaceArg], cwd);
    return createHash('sha1').update(diff).digest('hex');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return `err:${msg}`;
  }
}

// maxRetries/retryDelay: Node retries rmSync on Windows EBUSY/EPERM/ENOTEMPTY (an AV, indexer,
// or a just-exited worker briefly holding a handle on the temp dir) before giving up — this
// clears most transient locks. A persistent lock still throws; callers treat that as non-fatal.
export function removeWorkspace(pristine: string, workspace: string): void {
  fs.rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.rmSync(pristine, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export function applyPatch(repo: string, patchFile: string): void {
  // Let the error propagate — caller wraps as patch-conflict
  runGit(['apply', '--3way', patchFile], repo);
}

export function applyWorkspacePatch(dir: string, patchFile: string): void {
  // No-git apply-back uses `git apply` in the original directory against the
  // repo-relative patch. There is no index or base commit, so no 3-way merge.
  runGit(['apply', patchFile], dir);
}

export function reverseApplyPatch(repo: string, patchFile: string): void {
  // An undo must be EXACT: no --3way fuzzing. `git apply --reverse` is atomic — it
  // checks the whole patch applies in reverse before touching anything, so a tree that
  // moved since apply fails cleanly with nothing modified. Caller wraps the error.
  runGit(['apply', '--reverse', patchFile], repo);
}

export function reverseApplyWorkspacePatch(dir: string, patchFile: string): void {
  // No-git undo is supported only as best-effort exact reversal of the recorded
  // patch; without a repository there is no index/base commit to validate against.
  runGit(['apply', '--reverse', patchFile], dir);
}

export function countDiffLines(diffStat: string): number {
  // Parse trailing "N insertions(+), M deletions(-)" from git --stat summary line
  const insertMatch = diffStat.match(/(\d+)\s+insertion/);
  const deleteMatch = diffStat.match(/(\d+)\s+deletion/);
  const ins = insertMatch !== null ? parseInt(insertMatch[1]!, 10) : 0;
  const del = deleteMatch !== null ? parseInt(deleteMatch[1]!, 10) : 0;
  if (insertMatch === null && deleteMatch === null) return 0;
  return ins + del;
}
