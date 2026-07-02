import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-council-run-'));

const root = path.resolve('.');
const { runCouncil } = await import('../dist/council.js');
const { _assumeBinariesForTest } = await import('../dist/registry.js');

_assumeBinariesForTest(['node']);

function git(cwd, ...args) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-council-repo-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  return dir;
}

function makePlainDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-council-plain-'));
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n');
  return dir;
}

function baseConfig(extra = {}) {
  const long = `${'x'.repeat(9500)}TAIL-SURVIVES`;
  return {
    version: 1,
    defaults: {
      policy: 'review',
      budget: { wallClockMs: 30_000 },
      checkpointSeconds: 90, stallSeconds: 120, silenceKillSeconds: 300,
      keepRuns: extra.keepRuns ?? 50, queueTimeoutSeconds: 5, queuePollSeconds: 1,
      autoApply: { maxFiles: 10, maxLines: 400 },
      retries: { rateLimit: 0, server: 0 },
      breaker: { failures: 3, cooldownMs: 600_000 },
      keyCooldownMs: 900_000,
    },
    privacy: { sensitivePaths: [] },
    runtimes: {
      a: {
        mode: 'command',
        command: 'node',
        args: ['-e', `process.stdout.write(${JSON.stringify(long)});`],
        prompt: { mode: 'stdin' },
        parser: 'builtin:generic-lines',
      },
      b: {
        mode: 'command',
        command: 'node',
        args: ['-e', "process.stdout.write('short answer');"],
        prompt: { mode: 'stdin' },
        parser: 'builtin:generic-lines',
      },
      broken: {
        mode: 'command',
        command: 'node',
        args: ['-e', "process.stderr.write('broken worker\\n');process.exit(9);"],
        prompt: { mode: 'stdin' },
        parser: 'builtin:generic-lines',
      },
    },
    providers: {
      p: { kind: 'openai-compatible', protocol: 'none', auth: 'none' },
    },
    workers: {
      a: { provider: 'p', model: 'unused', runtime: 'a' },
      b: { provider: 'p', model: 'unused', runtime: 'b' },
      broken: { provider: 'p', model: 'unused', runtime: 'broken' },
    },
    tiers: {},
  };
}

test('runCouncil gathers full answers, bundle, and usage from two workers', async () => {
  const env = await runCouncil({
    task: 'answer',
    cwd: makeRepo(),
    options: {
      models: [{ handle: 'a' }, { handle: 'b' }],
      minProposers: 2,
      maxRetriesPerWorker: 0,
    },
  }, baseConfig());

  assert.equal(env.candidates.length, 2);
  assert.equal(env.quorumMet, true);
  assert.equal(env.usage.calls, 2);
  assert.ok(env.candidates[0].answer.endsWith('TAIL-SURVIVES'));
  assert.ok(env.bundle.includes('TAIL-SURVIVES'));
});

test('runCouncil keeps failed workers as candidates and returns degraded result', async () => {
  const env = await runCouncil({
    task: 'answer',
    cwd: makeRepo(),
    options: {
      models: [{ handle: 'a' }, { handle: 'broken' }],
      minProposers: 2,
      maxRetriesPerWorker: 0,
    },
  }, baseConfig());

  assert.equal(env.candidates.length, 2);
  assert.equal(env.candidates.find((c) => c.workerId === 'broken').status, 'failed');
  assert.equal(env.quorumMet, false);
  assert.equal(env.stopReason, 'degraded');
  assert.match(env.warnings.join('\n'), /quorum not met/);
});

test('runCouncil works in a non-git directory', async () => {
  const env = await runCouncil({
    task: 'answer',
    cwd: makePlainDir(),
    options: {
      models: [{ handle: 'a' }, { handle: 'b' }],
      minProposers: 2,
      maxRetriesPerWorker: 0,
    },
  }, baseConfig());

  assert.equal(env.candidates.length, 2);
  assert.ok(env.candidates.every((c) => c.answer.trim()));
});

test('runCouncil retries a failed worker when requested', async () => {
  const env = await runCouncil({
    task: 'answer',
    cwd: makeRepo(),
    options: {
      models: [{ handle: 'a' }, { handle: 'broken' }],
      minProposers: 2,
      maxRetriesPerWorker: 1,
    },
  }, baseConfig());

  assert.equal(env.candidates.find((c) => c.workerId === 'broken').attempts, 2);
});

test('runCouncil defers pruning until both worker envelopes are readable', async () => {
  const env = await runCouncil({
    task: 'answer',
    cwd: makeRepo(),
    options: {
      models: [{ handle: 'a' }, { handle: 'b' }],
      minProposers: 2,
      maxRetriesPerWorker: 0,
    },
  }, baseConfig({ keepRuns: 1 }));

  assert.equal(env.candidates.length, 2);
  assert.ok(env.candidates.some((c) => c.answer.endsWith('TAIL-SURVIVES')));
  assert.ok(env.candidates.some((c) => c.answer === 'short answer'));
});

test('dlg council rejects a single worker list', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-council-cli-'));
  fs.writeFileSync(path.join(home, 'providers.yaml'), [
    'version: 1',
    'defaults:',
    '  budget: { wallClock: 10m }',
    'privacy:',
    '  sensitivePaths: []',
    'providers:',
    '  p: { kind: openai-compatible, protocol: none, auth: none }',
    'workers: {}',
    'tiers: {}',
    '',
  ].join('\n'), 'utf8');

  const r = spawnSync(process.execPath, [path.join(root, 'dist', 'cli.js'), 'council', '-w', 'a', '-m', 'x'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', DELEGATOR_HOME: home },
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /at least 2 different models/);
});

test('runCouncil --aggregate runs one more worker over the bundle and attaches final', async () => {
  const env = await runCouncil({
    task: 'answer',
    cwd: makeRepo(),
    options: {
      models: [{ handle: 'a' }, { handle: 'b' }],
      minProposers: 2,
      maxRetriesPerWorker: 0,
    },
    aggregateWith: 'b',
  }, baseConfig());

  assert.equal(env.final?.workerId, 'b');
  assert.equal(env.final?.answer, 'short answer');
  // The aggregate is a paid call: counted in totals, but NOT a candidate.
  assert.equal(env.usage.calls, 3);
  assert.equal(env.candidates.length, 2);
});

test('a failed aggregate never masquerades as final synthesis', async () => {
  const env = await runCouncil({
    task: 'answer',
    cwd: makeRepo(),
    options: {
      models: [{ handle: 'a' }, { handle: 'b' }],
      minProposers: 2,
      maxRetriesPerWorker: 0,
    },
    aggregateWith: 'broken',
  }, baseConfig());

  assert.equal(env.final, undefined);
  assert.match(env.warnings.join('\n'), /aggregate broken:/);
  // Still a paid call even though it produced nothing usable.
  assert.equal(env.usage.calls, 3);
});

test('runCouncil fails fast on an unknown worker handle instead of degrading', async () => {
  await assert.rejects(
    runCouncil({
      task: 'answer',
      cwd: makeRepo(),
      options: {
        models: [{ handle: 'a' }, { handle: 'no-such-worker' }],
        minProposers: 2,
        maxRetriesPerWorker: 0,
      },
    }, baseConfig()),
    (e) => /no-such-worker/.test(String(e && e.message)),
  );
});
