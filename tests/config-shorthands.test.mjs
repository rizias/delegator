import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-cfg-short-'));

const { loadConfig } = await import('../dist/config.js');
const { resolveWorkerHandle } = await import('../dist/registry.js');

function writeGlobal(yaml) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-cfg-short-case-'));
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

test('keyEnv normalizes to apiKeyEnv and wins over apiKeyEnv', () => {
  const cfg = loadYaml([
    defaultsYaml,
    'providers:',
    '  openai:',
    '    kind: openai-compatible',
    '    apiKeyEnv: SHOULD_NOT_WIN',
    '    keyEnv: OPENAI_API_KEY',
    'workers: {}',
    'tiers: {}',
    '',
  ].join('\n'));

  assert.equal(cfg.providers.openai.apiKeyEnv, 'OPENAI_API_KEY');
  assert.equal(Object.hasOwn(cfg.providers.openai, 'keyEnv'), false);
});

test('models list normalizes to a model map and remains resolvable as a provider/model handle', () => {
  const cfg = loadYaml([
    defaultsYaml,
    'runtimes:',
    '  api-oneshot: { mode: direct-api, protocol: openai, auth: api-key, request: { method: POST, path: /responses }, output: { parser: builtin:openai-responses } }',
    'providers:',
    '  openai:',
    '    protocol: openai',
    '    auth: api-key',
    '    models: [gpt-5.5, gpt-5-mini]',
    'workers: {}',
    'tiers: {}',
    '',
  ].join('\n'));

  assert.deepEqual(cfg.providers.openai.models, { 'gpt-5.5': {}, 'gpt-5-mini': {} });
  // The model declares no reasoningEffort, so it inherits the api runtime's effortLevels catalog.
  assert.deepEqual(resolveWorkerHandle('openai/gpt-5.5', cfg), {
    provider: 'openai',
    model: 'gpt-5.5',
    runtime: 'api',
    reasoningEffort: 'medium',
    reasoningEffortLevels: ['minimal', 'low', 'medium', 'high'],
  });
});

test('runtimes block and modelCatalog descriptors load without wiring dispatch to them', () => {
  const cfg = loadYaml([
    defaultsYaml,
    'runtimes:',
    '  codex:',
    '    mode: command',
    '    command: codex',
    '    args:',
    '      - exec',
    '      - ["--json", "--experimental"]',
    '    prompt: { mode: file }',
    '    output: { parser: builtin:codex-exec-json-events }',
    '    equipment:',
    '      profile: { flag: "-p" }',
    'providers:',
    '  openai:',
    '    protocol: openai',
    '    auth: api-key',
    '    keyEnv: OPENAI_API_KEY',
    '    modelCatalog:',
    '      mode: direct-api',
    '      method: GET',
    '      path: /models',
    '      output:',
    '        parser: builtin:openai-models-list',
    '        itemsPath: data',
    '        idPath: id',
    '    models: { gpt-5.5: {} }',
    'workers:',
    '  gpt-via-codex: { runtime: codex, provider: openai, model: gpt-5.5 }',
    'tiers: {}',
    '',
  ].join('\n'));

  assert.equal(cfg.runtimes.codex.mode, 'command');
  assert.deepEqual(cfg.runtimes.codex.args, ['exec', ['--json', '--experimental']]);
  assert.equal(cfg.runtimes.codex.prompt.mode, 'file');
  assert.equal(cfg.runtimes.codex.parser, 'builtin:codex-exec-json-events');
  assert.equal(cfg.providers.openai.modelCatalog.output.itemsPath, 'data');
  assert.equal(cfg.workers['gpt-via-codex'].runtime, 'codex');
});

test('tier chains accept declared worker ids and provider/model handles without warnings', () => {
  const cfg = loadYaml([
    defaultsYaml,
    'runtimes:',
    '  codex: { mode: command, command: codex, output: { parser: builtin:codex-exec-json-events } }',
    '  openai-responses: { mode: direct-api, protocol: openai, auth: api-key, request: { method: POST, path: /responses }, output: { parser: builtin:openai-responses } }',
    'providers:',
    '  openai:',
    '    protocol: openai',
    '    auth: api-key',
    '    models: [gpt-5.5]',
    'workers:',
    '  gpt-via-codex: { runtime: codex, provider: openai, model: gpt-5.5 }',
    'tiers:',
    '  standard-code: { chain: [gpt-via-codex, openai/gpt-5.5], fallback: auto }',
    '',
  ].join('\n'));

  assert.equal(cfg.warnings, undefined);
  assert.deepEqual(resolveWorkerHandle('openai/gpt-5.5', cfg), {
    provider: 'openai',
    model: 'gpt-5.5',
    runtime: 'openai-responses',
  });
});

test('unresolved tier chain entries become load warnings, not config errors', () => {
  const cfg = loadYaml([
    defaultsYaml,
    'runtimes:',
    '  api-oneshot: { mode: direct-api, protocol: openai, auth: api-key, request: { method: POST, path: /responses }, output: { parser: builtin:openai-responses } }',
    'providers:',
    '  openai: { protocol: openai, auth: api-key, models: [gpt-5.5] }',
    'workers: {}',
    'tiers:',
    '  standard-code: { chain: [missing-worker], fallback: auto }',
    '',
  ].join('\n'));

  assert.match((cfg.warnings ?? []).join('\n'), /standard-code/);
  assert.match((cfg.warnings ?? []).join('\n'), /missing-worker/);
});

test('a bare provider/model handle inherits the provider per-model defaults', () => {
  const cfg = loadYaml([
    defaultsYaml,
    'providers:',
    '  openai-codex:',
    '    protocol: openai',
    '    auth: subscription',
    '    defaultRuntime: codex',
    '    models:',
    '      gpt-5.5:',
    '        reasoningEffort: high',
    '        contextWindow: 400000',
    '        budget: { wallClock: 25m }',
    '        card: { goodFor: [reasoning], notes: "flagship" }',
    'workers: {}',
    'tiers:',
    '  reasoning-code: { chain: [openai-codex/gpt-5.5], fallback: report }',
    '',
  ].join('\n'));

  const w = resolveWorkerHandle('openai-codex/gpt-5.5', cfg);
  assert.equal(w.runtime, 'codex');
  assert.equal(w.reasoningEffort, 'high', 'handle must inherit reasoningEffort from the model');
  assert.equal(w.contextWindow, 400000, 'handle must inherit contextWindow');
  assert.equal(w.budget?.wallClockMs, 25 * 60 * 1000, 'handle must inherit (and normalise) budget');
  assert.deepEqual(w.card, { goodFor: ['reasoning'], notes: 'flagship' }, 'handle must inherit the card');
});

test('a bare handle to a model with no per-model reasoning data inherits runtime effort defaults', () => {
  const cfg = loadYaml([
    defaultsYaml,
    'providers:',
    '  zai:',
    '    protocol: anthropic',
    '    auth: api-key',
    '    baseUrl: https://api.z.ai/api/anthropic',
    '    models: [glm-5.2]',
    'workers: {}',
    'tiers: {}',
    '',
  ].join('\n'));

  assert.deepEqual(resolveWorkerHandle('zai/glm-5.2', cfg), {
    provider: 'zai',
    model: 'glm-5.2',
    runtime: 'claude',
    reasoningEffort: 'medium',
    reasoningEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode'],
  });
});

test('the full config shape example loads cleanly', () => {
  const cfg = loadYaml([
    defaultsYaml,
    'runtimes:',
    '  claude:',
    '    mode: command',
    '    command: claude',
    '    args:',
    '      - "-p"',
    '      - "--output-format"',
    '      - "stream-json"',
    '      - "--verbose"',
    '      - "--model"',
    '      - "{{model.id}}"',
    '      - "--permission-mode"',
    '      - "{{permissionMode:bypassPermissions}}"',
    '    prompt: { mode: stdin }',
    '    output: { parser: builtin:claude-stream-json-events }',
    '    equipment:',
    '      tools: { allow: { flag: "--tools", join: "," } }',
    '      mcp: { configFlag: "--mcp-config" }',
    '      profile: { env: "CLAUDE_CONFIG_DIR" }',
    '',
    '  codex:',
    '    mode: command',
    '    command: codex',
    '    args:',
    '      - "exec"',
    '      - "--json"',
    '      - "-m"',
    '      - "{{model.id}}"',
    '      - "-C"',
    '      - "{{worktree}}"',
    '      - "-c"',
    '      - "model_reasoning_effort=\\"{{reasoningEffort:medium}}\\""',
    '      - "-"',
    '    prompt: { mode: stdin }',
    '    output: { parser: builtin:codex-exec-json-events }',
    '    equipment:',
    '      profile: { flag: "-p" }',
    '      config: { repeatFlag: "-c" }',
    '',
    '  opencode:',
    '    mode: command',
    '    command: opencode',
    '    args: ["run", "--format", "json", "--model", "{{provider.id}}/{{model.id}}"]',
    '    prompt: { mode: argv-last }',
    '    output: { parser: builtin:opencode-run-json-events }',
    '',
    '  pi:',
    '    mode: command',
    '    command: pi',
    '    args:',
    '      - "--print"',
    '      - "--mode"',
    '      - "json"',
    '      - "--no-session"',
    '      - "--model"',
    '      - "{{provider.id}}/{{model.id}}"',
    '      - "--thinking"',
    '      - "{{reasoningEffort:medium}}"',
    '    prompt: { mode: argv-last }',
    '    output: { parser: builtin:pi-json-events }',
    '    equipment:',
    '      tools:',
    '        none: ["--no-tools"]',
    '        allow: { flag: "--tools", join: "," }',
    '      skills: { repeatFlag: "--skill" }',
    '      extensions: { repeatFlag: "--extension" }',
    '',
    '  openai-responses:',
    '    mode: direct-api',
    '    protocol: openai',
    '    auth: api-key',
    '    request:',
    '      method: POST',
    '      path: /responses',
    '      headers:',
    '        Authorization: "Bearer {{secret(provider.id)}}"',
    '      json:',
    '        model: "{{model.id}}"',
    '        input: "{{brief}}"',
    '        reasoning: { effort: "{{reasoningEffort:medium}}" }',
    '    output: { parser: builtin:openai-responses }',
    '',
    '  anthropic-messages:',
    '    mode: direct-api',
    '    protocol: anthropic',
    '    auth: api-key',
    '    request:',
    '      method: POST',
    '      path: /v1/messages',
    '      headers:',
    '        x-api-key: "{{secret(provider.id)}}"',
    '        anthropic-version: "2023-06-01"',
    '      json:',
    '        model: "{{model.id}}"',
    '        max_tokens: "{{maxTokens:4096}}"',
    '        messages:',
    '          - role: user',
    '            content: "{{brief}}"',
    '    output: { parser: builtin:anthropic-messages }',
    '',
    'providers:',
    '  openai:',
    '    protocol: openai',
    '    auth: api-key',
    '    baseUrl: https://api.openai.com/v1',
    '    keyEnv: OPENAI_API_KEY',
    '    modelCatalog:',
    '      mode: direct-api',
    '      method: GET',
    '      path: /models',
    '      output:',
    '        parser: builtin:openai-models-list',
    '        itemsPath: data',
    '        idPath: id',
    '    models: []',
    '',
    '  pi:',
    '    auth: subscription',
    '    modelCatalog:',
    '      mode: command',
    '      command: pi',
    '      args: ["--list-models"]',
    '      output: { parser: builtin:generic-lines }',
    '    models: []',
    '',
    'workers:',
    '  gpt-via-codex:',
    '    runtime: codex',
    '    provider: openai',
    '    model: gpt-5.5',
    '    equip:',
    '      profile: inherit',
    '      tools: [Read, Edit, Write, Bash]',
    '',
    'tiers:',
    '  standard-code:',
    '    chain: [gpt-via-codex, openai/gpt-5.5]',
    '    fallback: auto',
    '',
  ].join('\n'));

  assert.equal(cfg.warnings, undefined);
  assert.equal(cfg.runtimes.codex.mode, 'command');
  assert.equal(cfg.providers.openai.apiKeyEnv, 'OPENAI_API_KEY');
  assert.deepEqual(cfg.providers.openai.models, {});
  assert.deepEqual(resolveWorkerHandle('openai/gpt-5.5', cfg), {
    provider: 'openai',
    model: 'gpt-5.5',
    runtime: 'openai-responses',
  });
});
