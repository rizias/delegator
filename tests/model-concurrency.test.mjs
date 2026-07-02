// Per-model / per-provider concurrency gate, proven end-to-end through executeRun.
// Deterministic by construction: executeRun claims the provider + model slots BEFORE running the
// worker, so an in-process worker that blocks inside execute() provably HOLDS its slot until the test
// releases it. A contending run therefore always meets an occupied slot. No sleeps, no spawned worker,
// no wall-clock — only the gate's terminal status + stop-reason are asserted, and the reason is anchored
// on the exact queue-timeout wording so an unrelated rejection cannot pass. Each test uses its OWN
// provider id, so the lock scopes never overlap even when node:test runs the tests in parallel.
//
// Scope of this file: the acquire / queue / timeout / reject / compose-release LOGIC, which spawned and
// in-process workers share (the gate runs before the runtime branch). It does NOT cover spawn-only
// concerns — stale-lock reaping after a holder process crashes, or the pid liveness check for a lock
// owned by a DIFFERENT process — because every holder here shares this process's pid.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-home-'));
const { executeRun } = await import('../dist/runner.js');
const { _assumeBinariesForTest } = await import('../dist/registry.js');
_assumeBinariesForTest(['claude']);

const BRIEF = '## Goal\nwrite out.txt\n## Definition of done\nout.txt exists\n';
const T = { timeout: 10_000 }; // a broken gate must FAIL here, never hang the suite
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-conc-'));
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

// An in-process runtime (has `execute`, so the runner takes the no-spawn path). A worker whose model is
// in `gated` signals `entered` (its slot is now held) and blocks on `release`; any other model completes
// at once. queueTimeoutSeconds is small, so a run that meets a held slot rejects promptly — the holder
// stays put until the test releases it, so the rejection is guaranteed regardless of how slow the runner.
function holdingRuntime(gated) {
  return {
    id: 'claude',
    async execute(ctx) {
      const g = gated[ctx.resolved.worker.model];
      g?.entered.resolve();
      if (g) await g.release.promise;
      return { status: 'completed', summary: 'ok', stopReason: 'ok', errType: 'internal', failure: null };
    },
  };
}

function cfg(providerId, { providerMax, workers }) {
  return {
    version: 1,
    defaults: {
      policy: 'review', budget: { wallClockMs: 60_000 },
      checkpointSeconds: 90, stallSeconds: 120, silenceKillSeconds: 300,
      keepRuns: 50, queueTimeoutSeconds: 0.2, queuePollSeconds: 0.02,
      autoApply: { maxFiles: 10, maxLines: 400 },
      retries: { rateLimit: 1, server: 1 },
      breaker: { failures: 99, cooldownMs: 600_000 },
      keyCooldownMs: 900_000,
    },
    privacy: { sensitivePaths: [] },
    providers: {
      [providerId]: { kind: 'anthropic', auth: 'subscription', ...(providerMax !== undefined ? { maxConcurrent: providerMax } : {}) },
    },
    workers, tiers: {},
  };
}

const run = (c, runtimes, workerId, cwd) =>
  executeRun({ workerId, brief: BRIEF, cwd, policy: 'review' }, c, runtimes);

// Launch a worker and return { holder } once it PROVABLY holds its slot (execute() entered). The bare
// promise is wrapped so `await launchHolder(...)` resolves on the race, not by chaining the still-pending
// holder (which would deadlock). Both race branches RESOLVE — including the holder's REJECT arm — so no
// orphaned promise can turn a later holder rejection into an unhandled rejection.
async function launchHolder(c, runtimes, workerId, cwd, gate) {
  const holder = run(c, runtimes, workerId, cwd);
  const outcome = await Promise.race([
    gate.entered.promise.then(() => 'held'),
    holder.then((r) => `ended:${r.status}:${r.stopReason}`, (e) => `errored:${e?.message ?? e}`),
  ]);
  assert.equal(outcome, 'held', `holder ended before acquiring its slot (${outcome})`);
  return { holder };
}

// (a) A model cap serializes that model across DIFFERENT workers: a 2nd run on the SAME model (via a
// different worker id) is rejected. Two workers prove the scope is the model, not the worker.
test('limits.concurrent caps a model across workers (2nd run of that model is rejected)', T, async () => {
  const cwd = tmp();
  const gate = { entered: deferred(), release: deferred() };
  const runtimes = { claude: holdingRuntime({ m1: gate }) };
  const c = cfg('pa', { workers: {
    w1: { provider: 'pa', model: 'm1', runtime: 'claude', limits: { concurrent: 1 } },
    w2: { provider: 'pa', model: 'm1', runtime: 'claude', limits: { concurrent: 1 } },
  } });

  const { holder } = await launchHolder(c, runtimes, 'w1', cwd, gate);
  const b = await run(c, runtimes, 'w2', cwd);
  assert.equal(b.status, 'rejected', b.stopReason);
  assert.match(b.stopReason, /queue timeout: model/i, b.stopReason);

  gate.release.resolve();
  assert.equal((await holder).status, 'completed');
  // Normal completion must free the model slot too: a fresh run of the same model now succeeds.
  assert.equal((await run(c, runtimes, 'w1', cwd)).status, 'completed');
});

// (b) The provider cap gates a 2nd run across DIFFERENT models with a provider-scope timeout.
test('provider maxConcurrent gates a second run across different models', T, async () => {
  const cwd = tmp();
  const gate = { entered: deferred(), release: deferred() };
  const runtimes = { claude: holdingRuntime({ m1: gate }) };
  const c = cfg('pb', { providerMax: 1, workers: {
    w1: { provider: 'pb', model: 'm1', runtime: 'claude' },
    w2: { provider: 'pb', model: 'm2', runtime: 'claude' },
  } });

  const { holder } = await launchHolder(c, runtimes, 'w1', cwd, gate);
  const b = await run(c, runtimes, 'w2', cwd);
  assert.equal(b.status, 'rejected', b.stopReason);
  assert.match(b.stopReason, /queue timeout: scope/i, b.stopReason);   // provider scope, positively
  assert.doesNotMatch(b.stopReason, /model/i, b.stopReason);

  gate.release.resolve();
  assert.equal((await holder).status, 'completed');
});

// (c) A model with NO cap does not queue behind a different model's slot — it completes.
test('a model without limits.concurrent does not queue behind another model slot', T, async () => {
  const cwd = tmp();
  const gate = { entered: deferred(), release: deferred() };
  const runtimes = { claude: holdingRuntime({ m1: gate }) }; // m2 has no gate → completes at once
  const c = cfg('pc', { workers: {
    w1: { provider: 'pc', model: 'm1', runtime: 'claude', limits: { concurrent: 1 } },
    w2: { provider: 'pc', model: 'm2', runtime: 'claude' },
  } });

  const { holder } = await launchHolder(c, runtimes, 'w1', cwd, gate);
  const b = await run(c, runtimes, 'w2', cwd);
  assert.equal(b.status, 'completed', b.stopReason);

  gate.release.resolve();
  assert.equal((await holder).status, 'completed');
});

// (d) A cap declared under providers.x.models.y.limits (not on the worker) still gates a named worker.
test('limits.concurrent under the model config gates a named worker with no own limit', T, async () => {
  const cwd = tmp();
  const gate = { entered: deferred(), release: deferred() };
  const runtimes = { claude: holdingRuntime({ m1: gate }) };
  const c = cfg('pd', { workers: { w1: { provider: 'pd', model: 'm1', runtime: 'claude' } } });
  c.providers.pd.models = { m1: { limits: { concurrent: 1 } } };

  const { holder } = await launchHolder(c, runtimes, 'w1', cwd, gate);
  const b = await run(c, runtimes, 'w1', cwd);
  assert.equal(b.status, 'rejected', b.stopReason);
  assert.match(b.stopReason, /queue timeout: model/i, b.stopReason);

  gate.release.resolve();
  assert.equal((await holder).status, 'completed');
});

// (e) A model-slot timeout must RELEASE the provider slot the run briefly held (no leak). Provider has
// room for 2; model m1 is capped at 1. A 2nd m1 run takes a provider slot, then times out on the model
// slot — and must free that provider slot, proven by a different-model run still fitting under the cap.
test('a model-slot timeout releases the provider slot it briefly held', T, async () => {
  const cwd = tmp();
  const gate = { entered: deferred(), release: deferred() };
  const runtimes = { claude: holdingRuntime({ m1: gate }) };
  const c = cfg('pe', { providerMax: 2, workers: {
    w1:  { provider: 'pe', model: 'm1', runtime: 'claude', limits: { concurrent: 1 } },
    w1b: { provider: 'pe', model: 'm1', runtime: 'claude', limits: { concurrent: 1 } },
    w2:  { provider: 'pe', model: 'm2', runtime: 'claude' },
  } });

  const { holder } = await launchHolder(c, runtimes, 'w1', cwd, gate);
  const contended = await run(c, runtimes, 'w1b', cwd); // takes provider slot 2, times out on m1
  assert.equal(contended.status, 'rejected', contended.stopReason);
  assert.match(contended.stopReason, /queue timeout: model/i, contended.stopReason);
  // If w1b had leaked its provider slot the provider would be full (2/2) and this would time out too.
  const other = await run(c, runtimes, 'w2', cwd);
  assert.equal(other.status, 'completed', other.stopReason);

  gate.release.resolve();
  assert.equal((await holder).status, 'completed');
});
