// Single owner of ~/.delegator/state.json — the cross-process persistence file
// for everything that must survive a fresh core process: the key-rotation cursor,
// the per-worker circuit breaker, and per-key cooldowns.
// Mirrors the semaphore's readState/writeState shape; like the
// rotation cursor it is best-effort across processes (no lock) and
// explicitly accepts slightly-stale breaker reads.

import fs from 'node:fs';
import { configHome, ensureDir, stateFilePath } from './paths.js';

export interface BreakerEntry {
  state: 'closed' | 'open' | 'half-open';
  failures: number;          // consecutive hard provider failures
  openedAt?: number;         // epoch ms the breaker last opened
  cooldownMs?: number;       // how long THIS open lasts (Retry-After estimate or default)
  lastErrType?: string;      // 'rate-limit' | 'auth' | 'server'
  lastError?: string;        // short evidence for discovery / the envelope
  lastFailureAt?: number;
}

/** A parked pool key: only its hash is stored — never the secret itself. */
export interface KeyCooldownEntry {
  hash: string;
  until: number;             // epoch ms when the key becomes usable again
  reason?: string;           // 'auth' | 'rate-limit'
}

export interface DelegatorState {
  keyCursor?: Record<string, number>;
  breaker?: Record<string, BreakerEntry>;
  keyCooldown?: Record<string, KeyCooldownEntry[]>; // providerId -> parked keys
}

export function readState(): DelegatorState {
  try {
    return JSON.parse(fs.readFileSync(stateFilePath(), 'utf8')) as DelegatorState;
  } catch {
    return {};
  }
}

export function writeState(s: DelegatorState): void {
  ensureDir(configHome());
  // Atomic write: a crash mid-write must never leave a half-written/corrupt state.json that
  // readState would then silently reset to {}. (Cross-process lost-update races remain a lower-priority
  // item — see the header note; the single-active-run-per-worker regime avoids them today.)
  const p = stateFilePath();
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/**
 * Read-modify-write the whole state object. Every feature area reads and writes
 * the FULL file, so the breaker never clobbers the key cursor (and vice-versa).
 */
export function mutateState<T>(fn: (s: DelegatorState) => T): T {
  const s = readState();
  const r = fn(s);
  writeState(s);
  return r;
}
