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

const STALE_MS = 60_000; // a slot whose holder hasn't proven alive in this long is reclaimable

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

/** Try to atomically claim slot n. Returns true on success. */
function claim(dir: string, n: number, info: SlotInfo): boolean {
  const p = path.join(dir, `${n}.slot`);
  try {
    const fd = fs.openSync(p, 'wx'); // wx = create-exclusive, fails if exists
    fs.writeSync(fd, JSON.stringify(info));
    fs.closeSync(fd);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') {
      // Occupied — reclaim if the holder is dead or the slot is stale.
      try {
        const raw = fs.readFileSync(p, 'utf8');
        const held = JSON.parse(raw) as SlotInfo;
        if (!pidAlive(held.pid) || Date.now() - held.ts > STALE_MS) {
          fs.rmSync(p, { force: true });
          return claim(dir, n, info); // one retry after reclaiming
        }
      } catch {
        // Unreadable/corrupt slot file — treat as stale.
        fs.rmSync(p, { force: true });
        return claim(dir, n, info);
      }
      return false;
    }
    throw e;
  }
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
        // Keep our slot fresh so peers never reclaim it from under a long run.
        heartbeat = setInterval(() => {
          try { fs.writeFileSync(slotPath, JSON.stringify({ ...info, ts: Date.now() })); } catch { /* ignore */ }
        }, Math.floor(STALE_MS / 3));
        heartbeat.unref?.();
        const handle: SlotHandle = {
          slot: n,
          waitedMs: Date.now() - started,
          release: () => {
            if (heartbeat) clearInterval(heartbeat);
            try { fs.rmSync(slotPath, { force: true }); } catch { /* ignore */ }
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
      if (pidAlive(held.pid) && Date.now() - held.ts <= STALE_MS) holders.push(held);
    } catch { /* skip */ }
  }
  return { held: holders.length, holders };
}
