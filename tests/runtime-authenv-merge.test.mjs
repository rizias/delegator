// A stale user/project runtimes override that redefines `claude`
// without `authEnv` wholesale-replaced the packaged descriptor, dropping the login namespace, so the
// worker's own subscription auth got stripped -> 401. The packaged authEnv must survive such an
// override (it is a security default), while an explicit `authEnv: []` still opts out.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Isolate from the real ~/.delegator/runtimes.yaml so the test exercises only the override path.
process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-authenv-'));

const { mergedRuntimeDescriptors } = await import('../dist/config.js');

const claudeOverride = (extra) => ({
  runtimes: { claude: { command: 'claude', prompt: { mode: 'stdin' }, parser: 'builtin:claude-stream-json-events', ...extra } },
});

test('a claude override that omits authEnv inherits the packaged login namespace', () => {
  const claude = mergedRuntimeDescriptors(claudeOverride({})).claude;
  assert.deepEqual(claude.authEnv, ['ANTHROPIC', 'CLAUDE'],
    'packaged authEnv must survive a wholesale override (else subscription auth is stripped -> 401)');
});

test('an explicit empty authEnv in the override opts out (not restored)', () => {
  const claude = mergedRuntimeDescriptors(claudeOverride({ authEnv: [] })).claude;
  assert.deepEqual(claude.authEnv, [], 'an explicit authEnv: [] must be respected');
});

test('a stale override inherits packaged env additions it does not set, override env wins on conflict', () => {
  // The same class as authEnv: a full-copy runtimes.yaml that predates a new packaged env var (e.g.
  // API_TIMEOUT_MS) must still get it, while the override's own env keys take precedence.
  const claude = mergedRuntimeDescriptors(claudeOverride({ env: { ANTHROPIC_BASE_URL: 'https://override.example' } })).claude;
  assert.equal(claude.env.API_TIMEOUT_MS, '{{budget.wallClockMs}}', 'packaged env default must be inherited');
  assert.equal(claude.env.ANTHROPIC_BASE_URL, 'https://override.example', 'override env value wins on conflict');
});

test('an override REPLACES identity fields — omitting auth means unset, not the packaged value', () => {
  // Regression for the field-merge mistake: inheriting packaged `auth` broke api-key compatibility.
  const claude = mergedRuntimeDescriptors(claudeOverride({ protocol: 'openai' })).claude;
  assert.equal(claude.protocol, 'openai', 'override identity field wins');
  assert.equal(claude.auth, undefined, 'an omitted identity field stays unset (not inherited from packaged)');
});
