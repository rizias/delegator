// Config semantics: durations, secret pools, key rotation cursor.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-test-'));
const { parseDuration, saveSecret, loadSecretPools, nextPoolKey, loadConfig, ConfigError } = await import('../dist/config.js');

test('parseDuration understands ms/s/m/h and plain integers', () => {
  assert.equal(parseDuration('500ms'), 500);
  assert.equal(parseDuration('90s'), 90_000);
  assert.equal(parseDuration('10m'), 600_000);
  assert.equal(parseDuration('2h'), 7_200_000);
  assert.equal(parseDuration('1234'), 1234);
  assert.throws(() => parseDuration('soon'));
});

test('key pools: set replaces, add appends and dedupes', () => {
  saveSecret('prov', 'k1');
  saveSecret('prov', 'k2', { append: true });
  saveSecret('prov', 'k2', { append: true }); // dedupe
  assert.deepEqual(loadSecretPools()['prov'], ['k1', 'k2']);
  saveSecret('prov', 'k3'); // replace
  assert.deepEqual(loadSecretPools()['prov'], ['k3']);
});

test('refusing an empty key never wipes the existing pool (set or add)', () => {
  saveSecret('keep', 'good-key');
  assert.throws(() => saveSecret('keep', ''), /empty key/, 'set with empty must throw');
  assert.throws(() => saveSecret('keep', '   '), /empty key/, 'whitespace-only must throw');
  assert.throws(() => saveSecret('keep', '', { append: true }), /empty key/, 'append empty must throw');
  assert.deepEqual(loadSecretPools()['keep'], ['good-key'], 'the working key survived the rejected writes');
});

test('rotation cursor is round-robin and persists', () => {
  const pool = ['a', 'b', 'c'];
  const seq = [nextPoolKey('rot', pool), nextPoolKey('rot', pool), nextPoolKey('rot', pool), nextPoolKey('rot', pool)];
  assert.deepEqual(seq, ['a', 'b', 'c', 'a']);
});

test('saveSecret refuses to overwrite a CORRUPT secrets.yaml (never silently wipes keys)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-corrupt-sec-'));
  process.env.DELEGATOR_HOME = home;
  const secrets = path.join(home, 'secrets.yaml');
  saveSecret('glm', 'glm-key'); // establish a real pool first
  const corrupt = 'glm: "glm-key"\nmimo: ["a", "b"\n'; // unterminated flow seq -> invalid YAML
  fs.writeFileSync(secrets, corrupt, 'utf8');
  // A new save must ABORT on the unparseable existing file, not overwrite it away.
  assert.throws(() => saveSecret('nvidia', 'nv-key'), /not valid YAML|refusing to overwrite/i,
    'saving onto a corrupt secrets.yaml must throw, not silently destroy it');
  assert.equal(fs.readFileSync(secrets, 'utf8'), corrupt, 'the corrupt file is left intact — nothing destroyed');
});

function writeConfig(yaml) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-removed-fields-'));
  process.env.DELEGATOR_HOME = home;
  fs.writeFileSync(path.join(home, 'providers.yaml'), yaml, 'utf8');
  return home;
}

test('config containing provider trust is rejected with a clear error', () => {
  const home = writeConfig([
    'version: 1',
    'providers:',
    '  p:',
    '    kind: openai-compatible',
    '    baseUrl: http://localhost:1234/v1',
    '    trust: local',
    'workers: {}',
    'tiers: {}',
  ].join('\n'));
  assert.throws(
    () => loadConfig(home),
    (e) => e instanceof ConfigError && /removed field "providers\.p\.trust"/.test(e.message),
  );
});

test('config containing privacy.externalWorkers is rejected with a clear error', () => {
  const home = writeConfig([
    'version: 1',
    'privacy:',
    '  externalWorkers: deny',
    'providers: {}',
    'workers: {}',
    'tiers: {}',
  ].join('\n'));
  assert.throws(
    () => loadConfig(home),
    (e) => e instanceof ConfigError && /removed field "privacy\.externalWorkers"/.test(e.message),
  );
});

test('numeric wallClock must be a positive integer (0 / -1 / 1.5 rejected, same as wallClockMs)', () => {
  for (const bad of [0, -1, 1.5]) {
    const home = writeConfig([
      'version: 1',
      'defaults:',
      `  budget: { wallClock: ${bad} }`,
      'providers: {}',
      'workers: {}',
      'tiers: {}',
    ].join('\n'));
    assert.throws(() => loadConfig(home), ConfigError, `wallClock: ${bad} must be rejected`);
  }
});
