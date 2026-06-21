// In-attempt retry/backoff (ARCHITECTURE §5). Pure retryPlan matrix, then two
// end-to-end runs: transient-then-recover (retry succeeds) and always-transient
// (retries bounded, then fails). A spawn counter outside the worktree lets a stub
// behave differently across re-spawns without dirtying the diff.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-home-'));
const { executeRun } = await import('../dist/runner.js');
const { _assumeBinariesForTest } = await import('../dist/registry.js');
const { retryPlan } = await import('../dist/classify.js');
_assumeBinariesForTest(['claude', 'codex']);

// ---- pure decision matrix ----

const RETRIES = { rateLimit: 3, server: 2 };
const server = { class: 'server', transient: true };
const rl = (retryAfterMs) => ({ class: 'rate-limit', transient: true, retryAfterMs });
const auth = { class: 'auth', transient: false };

test('retryPlan: no failure / non-transient never retries', () => {
  assert.equal(retryPlan(null, true, 0, RETRIES, 30_000).retry, false);
  assert.equal(retryPlan(auth, true, 0, RETRIES, 30_000).retry, false);
});

test('retryPlan: a transient failure with an empty patch retries within the cap', () => {
  assert.equal(retryPlan(server, true, 0, RETRIES, 30_000).retry, true);
  assert.equal(retryPlan(server, true, 1, RETRIES, 30_000).retry, true);
  assert.equal(retryPlan(server, true, 2, RETRIES, 30_000).retry, false); // cap (server=2) reached
});

test('retryPlan: a non-empty patch is never retried (work is not reproducible)', () => {
  assert.equal(retryPlan(server, false, 0, RETRIES, 30_000).retry, false);
});

test('retryPlan: rate-limit uses its own (larger) cap and honors Retry-After', () => {
  assert.equal(retryPlan(rl(), true, 2, RETRIES, 30_000).retry, true); // server would be done; rateLimit cap is 3
  const p = retryPlan(rl(8_000), true, 0, RETRIES, 30_000);
  assert.ok(p.delayMs >= 8_000, `honors Retry-After (${p.delayMs})`);
});

test('retryPlan: respects the remaining wall-clock budget', () => {
  assert.equal(retryPlan(server, true, 0, RETRIES, 1_500).retry, false); // < 2s left → not worth it
  const p = retryPlan(rl(50_000), true, 0, RETRIES, 10_000);
  assert.ok(p.retry && p.delayMs <= 9_000, `delay clamped under remaining (${p.delayMs})`);
});

// ---- end-to-end ----

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

// A stub that counts its spawns via an external file (so the count survives a
// re-spawn and never touches the worktree diff). `recoverAt` = the spawn index at
// which it starts succeeding; Infinity = always fails with a transient 503.
function countingStub(counterFile, recoverAt) {
  const cf = JSON.stringify(counterFile);
  const script =
    `const fs=require('node:fs');` +
    `let n=0;try{n=parseInt(fs.readFileSync(${cf},'utf8'))||0}catch{}` +
    `fs.writeFileSync(${cf},String(n+1));` +
    `if(n>=${recoverAt}){fs.writeFileSync('out.txt','recovered');process.stdout.write('ok\\n');process.exit(0);}` +
    `process.stderr.write('API Error: 503 Service Unavailable\\n');process.exit(1);`;
  return {
    id: 'counting', binary: 'node',
    buildSpawn: (ctx) => ({ command: 'node', args: ['-e', script], env: {}, cwd: ctx.worktree, stdinData: ctx.brief }),
    parseLine: (line, stream) => ({ ts: Date.now(), stream, kind: 'output', raw: line }),
    finalSummary: (tail) => tail || 'counting',
    finalUsage: () => ({}),
  };
}

function cfgWith(retries) {
  return {
    version: 1,
    defaults: {
      policy: 'review', budget: { wallClockMs: 30_000 },
      checkpointSeconds: 90, stallSeconds: 120, silenceKillSeconds: 300,
      keepRuns: 50, queueTimeoutSeconds: 5, queuePollSeconds: 1,
      autoApply: { maxFiles: 10, maxLines: 400 },
      retries,
      breaker: { failures: 99, cooldownMs: 600_000 }, // high, so the breaker never interferes here
      keyCooldownMs: 900_000,
    },
    privacy: { sensitivePaths: [] },
    providers: { anth: { kind: 'anthropic', auth: 'subscription' } },
    workers: { w1: { provider: 'anth', model: 'm1', runtime: 'claude' } },
    tiers: {},
  };
}

const BRIEF = '## Goal\nwrite out.txt\n## Definition of done\nout.txt exists\n';

test('a transient 503 with no work is retried, and the retry completes', async () => {
  const repo = makeRepo();
  const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-cnt-')), 'n');
  const runtimes = { claude: countingStub(counter, 1) }; // fail once, then recover

  const env = await executeRun({ workerId: 'w1', brief: BRIEF, cwd: repo, policy: 'review' }, cfgWith({ rateLimit: 3, server: 2 }), runtimes);

  assert.equal(env.status, 'completed', env.stopReason);
  assert.ok(env.changes.filesTouched.includes('out.txt'));
  assert.equal(Number(fs.readFileSync(counter, 'utf8')), 2, 'worker spawned twice (1 failure + 1 retry)');
});

test('a persistent transient failure exhausts the bounded retries then fails', async () => {
  const repo = makeRepo();
  const counter = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-cnt-')), 'n');
  const runtimes = { claude: countingStub(counter, Infinity) }; // never recovers

  const env = await executeRun({ workerId: 'w1', brief: BRIEF, cwd: repo, policy: 'review' }, cfgWith({ rateLimit: 3, server: 1 }), runtimes);

  assert.equal(env.status, 'failed');
  assert.equal(env.errors[0].type, 'server');
  assert.equal(Number(fs.readFileSync(counter, 'utf8')), 2, 'initial spawn + exactly 1 retry (server cap = 1)');
});
