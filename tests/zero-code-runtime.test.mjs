import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-zero-code-'));

const { executeRun } = await import('../dist/runner.js');
const { _assumeBinariesForTest } = await import('../dist/registry.js');

_assumeBinariesForTest(['node']);

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-zero-code-repo-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  return dir;
}

function baseConfig(keepRuns = 50) {
  const script = "require('node:fs').writeFileSync('zero-code.txt','ok\\n');process.stdout.write('zero-code runtime completed\\n');";
  return {
    version: 1,
    defaults: {
      policy: 'review',
      budget: { wallClockMs: 30_000 },
      checkpointSeconds: 90, stallSeconds: 120, silenceKillSeconds: 300,
      keepRuns, queueTimeoutSeconds: 5, queuePollSeconds: 1,
      autoApply: { maxFiles: 10, maxLines: 400 },
      retries: { rateLimit: 0, server: 0 },
      breaker: { failures: 3, cooldownMs: 600_000 },
      keyCooldownMs: 900_000,
    },
    privacy: { sensitivePaths: [] },
    runtimes: {
      'echo-lines': {
        mode: 'command',
        command: 'node',
        args: ['-e', script],
        prompt: { mode: 'stdin' },
        parser: 'builtin:generic-lines',
      },
    },
    providers: {
      echo: { kind: 'openai-compatible', protocol: 'none', auth: 'none' },
    },
    workers: {
      echoer: { provider: 'echo', model: 'unused', runtime: 'echo-lines' },
    },
    tiers: {},
  };
}

test('executeRun: config-declared shell runtime runs with zero adapter code', async () => {
  const repo = makeRepo();
  const env = await executeRun(
    { workerId: 'echoer', brief: 'write one file', cwd: repo, policy: 'review' },
    baseConfig(),
  );

  assert.equal(env.status, 'completed', env.stopReason);
  assert.equal(env.runtime, 'echo-lines');
  assert.ok(env.changes.filesTouched.includes('zero-code.txt'));
  assert.equal(env.summary, 'zero-code runtime completed');
});

test('executeRun: skipPrune lets fan-out callers gather sibling results before retention', async () => {
  {
    const repo = makeRepo();
    const first = await executeRun(
      { workerId: 'echoer', brief: 'write one file', cwd: repo, policy: 'review' },
      baseConfig(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    await executeRun(
      { workerId: 'echoer', brief: 'write one file', cwd: repo, policy: 'review' },
      baseConfig(1),
    );
    assert.equal(fs.existsSync(path.dirname(first.logsPath)), false, 'older done run is pruned normally');
  }

  {
    const repo = makeRepo();
    const first = await executeRun(
      { workerId: 'echoer', brief: 'write one file', cwd: repo, policy: 'review', skipPrune: true },
      baseConfig(1),
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await executeRun(
      { workerId: 'echoer', brief: 'write one file', cwd: repo, policy: 'review', skipPrune: true },
      baseConfig(1),
    );
    assert.equal(fs.existsSync(path.dirname(first.logsPath)), true, 'first sibling survives deferred prune');
    assert.equal(fs.existsSync(path.dirname(second.logsPath)), true, 'second sibling survives deferred prune');
  }
});
