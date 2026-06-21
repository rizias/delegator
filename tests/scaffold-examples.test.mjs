import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-scaffold-examples-'));

const { loadConfig, mergedRuntimeDescriptors } = await import('../dist/config.js');
const { resolveRunPlan, resolveWorkerHandle } = await import('../dist/registry.js');
const { initConfigHome, minimalProvidersYaml } = await import('../dist/scaffold.js');

function loadAsGlobal(yaml) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-scaffold-examples-case-'));
  process.env.DELEGATOR_HOME = home;
  fs.writeFileSync(path.join(home, 'providers.yaml'), yaml, 'utf8');
  return loadConfig(home);
}

function candidateIds(plan) {
  return plan.candidates.map((c) => c.workerId);
}

function assertCanonicalSourceShape(yaml) {
  assert.doesNotMatch(yaml, /^workers\s*:/m);
  assert.doesNotMatch(yaml, /^tiers\s*:/m);
  assert.doesNotMatch(yaml, /^trust\s*:/m);
  assert.doesNotMatch(yaml, /^\s*autoApply\s*:/m);
  assert.doesNotMatch(yaml, /^\s*card\s*:/m);
}

function assertCleanFinalConfigLoads(yaml, expected) {
  assertCanonicalSourceShape(yaml);
  const cfg = loadAsGlobal(yaml);
  const runtimes = mergedRuntimeDescriptors(cfg);
  assert.equal(cfg.warnings, undefined);
  assert.ok(runtimes.api);
  assert.ok(runtimes.claude);
  assert.equal(cfg.defaults.model, expected.defaultModel);
  assert.ok(resolveWorkerHandle(cfg.defaults.model, cfg), `defaults.model resolves: ${cfg.defaults.model}`);

  for (const [handle, expectedWorker] of Object.entries(expected.handles)) {
    const worker = resolveWorkerHandle(handle, cfg);
    assert.ok(worker, `handle resolves: ${handle}`);
    assert.equal(worker.provider, expectedWorker.provider);
    assert.equal(worker.model, expectedWorker.model);
    assert.equal(worker.runtime, expectedWorker.runtime);
    if (expectedWorker.reasoningEffort !== undefined) {
      assert.equal(worker.reasoningEffort, expectedWorker.reasoningEffort);
    }
    if (expectedWorker.reasoningEffortLevels !== undefined) {
      assert.deepEqual(worker.reasoningEffortLevels, expectedWorker.reasoningEffortLevels);
    }
  }

  // tolerant: inspect the chain STRUCTURE without requiring keys (the test env has no secrets), the
  // way `dlg route` does — a missing-key head is a skipped candidate, not a throw.
  const plan = resolveRunPlan(cfg, { workerId: expected.fallbackHead }, { tolerant: true });
  assert.deepEqual(candidateIds(plan), expected.fallbackChain);
  assert.ok(plan.candidates.length > 1);
  assert.equal(plan.fallback, 'auto');
}

test('scaffold providers.yaml is an EMPTY registry that loads cleanly with no default model', () => {
  const yaml = minimalProvidersYaml();
  assertCanonicalSourceShape(yaml);
  const cfg = loadAsGlobal(yaml);
  const runtimes = mergedRuntimeDescriptors(cfg);
  assert.equal(cfg.warnings, undefined);
  // Runtime descriptors still come from the packaged defaults, independent of providers.
  assert.ok(runtimes.api);
  assert.ok(runtimes.claude);
  // EMPTY registry: no providers shipped...
  assert.deepEqual(cfg.providers, {});
  // ...and no default model pinned (the field is absent, not just blank).
  assert.equal(cfg.defaults.model, undefined);
  assert.equal('model' in cfg.defaults, false);
  // The machine-agnostic operational defaults block is fully present.
  assert.equal(cfg.defaults.policy, 'review');
  assert.equal(cfg.defaults.budget.wallClockMs, 900_000);
  assert.equal(cfg.defaults.checkpointSeconds, 90);
  assert.equal(cfg.defaults.stallSeconds, 300);
  assert.equal(cfg.defaults.silenceKillSeconds, 600);
  assert.equal(cfg.defaults.keepRuns, 30);
  assert.equal(cfg.defaults.worktreeRetention, 'keep-unfinished');
  assert.equal(cfg.defaults.retries.rateLimit, 3);
  assert.equal(cfg.defaults.retries.server, 2);
  assert.equal(cfg.defaults.breaker.failures, 3);
  assert.equal(cfg.defaults.breaker.cooldownMs, 600_000);
  assert.equal(cfg.defaults.keyCooldownMs, 900_000);
  // privacy defaults survive.
  assert.ok(cfg.privacy.sensitivePaths.length > 0);
});

test('initConfigHome creates providers.yaml and runtimes.yaml in the configured home', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-scaffold-init-'));
  process.env.DELEGATOR_HOME = home;

  const result = initConfigHome();

  assert.equal(result.created, true);
  assert.equal(result.runtimesCreated, true);
  assert.equal(path.basename(result.path), 'providers.yaml');
  assert.equal(path.basename(result.runtimesPath), 'runtimes.yaml');
  assert.equal(fs.existsSync(path.join(home, 'providers.yaml')), true);
  assert.equal(fs.existsSync(path.join(home, 'runtimes.yaml')), true);
  assertCanonicalSourceShape(fs.readFileSync(path.join(home, 'providers.yaml'), 'utf8'));
});

test('examples/providers.example.yaml loads cleanly with default model handles and fallback chain', () => {
  const example = fs.readFileSync(path.resolve('examples/providers.example.yaml'), 'utf8');
  assertCleanFinalConfigLoads(example, {
    defaultModel: 'anthropic/claude-opus-4-8',
    fallbackHead: 'openai/gpt-5.5',
    fallbackChain: ['openai/gpt-5.5', 'opencode/opencode/north-mini-code-free', 'local/gpt-5.5'],
    handles: {
      'anthropic/claude-opus-4-8': { provider: 'anthropic', model: 'claude-opus-4-8', runtime: 'claude' },
      'anthropic/claude-sonnet-4-6': { provider: 'anthropic', model: 'claude-sonnet-4-6', runtime: 'claude' },
      'anthropic/claude-haiku-4-5': { provider: 'anthropic', model: 'claude-haiku-4-5', runtime: 'claude' },
      'zai/glm-5.2': { provider: 'zai', model: 'glm-5.2', runtime: 'claude' },
      'zai/glm-5.2[1m]': { provider: 'zai', model: 'glm-5.2[1m]', runtime: 'claude' },
      'openai-codex/gpt-5.5': { provider: 'openai-codex', model: 'gpt-5.5', runtime: 'codex' },
      'openai/gpt-5.5': {
        provider: 'openai',
        model: 'gpt-5.5',
        runtime: 'api',
        reasoningEffort: 'medium',
        reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
      },
      'opencode/opencode/north-mini-code-free': {
        provider: 'opencode',
        model: 'opencode/north-mini-code-free',
        runtime: 'opencode',
      },
      'local/gpt-5.5': { provider: 'local', model: 'gpt-5.5', runtime: 'api' },
    },
  });
});
