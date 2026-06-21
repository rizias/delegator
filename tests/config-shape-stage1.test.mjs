import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-cfg-v2-'));
const { loadConfig, parseHandle, ConfigError } = await import('../dist/config.js');

function writeGlobal(yaml) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-cfg-v2-case-'));
  process.env.DELEGATOR_HOME = home;
  fs.writeFileSync(path.join(home, 'providers.yaml'), yaml, 'utf8');
  return home;
}

function loadYaml(yaml) {
  const home = writeGlobal(yaml);
  return loadConfig(home);
}

const defaultsYaml = [
  'version: 1',
  'defaults:',
  '  budget: { wallClock: 10m }',
  'privacy:',
  '  sensitivePaths: []',
].join('\n');

test('new provider-first shape loads and expands profiles to the canonical worker model', () => {
  const cfg = loadYaml([
    defaultsYaml,
    'runtimes:',
    '  claude-headless: { command: claude, protocol: anthropic, prompt: { mode: stdin }, parser: builtin:claude-stream-json-events }',
    '  api-oneshot: { protocol: openai, auth: api-key, parser: none }',
    'providers:',
    '  zai-anthropic:',
    '    protocol: anthropic',
    '    auth: api-key',
    '    baseUrl: https://api.z.ai/api/anthropic',
    '    models:',
    '      glm-5.1:',
    '        contextWindow: 200000',
    '        price: { inPerMtok: 0.5, outPerMtok: 1.5 }',
    '        card: { goodFor: [reasoning] }',
    '  zai-openai:',
    '    protocol: openai',
    '    auth: api-key',
    '    baseUrl: https://api.z.ai/api/v1',
    '    models: { glm-5.1: {} }',
    'workers:',
    '  glm:',
    '    runtime: claude-headless',
    '    provider: zai-anthropic',
    '    model: glm-5.1',
    '    reasoningEffort: high',
    '    card: { avoidFor: [cheap] }',
    '  glm-via-api:',
    '    provider: zai-openai',
    '    model: glm-5.1',
    'tiers:',
    '  standard-code: { chain: [glm, glm-via-api], fallback: auto }',
    '',
  ].join('\n'));

  assert.equal(cfg.providers['zai-anthropic'].kind, 'anthropic-compatible');
  assert.equal(cfg.workers.glm.runtime, 'claude');
  assert.equal(cfg.workers.glm.contextWindow, 200000);
  assert.deepEqual(cfg.workers.glm.price, { inPerMtok: 0.5, outPerMtok: 1.5 });
  assert.deepEqual(cfg.workers.glm.card, { goodFor: ['reasoning'], avoidFor: ['cheap'] });
  assert.equal(cfg.workers['glm-via-api'].runtime, 'api');
});

test('old flat shape still loads through the compatibility shim', () => {
  const cfg = loadYaml([
    defaultsYaml,
    'providers:',
    '  opencode:',
    '    kind: opencode',
    'workers:',
    '  oc-free:',
    '    provider: opencode',
    '    model: opencode/north-mini-code-free',
    'tiers: {}',
    '',
  ].join('\n'));
  assert.equal(cfg.workers['oc-free'].runtime, 'opencode');
});

test('old opencode-family handles surface one identity-drift warning on cfg.warnings, NOT stderr', () => {
  // Regression: warnings used to print to stderr on EVERY load (noise on dlg run/--json).
  // They now ride the returned config and are surfaced only by providers/doctor.
  const originalWrite = process.stderr.write;
  let stderr = '';
  process.stderr.write = (chunk, ...args) => {
    stderr += String(chunk);
    if (typeof args.at(-1) === 'function') args.at(-1)();
    return true;
  };
  let cfg;
  try {
    cfg = loadYaml([
      defaultsYaml,
      'providers:',
      '  opencode:',
      '    kind: opencode',
      'workers:',
      '  opencode/north-mini-code-free:',
      '    provider: opencode',
      '    model: opencode/north-mini-code-free',
      'tiers: {}',
      '',
    ].join('\n'));
  } finally {
    process.stderr.write = originalWrite;
  }
  const warnings = cfg.warnings ?? [];
  assert.match(warnings.join('\n'), /identity-drift/i);
  assert.match(warnings.join('\n'), /opencode\/north-mini-code-free/);
  assert.equal(warnings.filter((w) => /north-mini-code-free/.test(w)).length, 1, 'one warning per handle, deduped');
  assert.doesNotMatch(stderr, /identity-drift/i, 'load must NOT write the warning to stderr');
});

test('parseHandle resolves runtime/provider/model or profile alias by declared keys', () => {
  const cfg = loadYaml([
    defaultsYaml,
    'runtimes:',
    '  claude-headless: { command: claude, protocol: anthropic, prompt: { mode: stdin }, parser: builtin:claude-stream-json-events }',
    '  codex-exec: { command: codex, protocol: openai, prompt: { mode: stdin }, parser: builtin:codex-exec-json-events }',
    '  opencode: { command: opencode, protocol: opencode, auth: subscription, prompt: { mode: argv-last }, parser: builtin:opencode-run-json-events }',
    '  api-oneshot: { protocol: openai, auth: api-key, parser: none }',
    'providers:',
    '  zai-anthropic: { protocol: anthropic, auth: api-key, defaultRuntime: claude-headless, models: { glm-5.1: {}, "glm-5.2[1m]": {} } }',
    '  zai-openai: { protocol: openai, auth: api-key, defaultRuntime: api-oneshot, models: { glm-5.1: {} } }',
    '  ollama: { protocol: openai, auth: none, baseUrl: "http://localhost:11434/v1", models: { "gemma3:4b": {} } }',
    '  github-copilot: { protocol: opencode, auth: subscription, models: { "gpt-5.5": {} } }',
    'workers:',
    '  glm-5.1-oc: { provider: github-copilot, model: gpt-5.5 }',
    'tiers: {}',
    '',
  ].join('\n'));

  assert.deepEqual(parseHandle('zai-anthropic/glm-5.1', cfg), {
    provider: 'zai-anthropic',
    model: 'glm-5.1',
  });
  assert.deepEqual(parseHandle('codex-exec/zai-openai/glm-5.1', cfg), {
    runtime: 'codex',
    provider: 'zai-openai',
    model: 'glm-5.1',
  });
  assert.deepEqual(parseHandle('claude/zai-anthropic/opus', cfg), {
    runtime: 'claude',
    provider: 'zai-anthropic',
    model: 'opus',
  });
  assert.deepEqual(parseHandle('claude-headless/zai-anthropic/opus', cfg), {
    runtime: 'claude',
    provider: 'zai-anthropic',
    model: 'opus',
  });
  assert.deepEqual(parseHandle('ollama/gemma3:4b', cfg), {
    provider: 'ollama',
    model: 'gemma3:4b',
  });
  assert.deepEqual(parseHandle('opencode/github-copilot/gpt-5.5', cfg), {
    runtime: 'opencode',
    provider: 'github-copilot',
    model: 'gpt-5.5',
  });
  assert.deepEqual(parseHandle('glm-5.1-oc', cfg), { profileAlias: 'glm-5.1-oc' });
  assert.deepEqual(parseHandle('zai-anthropic/glm-5.2[1m]', cfg), {
    provider: 'zai-anthropic',
    model: 'glm-5.2[1m]',
  });
});

test('old runtime ids are accepted as aliases and normalized on load', () => {
  const cfg = loadYaml([
    defaultsYaml,
    'providers:',
    '  anthropic-sub: { kind: anthropic, defaultRuntime: claude-headless }',
    '  codex-sub: { kind: codex-cli, defaultRuntime: codex-exec }',
    '  opencode-sub: { kind: opencode, defaultRuntime: opencode-run }',
    '  local-api: { kind: openai-compatible, baseUrl: "http://localhost:1234/v1", defaultRuntime: api-oneshot }',
    'workers:',
    '  old-claude: { provider: anthropic-sub, model: opus, runtime: claude-headless }',
    '  old-codex: { provider: codex-sub, model: gpt-5.5, runtime: codex-exec }',
    '  old-opencode: { provider: opencode-sub, model: github-copilot/gpt-5.5, runtime: opencode-run }',
    '  old-api: { provider: local-api, model: local-model, runtime: api-oneshot }',
    'tiers: {}',
    '',
  ].join('\n'));

  assert.equal(cfg.providers['anthropic-sub'].defaultRuntime, 'claude');
  assert.equal(cfg.providers['codex-sub'].defaultRuntime, 'codex');
  assert.equal(cfg.providers['opencode-sub'].defaultRuntime, 'opencode');
  assert.equal(cfg.providers['local-api'].defaultRuntime, 'api');
  assert.equal(cfg.workers['old-claude'].runtime, 'claude');
  assert.equal(cfg.workers['old-codex'].runtime, 'codex');
  assert.equal(cfg.workers['old-opencode'].runtime, 'opencode');
  assert.equal(cfg.workers['old-api'].runtime, 'api');
});

test('new shape validates ids, handle segments, compatibility, and ambiguous defaults', () => {
  // A name may be BOTH a runtime and a provider (a self-routing CLI like pi/opencode is naturally
  // both) — handle positions disambiguate (`same/model` = provider; `same/p/model` = runtime), so it
  // loads rather than clashing.
  assert.doesNotThrow(() => loadYaml([
    defaultsYaml,
    'runtimes: { same: { protocol: openai, auth: api-key, parser: none } }',
    'providers: { same: { protocol: openai, auth: api-key, baseUrl: "http://localhost:1234/v1", models: {} } }',
    'workers: {}',
    'tiers: {}',
  ].join('\n')));

  assert.throws(() => loadYaml([
    defaultsYaml,
    'runtimes: { api-oneshot: { protocol: openai, auth: api-key, parser: none } }',
    'providers: { ollama: { protocol: openai, auth: none, baseUrl: "http://localhost:11434/v1", models: {} } }',
    'workers: { bad: { provider: ollama, model: "gemma3:4b/" } }',
    'tiers: {}',
  ].join('\n')), /empty handle segment/i);

  assert.throws(() => loadYaml([
    defaultsYaml,
    'runtimes: { claude-headless: { command: claude, protocol: anthropic, auth: subscription, prompt: { mode: stdin }, parser: builtin:claude-stream-json-events } }',
    'providers: { zai-openai: { protocol: openai, auth: api-key, models: { glm: {} } } }',
    'workers: { glm: { runtime: claude-headless, provider: zai-openai, model: glm } }',
    'tiers: {}',
  ].join('\n')), /protocol\/auth/i);

  assert.throws(() => loadYaml([
    defaultsYaml,
    'runtimes:',
    '  api-oneshot: { protocol: openai, auth: api-key, parser: none }',
    '  api-alt: { protocol: openai, auth: api-key, parser: none }',
    'providers: { zai-openai: { protocol: openai, auth: api-key, models: { glm: {} } } }',
    'workers: { glm: { provider: zai-openai, model: glm } }',
    'tiers: {}',
  ].join('\n')), /defaultRuntime/i);
});

test('equip parses on worker profiles', () => {
  const cfg = loadYaml([
    defaultsYaml,
    'runtimes: { claude-headless: { command: claude, protocol: anthropic, auth: api-key, prompt: { mode: stdin }, parser: builtin:claude-stream-json-events } }',
    'providers: { zai: { protocol: anthropic, auth: api-key, models: { glm: {} } } }',
    'workers:',
    '  glm:',
    '    provider: zai',
    '    model: glm',
    '    equip:',
    '      profile: clean',
    '      skills: [qa-review]',
    '      mcp: [playwright]',
    '      tools: [Read, Edit, Write]',
    'tiers: {}',
    '',
  ].join('\n'));
  assert.deepEqual(cfg.workers.glm.equip, {
    profile: 'clean',
    skills: ['qa-review'],
    mcp: ['playwright'],
    tools: ['Read', 'Edit', 'Write'],
  });
});
