// Frozen judge, end-to-end (verification-model.md §3). Verification runs
// INSIDE the worker's worktree, so a worker can edit the very test that judges it and
// turn a broken patch green. A run whose patch touches a judge file must come back
// `requires-review` — never a clean `completed`, and never auto-applied — with the
// patch + worktree kept for a human. Driven through executeRun with a stub runtime
// (no real CLI, no tokens), same harness as isolation.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-home-'));
const { executeRun } = await import('../dist/runner.js');
const { _assumeBinariesForTest } = await import('../dist/registry.js');
_assumeBinariesForTest(['claude']); // gate only; stubs spawn `node`, never claude

function git(cwd, ...args) { execFileSync('git', args, { cwd, stdio: 'pipe' }); }

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-repo-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'app.test.js'), 'assert(add(2,2) === 4)\n'); // the judge, committed
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  return dir;
}

const BRIEF = '## Goal\nfix add()\n## Definition of done\ntests pass\n';

function baseConfig(policy) {
  return {
    version: 1,
    defaults: {
      policy,
      budget: { wallClockMs: 30_000 },
      checkpointSeconds: 90, stallSeconds: 120, silenceKillSeconds: 300,
      keepRuns: 50, queueTimeoutSeconds: 5, queuePollSeconds: 1,
      autoApply: { maxFiles: 10, maxLines: 400 },
      retries: { rateLimit: 0, server: 0 },
      breaker: { failures: 3, cooldownMs: 600_000 },
      keyCooldownMs: 900_000,
    },
    privacy: { sensitivePaths: [] },
    providers: { anth: { kind: 'anthropic', auth: 'subscription' } },
    workers: { w1: { provider: 'anth', model: 'm1', runtime: 'claude' } },
    tiers: { t: { chain: ['w1'], fallback: 'report' } },
  };
}

// A stub worker that "fixes" app.js but ALSO rewrites the test that judges it — the
// classic gaming move. Both writes are relative → land in the worktree (cwd).
function gamingStub() {
  const script =
    `const fs=require('node:fs');` +
    `fs.writeFileSync('app.js','function add(a,b){return a-b}');` + // still buggy
    `fs.writeFileSync('app.test.js','// assertions removed\\n');` +  // neutered its own judge
    `process.stdout.write('done\\n');process.exit(0);`;
  return {
    claude: {
      id: 'w1', binary: 'node',
      buildSpawn: (ctx) => ({ command: 'node', args: ['-e', script], env: {}, cwd: ctx.worktree, stdinData: ctx.brief }),
      parseLine: (line, stream) => ({ ts: Date.now(), stream, kind: 'output', raw: line }),
      finalSummary: (tail) => tail || 'summary w1',
      finalUsage: () => ({}),
    },
  };
}

test('FROZEN JUDGE: a worker that edits the test judging it → requires-review, not completed', async () => {
  const repo = makeRepo();
  const env = await executeRun({ tier: 't', brief: BRIEF, cwd: repo, policy: 'review' }, baseConfig('review'), gamingStub());

  assert.equal(env.status, 'requires-review', env.stopReason);
  const err = env.errors.find((e) => e.type === 'judge-tampered');
  assert.ok(err, 'a judge-tampered error must be present');
  assert.match(err.message, /app\.test\.js/, 'the tampered judge file is named');
  assert.ok(env.changes.filesTouched.includes('app.test.js'), 'the judge edit IS in the patch (kept for review)');
  assert.ok(env.worktree, 'the worktree is kept so a human can inspect');
  assert.match(env.stopReason, /review/i);
});

test('FROZEN JUDGE: a requires-review run is never auto-applied (policy=auto)', async () => {
  const repo = makeRepo();
  const env = await executeRun({ tier: 't', brief: BRIEF, cwd: repo, policy: 'auto' }, baseConfig('auto'), gamingStub());

  assert.equal(env.status, 'requires-review', env.stopReason);
  assert.equal(env.changes.applied, false, 'a gamed-judge patch must NOT auto-apply, even under policy=auto');
  // The main tree must be untouched by an auto-apply (only seed + the committed judge exist).
  assert.ok(!fs.existsSync(path.join(repo, 'app.js')), 'no patch was applied to the main tree');
});

test('NO false positive: a worker touching only source completes cleanly', async () => {
  const repo = makeRepo();
  const script = `require('node:fs').writeFileSync('app.js','function add(a,b){return a+b}');process.stdout.write('done\\n');process.exit(0);`;
  const runtimes = {
    claude: {
      id: 'w1', binary: 'node',
      buildSpawn: (ctx) => ({ command: 'node', args: ['-e', script], env: {}, cwd: ctx.worktree, stdinData: ctx.brief }),
      parseLine: (line, stream) => ({ ts: Date.now(), stream, kind: 'output', raw: line }),
      finalSummary: (tail) => tail || 'summary w1',
      finalUsage: () => ({}),
    },
  };
  const env = await executeRun({ tier: 't', brief: BRIEF, cwd: repo, policy: 'review' }, baseConfig('review'), runtimes);

  assert.equal(env.status, 'completed', env.stopReason);
  assert.ok(!env.errors.some((e) => e.type === 'judge-tampered'), 'editing only source must NOT trip the judge guard');
  assert.ok(env.changes.filesTouched.includes('app.js'));

  // Receipt / run identity (verification-model.md §4): the envelope names the exact base
  // commit and a hash of the exact patch bytes that were reviewed.
  assert.match(env.changes.baseCommit ?? '', /^[0-9a-f]{40}$/, 'baseCommit is the git HEAD sha the worktree branched from');
  assert.match(env.changes.patchSha256 ?? '', /^[0-9a-f]{64}$/, 'patchSha256 is a SHA-256 hex digest');
  const fileSha = createHash('sha256').update(fs.readFileSync(env.changes.patchFile, 'utf8')).digest('hex');
  assert.equal(env.changes.patchSha256, fileSha, 'patchSha256 is the hash of the saved patch bytes');
});
