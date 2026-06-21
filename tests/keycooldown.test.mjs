// Per-key cooldown: nextPoolKey skips parked keys; runs continue on
// the next key; parked keys are stored hashed, never raw.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-test-'));
const { nextPoolKey } = await import('../dist/config.js');
const { parkKey, isKeyParked, hashKey } = await import('../dist/keycooldown.js');

const FAR = () => Date.now() + 100_000;

test('rotation skips a parked key and continues on the others', () => {
  const pool = ['a', 'b', 'c'];
  parkKey('p1', 'b', FAR());
  const seq = [nextPoolKey('p1', pool), nextPoolKey('p1', pool), nextPoolKey('p1', pool), nextPoolKey('p1', pool)];
  assert.ok(!seq.includes('b'), `parked key must be skipped, got ${seq}`);
  assert.deepEqual([...new Set(seq)].sort(), ['a', 'c']); // only the live keys
});

test('an expired park no longer skips the key', () => {
  const pool = ['x', 'y'];
  parkKey('p2', 'y', Date.now() - 1); // already expired
  const seq = [nextPoolKey('p2', pool), nextPoolKey('p2', pool)];
  assert.ok(seq.includes('y'), 'expired park should be pruned, y reachable again');
});

test('when every key is parked, the soonest-to-recover key is chosen', () => {
  const pool = ['m', 'n'];
  parkKey('p4', 'm', Date.now() + 50_000);
  parkKey('p4', 'n', Date.now() + 100_000);
  assert.equal(nextPoolKey('p4', pool), 'm'); // m recovers first
});

test('isKeyParked reflects the active cooldown', () => {
  parkKey('p3', 'secret-key', FAR());
  assert.equal(isKeyParked('p3', 'secret-key'), true);
  assert.equal(isKeyParked('p3', 'some-other-key'), false);
});

test('SECURITY: state.json stores the key HASH, never the raw key', () => {
  const raw = 'sk-supersecret-zai-key-DO-NOT-LEAK';
  parkKey('p5', raw, FAR());
  const stateFile = path.join(process.env.DELEGATOR_HOME, 'state.json');
  const text = fs.readFileSync(stateFile, 'utf8');
  assert.ok(!text.includes(raw), 'raw key must never be written to state.json');
  assert.ok(text.includes(hashKey(raw)), 'the sha256 hash should be present');
});

test('a single-key pool is never skipped (nothing to rotate to)', () => {
  parkKey('p6', 'only', FAR());
  assert.equal(nextPoolKey('p6', ['only']), 'only');
});
