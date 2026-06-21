// Per-key cooldown. A 429/auth is usually the KEY's problem, not the
// worker's: in a multi-key pool (free-tier stacks), one key exhausts its quota or
// gets revoked while the others are fine. We park the offending key for a cooldown
// and let rotation skip it; the run continues on the next key.
//
// Scope boundary: this tracks KEYS. The circuit breaker (breaker.ts) tracks
// WORKERS. A whole provider going down opens the breaker; one bad key in a pool
// just parks that key.
//
// Security: only a SHA-256 hash of the key is ever written to state.json — never
// the secret itself (the registry/secrets split would be pointless if
// state.json leaked keys).

import crypto from 'node:crypto';
import { mutateState, type DelegatorState, type KeyCooldownEntry } from './state.js';

export function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Park `key` for `providerId` until `untilMs` (epoch). Extends an existing park
 * rather than shortening it. Idempotent per (provider, key).
 */
export function parkKey(providerId: string, key: string, untilMs: number, reason?: string): void {
  const hash = hashKey(key);
  mutateState((s) => {
    const map = (s.keyCooldown ??= {});
    const list = (map[providerId] ??= []);
    const existing = list.find((e) => e.hash === hash);
    if (existing) {
      existing.until = Math.max(existing.until, untilMs);
      if (reason) existing.reason = reason;
    } else {
      list.push({ hash, until: untilMs, ...(reason ? { reason } : {}) });
    }
  });
}

/**
 * Active (non-expired) parked hashes for a provider, pruning expired entries from
 * the passed state in place. Pure over `state` so callers can fold it into one
 * read-modify-write (see config.nextPoolKey).
 */
export function activeParkedHashes(
  state: DelegatorState,
  providerId: string,
  now: number,
): Set<string> {
  const map = state.keyCooldown;
  const list = map?.[providerId];
  if (!map || !list) return new Set();
  const active = list.filter((e) => e.until > now);
  if (active.length) map[providerId] = active;
  else delete map[providerId];
  return new Set(active.map((e) => e.hash));
}

/** Diagnostic: is this exact key currently parked? (pure read via mutateState prune) */
export function isKeyParked(providerId: string, key: string, now: number = Date.now()): boolean {
  const hash = hashKey(key);
  return mutateState((s) => activeParkedHashes(s, providerId, now)).has(hash);
}

/** The parked entries (hash + expiry) for a provider, expired ones pruned. */
export function parkedEntries(providerId: string, now: number = Date.now()): KeyCooldownEntry[] {
  return mutateState((s) => {
    activeParkedHashes(s, providerId, now); // prunes
    return [...(s.keyCooldown?.[providerId] ?? [])];
  });
}
