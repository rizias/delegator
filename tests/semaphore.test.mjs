// Concurrency queue: limit, queueing, release, stale reclaim.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolate the config home so tests never touch the real ~/.delegator.
process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-test-'));
const { acquireSlot, scopeOccupancy } = await import('../dist/semaphore.js');

test('unbounded scope returns immediately', async () => {
  const slot = await acquireSlot('s0', { limit: 0, runId: 'r', queueTimeoutMs: 100, pollMs: 10 });
  assert.ok(slot);
  slot.release();
});

test('second acquire waits until the first releases', async () => {
  const a = await acquireSlot('s1', { limit: 1, runId: 'a', queueTimeoutMs: 2000, pollMs: 20 });
  assert.ok(a);
  let waited = false;
  const bP = acquireSlot('s1', { limit: 1, runId: 'b', queueTimeoutMs: 2000, pollMs: 20, onWait: () => { waited = true; } });
  setTimeout(() => a.release(), 120);
  const b = await bP;
  assert.ok(b, 'queued acquire must eventually get the slot');
  assert.ok(waited, 'onWait must fire while queueing');
  assert.ok(b.waitedMs >= 80, `waited ${b.waitedMs}ms`);
  b.release();
});

test('queue timeout returns null instead of hanging', async () => {
  const a = await acquireSlot('s2', { limit: 1, runId: 'a', queueTimeoutMs: 5000, pollMs: 20 });
  const b = await acquireSlot('s2', { limit: 1, runId: 'b', queueTimeoutMs: 150, pollMs: 20 });
  assert.equal(b, null);
  a.release();
});

test('a slot held by a dead pid is reclaimed', async () => {
  const dir = path.join(process.env.DELEGATOR_HOME, 'locks', 's3');
  fs.mkdirSync(dir, { recursive: true });
  // 999999: virtually guaranteed dead; ts fresh so only pid-liveness triggers reclaim
  fs.writeFileSync(path.join(dir, '0.slot'), JSON.stringify({ pid: 999999, ts: Date.now(), runId: 'dead' }));
  const slot = await acquireSlot('s3', { limit: 1, runId: 'live', queueTimeoutMs: 500, pollMs: 20 });
  assert.ok(slot, 'dead holder must not wedge the queue');
  assert.equal(scopeOccupancy('s3').held, 1);
  slot.release();
  assert.equal(scopeOccupancy('s3').held, 0);
});
