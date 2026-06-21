import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';

const { descriptorToAdapter } = await import('../dist/runtimes/factory.js');
const { mergedRuntimeDescriptors } = await import('../dist/config.js');
process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-codex-runtime-'));
const codexRuntime = descriptorToAdapter('codex', mergedRuntimeDescriptors({}).codex);

function cxCtx(workerOver) {
  return {
    brief: 'b',
    worktree: 'wt',
    budget: { wallClockMs: 1000 },
    resolved: {
      workerId: 'cx',
      providerId: 'oc',
      worker: { provider: 'oc', model: 'gpt-5.5', runtime: 'codex', ...workerOver },
      provider: { kind: 'codex-cli' },
    },
  };
}

test('codex descriptor renders exec --json, sandbox, model, effort, and stdin marker', () => {
  const spec = codexRuntime.buildSpawn(cxCtx({ reasoningEffort: 'high' }));
  assert.deepEqual(spec.args, [
    'exec',
    '--json',
    '--sandbox',
    'workspace-write',
    '-m',
    'gpt-5.5',
    '-c',
    'model_reasoning_effort="high"',
    '-',
  ]);
});

test('no reasoningEffort → no model_reasoning_effort flag (codex uses its own default)', () => {
  const spec = codexRuntime.buildSpawn(cxCtx({}));
  assert.ok(
    !spec.args.some((a) => a.startsWith('model_reasoning_effort=')),
    'the -c model_reasoning_effort group drops when effort is unset, so codex applies its own default',
  );
});

test('extraArgs reasoning effort wins — never a duplicate -c (migration safety)', () => {
  const spec = codexRuntime.buildSpawn(cxCtx({ reasoningEffort: 'high', extraArgs: ['-c', 'model_reasoning_effort="low"'] }));
  const efforts = spec.args.filter((a) => a.includes('model_reasoning_effort'));
  assert.equal(efforts.length, 1, 'exactly one effort setting, not both');
  assert.equal(efforts[0], 'model_reasoning_effort="low"', 'the explicit extraArgs value wins');
});

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-cx-'));
const { executeRun } = await import('../dist/runner.js');
const { _assumeBinariesForTest } = await import('../dist/registry.js');
_assumeBinariesForTest(['codex']);

function git(cwd, ...args) { execFileSync('git', args, { cwd, stdio: 'pipe' }); }

function makeRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-cx-repo-'));
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
    providers: { oc: { kind: 'codex-cli', auth: 'subscription' } },
    workers: { cx: { provider: 'oc', model: 'm', runtime: 'codex' } },
    tiers,
  };
}

function codexStub(fileChangePath) {
  const events = [
    { type: 'thread.started', thread_id: 'test-thread' },
    { type: 'item.completed', item: { id: 'item_1', type: 'file_change', changes: [{ path: fileChangePath, kind: 'add' }], status: 'completed' } },
    { type: 'item.completed', item: { id: 'item_2', type: 'agent_message', text: 'done' } },
    { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 2, reasoning_output_tokens: 0 } },
  ];
  const script = `require('node:fs').writeFileSync('out.txt','ok');for(const event of ${JSON.stringify(events)})process.stdout.write(JSON.stringify(event)+'\\n');process.exit(0);`;
  return {
    ...codexRuntime,
    id: 'cx',
    binary: 'node',
    preflight: undefined,
    buildSpawn: (ctx) => ({ command: 'node', args: ['-e', script], env: {}, cwd: ctx.worktree, stdinData: ctx.brief }),
  };
}

const cfg = baseConfig({ t: { chain: ['cx'], fallback: 'report' } });

test('E2E: outside file_change path → status failed, isolation-unverified error', async () => {
  const repo = makeRepo();
  const outside = path.join(os.tmpdir(), 'dlg-cx-outside.txt');
  const env = await executeRun(
    { tier: 't', brief: BRIEF, cwd: repo, policy: 'review' },
    cfg,
    { codex: codexStub(outside) },
  );
  assert.equal(env.status, 'failed', `expected failed but got ${env.status}: ${env.stopReason}`);
  assert.ok(
    env.errors.some((e) => e.type === 'isolation-unverified'),
    `expected isolation-unverified error; got: ${JSON.stringify(env.errors)}`,
  );
});

test('E2E: inside file_change path → status completed, no isolation-unverified error, out.txt touched', async () => {
  const repo = makeRepo();
  const env = await executeRun(
    { tier: 't', brief: BRIEF, cwd: repo, policy: 'review' },
    cfg,
    { codex: codexStub('out.txt') },
  );
  assert.equal(env.status, 'completed', `expected completed but got ${env.status}: ${env.stopReason}`);
  assert.ok(
    !env.errors.some((e) => e.type === 'isolation-unverified'),
    `unexpected isolation-unverified error: ${JSON.stringify(env.errors)}`,
  );
  assert.ok(
    env.changes.filesTouched.includes('out.txt'),
    `expected out.txt in filesTouched; got: ${JSON.stringify(env.changes.filesTouched)}`,
  );
});

function effortCfg() {
  const c = baseConfig({ t: { chain: ['cx'], fallback: 'report' } });
  c.workers = { cx: { provider: 'oc', model: 'm', runtime: 'codex', reasoningEffort: 'low' } };
  return c;
}

function captureStub(sink) {
  return {
    ...codexRuntime,
    id: 'cx',
    binary: 'node',
    preflight: undefined,
    buildSpawn: (ctx) => {
      sink.effort = ctx.resolved.worker.reasoningEffort;
      return { command: 'node', args: ['-e', 'process.exit(0)'], env: {}, cwd: ctx.worktree, stdinData: ctx.brief };
    },
  };
}

test('effortOverride replaces the worker default at run time', async () => {
  const repo = makeRepo();
  const sink = {};
  await executeRun({ tier: 't', brief: BRIEF, cwd: repo, policy: 'review', effortOverride: 'xhigh' }, effortCfg(), { codex: captureStub(sink) });
  assert.equal(sink.effort, 'xhigh', 'override wins over the worker default (low)');
});

test('no override → the worker default reasoningEffort is used', async () => {
  const repo = makeRepo();
  const sink = {};
  await executeRun({ tier: 't', brief: BRIEF, cwd: repo, policy: 'review' }, effortCfg(), { codex: captureStub(sink) });
  assert.equal(sink.effort, 'low', 'falls back to the configured default');
});
