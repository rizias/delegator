// Cross-process concurrency control. Each run takes a ticket in a scope before
// spawning its worker; if the scope is full it WAITS (queues) instead of failing.
// This is what stops a local 1-GPU model from being asked to run 50 agents at once:
// set the provider's maxConcurrent to 1 and excess runs line up.
//
// Design: a write-once bakery gate (Lamport, "A New Solution of Dijkstra's
// Concurrent Programming Problem", CACM 1974 —
// https://lamport.azurewebsites.net/pubs/bakery.pdf). ALL claim state lives in
// the NAMES of zero-byte files: `ticket-<num>-<pid>-<runId>` (a queue position),
// `choosing-<pid>-<runId>` (a doorway announcement), `held-<pid>-<runId>` (an
// admission marker, display-only). Nothing is ever renamed, rewritten, or
// restored, and non-owners delete ONLY files whose name-embedded pid is dead —
// so a file's path IS its identity and a deadness verdict can never be applied
// to the wrong claim. There is no heartbeat and no staleness clock: pid
// liveness is the single reclaim oracle (process.kill(pid, 0) never reports a
// live pid as dead; EPERM counts as alive). Earlier designs arbitrated reused
// slot paths with rename/restore; three adversarial review rounds each found an
// over-admission interleaving in that class, which is why this file avoids
// mutation of shared paths entirely.
//
// Accepted tradeoffs (deliberate, visible via queue timeout + `dlg queue`):
// - a process suspended INSIDE the three-syscall doorway stalls its scope until
//   it resumes or dies (machine-wide sleep suspends every contender anyway);
// - a crashed holder whose pid the OS recycled onto a long-lived foreign
//   process pins its queue position until that process exits.
// Upgrade note: lock files of the pre-bakery format (`<n>.slot`, JSON content)
// are invisible to this gate; mixed-version processes do not share a limit
// during the upgrade window.

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

const TICKET_RE = /^ticket-(\d{10})-(\d+)-(.+)$/;
const CHOOSING_RE = /^choosing-(\d+)-(.+)$/;
const HELD_RE = /^held-(\d+)-(.+)$/;

function locksDir(scope: string): string {
  const safe = scope.replace(/[^a-zA-Z0-9_-]+/g, '_');
  return path.join(configHome(), 'locks', safe);
}

// runIds are filename-embedded; sanitize the same way as scopes.
function safeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]+/g, '_');
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

function rmQuiet(p: string): void {
  try { fs.rmSync(p, { force: true }); } catch { /* transient FS refusal — retried on a later pass */ }
}

/** Create an empty file, exclusively. The single atomic syscall IS the claim. */
function touchNew(p: string): void {
  fs.closeSync(fs.openSync(p, 'wx'));
}

interface Ticket { name: string; num: number; pid: number; runId: string; }

/**
 * One pass over the scope dir: collect live choosing announcements and live
 * tickets (sorted into the admission order), and lazily GC every entry whose
 * name-embedded pid is dead. Blind removal is safe precisely because files are
 * write-once and their path encodes their identity — a dead entry can never
 * "become" someone else's live claim.
 */
function gcAndList(dir: string): { choosing: string[]; tickets: Ticket[] } {
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return { choosing: [], tickets: [] }; }
  const choosing: string[] = [];
  const tickets: Ticket[] = [];
  for (const f of names) {
    let m = CHOOSING_RE.exec(f);
    if (m) {
      if (pidAlive(Number(m[1]))) choosing.push(f);
      else rmQuiet(path.join(dir, f));
      continue;
    }
    m = TICKET_RE.exec(f);
    if (m) {
      const t: Ticket = { name: f, num: Number(m[1]), pid: Number(m[2]), runId: m[3] ?? '' };
      if (pidAlive(t.pid)) tickets.push(t);
      else rmQuiet(path.join(dir, f));
      continue;
    }
    m = HELD_RE.exec(f);
    if (m && !pidAlive(Number(m[1]))) rmQuiet(path.join(dir, f));
  }
  // Total order: ticket number, then runId — every observer computes the same ranking.
  tickets.sort((a, b) => (a.num - b.num) || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  return { choosing, tickets };
}

/**
 * Lamport's doorway: announce "choosing", take 1+max of the ticket numbers in
 * sight, place the ticket, retract the announcement. Peers must not decide the
 * order while a live announcement stands — that wait is what makes two
 * simultaneous choosers safe even when they pick the same number (ties break
 * deterministically by runId).
 */
function chooseTicket(dir: string, runId: string): Ticket {
  const choosingPath = path.join(dir, `choosing-${process.pid}-${runId}`);
  touchNew(choosingPath);
  try {
    const { tickets } = gcAndList(dir);
    const num = 1 + tickets.reduce((m, t) => Math.max(m, t.num), 0);
    const name = `ticket-${String(num).padStart(10, '0')}-${process.pid}-${runId}`;
    touchNew(path.join(dir, name));
    return { name, num, pid: process.pid, runId };
  } finally {
    rmQuiet(choosingPath);
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
  const runId = safeId(opts.runId);
  const started = Date.now();
  let mine = chooseTicket(dir, runId);
  const minePath = () => path.join(dir, mine.name);
  let notifiedWait = false;

  for (;;) {
    const { choosing, tickets } = gcAndList(dir);
    // Doorway wait: while any LIVE peer is mid-choosing the order is not decidable.
    if (!choosing.some((c) => c !== `choosing-${process.pid}-${runId}`)) {
      const idx = tickets.findIndex((t) => t.name === mine.name);
      if (idx === -1) {
        // Our ticket vanished (only possible through outside interference —
        // peers GC dead pids only, and we are alive). Re-enter the doorway.
        mine = chooseTicket(dir, runId);
        continue;
      }
      if (idx < opts.limit) {
        // Admitted by rank. The held marker is DISPLAY-ONLY state for
        // scopeOccupancy — admission is decided by the ticket order alone.
        const heldPath = path.join(dir, `held-${process.pid}-${runId}`);
        try { touchNew(heldPath); } catch { /* leftover from an identical crashed runId — display-only */ }
        return {
          slot: mine.num,
          waitedMs: Date.now() - started,
          release: () => {
            rmQuiet(heldPath);
            rmQuiet(minePath());
          },
        };
      }
    }
    if (Date.now() - started > opts.queueTimeoutMs) {
      rmQuiet(minePath()); // leave no queue position behind
      return null;
    }
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
  let names: string[] = [];
  try { names = fs.readdirSync(dir); } catch { return { held: 0, holders: [] }; }
  const holders: SlotInfo[] = [];
  for (const f of names) {
    const m = HELD_RE.exec(f);
    if (!m) continue;
    const pid = Number(m[1]);
    if (!pidAlive(pid)) continue; // stale marker of a crashed holder; GCed by the next acquirer
    let ts = 0;
    try { ts = Math.round(fs.statSync(path.join(dir, f)).mtimeMs); } catch { /* racing a release */ }
    holders.push({ pid, ts, runId: m[2] ?? '' });
  }
  return { held: holders.length, holders };
}
