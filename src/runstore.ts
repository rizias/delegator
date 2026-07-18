import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  ensureDir,
  projectsRoot,
  projectKey,
  runsRoot,
  runsJournalPath,
  worktreeDir,
  workspaceDir,
  pristineDir,
  dirSizeBytes,
} from './paths.js';
import { removeWorktree, pruneWorktreeAdmin } from './worktree.js';
import { pidAlive } from './semaphore.js';
import type { RunMeta, WorkerEvent, Envelope } from './types.js';

// ---------- project scoping: runs are grouped per project ----------

let activeProjectKey = 'default';

export function setRunsProject(cwd: string): void {
  activeProjectKey = projectKey(cwd);
}

export function currentProjectSlug(): string {
  return activeProjectKey;
}

export function currentProjectKey(): string {
  return activeProjectKey;
}

/** Guard the run id at the single path chokepoint: it must be ONE safe path segment,
 *  never a traversal. Without this a crafted id (e.g. "../../x") could make destructive
 *  helpers (removeRun's rmSync) escape the run store. */
function assertSafeRunId(id: string): void {
  if (!id || id !== path.basename(id) || id.includes('..')) {
    throw new Error(`invalid run id: ${JSON.stringify(id)}`);
  }
}

/** Current project's dir first; legacy flat layout (pre-grouping) as fallback. */
function resolveRunDir(id: string): string {
  assertSafeRunId(id);
  const proj = path.join(projectsRoot(), activeProjectKey, id);
  if (fs.existsSync(proj)) return proj;
  const legacyGrouped = path.join(runsRoot(), activeProjectKey, id);
  if (fs.existsSync(legacyGrouped)) return legacyGrouped;
  const legacy = path.join(runsRoot(), id);
  if (fs.existsSync(legacy)) return legacy;
  return proj; // creation target for new runs
}

// ---------- paths ----------

export const eventsPath = (id: string): string =>
  path.join(resolveRunDir(id), 'events.jsonl');

export const briefPath = (id: string): string =>
  path.join(resolveRunDir(id), 'brief.md');

const metaPath = (id: string): string =>
  path.join(resolveRunDir(id), 'meta.json');

const envelopePath = (id: string): string =>
  path.join(resolveRunDir(id), 'envelope.json');

const patchFilePath = (id: string): string =>
  path.join(resolveRunDir(id), 'patch.diff');

// ---------- run id ----------

export function newRunId(): string {
  return 'dlg_' + crypto.randomBytes(4).toString('hex');
}

// ---------- lifecycle ----------

export function createRun(meta: RunMeta, brief: string, gen: () => string = newRunId): RunMeta {
  for (let attempt = 0; attempt < 5; attempt++) {
    const id = attempt === 0 ? meta.id : gen();
    // Stamp the owning delegator process. If that process later dies (crash, Ctrl-C, a killed
    // council parent) before the run finalizes, `reapIfOrphaned` (below) can close the run instead
    // of leaving it stranded in a non-terminal state forever.
    const runMeta: RunMeta = { ...meta, id, ownerPid: meta.ownerPid ?? process.pid };
    const dir = resolveRunDir(id);
    try {
      ensureDir(path.dirname(dir));
      fs.mkdirSync(dir);
      fs.writeFileSync(metaPath(id), JSON.stringify(runMeta, null, 2), 'utf8');
      fs.writeFileSync(briefPath(id), brief, 'utf8');
      return runMeta;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
  }
  throw new Error('could not allocate unique run id after 5 attempts');
}

export function readMeta(id: string): RunMeta {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), 'utf8')) as RunMeta;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`run not found: ${id}`);
    }
    throw err;
  }
}

export function updateMeta(id: string, patch: Partial<RunMeta>): RunMeta {
  const current = readMeta(id);
  const updated: RunMeta = { ...current, ...patch };
  fs.writeFileSync(metaPath(id), JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

// ---------- events ----------

export function appendEvent(id: string, ev: WorkerEvent): void {
  fs.appendFileSync(eventsPath(id), JSON.stringify(ev) + '\n');
}

export function readEventsTail(id: string, n: number): string[] {
  let content: string;
  try {
    content = fs.readFileSync(eventsPath(id), 'utf8');
  } catch {
    return [];
  }
  const lines = content.split('\n').filter(l => l.length > 0);
  return lines.slice(-n);
}

// ---------- envelope ----------

export function writeEnvelope(id: string, env: Envelope): void {
  fs.writeFileSync(envelopePath(id), JSON.stringify(env, null, 2), 'utf8');
}

export function readEnvelope(id: string): Envelope | null {
  try {
    return JSON.parse(fs.readFileSync(envelopePath(id), 'utf8')) as Envelope;
  } catch {
    return null;
  }
}

// ---------- patch ----------

export function writePatch(id: string, patch: string): string {
  const p = patchFilePath(id);
  fs.writeFileSync(p, patch, 'utf8');
  return path.resolve(p);
}

// ---------- reaping orphans ----------

/**
 * A run whose owning delegator process is gone but that never reached a terminal state is an
 * orphan (the process crashed / was Ctrl-C'd / a council parent was killed between `createRun`
 * and finalize — an in-process `api` run has no worker pid to kill-detect, so this is the only
 * signal). Close it as a terminal `failed` so it stops showing as a live/preparing zombie.
 * Best-effort and idempotent: only fires once (state flips to `done`), never touches a run whose
 * owner is still alive, and swallows write races with a concurrent finalize. Mutates `m` in place
 * so a freshly-listed metas array reflects the reap without a re-read.
 */
function reapIfOrphaned(m: RunMeta): void {
  if (m.state === 'done') return;
  if (m.ownerPid === undefined) return;   // legacy run with no owner stamp — cannot judge liveness
  if (pidAlive(m.ownerPid)) return;       // owner still running: the run is genuinely in progress
  const skip = { status: 'skipped' as const, outputTail: 'run orphaned before verification' };
  const endedAt = new Date().toISOString();
  const env: Envelope = {
    envelopeVersion: 1,
    runId: m.id,
    status: 'failed',
    workerId: m.workerId,
    model: m.model,
    runtime: m.runtime,
    summary: 'run orphaned: the delegator process that owned this run exited before it finished',
    changes: { diffStat: '', filesTouched: [], applied: false },
    verification: { build: skip, test: skip, lint: skip },
    usage: { wallClockMs: 0 },
    stopReason: `orphaned: owner process ${m.ownerPid} is no longer alive`,
    errors: [{ type: 'internal', message: 'run orphaned (owner process exited before finalize)' }],
    logsPath: eventsPath(m.id),
    worktree: m.worktree,
  };
  try {
    // Re-read fresh: a dead owner necessarily finished (or crashed through) its own writes before it
    // exited, so if it finalized in the gap between the listing snapshot and now, the store already
    // reflects it. Do NOT clobber a real result or its timestamps — only close a genuine orphan.
    const fresh = readMeta(m.id);
    if (fresh.state === 'done') { m.state = 'done'; m.endedAt = fresh.endedAt; return; }
    if (readEnvelope(m.id)) { updateMeta(m.id, { state: 'done' }); m.state = 'done'; return; } // real result exists
    writeEnvelope(m.id, env);
    journalAppend(env);
    updateMeta(m.id, { state: 'done', endedAt });
    m.state = 'done';
    m.endedAt = endedAt;
  } catch {
    // a concurrent finalize/reaper won the race, or the store is read-only — leave it.
  }
}

// ---------- listing ----------

export function listRuns(): RunMeta[] {
  const metas: RunMeta[] = [];
  const seen = new Set<string>();
  const base = path.join(projectsRoot(), activeProjectKey);
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(base);
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (!entry.startsWith('dlg_') || seen.has(entry)) continue;
    try {
      const raw = fs.readFileSync(path.join(base, entry, 'meta.json'), 'utf8');
      metas.push(JSON.parse(raw) as RunMeta);
      seen.add(entry);
    } catch {
      // skip corrupt entries
    }
  }

  // Close any run whose owner process died before it finalized — so a dead process never leaves a
  // run stuck showing as live/preparing. Cheap: a liveness syscall per non-terminal run, a write
  // only for actual orphans (once).
  for (const m of metas) reapIfOrphaned(m);

  metas.sort((a, b) => {
    const ta = new Date(a.createdAt).getTime();
    const tb = new Date(b.createdAt).getTime();
    return tb - ta;
  });

  return metas;
}

// ---------- removal ----------

export function removeRun(id: string): void {
  const dir = resolveRunDir(id);
  fs.rmSync(dir, { recursive: true, force: true });
}

/** Retention: keep at most `keep` finished runs per project, prune oldest first. */
export function pruneRuns(keep: number): string[] {
  if (keep <= 0) return [];
  const done = listRuns().filter((m) => m.state === 'done'); // sorted newest-first
  const removed: string[] = [];
  for (const m of done.slice(keep)) {
    try {
      if (m.worktree && fs.existsSync(m.worktree)) {
        try {
          removeWorktree(m.request.cwd, m.worktree);
        } catch {
          fs.rmSync(m.worktree, { recursive: true, force: true });
        }
      }
      removeRun(m.id);
      removed.push(m.id);
    } catch {
      // best-effort - never fail a run over cleanup
    }
  }
  return removed;
}

/** Reaper: drop the heavy git checkout / workspace of every run in the active project
 *  (any state — including killed/crashed runs retention never reaches), keeping each run's
 *  lightweight receipt (envelope + patch.diff + logs) so `gain`/`result`/`apply` still work.
 *  Returns how many heavy dirs were removed and the bytes freed. */
export function reapWorktrees(): { dropped: number; freedBytes: number } {
  let dropped = 0;
  let freedBytes = 0;
  const repos = new Set<string>();
  for (const m of listRuns()) {
    const cwd = m.request?.cwd;
    const heavy = cwd
      ? [worktreeDir(cwd, m.id), workspaceDir(cwd, m.id), pristineDir(cwd, m.id)]
      : (m.worktree ? [m.worktree] : []);
    for (const h of heavy) {
      if (!fs.existsSync(h)) continue;
      freedBytes += dirSizeBytes(h);
      try {
        if (cwd) removeWorktree(cwd, h);
        else fs.rmSync(h, { recursive: true, force: true });
      } catch {
        fs.rmSync(h, { recursive: true, force: true });
      }
      dropped++;
    }
    if (cwd) repos.add(cwd);
  }
  for (const repo of repos) pruneWorktreeAdmin(repo);
  return { dropped, freedBytes };
}

// ---------- journal ----------

export function journalAppend(env: Envelope): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    runId: env.runId,
    project: activeProjectKey,
    workerId: env.workerId,
    status: env.status,
    wallClockMs: env.usage.wallClockMs,
    tokens: env.usage.tokens?.total ?? null,
    tokensReasoning: env.usage.tokens?.reasoning ?? null,
  });
  fs.appendFileSync(runsJournalPath(), line + '\n');
}
