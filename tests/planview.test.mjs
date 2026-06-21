// `dlg plan` dry-run view. buildPlanView turns a resolved RunPlan into the preview
// the CLI prints — which worker would actually run, availability/skip reasons, and a
// rough context-fit estimate — without spawning anything.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPlanView } from '../dist/registry.js';

const plan = {
  tierName: 't', fallback: 'auto',
  candidates: [
    // first listed is NOT runnable (breaker open) — must be skipped as "would run"
    { workerId: 'w1', available: false, skipReason: 'breaker-open (retry in 8m)' },
    { workerId: 'w2', available: true, providerId: 'zai',
      worker: { provider: 'zai', model: 'glm-5.2', runtime: 'claude', contextWindow: 200000, price: { inPerMtok: 0.5, outPerMtok: 1.5 } },
      provider: { kind: 'anthropic-compatible' } },
  ],
};

test('would run the first AVAILABLE candidate, not the first listed', () => {
  const v = buildPlanView(plan, 'x'.repeat(400));
  assert.equal(v.selector, 'tier "t"');
  assert.equal(v.wouldRunWorkerId, 'w2');           // w1 is breaker-open
  assert.equal(v.candidates[0].available, false);
  assert.equal(v.candidates[0].skipReason, 'breaker-open (retry in 8m)');
  assert.equal(v.candidates[1].model, 'glm-5.2');
  assert.equal(v.candidates[1].pool, 'zai');
});

test('context-fit estimate: brief tokens vs the worker window', () => {
  const small = buildPlanView(plan, 'x'.repeat(400)); // ~100 tok
  assert.equal(small.briefEstTokens, 100);
  assert.equal(small.candidates[1].fitsContext, true);

  const huge = buildPlanView(plan, 'x'.repeat(1_000_000)); // ~250k tok > 200k window
  assert.equal(huge.candidates[1].fitsContext, false);
});

test('no brief → no fit estimate (chain still shown)', () => {
  const v = buildPlanView(plan);
  assert.equal(v.briefChars, undefined);
  assert.equal(v.candidates[1].fitsContext, undefined);
  assert.equal(v.wouldRunWorkerId, 'w2');
});

test('nothing available → wouldRun is undefined', () => {
  const dead = { tierName: 't', fallback: 'auto', candidates: [{ workerId: 'w1', available: false, skipReason: 'no key' }] };
  const v = buildPlanView(dead);
  assert.equal(v.wouldRunWorkerId, undefined);
});
