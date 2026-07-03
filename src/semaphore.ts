// Cross-process concurrency control. Each run claims a slot in a scope before
// spawning its worker; if the scope is full it WAITS (queues) instead of failing.
// This is what stops a local 1-GPU model from being asked to run 50 agents at once
// Set the provider's maxConcurrent to 1 and excess runs line up.

import fs from 'node:fs';
import path from 'node:path';
import { configHome, ensureDir } from './paths.js';

export interface SlotHandle {
  release(): void;
  slot: number;
  waitedMs: number;
}

interface SlotInfo {
  pid: number;
  ts: number;
  runId: string;
}

const STALE_MS = 60_000; // heartbeat cadence base; also how old an UNREADABLE slot file must be before it counts as abandoned

function locksDir(scope: string): string {
  const safe = scope.replace(/[^a-zA-Z0-9_-]+/g, '_');
  return path.join(configHome(), 'locks', safe);
}

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = no such process; EPERM = exists but not ours (alive).
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Take slot n's file out of service — with the "abandoned" verdict re-judged
 * AFTER the file is immobilized. renameSync first: of N racing reclaimers
 * exactly one wins, and the renamed file can no longer change under us, so
 * re-reading it now is authoritative. The caller's pre-rename read may be
 * stale (the ABA case: the dead slot was reclaimed AND re-claimed by a live
 * run inside the caller's read→rename gap) — then the tomb holds a live claim
 * and is put back via linkSync, which is atomic and fails-if-exists, so a
 * restore can never clobber a third racer's fresh claim. Residual window: a
 * third claim landing while we hold a stolen live tomb orphans the victim's
 * file (its heartbeat then just stops beating; it keeps running) — that takes
 * two independent sub-ms coincidences to line up. Exported for tests.
 */
export function unclaimSlot(dir: string, n: number): boolean {
  const p = path.join(dir, `${n}.slot`);
  const tomb = path.join(dir, `${n}.${process.pid}.reclaim`); // must not end in .slot: invisible to claim/occupancy
  try { fs.renameSync(p, tomb); } catch { return false; } // lost the rename race, or transient FS refusal
  let abandoned = false;
  try {
    const held = JSON.parse(fs.readFileSync(tomb, 'utf8')) as SlotInfo;
    if (typeof held.pid !== 'number') throw new Error('malformed slot file');
    abandoned = !pidAlive(held.pid);
  } catch {
    // Unreadable garbage: abandoned only when the FILE is old (rename keeps mtime).
    try { abandoned = Date.now() - fs.statSync(tomb).mtimeMs > STALE_MS; } catch { abandoned = false; }
  }
  if (abandoned) {
    try { fs.rmSync(tomb, { force: true }); } catch { /* orphaned tombstone is inert */ }
    return true;
  }
  // Stale verdict — the tomb holds a claim that must keep its slot. Put it back.
  try { fs.linkSync(tomb, p); } catch { /* p was re-claimed while we held the tomb — nothing safe to restore onto */ }
  try { fs.rmSync(tomb, { force: true }); } catch { /* ignore */ }
  return false;
}

/** Try to atomically claim slot n. Returns true on success. */
function claim(dir: string, n: number, info: SlotInfo): boolean {
  const p = path.join(dir, `${n}.slot`);
  // Create atomically: write the full content, then link into place. linkSync
  // is exclusive like 'wx', but the slot file can never be observed empty or
  // half-written — a claimant suspended between a create and its write used to
  // leave an aging empty file that a peer would "reclaim" by mtime while the
  // resumed owner went on to admit itself through its still-open fd.
  const tmp = path.join(dir, `${n}.${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(info));
    fs.linkSync(tmp, p);
    fs.rmSync(tmp, { force: true });
    return true;
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'ENOSYS' || code === 'ENOTSUP' || code === 'EOPNOTSUPP') {
      // A filesystem without hardlinks (exotic for ~/.delegator, but possible):
      // fall back to create-exclusive. Only there the born-atomic guarantee is
      // reduced to what an empty file self-heals via the mtime rule.
      try {
        const fd = fs.openSync(p, 'wx');
        try { fs.writeSync(fd, JSON.stringify(info)); } finally { fs.closeSync(fd); }
        return true;
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code !== 'EEXIST') throw e2;
      }
    } else if (code !== 'EEXIST') {
      throw e;
    }
  }
  // Occupied. Reclaim ONLY a provably dead holder — never a live pid, however
  // stale its heartbeat: a stalled-but-running holder (suspended laptop, GC
  // pause, blocked event loop) still owns its slot, and evicting it would admit
  // limit+1 workers at once. Cost of this contract: a crashed holder whose pid
  // the OS recycled onto a long-lived process pins its slot until that process
  // exits — the queue timeout keeps that failure visible (runs reject with a
  // clear reason) instead of silently breaking the limit.
  let abandoned = false;
  try {
    const held = JSON.parse(fs.readFileSync(p, 'utf8')) as SlotInfo;
    if (typeof held.pid !== 'number') throw new Error('malformed slot file');
    abandoned = !pidAlive(held.pid);
  } catch {
    // Unreadable or malformed. Treat as abandoned only when the FILE is old —
    // a fresh one is likely a peer's write we caught halfway through.
    try { abandoned = Date.now() - fs.statSync(p).mtimeMs > STALE_MS; } catch { return false; }
  }
  // Re-enter after a successful unclaim (a racer may still win the create).
  // Bounded in practice: each further level needs a fresh holder to die inside
  // the microsecond reclaim window.
  if (abandoned && unclaimSlot(dir, n)) return claim(dir, n, info);
  return false;
}

/**
 * One heartbeat tick: freshen the slot file's ts IF the slot is still ours
 * (same pid AND runId). Returns false when it no longer is — released,
 * reclaimed, or handed to another run — in which case the caller must stop
 * beating and must NOT recreate the file: resurrecting it would admit two
 * runs through one slot. Exported for tests.
 */
export function heartbeatSlot(slotPath: string, own: SlotInfo): boolean {
  try {
    const held = JSON.parse(fs.readFileSync(slotPath, 'utf8')) as SlotInfo;
    if (held.pid !== own.pid || held.runId !== own.runId) return false;
  } catch {
    return false; // gone or unreadable — assume lost; never resurrect
  }
  // Write-then-rename so a polling claimant can never read half-written JSON
  // and mistake a live slot for an abandoned one.
  const tmp = `${slotPath}.${own.pid}.hb`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ ...own, ts: Date.now() }));
    fs.renameSync(tmp, slotPath);
  } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    // Transient FS refusal: we still own the slot; the next beat retries.
  }
  return true;
}

export interface AcquireOpts {
  limit: number;
  runId: string;
  queueTimeoutMs: number;
  pollMs: number;
  onWait?: (waitedMs: number) => void; // called once when a run first has to queue
}

/**
 * Acquire one of `limit` slots in `scope`, waiting up to queueTimeoutMs.
 * Returns a handle (call release() when the worker exits) or null on timeout.
 * limit <= 0 means "unbounded" — returns immediately with a no-op handle.
 */
export async function acquireSlot(scope: string, opts: AcquireOpts): Promise<SlotHandle | null> {
  if (opts.limit <= 0) {
    return { release: () => {}, slot: -1, waitedMs: 0 };
  }
  const dir = locksDir(scope);
  ensureDir(dir);
  const started = Date.now();
  const info: SlotInfo = { pid: process.pid, ts: started, runId: opts.runId };
  let notifiedWait = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  for (;;) {
    for (let n = 0; n < opts.limit; n++) {
      info.ts = Date.now();
      if (claim(dir, n, info)) {
        const slotPath = path.join(dir, `${n}.slot`);
        // Keep our slot fresh; if we ever find it is no longer ours, stop
        // beating — heartbeatSlot never resurrects or overwrites a foreign file.
        heartbeat = setInterval(() => {
          if (!heartbeatSlot(slotPath, info) && heartbeat) { clearInterval(heartbeat); heartbeat = null; }
        }, Math.floor(STALE_MS / 3));
        heartbeat.unref?.();
        const handle: SlotHandle = {
          slot: n,
          waitedMs: Date.now() - started,
          release: () => {
            if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
            // Delete only what is still ours: if the slot was handed to another
            // run, deleting the path would silently admit yet another worker.
            try {
              const held = JSON.parse(fs.readFileSync(slotPath, 'utf8')) as SlotInfo;
              if (held.pid === info.pid && held.runId === info.runId) fs.rmSync(slotPath, { force: true });
            } catch { /* already gone or unreadable — nothing of ours left to free */ }
          },
        };
        return handle;
      }
    }
    if (Date.now() - started > opts.queueTimeoutMs) return null;
    if (!notifiedWait) {
      notifiedWait = true;
      opts.onWait?.(Date.now() - started);
    }
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }
}

/** Inspect a scope: how many slots are held right now (for `dlg queue`/status). */
export function scopeOccupancy(scope: string): { held: number; holders: SlotInfo[] } {
  const dir = locksDir(scope);
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.slot')); } catch { return { held: 0, holders: [] }; }
  const holders: SlotInfo[] = [];
  for (const f of files) {
    try {
      const held = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as SlotInfo;
      // Same contract as claim(): a live pid holds its slot no matter how stale
      // its heartbeat; only a dead holder's file does not count as occupancy.
      if (typeof held.pid === 'number' && pidAlive(held.pid)) holders.push(held);
    } catch { /* skip */ }
  }
  return { held: holders.length, holders };
}
