import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-effort-levels-'));

const { effortLevels, loadConfig, mergedRuntimeDescriptors } = await import('../dist/config.js');
const { resolveWorkerHandle } = await import('../dist/registry.js');

function writeGlobal(yaml) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-effort-levels-case-'));
  process.env.DELEGATOR_HOME = home;
  fs.writeFileSync(path.join(home, 'providers.yaml'), yaml, 'utf8');
  return home;
}

function loadYaml(yaml) {
  const home = writeGlobal(yaml);
  return loadConfig(home);
}

function yamlWithModel(modelLines) {
  return [
    'version: 1',
    'defaults:',
    '  budget: { wallClock: 10m }',
    'privacy:',
    '  sensitivePaths: []',
    'providers:',
    '  p:',
    '    kind: openai-compatible',
    '    defaultRuntime: api',
    '    models:',
    '      m:',
    ...modelLines.map((line) => `        ${line}`),
    'workers: {}',
    'tiers: {}',
    '',
  ].join('\n');
}

test('effortLevels normalizes undefined, scalar, and object specs', () => {
  assert.deepEqual(effortLevels(undefined), { levels: [] });
  assert.deepEqual(effortLevels('low'), { levels: ['low'], default: 'low' });
  assert.deepEqual(effortLevels({ levels: ['think', 'deep'] }), { levels: ['think', 'deep'], default: undefined });
});

test('runtime descriptors carry effortLevels catalogs', () => {
  assert.deepEqual(mergedRuntimeDescriptors({}).api.effortLevels, {
    levels: ['minimal', 'low', 'medium', 'high'],
    default: 'medium',
  });
});

test('model with no reasoningEffort inherits runtime levels and default', () => {
  const cfg = loadYaml(yamlWithModel([]));

  const w = resolveWorkerHandle('p/m', cfg);
  assert.equal(w.reasoningEffort, 'medium');
  assert.deepEqual(w.reasoningEffortLevels, ['minimal', 'low', 'medium', 'high']);
});

test('object reasoningEffort resolves the model default and available levels', () => {
  const cfg = loadYaml(yamlWithModel([
    'reasoningEffort:',
    '  levels: [low, high]',
    '  default: high',
  ]));

  const w = resolveWorkerHandle('p/m', cfg);
  assert.equal(w.reasoningEffort, 'high');
  assert.deepEqual(w.reasoningEffortLevels, ['low', 'high']);
});

test('model reasoningEffort may narrow runtime levels to a subset', () => {
  const cfg = loadYaml(yamlWithModel([
    'reasoningEffort:',
    '  levels: [minimal, high]',
    '  default: high',
  ]));

  const w = resolveWorkerHandle('p/m', cfg);
  assert.equal(w.reasoningEffort, 'high');
  assert.deepEqual(w.reasoningEffortLevels, ['minimal', 'high']);
});

test('scalar reasoningEffort resolves as the only available level', () => {
  const cfg = loadYaml(yamlWithModel(['reasoningEffort: low']));

  const w = resolveWorkerHandle('p/m', cfg);
  assert.equal(w.reasoningEffort, 'low');
  assert.deepEqual(w.reasoningEffortLevels, ['low']);
});

test('model-specific reasoning effort names are accepted', () => {
  const cfg = loadYaml(yamlWithModel([
    'reasoningEffort:',
    '  levels: [think, deep]',
    '  default: think',
  ]));

  const w = resolveWorkerHandle('p/m', cfg);
  assert.equal(w.reasoningEffort, 'think');
  assert.deepEqual(w.reasoningEffortLevels, ['think', 'deep']);
});

test('object reasoningEffort default must be one of its levels', () => {
  assert.throws(
    () => loadYaml(yamlWithModel([
      'reasoningEffort:',
      '  levels: [low, high]',
      '  default: turbo',
    ])),
    /reasoningEffort\.default 'turbo' is not in levels \[low, high\]/,
  );
});

test('model reasoningEffort levels outside the runtime catalog produce a load warning', () => {
  const cfg = loadYaml(yamlWithModel([
    'reasoningEffort:',
    '  levels: [low, turbo]',
    '  default: low',
  ]));

  assert.match((cfg.warnings ?? []).join('\n'), /reasoningEffort level "turbo".*runtime "api"/);
});
