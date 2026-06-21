// Deterministic failure classification + backoff math for the resilience layer.
//
// Brainless: pure pattern matching over the worker's own output —
// no LLM, no network, no state. Both claude-headless and codex-exec surface
// provider errors in their stdout/stderr stream (an API error prints the HTTP
// status and the provider's error name); we read the verdict the provider
// already gave us and map it to an ErrorEntry class (ARCHITECTURE §5).

import type { ErrorEntry } from './types.js';

/** Provider-side failure classes the core can act on (retry / break / fall over). */
export type FailureClass = 'rate-limit' | 'auth' | 'server';

export interface FailureVerdict {
  class: FailureClass;
  /** Maps straight onto ErrorEntry.type for the envelope. */
  errType: Extract<ErrorEntry['type'], 'rate-limit' | 'auth' | 'server'>;
  /** Retryable within the SAME worker (rate-limit / server). Auth is not — a bad
   *  key will not fix itself on retry — but every class is still a *provider*
   *  problem, so all three are eligible to fall over to another worker. */
  transient: boolean;
  /** Parsed Retry-After (ms) when the provider supplied one. */
  retryAfterMs?: number;
  /** Short reason for the stop line / envelope. */
  reason: string;
  /** The matched fragment, for the ErrorEntry.detail. */
  evidence: string;
}

// --- Signatures. Ordered rate-limit -> auth -> server so a 429 is never mistaken
// for a generic 4xx/5xx. Matched case-insensitively against the worker's output.
// Curated (not "any 5xx") to keep false positives — a literal "503" in a token
// count, a file path — from masking a genuine crash as a provider outage.

const RATE_LIMIT_RE =
  /\b429\b|rate[\s_-]?limit|too\s+many\s+requests|rate_limit_error|insufficient_quota|resource_exhausted|quota\s+(?:exceeded|exhausted|reached)|requests?\s+per\s+(?:minute|second|day)\s+limit/i;

const AUTH_RE =
  /\b401\b|\b403\b|authentication_error|permission_error|invalid_api_key|invalid[\s_-]?x?-?api[\s_-]?key|\bunauthorized\b|\bforbidden\b|authentication\s+failed|not\s+authorized|invalid\s+(?:bearer\s+)?token|expired\s+token|missing\s+api\s+key/i;

const SERVER_RE =
  /\b5(?:00|02|03|04|29)\b|\b52[0-4]\b|internal\s+server\s+error|bad\s+gateway|service\s+unavailable|gateway\s+time(?:d)?[\s-]?out|server\s+error|overloaded(?:_error)?|api_error|econnrefused|econnreset|etimedout|enotfound|eai_again|epipe|socket\s+hang\s?up|network\s+error|connection\s+(?:refused|reset|closed|error)|getaddrinfo|fetch\s+failed|tunneling\s+socket|request\s+timed?\s?out/i;

/** First line containing the match, trimmed — the useful evidence for a human. */
function evidenceFor(text: string, re: RegExp): string {
  for (const line of text.split(/\r?\n/)) {
    if (re.test(line)) {
      const t = line.trim();
      return t.length > 300 ? t.slice(0, 300) + '…' : t;
    }
  }
  // Match spanned lines (e.g. compact JSON without newlines) — fall back to a window.
  const m = re.exec(text);
  if (m) {
    const start = Math.max(0, m.index - 80);
    return text.slice(start, m.index + 160).replace(/\s+/g, ' ').trim();
  }
  return '';
}

/**
 * Classify a worker failure from the text it emitted (stderr + stdout tail).
 * Returns null when nothing provider-shaped is found — the caller then treats it
 * as a genuine `worker-crash` (a task/code error the Brain must see, not retry).
 */
export function classifyFailure(text: string): FailureVerdict | null {
  if (!text) return null;

  if (RATE_LIMIT_RE.test(text)) {
    const retryAfterMs = parseRetryAfter(text);
    return {
      class: 'rate-limit',
      errType: 'rate-limit',
      transient: true,
      retryAfterMs,
      reason:
        'provider returned a rate-limit (429)' +
        (retryAfterMs !== undefined ? `; retry after ${Math.round(retryAfterMs / 1000)}s` : ''),
      evidence: evidenceFor(text, RATE_LIMIT_RE),
    };
  }

  if (AUTH_RE.test(text)) {
    return {
      class: 'auth',
      errType: 'auth',
      transient: false,
      reason: 'provider rejected credentials (401/403)',
      evidence: evidenceFor(text, AUTH_RE),
    };
  }

  if (SERVER_RE.test(text)) {
    return {
      class: 'server',
      errType: 'server',
      transient: true,
      reason: 'provider server / network error (5xx, overload, or connection failure)',
      evidence: evidenceFor(text, SERVER_RE),
    };
  }

  return null;
}

// --- Retry-After parsing -----------------------------------------------------
// Honor whatever the provider gave us, in the shapes the SDKs/CLIs actually print:
//   HTTP header   "retry-after: 30"      (delta-seconds)
//   prose         "try again in 30 seconds", "retry after 30s"
//   JSON body     "retry_after": 30  /  "retryAfter": 30000 (ms)
// Anything implausible is ignored; sane values are capped at one hour.

const RETRY_AFTER_CAP_MS = 60 * 60 * 1000;

export function parseRetryAfter(text: string): number | undefined {
  const candidates: number[] = [];

  // "retry-after: 30" (seconds) — the canonical HTTP header.
  const header = /retry[\s_-]?after["'\s:]+(\d+(?:\.\d+)?)/i.exec(text);
  if (header) candidates.push(Number(header[1]) * 1000);

  // JSON "retry_after_ms"/"retryAfterMs": already milliseconds.
  const jsonMs = /retry[\s_-]?after[\s_-]?ms["'\s:]+(\d+)/i.exec(text);
  if (jsonMs) candidates.push(Number(jsonMs[1]));

  // Prose: "try again in 30 seconds" / "in 1 minute".
  const prose = /(?:try\s+again|retry|wait)\s+(?:in\s+)?(\d+(?:\.\d+)?)\s*(ms|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?)\b/i.exec(text);
  if (prose) {
    const n = Number(prose[1]);
    const unit = prose[2]!.toLowerCase();
    const mult = unit.startsWith('ms') || unit.startsWith('mill') ? 1
      : unit.startsWith('m') ? 60_000
      : 1000;
    candidates.push(n * mult);
  }

  const valid = candidates.filter((n) => Number.isFinite(n) && n >= 0);
  if (!valid.length) return undefined;
  // Most conservative provider hint wins, capped so a bogus huge value can't wedge a run.
  return Math.min(RETRY_AFTER_CAP_MS, Math.max(...valid));
}

// --- Backoff -----------------------------------------------------------------
// Exponential backoff with full ±jitter, capped (ARCHITECTURE §5: base 1s, ×2,
// jitter ±50%, cap 60s). `backoffBase` is the pre-jitter value — pure and exact,
// so tests can assert the schedule without fighting randomness.

export interface BackoffOpts {
  baseMs?: number;
  factor?: number;
  capMs?: number;
  jitter?: number; // fraction, e.g. 0.5 = ±50%
}

const BACKOFF_DEFAULTS = { baseMs: 1000, factor: 2, capMs: 60_000, jitter: 0.5 };

/** Deterministic pre-jitter delay for retry number `attemptIndex` (0-based). */
export function backoffBase(attemptIndex: number, opts: BackoffOpts = {}): number {
  const { baseMs, factor, capMs } = { ...BACKOFF_DEFAULTS, ...opts };
  const raw = baseMs * Math.pow(factor, Math.max(0, attemptIndex));
  return Math.min(capMs, Math.round(raw));
}

/**
 * Delay (ms) before retry number `attemptIndex` (0-based). Honors `retryAfterMs`
 * when the provider supplied one (still jittered a touch to avoid a thundering
 * herd), otherwise exponential backoff. Always within [0, capMs].
 */
export function computeBackoff(
  attemptIndex: number,
  retryAfterMs?: number,
  opts: BackoffOpts = {},
): number {
  const { capMs, jitter } = { ...BACKOFF_DEFAULTS, ...opts };
  if (retryAfterMs !== undefined && retryAfterMs > 0) {
    // Respect the provider, but add up to +25% so retries don't all fire at once.
    const ms = retryAfterMs * (1 + Math.random() * 0.25);
    return Math.round(Math.min(capMs * 2, ms));
  }
  const base = backoffBase(attemptIndex, opts);
  const delta = base * jitter;
  const lo = base - delta;
  const ms = lo + Math.random() * (2 * delta);
  return Math.round(Math.max(0, Math.min(capMs, ms)));
}

// --- In-attempt retry decision (ARCHITECTURE §5) -----------------------------
// Whether to re-spawn the SAME worker after a transient failure, and how long to
// wait first. Conservative on purpose ("where it makes sense"): only when
// the worker exited on a transient class (rate-limit / server) AND produced no
// work yet (empty patch — re-spawning a clean worktree is safe and idempotent),
// within the bounded count and the remaining wall-clock budget. Auth never
// retries (a bad key will not heal); a partial patch never retries (the work is
// not reproducible). Pure — the runner just acts on the verdict.

export function retryPlan(
  providerFailure: FailureVerdict | null,
  patchEmpty: boolean,
  retriesSoFar: number,
  retries: { rateLimit: number; server: number },
  remainingMs: number,
  opts: BackoffOpts = {},
): { retry: boolean; delayMs: number } {
  if (!providerFailure || !providerFailure.transient || !patchEmpty) return { retry: false, delayMs: 0 };
  const cap = providerFailure.class === 'rate-limit' ? retries.rateLimit : retries.server;
  if (retriesSoFar >= cap) return { retry: false, delayMs: 0 };
  if (remainingMs <= 2000) return { retry: false, delayMs: 0 }; // not enough wall-clock left to bother
  const raw = computeBackoff(retriesSoFar, providerFailure.retryAfterMs, opts);
  // Never let the backoff itself blow the wall-clock budget.
  const delayMs = Math.max(0, Math.min(raw, remainingMs - 1000));
  return { retry: true, delayMs };
}
