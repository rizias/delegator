import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-fallback-routing-'));

const { loadConfig, mergedRuntimeDescriptors, parseHandle } = await import('../dist/config.js');
const { resolveRunPlan, resolveWorkerHandle } = await import('../dist/registry.js');
const { descriptorToAdapter } = await import('../dist/runtimes/factory.js');

function writeGlobal(yaml) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-fallback-routing-case-'));
  process.env.DELEGATOR_HOME = home;
  fs.writeFileSync(path.join(home, 'providers.yaml'), yaml, 'utf8');
  return home;
}

function loadYaml(lines) {
  const home = writeGlobal(lines.join('\n'));
  return loadConfig(home);
}

function baseYaml(extraLines) {
  return [
    'version: 1',
    'defaults:',
    '  budget: { wallClock: 10m }',
    'privacy:',
    '  sensitivePaths: []',
    'runtimes:',
    '  api:',
    '    mode: direct-api',
    '    protocol: openai',
    '    auth: none',
    '    request: { method: POST, path: /responses }',
    '    output: { parser: builtin:openai-responses }',
    ...extraLines,
    '',
  ];
}

function candidateIds(plan) {
  return plan.candidates.map((c) => c.workerId);
}

test('model fallback builds a direct worker fallback chain', () => {
  const cfg = loadYaml(baseYaml([
    'providers:',
    '  zai: { protocol: openai, auth: none, models: { glm-5.2: { fallback: deepseek/x } } }',
    '  deepseek: { protocol: openai, auth: none, models: [x] }',
    'workers: {}',
    'tiers: {}',
  ]));

  const plan = resolveRunPlan(cfg, { workerId: 'zai/glm-5.2' });

  assert.deepEqual(candidateIds(plan), ['zai/glm-5.2', 'deepseek/x']);
  assert.equal(plan.fallback, 'auto');
});

test('fallback chains are transitive and cycle-safe', () => {
  const transitive = loadYaml(baseYaml([
    'providers:',
    '  p:',
    '    protocol: openai',
    '    auth: none',
    '    models:',
    '      a: { fallback: p/b }',
    '      b: { fallback: p/c }',
    '      c: {}',
    'workers: {}',
    'tiers: {}',
  ]));

  assert.deepEqual(candidateIds(resolveRunPlan(transitive, { workerId: 'p/a' })), ['p/a', 'p/b', 'p/c']);

  const cyclic = loadYaml(baseYaml([
    'providers:',
    '  p:',
    '    protocol: openai',
    '    auth: none',
    '    models:',
    '      a: { fallback: p/b }',
    '      b: { fallback: p/a }',
    'workers: {}',
    'tiers: {}',
  ]));

  assert.deepEqual(candidateIds(resolveRunPlan(cyclic, { workerId: 'p/a' })), ['p/a', 'p/b']);
});

test('fallback arrays preserve declared order', () => {
  const cfg = loadYaml(baseYaml([
    'providers:',
    '  p:',
    '    protocol: openai',
    '    auth: none',
    '    models:',
    '      a: { fallback: [p/x, p/y] }',
    '      x: {}',
    '      y: {}',
    'workers: {}',
    'tiers: {}',
  ]));

  assert.deepEqual(candidateIds(resolveRunPlan(cfg, { workerId: 'p/a' })), ['p/a', 'p/x', 'p/y']);
});

test('parseHandle greedily preserves slash-bearing provider model ids', () => {
  const cfg = loadYaml(baseYaml([
    'providers:',
    '  opencode:',
    '    protocol: opencode',
    '    auth: subscription',
    '    defaultRuntime: opencode',
    '    models:',
    '      opencode/north-mini-code-free: {}',
    '  lmstudio:',
    '    protocol: openai',
    '    auth: none',
    '    models:',
    '      liquid/lfm2.5-1.2b: {}',
    '  pi:',
    '    protocol: openai',
    '    auth: subscription',
    '    defaultRuntime: pi',
    '    models: [other]',
    '  openai-codex:',
    '    protocol: openai',
    '    auth: subscription',
    '    defaultRuntime: codex',
    '    models: [gpt-5.5]',
    'workers: {}',
    'tiers: {}',
  ]));

  assert.deepEqual(parseHandle('opencode/opencode/north-mini-code-free', cfg), {
    provider: 'opencode',
    model: 'opencode/north-mini-code-free',
  });
  assert.deepEqual(parseHandle('lmstudio/liquid/lfm2.5-1.2b', cfg), {
    provider: 'lmstudio',
    model: 'liquid/lfm2.5-1.2b',
  });
  assert.deepEqual(parseHandle('pi/openai-codex/gpt-5.5', cfg), {
    runtime: 'pi',
    provider: 'openai-codex',
    model: 'gpt-5.5',
  });
});

test('defaults.model is used as the bare run target', () => {
  const cfg = loadYaml([
    'version: 1',
    'defaults:',
    '  budget: { wallClock: 10m }',
    '  model: p/a',
    'privacy:',
    '  sensitivePaths: []',
    'runtimes:',
    '  api:',
    '    mode: direct-api',
    '    protocol: openai',
    '    auth: none',
    '    request: { method: POST, path: /responses }',
    '    output: { parser: builtin:openai-responses }',
    'providers:',
    '  p: { protocol: openai, auth: none, models: [a] }',
    'workers: {}',
    'tiers: {}',
    '',
  ]);

  assert.deepEqual(candidateIds(resolveRunPlan(cfg, {})), ['p/a']);
});

test('bare handles inherit fallback limits and tools from model config', () => {
  const cfg = loadYaml(baseYaml([
    'providers:',
    '  p:',
    '    protocol: openai',
    '    auth: none',
    '    models:',
    '      a:',
    '        fallback: p/b',
    '        limits: { concurrent: 2 }',
    '        tools: [Read, Edit]',
    '      b: {}',
    'workers: {}',
    'tiers: {}',
  ]));

  const worker = resolveWorkerHandle('p/a', cfg);

  assert.equal(worker.fallback, 'p/b');
  assert.deepEqual(worker.limits, { concurrent: 2 });
  assert.deepEqual(worker.tools, ['Read', 'Edit']);
});

test('claude tools precedence uses cli then worker/model then tier then defaults', () => {
  const adapter = descriptorToAdapter('claude', mergedRuntimeDescriptors({}).claude);
  const baseCtx = {
    brief: 'brief',
    worktree: '/wt',
    budget: { wallClockMs: 1000 },
    tier: { chain: ['w'], fallback: 'report', tools: ['Tier'] },
    defaultsTools: ['Default'],
    resolved: {
      workerId: 'w',
      providerId: 'p',
      worker: { provider: 'p', model: 'm', runtime: 'claude', tools: ['Worker'] },
      provider: { kind: 'anthropic-compatible' },
      apiKey: 'k',
    },
  };

  const argsWithCli = adapter.buildSpawn({ ...baseCtx, toolsOverride: ['Cli'] }).args;
  assert.equal(argsWithCli[argsWithCli.indexOf('--allowedTools') + 1], 'Cli');

  const argsWithWorker = adapter.buildSpawn(baseCtx).args;
  assert.equal(argsWithWorker[argsWithWorker.indexOf('--allowedTools') + 1], 'Worker');

  const tierCtx = { ...baseCtx, resolved: { ...baseCtx.resolved, worker: { provider: 'p', model: 'm', runtime: 'claude' } } };
  const argsWithTier = adapter.buildSpawn(tierCtx).args;
  assert.equal(argsWithTier[argsWithTier.indexOf('--allowedTools') + 1], 'Tier');

  const defaultsCtx = { ...tierCtx, tier: { chain: ['w'], fallback: 'report' } };
  const argsWithDefaults = adapter.buildSpawn(defaultsCtx).args;
  assert.equal(argsWithDefaults[argsWithDefaults.indexOf('--allowedTools') + 1], 'Default');
});
