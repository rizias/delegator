import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-handle-resolve-'));

const {
  resolveWorkerHandle,
  workerInfo,
  resolveRunPlan,
  _assumeBinariesForTest,
} = await import('../dist/registry.js');
const { ConfigError } = await import('../dist/config.js');

_assumeBinariesForTest(['claude']);

function baseCfg() {
  return {
    version: 1,
    defaults: {
      policy: 'review',
      budget: { wallClockMs: 30_000 },
      checkpointSeconds: 90,
      stallSeconds: 120,
      silenceKillSeconds: 300,
      keepRuns: 50,
      queueTimeoutSeconds: 5,
      queuePollSeconds: 1,
      autoApply: { maxFiles: 10, maxLines: 400 },
      retries: { rateLimit: 0, server: 0 },
      breaker: { failures: 3, cooldownMs: 600_000 },
      keyCooldownMs: 900_000,
    },
    privacy: { sensitivePaths: [] },
    providers: {
      zai: {
        kind: 'anthropic-compatible',
        protocol: 'anthropic',
        auth: 'api-key',
        baseUrl: 'https://api.z.ai/api/anthropic',
        apiKey: 'test-key',
      },
      ollama: {
        kind: 'openai-compatible',
        protocol: 'openai',
        auth: 'none',
        baseUrl: 'http://localhost:11434/v1',
      },
    },
    workers: {
      'glm-5.2': { provider: 'zai', model: 'glm-5.2', runtime: 'claude-headless' },
    },
    tiers: {},
  };
}

test('runtime/provider/model handle resolves to a synthesized worker', () => {
  const worker = resolveWorkerHandle('claude-headless/zai/glm-5.2', baseCfg());
  assert.deepEqual(worker, { provider: 'zai', model: 'glm-5.2', runtime: 'claude' });
});

test('provider/model handle resolves with inferred runtime', () => {
  const worker = resolveWorkerHandle('zai/glm-5.2', baseCfg());
  assert.deepEqual(worker, { provider: 'zai', model: 'glm-5.2', runtime: 'claude' });
});

test('flat worker ids still resolve unchanged', () => {
  const cfg = baseCfg();
  assert.deepEqual(resolveWorkerHandle('glm-5.2', cfg), { provider: 'zai', model: 'glm-5.2', runtime: 'claude' });
});

test('explicit runtime segment is honored through run planning', () => {
  const plan = resolveRunPlan(baseCfg(), { workerId: 'claude-headless/zai/glm-5.2' });
  assert.equal(plan.candidates.length, 1);
  assert.equal(plan.candidates[0].available, true);
  assert.equal(plan.candidates[0].worker.provider, 'zai');
  assert.equal(plan.candidates[0].worker.model, 'glm-5.2');
  assert.equal(plan.candidates[0].worker.runtime, 'claude');
  assert.equal(plan.candidates[0].providerId, 'zai');
});

test('ollama model ids keep colon inside the model segment', () => {
  const worker = resolveWorkerHandle('ollama/gemma3:4b', baseCfg());
  assert.deepEqual(worker, { provider: 'ollama', model: 'gemma3:4b', runtime: 'api' });
});

test('canonical and old alias runtime handles resolve to the same canonical runtime', () => {
  const canonical = resolveWorkerHandle('claude/zai/glm-5.2', baseCfg());
  const oldAlias = resolveWorkerHandle('claude-headless/zai/glm-5.2', baseCfg());
  assert.deepEqual(canonical, { provider: 'zai', model: 'glm-5.2', runtime: 'claude' });
  assert.deepEqual(oldAlias, canonical);
});

test('unknown handles are unresolved and direct run errors clearly', () => {
  const cfg = baseCfg();
  assert.equal(resolveWorkerHandle('unknown/glm-5.2', cfg), undefined);
  assert.throws(
    () => resolveRunPlan(cfg, { workerId: 'unknown/glm-5.2' }),
    (e) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /unknown worker\/handle/);
      return true;
    },
  );
});

test('known provider without a model keeps the provider-not-worker diagnostic', () => {
  const info = workerInfo('zai', baseCfg());
  assert.equal(info.status, 'unconfigured');
  assert.match(info.reason, /"zai" is a provider, not a worker/);
});

test('known provider handle with an empty model reports the missing model', () => {
  const info = workerInfo('zai/', baseCfg());
  assert.equal(info.status, 'unconfigured');
  assert.match(info.reason, /provider "zai" but has no model/);
});
