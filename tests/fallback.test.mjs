// tier.fallback: auto auto-advance (ARCHITECTURE §5). End-to-end through executeRun
// with INJECTED stub runtimes (node one-liners) — no real CLI, no API calls, no
// tokens. Proves: a provider-class failure (429) falls over to the next worker, a
// task/code failure does not, `report` never advances, and the envelope records
// the full chain (no silent substitution).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-home-'));
const { executeRun } = await import('../dist/runner.js');
const { _assumeBinariesForTest } = await import('../dist/registry.js');
const { descriptorToAdapter } = await import('../dist/runtimes/factory.js');
const { mergedRuntimeDescriptors } = await import('../dist/config.js');
const opencodeRuntime = descriptorToAdapter('opencode', mergedRuntimeDescriptors({}).opencode);
_assumeBinariesForTest(['claude', 'codex', 'opencode']); // gate only; the stubs spawn `node`, never these

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

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

// A stub runtime: a node one-liner that writes a file and/or prints to std*, then
// exits with a chosen code. buildSpawn runs in the worktree (cwd), so writeFile
// produces a real diff the core will collect.
function stubRuntime(id, { stderr = '', stdout = '', exit = 0, writeFile = null }) {
  const lines = [];
  if (writeFile) lines.push(`require('node:fs').writeFileSync(${JSON.stringify(writeFile)},'from ${id}');`);
  if (stdout) lines.push(`process.stdout.write(${JSON.stringify(stdout)});`);
  if (stderr) lines.push(`process.stderr.write(${JSON.stringify(stderr)});`);
  lines.push(`process.exit(${exit});`);
  const script = lines.join('');
  return {
    id, binary: 'node',
    buildSpawn: (ctx) => ({ command: 'node', args: ['-e', script], env: {}, cwd: ctx.worktree, stdinData: ctx.brief }),
    parseLine: (line, stream) => ({ ts: Date.now(), stream, kind: 'output', raw: line }),
    finalSummary: (tail) => tail || `summary ${id}`,
    finalUsage: () => ({}),
  };
}

const BRIEF = '## Goal\nwrite out.txt\n## Definition of done\nout.txt exists\n';

function baseConfig(tiers) {
  return {
    version: 1,
    defaults: {
      policy: 'review',
      budget: { wallClockMs: 30_000 },
      checkpointSeconds: 90, stallSeconds: 120, silenceKillSeconds: 300,
      keepRuns: 50, queueTimeoutSeconds: 5, queuePollSeconds: 1,
      autoApply: { maxFiles: 10, maxLines: 400 },
      retries: { rateLimit: 0, server: 0 }, // isolate fallover from in-attempt retry (tested separately)
      breaker: { failures: 3, cooldownMs: 600_000 },
      keyCooldownMs: 900_000,
    },
    privacy: { sensitivePaths: [] },
    providers: {
      anth: { kind: 'anthropic', auth: 'subscription' },
      cdx: { kind: 'codex-cli', auth: 'subscription' },
    },
    workers: {
      w1: { provider: 'anth', model: 'm1', runtime: 'claude' },
      w2: { provider: 'cdx', model: 'm2', runtime: 'codex' },
    },
    tiers,
  };
}

const RATE_LIMIT = 'API Error: 429 {"type":"rate_limit_error","message":"slow down"}\n';
const OPENCODE_401 = JSON.stringify({
  type: 'error',
  timestamp: 1781800023173,
  sessionID: 'ses_test',
  error: {
    name: 'APIError',
    data: {
      message: 'Unauthorized: unauthorized: AuthenticateToken authentication failed',
      statusCode: 401,
      responseBody: 'unauthorized: unauthorized: AuthenticateToken authentication failed\n',
    },
  },
}) + '\n';

function opencodeErrorRuntime(stdout) {
  return {
    ...opencodeRuntime,
    binary: 'node',
    buildSpawn: (ctx) => ({ command: 'node', args: ['-e', `process.stdout.write(${JSON.stringify(stdout)});`], env: {}, cwd: ctx.worktree }),
  };
}

test('auto fallback: 429 on the first worker advances to the second, which completes', async () => {
  const repo = makeRepo();
  const cfg = baseConfig({ t: { chain: ['w1', 'w2'], fallback: 'auto' } });
  const runtimes = {
    claude: stubRuntime('w1', { stderr: RATE_LIMIT, exit: 1 }),
    codex: stubRuntime('w2', { writeFile: 'out.txt', stdout: 'done\n', exit: 0 }),
  };

  const env = await executeRun({ tier: 't', brief: BRIEF, cwd: repo, policy: 'review' }, cfg, runtimes);

  assert.equal(env.status, 'completed', env.stopReason);
  assert.equal(env.workerId, 'w2', 'the worker that ran is recorded, not the first one');
  assert.ok(env.changes.filesTouched.includes('out.txt'));
  assert.ok(Array.isArray(env.attempts) && env.attempts.length === 2, 'both attempts recorded');
  assert.equal(env.attempts[0].workerId, 'w1');
  assert.equal(env.attempts[0].outcome, 'failed-over');
  assert.equal(env.attempts[0].errType, 'rate-limit');
  assert.equal(env.attempts[1].workerId, 'w2');
  assert.equal(env.attempts[1].outcome, 'ran');
  assert.equal(env.attempts[1].status, 'completed');
});

test('auto fallback: opencode type:error with exit 0 is classified as provider auth failure', async () => {
  const repo = makeRepo();
  const cfg = baseConfig({ t: { chain: ['oc1', 'w2'], fallback: 'auto' } });
  cfg.providers.oc = { kind: 'opencode', auth: 'subscription' };
  cfg.workers.oc1 = { provider: 'oc', model: 'github-copilot/gpt-5.5', runtime: 'opencode' };
  const runtimes = {
    opencode: opencodeErrorRuntime(OPENCODE_401),
    codex: stubRuntime('w2', { writeFile: 'out.txt', stdout: 'done\n', exit: 0 }),
  };

  const env = await executeRun({ tier: 't', brief: BRIEF, cwd: repo, policy: 'review' }, cfg, runtimes);

  assert.equal(env.status, 'completed', env.stopReason);
  assert.equal(env.workerId, 'w2', 'the opencode provider error should fall over to the next worker');
  assert.equal(env.attempts[0].workerId, 'oc1');
  assert.equal(env.attempts[0].outcome, 'failed-over');
  assert.equal(env.attempts[0].errType, 'auth');
  assert.equal(env.attempts[1].workerId, 'w2');
  assert.equal(env.attempts[1].outcome, 'ran');
});

test('a task/code crash does NOT fall over (fallback is for provider failures only)', async () => {
  const repo = makeRepo();
  const cfg = baseConfig({ t: { chain: ['w1', 'w2'], fallback: 'auto' } });
  const runtimes = {
    // Non-zero exit with NO provider signature → worker-crash, not a provider class.
    claude: stubRuntime('w1', { stderr: 'TypeError: boom\n', exit: 1 }),
    codex: stubRuntime('w2', { writeFile: 'out.txt', exit: 0 }),
  };

  const env = await executeRun({ tier: 't', brief: BRIEF, cwd: repo, policy: 'review' }, cfg, runtimes);

  assert.equal(env.status, 'failed');
  assert.equal(env.workerId, 'w1', 'stayed on the first worker — a crash is the Brain\'s call');
  assert.equal(env.errors[0].type, 'worker-crash');
});

test('fallback: report never auto-advances even on a 429', async () => {
  const repo = makeRepo();
  const cfg = baseConfig({ t: { chain: ['w1', 'w2'], fallback: 'report' } });
  const runtimes = {
    claude: stubRuntime('w1', { stderr: RATE_LIMIT, exit: 1 }),
    codex: stubRuntime('w2', { writeFile: 'out.txt', exit: 0 }),
  };

  const env = await executeRun({ tier: 't', brief: BRIEF, cwd: repo, policy: 'review' }, cfg, runtimes);

  assert.equal(env.status, 'failed');
  assert.equal(env.workerId, 'w1', 'report leaves the choice to the Brain');
  assert.equal(env.errors[0].type, 'rate-limit');
});

test('auto fallback exhausts the chain: last worker\'s result stands', async () => {
  const repo = makeRepo();
  const cfg = baseConfig({ t: { chain: ['w1', 'w2'], fallback: 'auto' } });
  const runtimes = {
    claude: stubRuntime('w1', { stderr: RATE_LIMIT, exit: 1 }),
    codex: stubRuntime('w2', { stderr: 'fetch failed: ECONNREFUSED\n', exit: 1 }),
  };

  const env = await executeRun({ tier: 't', brief: BRIEF, cwd: repo, policy: 'review' }, cfg, runtimes);

  assert.equal(env.status, 'failed');
  assert.equal(env.workerId, 'w2', 'the last worker tried is the recorded result');
  assert.equal(env.errors[0].type, 'server');
  assert.equal(env.attempts.length, 2);
  assert.equal(env.attempts[0].outcome, 'failed-over'); // w1 (rate-limit)
  assert.equal(env.attempts[1].outcome, 'ran');         // w2 (server), no one left to try
});
