import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { loadConfig, mergedRuntimeDescriptors } = await import('../dist/config.js');

function makeHome(prefix = 'dlg-runtimes-file-') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(home, 'providers.yaml'), [
    'version: 1',
    'privacy:',
    '  sensitivePaths: []',
    'providers: {}',
    'workers: {}',
    'tiers: {}',
    '',
  ].join('\n'), 'utf8');
  return home;
}

function loadFromHome(home) {
  process.env.DELEGATOR_HOME = home;
  return mergedRuntimeDescriptors(loadConfig(home));
}

test('packaged runtimes.default.yaml supplies defaults when providers.yaml has no runtimes', () => {
  const runtimes = loadFromHome(makeHome());
  assert.deepEqual(Object.keys(runtimes).sort(), ['api', 'claude', 'codex', 'opencode', 'pi']);
  assert.equal(runtimes.claude.command, 'claude');
  assert.equal(runtimes.codex.command, 'codex');
  assert.equal(runtimes.api.mode, 'direct-api');
});

test('home runtimes.yaml overrides packaged runtime descriptors', () => {
  const home = makeHome();
  fs.writeFileSync(path.join(home, 'runtimes.yaml'), [
    'runtimes:',
    '  claude:',
    '    mode: command',
    '    command: custom-claude',
    '    protocol: anthropic',
    '    auth: subscription',
    '    prompt: { mode: stdin }',
    '    parser: builtin:claude-stream-json-events',
    '',
  ].join('\n'), 'utf8');

  const runtimes = loadFromHome(home);
  assert.equal(runtimes.claude.command, 'custom-claude');
  assert.equal(runtimes.codex.command, 'codex');
});

test('providers.yaml runtimes override home runtimes.yaml and packaged defaults', () => {
  const home = makeHome();
  fs.writeFileSync(path.join(home, 'providers.yaml'), [
    'version: 1',
    'privacy:',
    '  sensitivePaths: []',
    'runtimes:',
    '  claude:',
    '    mode: command',
    '    command: provider-claude',
    '    protocol: anthropic',
    '    auth: subscription',
    '    prompt: { mode: stdin }',
    '    parser: builtin:claude-stream-json-events',
    'providers: {}',
    'workers: {}',
    'tiers: {}',
    '',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(home, 'runtimes.yaml'), [
    'runtimes:',
    '  claude:',
    '    mode: command',
    '    command: home-claude',
    '    protocol: anthropic',
    '    auth: subscription',
    '    prompt: { mode: stdin }',
    '    parser: builtin:claude-stream-json-events',
    '',
  ].join('\n'), 'utf8');

  const runtimes = loadFromHome(home);
  assert.equal(runtimes.claude.command, 'provider-claude');
});
