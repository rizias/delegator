import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-home-'));
process.env.DELEGATOR_HOME = home;
const { executeRun } = await import('../dist/runner.js');
const { _assumeBinariesForTest } = await import('../dist/registry.js');
const { projectKey } = await import('../dist/paths.js');
_assumeBinariesForTest(['claude']); // gate only; stubs spawn `node`, never claude

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

const BRIEF = '## Goal\nwrite specs\n## Definition of done\nfiles exist\n';

function baseConfig(tiers) {
  return {
    version: 1,
    defaults: {
      policy: 'review',
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
    tiers,
  };
}

function runtimeWritingScript(script) {
  return {
    id: 'w1', binary: 'node',
    buildSpawn: (ctx) => ({ command: 'node', args: ['-e', script], env: {}, cwd: ctx.worktree, stdinData: ctx.brief }),
    parseLine: (line, stream) => ({ ts: Date.now(), stream, kind: 'output', raw: line }),
    finalSummary: (tail) => tail || 'summary w1',
    finalUsage: () => ({}),
  };
}

test('run state and worktree live under ~/.delegator/projects/<project-key>/<runId>', async () => {
  const repo = makeRepo();
  const oldInRepoRuntime = path.join(repo, '.delegator', 'worktrees', 'old');
  fs.mkdirSync(oldInRepoRuntime, { recursive: true });
  const cfg = baseConfig({ t: { chain: ['w1'], fallback: 'report' } });
  cfg.defaults.worktreeRetention = 'keep'; // this test asserts the worktree LOCATION, so it must survive
  const script = `require('node:fs').writeFileSync('out.txt','ok');process.stdout.write('done\\n');process.exit(0);`;

  const env = await executeRun({ tier: 't', brief: BRIEF, cwd: repo, policy: 'review' }, cfg, {
    claude: runtimeWritingScript(script),
  });

  const runRoot = path.join(home, 'projects', projectKey(repo), env.runId);
  assert.equal(env.status, 'completed', env.stopReason);
  assert.equal(env.worktree, path.join(runRoot, 'worktree'));
  assert.equal(env.logsPath, path.join(runRoot, 'events.jsonl'));
  assert.equal(env.changes.patchFile, path.join(runRoot, 'patch.diff'));
  assert.ok(fs.existsSync(path.join(runRoot, 'meta.json')));
  assert.ok(fs.existsSync(path.join(runRoot, 'envelope.json')));
  assert.ok(fs.existsSync(path.join(runRoot, 'brief.md')));
  assert.ok(fs.existsSync(oldInRepoRuntime), 'old in-repo runtime dirs are ignored, not migrated or removed');
  assert.deepEqual(fs.readdirSync(path.join(repo, '.delegator', 'worktrees')), ['old']);
});

test('worktreeRetention keep-unfinished (default): a completed run drops its checkout but keeps patch.diff', async () => {
  const repo = makeRepo();
  const cfg = baseConfig({ t: { chain: ['w1'], fallback: 'report' } }); // no override -> product default keep-unfinished
  const script = `require('node:fs').writeFileSync('out.txt','ok');process.stdout.write('done\\n');process.exit(0);`;

  const env = await executeRun({ tier: 't', brief: BRIEF, cwd: repo, policy: 'review' }, cfg, {
    claude: runtimeWritingScript(script),
  });

  const runRoot = path.join(home, 'projects', projectKey(repo), env.runId);
  assert.equal(env.status, 'completed', env.stopReason);
  assert.equal(env.worktree, undefined, 'completed run must not retain its heavy checkout by default');
  assert.ok(!fs.existsSync(path.join(runRoot, 'worktree')), 'worktree dir is reclaimed');
  assert.ok(fs.existsSync(path.join(runRoot, 'patch.diff')), 'patch.diff persists so `dlg apply` still works');
  assert.ok(fs.existsSync(path.join(runRoot, 'envelope.json')), 'receipt persists');
});

test('worktreeRetention keep-unfinished: a failed run KEEPS its checkout (recoverable)', async () => {
  const repo = makeRepo();
  const cfg = baseConfig({ t: { chain: ['w1'], fallback: 'report' } });
  const script = `process.stderr.write('boom\\n');process.exit(1);`; // non-zero exit, no output -> not completed

  const env = await executeRun({ tier: 't', brief: BRIEF, cwd: repo, policy: 'review' }, cfg, {
    claude: runtimeWritingScript(script),
  });

  const runRoot = path.join(home, 'projects', projectKey(repo), env.runId);
  assert.notEqual(env.status, 'completed', `expected a non-completed status, got ${env.status}`);
  assert.equal(env.worktree, path.join(runRoot, 'worktree'), 'an unfinished run retains its checkout for inspection/resume');
  assert.ok(fs.existsSync(path.join(runRoot, 'worktree')), 'worktree dir is kept');
});

test('main repo dirt during a run is not treated as an isolation-escape failure', async () => {
  const repo = makeRepo();
  const cfg = baseConfig({ t: { chain: ['w1'], fallback: 'report' } });
  const escaped = path.join(repo, 'main-tree-write.txt');
  const script =
    `require('node:fs').writeFileSync(${JSON.stringify(escaped)},'outside');` +
    `process.stdout.write('done\\n');process.exit(0);`;

  const env = await executeRun({ tier: 't', brief: BRIEF, cwd: repo, policy: 'review' }, cfg, {
    claude: runtimeWritingScript(script),
  });

  assert.equal(env.status, 'completed', env.stopReason);
  assert.ok(!env.errors.some((e) => e.type === 'isolation-escape'));
  assert.equal(env.changes.filesTouched.length, 0);
});
