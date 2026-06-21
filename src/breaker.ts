// Per-worker circuit breaker. Brainless: it counts consecutive hard
// provider failures, opens after a threshold, and reports the worker `unavailable`
// to discovery until a half-open probe (the next run after the cooldown) decides.
// "Do not send work to GLM when GLM is down" — expressed as deterministic state,
// persisted in ~/.delegator/state.json so a fresh process inherits it.
//
// Scope boundary: the breaker tracks WORKERS. Per-key cooldown
// (keycooldown.ts) tracks KEYS. A bad key parks the key; a down provider opens
// the breaker. They are independent.

import type { DelegatorConfig } from './types.js';
import type { FailureClass } from './classify.js';
import { mutateState, readState, type BreakerEntry, type DelegatorState } from './state.js';

/** What a finished attempt tells the breaker about the worker's provider. */
export type WorkerOutcome =
  | { kind: 'success' }
  | { kind: 'provider-failure'; class: FailureClass; retryAfterMs?: number; evidence?: string }
  | { kind: 'ignore' }; // crash / verification / budget / timeout — not a provider-health signal

export interface BreakerView {
  status: 'available' | 'degraded' | 'unavailable';
  state: 'closed' | 'open' | 'half-open';
  reason?: string;
  /** ms until a half-open probe is allowed (only when unavailable). */
  retryHintMs?: number;
}

function breakerCfg(cfg: DelegatorConfig): { failures: number; cooldownMs: number } {
  return cfg.defaults.breaker;
}

/**
 * Fold an attempt outcome into the worker's breaker entry.
 * - success  → reset to closed (the provider answered).
 * - auth     → open immediately (a rejected credential will not heal on its own).
 * - rate-limit with a Retry-After → open with that as the reopen estimate (a quota
 *   window; ARCHITECTURE §5). Without one it counts like a server error.
 * - server / plain rate-limit → count; open once `breaker.failures` pile up.
 * - ignore   → leave the entry untouched (a worker crash is the Brain's problem,
 *   not a provider outage).
 */
export function recordWorkerOutcome(
  workerId: string,
  outcome: WorkerOutcome,
  cfg: DelegatorConfig,
  now: number = Date.now(),
): void {
  if (outcome.kind === 'ignore') return;
  const { failures: threshold, cooldownMs } = breakerCfg(cfg);

  mutateState((s) => {
    const map = (s.breaker ??= {});
    if (outcome.kind === 'success') {
      // Closing fully (rather than deleting) keeps the last-known reason around
      // for one cycle of discovery; a 0-failure closed entry reads as available.
      map[workerId] = { state: 'closed', failures: 0 };
      return;
    }

    const prev = map[workerId];
    const failures = (prev?.failures ?? 0) + 1;
    const entry: BreakerEntry = {
      state: 'closed',
      failures,
      lastErrType: outcome.class,
      lastError: outcome.evidence,
      lastFailureAt: now,
    };

    const openImmediately = outcome.class === 'auth';
    const quotaWindow = outcome.class === 'rate-limit' && outcome.retryAfterMs !== undefined;
    if (openImmediately || quotaWindow || failures >= threshold) {
      entry.state = 'open';
      entry.openedAt = now;
      // A provider-supplied Retry-After is the authoritative reopen estimate — honor it even when it
      // is SHORTER than the default, or we keep a recovered provider open longer than it asked.
      entry.cooldownMs = (outcome.retryAfterMs && outcome.retryAfterMs > 0)
        ? outcome.retryAfterMs
        : cooldownMs;
    }
    map[workerId] = entry;
  });
}

/**
 * Read-only availability view for discovery and the fallback planner. Computes
 * the half-open transition from elapsed time WITHOUT mutating state (the probe's
 * own outcome, via recordWorkerOutcome, is what actually closes or re-opens it).
 */
export function workerBreakerView(
  workerId: string,
  cfg: DelegatorConfig,
  now: number = Date.now(),
  snapshot?: DelegatorState,
): BreakerView {
  const entry = (snapshot ?? readState()).breaker?.[workerId];
  if (!entry || (entry.state === 'closed' && entry.failures === 0)) {
    return { status: 'available', state: 'closed' };
  }

  if (entry.state === 'open') {
    const cd = entry.cooldownMs ?? breakerCfg(cfg).cooldownMs;
    const elapsed = now - (entry.openedAt ?? now);
    if (elapsed >= cd) {
      // Cooldown elapsed → allow one probe. Spawnable, but the Brain is warned.
      return {
        status: 'degraded',
        state: 'half-open',
        reason: `circuit half-open: probing after cooldown (last: ${entry.lastErrType ?? 'failure'})`,
      };
    }
    return {
      status: 'unavailable',
      state: 'open',
      reason: `circuit open after ${entry.failures} failure(s) (${entry.lastErrType ?? 'provider error'}); retry in ${Math.ceil((cd - elapsed) / 1000)}s`,
      retryHintMs: cd - elapsed,
    };
  }

  if (entry.state === 'half-open') {
    return { status: 'degraded', state: 'half-open', reason: 'circuit half-open: probe in flight' };
  }

  // closed but with recent failures below the open threshold → degraded (warned, still usable).
  return {
    status: 'degraded',
    state: 'closed',
    reason: `${entry.failures} recent provider error(s) (${entry.lastErrType ?? 'unknown'})`,
  };
}
