// `dlg undo` end-to-end (verification-model.md §4): an applied run must be
// reversible. Auto-apply a clean patch, then undo it and assert the main tree is back to
// baseline and the envelope no longer reads as applied. Driven through executeRun +
// undoRun with a stub runtime (no real CLI, no tokens).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-home-'));
const { executeRun, undoRun } = await import('../dist/runner.js');
const { _assumeBinariesForTest } = await import('../dist/registry.js');
_assumeBinariesForTest(['claude']);

function git(cwd, ...args) { execFileSync('git', args, { cwd, stdio: 'pipe' }); }

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-repo-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  return dir;
}

const BRIEF = '## Goal\nadd a file\n## Definition of done\nit exists\n';

function autoConfig() {
  return {
    version: 1,
    defaults: {
      policy: 'auto',
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

function cleanStub() {
  const script = `require('node:fs').writeFileSync('feature.js','module.exports=1\\n');process.stdout.write('done\\n');process.exit(0);`;
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

test('UNDO: an auto-applied run can be rolled back, restoring the main tree', async () => {
  const repo = makeRepo();
  const env = await executeRun({ tier: 't', brief: BRIEF, cwd: repo, policy: 'auto' }, autoConfig(), cleanStub());

  // Precondition: it auto-applied to the main tree.
  assert.equal(env.status, 'completed', env.stopReason);
  assert.equal(env.changes.applied, true, 'clean patch should auto-apply under policy=auto');
  assert.ok(fs.existsSync(path.join(repo, 'feature.js')), 'applied file is in the main tree');

  // Undo it.
  const undone = undoRun(env.runId);
  assert.equal(undone.changes.applied, false, 'envelope no longer reads as applied');
  assert.ok(!fs.existsSync(path.join(repo, 'feature.js')), 'the file is gone — main tree restored to baseline');
});

test('UNDO: refuses a run that was never applied', async () => {
  const repo = makeRepo();
  // policy=review → nothing auto-applies, so the run is completed-but-not-applied.
  const cfg = autoConfig(); cfg.defaults.policy = 'review';
  const env = await executeRun({ tier: 't', brief: BRIEF, cwd: repo, policy: 'review' }, cfg, cleanStub());
  assert.equal(env.changes.applied, false);

  assert.throws(() => undoRun(env.runId), /was not applied/, 'undo must refuse a run that was never applied');
});
