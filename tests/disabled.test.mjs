import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve('.');
process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-disabled-import-'));

const { ConfigError, loadConfig, parseHandle } = await import('../dist/config.js');
const {
  isWorkerDisabled,
  listWorkers,
  resolveCandidate,
  resolveForRun,
  resolveRunPlan,
  resolveWorkerHandle,
  workerInfo,
} = await import('../dist/registry.js');
const { fetchProviderModels } = await import('../dist/models.js');
const { runCouncil } = await import('../dist/council.js');

function configLines(body, defaultModel) {
  return [
    'version: 1',
    'defaults:',
    ...(defaultModel ? [`  model: ${defaultModel}`] : []),
    '  budget: { wallClock: 10m }',
    'privacy:',
    '  sensitivePaths: []',
    'runtimes:',
    '  api:',
    '    mode: direct-api',
    '    protocol: openai',
    '    auth: none',
    '    request: { method: POST, path: /chat/completions }',
    '    output: { parser: builtin:openai-chat }',
    ...body,
    '',
  ];
}

function writeConfig(lines, prefix = 'dlg-disabled-case-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(home, 'providers.yaml'), lines.join('\n'), 'utf8');
  return home;
}

function loadYaml(body, defaultModel) {
  const home = writeConfig(configLines(body, defaultModel));
  process.env.DELEGATOR_HOME = home;
  return loadConfig(home);
}

function runCli(home, args, cwd = root) {
  return spawnSync(process.execPath, [path.join(root, 'dist', 'cli.js'), ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, CI: '1', DELEGATOR_HOME: home },
  });
}

test('schema accepts only literal true and preserves absent disabled fields', () => {
  const enabled = loadYaml([
    'providers:',
    '  live: { protocol: openai, auth: none, models: [a] }',
    'workers: {}',
    'tiers: {}',
  ]);
  assert.equal(enabled.providers.live.disabled, undefined);
  assert.equal(enabled.providers.live.models.a.disabled, undefined);

  const disabled = loadYaml([
    'providers:',
    '  parked:',
    '    protocol: openai',
    '    auth: none',
    '    disabled: true',
    '    models:',
    '      a: { disabled: true }',
    'workers: {}',
    'tiers: {}',
  ]);
  assert.equal(disabled.providers.parked.disabled, true);
  assert.equal(disabled.providers.parked.models.a.disabled, true);

  for (const target of ['    disabled: false', '      a: { disabled: false }']) {
    const lines = target.startsWith('      ')
      ? ['providers:', '  p:', '    protocol: openai', '    auth: none', '    models:', target, 'workers: {}', 'tiers: {}']
      : ['providers:', '  p:', '    protocol: openai', '    auth: none', target, '    models: [a]', 'workers: {}', 'tiers: {}'];
    assert.throws(() => loadYaml(lines), ConfigError, `${target.trim()} must be rejected`);
  }
});

test('provider and model parking are distinct and disabled wins over breaker health', () => {
  const cfg = loadYaml([
    'providers:',
    '  parked: { protocol: openai, auth: none, disabled: true, models: [a] }',
    '  mixed:',
    '    protocol: openai',
    '    auth: none',
    '    models:',
    '      off: { disabled: true }',
    '      on: {}',
    '  sick: { protocol: openai, auth: none, models: [a] }',
    'workers: {}',
    'tiers: {}',
  ]);
  const snapshot = {
    breaker: {
      'parked/a': { state: 'open', failures: 3, openedAt: Date.now(), cooldownMs: 60_000 },
      'sick/a': { state: 'open', failures: 3, openedAt: Date.now(), cooldownMs: 60_000 },
    },
  };

  assert.equal(isWorkerDisabled(resolveWorkerHandle('parked/a', cfg), cfg.providers.parked), true);
  assert.equal(workerInfo('parked/a', cfg, snapshot).status, 'disabled');
  assert.equal(workerInfo('mixed/off', cfg, snapshot).status, 'disabled');
  assert.equal(workerInfo('mixed/on', cfg, snapshot).status, 'available');
  assert.equal(workerInfo('sick/a', cfg, snapshot).status, 'unavailable');
  assert.equal(listWorkers(cfg).find((w) => w.id === 'mixed/off').status, 'disabled');
});

test('direct disabled handles and disabled defaults fail without falling through', async () => {
  const cfg = loadYaml([
    'providers:',
    '  p:',
    '    protocol: openai',
    '    auth: none',
    '    models:',
    '      a: { disabled: true, fallback: p/b }',
    '      b: {}',
    'workers: {}',
    'tiers: {}',
  ], 'p/a');
  for (const selection of [{ workerId: 'p/a' }, {}]) {
    assert.throws(
      () => resolveRunPlan(cfg, selection),
      (e) => e instanceof ConfigError && /worker "p\/a" is disabled/.test(e.message) && /dlg provider enable p a/.test(e.message),
    );
  }
  await assert.rejects(() => resolveForRun(cfg, { workerId: 'p/a' }), /worker "p\/a" is disabled/);
  assert.deepEqual(parseHandle('p/a', cfg), { provider: 'p', model: 'a' });
});

test('disabled fallback nodes are omitted and their links are not traversed', () => {
  const cfg = loadYaml([
    'providers:',
    '  p:',
    '    protocol: openai',
    '    auth: none',
    '    models:',
    '      a: { fallback: p/b }',
    '      b: { disabled: true, fallback: p/c }',
    '      c: {}',
    'workers: {}',
    'tiers:',
    '  mixed: { chain: [p/b, p/c], fallback: auto }',
  ]);

  assert.deepEqual(resolveRunPlan(cfg, { workerId: 'p/a' }).candidates.map((c) => c.workerId), ['p/a']);
  assert.deepEqual(resolveRunPlan(cfg, { tier: 'mixed' }).candidates.map((c) => c.workerId), ['p/c']);
  assert.deepEqual(resolveRunPlan(cfg, { workerId: 'p/c' }).candidates.map((c) => c.workerId), ['p/c']);
});

test('resolveCandidate defensively rejects a stale disabled candidate before key rotation', async () => {
  const cfg = loadYaml([
    'providers:',
    '  p: { protocol: openai, auth: none, disabled: true, models: [a] }',
    'workers: {}',
    'tiers: {}',
  ]);
  const worker = resolveWorkerHandle('p/a', cfg);
  await assert.rejects(
    () => resolveCandidate({ workerId: 'p/a', available: true, worker, provider: cfg.providers.p, providerId: 'p' }, cfg),
    /provider "p" is disabled/,
  );
});

test('council rejects disabled proposers and aggregators during preflight', async () => {
  const cfg = loadYaml([
    'providers:',
    '  live: { protocol: openai, auth: none, models: [a, b] }',
    '  parked: { protocol: openai, auth: none, disabled: true, models: [judge] }',
    'workers: {}',
    'tiers: {}',
  ]);
  const options = { models: [{ handle: 'parked/judge' }, { handle: 'live/a' }], minProposers: 2, maxRetriesPerWorker: 0 };
  await assert.rejects(() => runCouncil({ task: 'x', cwd: os.tmpdir(), options }, cfg), /provider "parked" is disabled/);
  await assert.rejects(
    () => runCouncil({
      task: 'x',
      cwd: os.tmpdir(),
      options: { ...options, models: [{ handle: 'live/a' }, { handle: 'live/b' }] },
      aggregateWith: 'parked/judge',
    }, cfg),
    /provider "parked" is disabled/,
  );
});

test('model discovery refuses disabled providers and filters disabled declared model ids', async () => {
  const disabled = loadYaml([
    'providers:',
    '  p: { protocol: openai, auth: none, baseUrl: http://localhost:1234/v1, disabled: true, models: [a] }',
    'workers: {}',
    'tiers: {}',
  ]);
  let called = false;
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => { called = true; throw new Error('must not call'); };
  try {
    await assert.rejects(() => fetchProviderModels('p', disabled), /provider "p" is disabled/);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = oldFetch;
  }

  const mixed = loadYaml([
    'providers:',
    '  p:',
    '    protocol: openai',
    '    auth: none',
    '    baseUrl: http://localhost:1234/v1',
    '    models:',
    '      hidden: { disabled: true }',
    '      visible: {}',
    'workers: {}',
    'tiers: {}',
  ]);
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: 'hidden' }, { id: 'visible' }, { id: 'undeclared' }] }),
  });
  try {
    assert.deepEqual((await fetchProviderModels('p', mixed)).models, ['undeclared', 'visible']);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test('providers, models, doctor, and queue expose or omit disabled entries appropriately', () => {
  const home = writeConfig(configLines([
    'providers:',
    '  parked:',
    '    kind: opencode',
    '    disabled: true',
    '    maxConcurrent: 1',
    '    models: { off: {} }',
    '  live:',
    '    kind: codex-cli',
    '    defaultRuntime: codex',
    '    maxConcurrent: 2',
    '    models: { on: {} }',
    'workers: {}',
    'tiers: {}',
  ]));

  const providers = runCli(home, ['providers']);
  assert.equal(providers.status, 0, providers.stderr);
  assert.match(providers.stdout, /^parked\/off\s+disabled\s/m);

  const models = runCli(home, ['models']);
  assert.equal(models.status, 0, models.stderr);
  assert.match(models.stdout, /# live /);
  assert.doesNotMatch(models.stdout, /# parked /);

  const directModels = runCli(home, ['models', 'parked']);
  assert.notEqual(directModels.status, 0);
  assert.match(directModels.stderr, /provider "parked" is disabled/);

  const doctor = runCli(home, ['doctor', '--json']);
  assert.equal(doctor.status, 0, doctor.stderr);
  const diagnosis = JSON.parse(doctor.stdout);
  assert.deepEqual(diagnosis.workers.disabled.map((w) => w.id), ['parked/off']);
  assert.equal(diagnosis.workers.unavailable.some((w) => w.status === 'disabled'), false);

  const queue = runCli(home, ['queue', '--json']);
  assert.equal(queue.status, 0, queue.stderr);
  assert.deepEqual(JSON.parse(queue.stdout).map((r) => r.scope), ['live']);
});

test('provider disable and enable preserve comments and only mutate existing targets', () => {
  const home = writeConfig([
    '# registry comment',
    'version: 1',
    'providers:',
    '  # provider comment',
    '  zai:',
    '    kind: openai-compatible # kind comment',
    '    auth: none',
    '    models:',
    '      glm-5.2: {} # model comment',
    'workers: {}',
    'tiers: {}',
    '',
  ]);

  let r = runCli(home, ['provider', 'disable', 'zai']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /provider "zai" disabled/);
  let yaml = fs.readFileSync(path.join(home, 'providers.yaml'), 'utf8');
  for (const comment of ['# registry comment', '# provider comment', '# kind comment', '# model comment']) assert.ok(yaml.includes(comment));
  assert.match(yaml, /disabled: true/);

  r = runCli(home, ['provider', 'enable', 'zai']);
  assert.equal(r.status, 0, r.stderr);
  yaml = fs.readFileSync(path.join(home, 'providers.yaml'), 'utf8');
  assert.doesNotMatch(yaml, /disabled:/);
  for (const comment of ['# registry comment', '# provider comment', '# kind comment', '# model comment']) assert.ok(yaml.includes(comment));

  r = runCli(home, ['provider', 'disable', 'zai', 'glm-5.2']);
  assert.equal(r.status, 0, r.stderr);
  yaml = fs.readFileSync(path.join(home, 'providers.yaml'), 'utf8');
  assert.match(yaml, /glm-5\.2:[\s\S]*disabled: true/);

  r = runCli(home, ['provider', 'disable', 'typo']);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /provider "typo" does not exist/);

  const shorthandHome = writeConfig([
    'version: 1',
    'providers:',
    '  p: { kind: openai-compatible, auth: none, models: [a, b] } # keep shorthand comment',
    'workers: {}',
    'tiers: {}',
    '',
  ]);
  r = runCli(shorthandHome, ['provider', 'disable', 'p', 'a']);
  assert.equal(r.status, 0, r.stderr);
  process.env.DELEGATOR_HOME = shorthandHome;
  assert.equal(loadConfig(shorthandHome).providers.p.models.a.disabled, true);
  assert.match(fs.readFileSync(path.join(shorthandHome, 'providers.yaml'), 'utf8'), /# keep shorthand comment/);
});

test('provider enable of an unknown model in a shorthand list fails loudly, not a false success', () => {
  const home = writeConfig([
    'version: 1',
    'providers:',
    '  p: { kind: openai-compatible, auth: none, models: [a, b] }',
    'workers: {}',
    'tiers: {}',
    '',
  ]);
  // Regression: the `!disabled` early-return once skipped existence validation for a shorthand list,
  // so `enable p typo` reported success for a model that does not exist. It must now error.
  let r = runCli(home, ['provider', 'enable', 'p', 'typo']);
  assert.notEqual(r.status, 0, 'enabling an unknown shorthand model must fail');
  assert.match(r.stderr, /model "typo" does not exist uniquely/);
  // Enabling an EXISTING shorthand model is a clean no-op (shorthand entries are never disabled),
  // and it leaves the shorthand list byte-identical.
  r = runCli(home, ['provider', 'enable', 'p', 'b']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(fs.readFileSync(path.join(home, 'providers.yaml'), 'utf8'), /models: \[a, b\]/);
});

test('provider enable of an existing shorthand model is not blocked by an unrelated alias in the list', () => {
  // Regression (round 2): scoping enable to target existence must not reject the whole list just
  // because a DIFFERENT element is an alias — enabling rewrites nothing, so unrelated aliases are
  // irrelevant. (Disabling, which converts the list, still refuses aliases.)
  const home = writeConfig([
    'version: 1',
    'providers:',
    '  p: { kind: &m openai-compatible, auth: none, models: [*m, b] }',
    'workers: {}',
    'tiers: {}',
    '',
  ]);
  const r = runCli(home, ['provider', 'enable', 'p', 'b']);
  assert.equal(r.status, 0, r.stderr);
  // No-op enable leaves the file (and its alias) untouched.
  assert.match(fs.readFileSync(path.join(home, 'providers.yaml'), 'utf8'), /models: \[\*m, b\]/);
});

test('provider toggles refuse duplicate and aliased target mappings without writing', () => {
  for (const lines of [
    ['version: 1', 'providers:', '  p: { kind: openai-compatible }', '  p: { kind: opencode }'],
    ['version: 1', 'base: &base { kind: openai-compatible }', 'providers:', '  p: *base'],
  ]) {
    const home = writeConfig([...lines, 'workers: {}', 'tiers: {}', '']);
    const file = path.join(home, 'providers.yaml');
    const before = fs.readFileSync(file, 'utf8');
    const r = runCli(home, ['provider', 'disable', 'p']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /duplicate|alias|ambiguous|valid YAML/i);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  }
});

test('CLI rejects explicit and default disabled workers with a re-enable command', () => {
  const home = writeConfig(configLines([
    'providers:',
    '  p: { protocol: openai, auth: none, models: { a: { disabled: true, fallback: p/b }, b: {} } }',
    'workers: {}',
    'tiers: {}',
  ], 'p/a'));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-disabled-run-'));
  for (const args of [
    ['run', '--task', 'x', '--worker', 'p/a', '--cwd', cwd],
    ['run', '--task', 'x', '--cwd', cwd],
  ]) {
    const r = runCli(home, args, cwd);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /config error: worker "p\/a" is disabled/);
    assert.match(r.stderr, /dlg provider enable p a/);
    assert.doesNotMatch(r.stderr, /p\/b/);
  }
});
