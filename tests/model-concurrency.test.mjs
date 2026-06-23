// Per-model limits.concurrent gate (nested under the provider maxConcurrent gate).
// Proves three things end-to-end through executeRun:
//  (a) a model with limits.concurrent:1 serializes its OWN runs — a 2nd concurrent
//      run of that model queues and is `rejected` on the queue timeout;
//  (b) the provider-level maxConcurrent gate still works (unchanged);
//  (c) a model with NO limits.concurrent is unbounded at the model level — it does
//      NOT queue behind a different model's model-scoped slot.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-home-'));
const { executeRun } = await import('../dist/runner.js');
const { _assumeBinariesForTest } = await import('../dist/registry.js');
_assumeBinariesForTest(['claude']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function git(cwd, ...args) { execFileSync('git', args, { cwd, stdio: 'pipe' }); }
function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-repo-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@e.com');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  return dir;
}

// A spawn-runtime stub whose worker sleeps a duration chosen by MODEL, then exits 0.
// Both runs share runtime 'claude'; the hold time branches on the model id so a
// single stub serves several workers. The slot is held for the whole sleep (the
// spawn path releases only after the process exits), which is exactly what we gate on.
function sleepByModelStub(holds) {
  const holdsJson = JSON.stringify(holds);
  const script =
    `const fs=require('node:fs');` +
    `const holds=${holdsJson};` +
    `const m=JSON.parse(process.env.DLG_TEST_MODEL||'"?"');` +
    `const ms=holds[m]??0;` +
    `setTimeout(()=>{fs.writeFileSync('out.txt','x');process.stdout.write('done\\n');process.exit(0);},ms);`;
  return {
    id: 'sleep', binary: 'node',
    buildSpawn: (ctx) => ({
      command: 'node', args: ['-e', script],
      env: { DLG_TEST_MODEL: JSON.stringify(ctx.resolved.worker.model ?? '?') },
      cwd: ctx.worktree, stdinData: ctx.brief,
    }),
    parseLine: (line, stream) => ({ ts: Date.now(), stream, kind: 'output', raw: line }),
    finalSummary: (tail) => tail || 'sleep',
    finalUsage: () => ({}),
  };
}

function cfg({ providerMax, workers }) {
  return {
    version: 1,
    defaults: {
      policy: 'review', budget: { wallClockMs: 60_000 },
      checkpointSeconds: 90, stallSeconds: 120, silenceKillSeconds: 300,
      keepRuns: 50, queueTimeoutSeconds: 1, queuePollSeconds: 0.05,
      autoApply: { maxFiles: 10, maxLines: 400 },
      retries: { rateLimit: 1, server: 1 },
      breaker: { failures: 99, cooldownMs: 600_000 },
      keyCooldownMs: 900_000,
    },
    privacy: { sensitivePaths: [] },
    providers: {
      anth: { kind: 'anthropic', auth: 'subscription', ...(providerMax !== undefined ? { maxConcurrent: providerMax } : {}) },
    },
    workers, tiers: {},
  };
}

const BRIEF = '## Goal\nwrite out.txt\n## Definition of done\nout.txt exists\n';

// (a) Model-level cap queues the extra run of the SAME model.
test('limits.concurrent serializes runs of one model (2nd queues → rejected)', async () => {
  const repo = makeRepo();
  const runtimes = { claude: sleepByModelStub({ m1: 2000 }) };
  const c = cfg({
    workers: {
      w1: { provider: 'anth', model: 'm1', runtime: 'claude', limits: { concurrent: 1 } },
    },
  });

  const aP = executeRun({ workerId: 'w1', brief: BRIEF, cwd: repo, policy: 'review' }, c, runtimes);
  await sleep(300); // let run A claim the model slot + spawn
  const start = Date.now();
  const b = await executeRun({ workerId: 'w1', brief: BRIEF, cwd: repo, policy: 'review' }, c, runtimes);
  const bElapsed = Date.now() - start;
  const a = await aP;

  assert.equal(a.status, 'completed', a.stopReason);
  assert.equal(b.status, 'rejected', `expected 2nd run to be rejected, got ${b.status}: ${b.stopReason}`);
  // The rejection must come from the MODEL gate (distinct reason), not a provider timeout.
  assert.match(b.stopReason, /model/, `model-scoped reason expected: ${b.stopReason}`);
  assert.ok(bElapsed < 1900, `2nd run must queue-timeout well before the 1st finishes (took ${bElapsed}ms)`);
});

// (b) Provider-level maxConcurrent gate is unchanged.
test('provider maxConcurrent still gates across models', async () => {
  const repo = makeRepo();
  const runtimes = { claude: sleepByModelStub({ m1: 2000, m2: 2000 }) };
  const c = cfg({
    providerMax: 1,
    workers: {
      w1: { provider: 'anth', model: 'm1', runtime: 'claude' }, // no model limit
      w2: { provider: 'anth', model: 'm2', runtime: 'claude' }, // no model limit
    },
  });

  const aP = executeRun({ workerId: 'w1', brief: BRIEF, cwd: repo, policy: 'review' }, c, runtimes);
  await sleep(300); // let run A claim the provider slot
  const b = await executeRun({ workerId: 'w2', brief: BRIEF, cwd: repo, policy: 'review' }, c, runtimes);
  const a = await aP;

  assert.equal(a.status, 'completed', a.stopReason);
  assert.equal(b.status, 'rejected', `2nd run must queue-timeout at the PROVIDER gate: ${b.stopReason}`);
  assert.doesNotMatch(b.stopReason, /model/, `must be a provider-scope timeout, not model: ${b.stopReason}`);
});

// (c) A model with no limits.concurrent is unbounded at the model level and does
// NOT queue behind a different model's model-scoped slot.
test('a model without limits.concurrent does not queue behind another model slot', async () => {
  const repo = makeRepo();
  const runtimes = { claude: sleepByModelStub({ m1: 2000, m2: 300 }) };
  const c = cfg({
    workers: {
      w1: { provider: 'anth', model: 'm1', runtime: 'claude', limits: { concurrent: 1 } }, // gated, slow
      w2: { provider: 'anth', model: 'm2', runtime: 'claude' },                            // no model limit, fast
    },
  });

  // Saturate m1's model slot with a slow run, then run m2 concurrently.
  const aP = executeRun({ workerId: 'w1', brief: BRIEF, cwd: repo, policy: 'review' }, c, runtimes);
  await sleep(300); // let m1 claim its slot + spawn
  const start = Date.now();
  const b = await executeRun({ workerId: 'w2', brief: BRIEF, cwd: repo, policy: 'review' }, c, runtimes);
  const bElapsed = Date.now() - start;
  await aP;

  assert.equal(b.status, 'completed', b.stopReason);
  // m2 (300ms hold) must finish far inside m1's 2000ms hold → it did not wait on m1's slot.
  assert.ok(bElapsed < 1500, `m2 must not queue behind m1 (took ${bElapsed}ms; m1 holds 2000ms)`);
});

// (d) limits.concurrent declared UNDER the model (providers.x.models.y.limits) with a
// NAMED worker that has no own limits — the gate must STILL fire. This is the path the
// named-worker config-load merge does not copy, so the runner reads the model's config
// as a fallback. (Fails on a worker.limits-only reading; this locks in the fallback.)
test('limits.concurrent under the model gates a named worker with no own limits', async () => {
  const repo = makeRepo();
  const runtimes = { claude: sleepByModelStub({ m1: 2000 }) };
  const c = cfg({ workers: { w1: { provider: 'anth', model: 'm1', runtime: 'claude' } } });
  // Cap on the MODEL config (not the worker), like examples/providers.example.yaml.
  c.providers.anth.models = { m1: { limits: { concurrent: 1 } } };

  const aP = executeRun({ workerId: 'w1', brief: BRIEF, cwd: repo, policy: 'review' }, c, runtimes);
  await sleep(300);
  const start = Date.now();
  const b = await executeRun({ workerId: 'w1', brief: BRIEF, cwd: repo, policy: 'review' }, c, runtimes);
  const bElapsed = Date.now() - start;
  const a = await aP;

  assert.equal(a.status, 'completed', a.stopReason);
  assert.equal(b.status, 'rejected', `model-config cap must gate the named worker: ${b.stopReason}`);
  assert.match(b.stopReason, /model/, `model-scoped reason expected: ${b.stopReason}`);
  assert.ok(bElapsed < 1900, `2nd run must queue-timeout before the 1st finishes (took ${bElapsed}ms)`);
});
