// Circuit breaker: open after N hard failures, half-open after cooldown,
// auth opens immediately, success closes. Deterministic via an injected `now`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-test-'));
const { recordWorkerOutcome, workerBreakerView } = await import('../dist/breaker.js');

const cfg = { defaults: { breaker: { failures: 3, cooldownMs: 10_000 } } };
const t0 = 1_000_000;

test('clean worker is available', () => {
  assert.equal(workerBreakerView('clean', cfg, t0).status, 'available');
});

test('server failures: degraded below threshold, unavailable at threshold, half-open after cooldown, closed on success', () => {
  const w = 'srv';
  recordWorkerOutcome(w, { kind: 'provider-failure', class: 'server' }, cfg, t0);
  assert.equal(workerBreakerView(w, cfg, t0).status, 'degraded'); // 1 failure
  recordWorkerOutcome(w, { kind: 'provider-failure', class: 'server' }, cfg, t0);
  assert.equal(workerBreakerView(w, cfg, t0).status, 'degraded'); // 2 failures

  recordWorkerOutcome(w, { kind: 'provider-failure', class: 'server' }, cfg, t0); // 3 = threshold
  const open = workerBreakerView(w, cfg, t0);
  assert.equal(open.status, 'unavailable');
  assert.equal(open.state, 'open');
  assert.ok(open.retryHintMs > 0 && open.retryHintMs <= 10_000);

  assert.equal(workerBreakerView(w, cfg, t0 + 9_999).status, 'unavailable'); // still cooling
  const half = workerBreakerView(w, cfg, t0 + 10_000);
  assert.equal(half.status, 'degraded'); // cooldown elapsed → probe allowed
  assert.equal(half.state, 'half-open');

  recordWorkerOutcome(w, { kind: 'success' }, cfg, t0 + 11_000);
  assert.equal(workerBreakerView(w, cfg, t0 + 11_000).status, 'available'); // probe closed it
});

test('auth opens the breaker immediately (one failure)', () => {
  const w = 'auth';
  recordWorkerOutcome(w, { kind: 'provider-failure', class: 'auth' }, cfg, t0);
  const v = workerBreakerView(w, cfg, t0);
  assert.equal(v.status, 'unavailable');
  assert.equal(v.state, 'open');
});

test('rate-limit Retry-After becomes the reopen estimate (quota window)', () => {
  const w = 'quota';
  recordWorkerOutcome(w, { kind: 'provider-failure', class: 'rate-limit', retryAfterMs: 30_000 }, cfg, t0);
  assert.equal(workerBreakerView(w, cfg, t0 + 10_000).status, 'unavailable'); // default cd would have reopened; 30s wins
  assert.equal(workerBreakerView(w, cfg, t0 + 30_000).state, 'half-open');
});

test('a success resets accumulated failures', () => {
  const w = 'reset';
  recordWorkerOutcome(w, { kind: 'provider-failure', class: 'server' }, cfg, t0);
  recordWorkerOutcome(w, { kind: 'provider-failure', class: 'server' }, cfg, t0);
  recordWorkerOutcome(w, { kind: 'success' }, cfg, t0);
  assert.equal(workerBreakerView(w, cfg, t0).status, 'available');
  // The next failure starts the count from 1, so a single error does not re-open.
  recordWorkerOutcome(w, { kind: 'provider-failure', class: 'server' }, cfg, t0);
  assert.equal(workerBreakerView(w, cfg, t0).status, 'degraded');
});

test('ignore outcomes (crash/kill) never touch the breaker', () => {
  const w = 'crash';
  recordWorkerOutcome(w, { kind: 'ignore' }, cfg, t0);
  assert.equal(workerBreakerView(w, cfg, t0).status, 'available');
});

test('breaker state persists across a fresh state read (new process simulation)', async () => {
  const w = 'persist';
  recordWorkerOutcome(w, { kind: 'provider-failure', class: 'auth' }, cfg, t0);
  // Re-import with a fresh module registry would still read the same file; here we
  // assert the on-disk state drives the view (no in-memory caching).
  const { workerBreakerView: freshView } = await import('../dist/breaker.js?cachebust=1');
  assert.equal(freshView(w, cfg, t0).status, 'unavailable');
});
