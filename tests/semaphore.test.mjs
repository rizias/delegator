// Concurrency queue: limit, queueing, release, dead-holder reclaim, ownership.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolate the config home so tests never touch the real ~/.delegator.
process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-test-'));
const { acquireSlot, scopeOccupancy, heartbeatSlot } = await import('../dist/semaphore.js');

function slotFile(scope, n) {
  const dir = path.join(process.env.DELEGATOR_HOME, 'locks', scope);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${n}.slot`);
}

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

test('a live holder with a stale heartbeat keeps its slot (no over-admission)', async () => {
  const p = slotFile('s4', 0);
  // Holder pid is alive (our own); ts far beyond STALE_MS — a stalled heartbeat
  // (suspended laptop, blocked event loop), NOT a crash. Evicting it would let
  // limit+1 workers run at once.
  fs.writeFileSync(p, JSON.stringify({ pid: process.pid, ts: Date.now() - 600_000, runId: 'stalled' }));
  const thief = await acquireSlot('s4', { limit: 1, runId: 'thief', queueTimeoutMs: 150, pollMs: 20 });
  assert.equal(thief, null, 'a stale-but-alive holder must not be evicted');
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).runId, 'stalled', 'holder slot file must be untouched');
});

test("release() leaves a slot file it no longer owns untouched", async () => {
  const a = await acquireSlot('s5', { limit: 1, runId: 'old', queueTimeoutMs: 500, pollMs: 20 });
  assert.ok(a);
  const p = slotFile('s5', a.slot);
  // Simulate the slot having been handed to another run in the meantime.
  fs.writeFileSync(p, JSON.stringify({ pid: process.pid, ts: Date.now(), runId: 'new' }));
  a.release();
  assert.ok(fs.existsSync(p), "the old holder's release must not delete the new holder's slot");
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).runId, 'new');
});

test('heartbeatSlot() freshens a slot it still owns', () => {
  const p = slotFile('s6', 0);
  const own = { pid: process.pid, ts: Date.now() - 50_000, runId: 'me' };
  fs.writeFileSync(p, JSON.stringify(own));
  assert.equal(heartbeatSlot(p, own), true);
  const after = JSON.parse(fs.readFileSync(p, 'utf8'));
  assert.equal(after.runId, 'me');
  assert.ok(after.ts > own.ts, 'heartbeat must freshen ts');
});

test('heartbeatSlot() refuses a slot owned by another run', () => {
  const p = slotFile('s6', 1);
  fs.writeFileSync(p, JSON.stringify({ pid: process.pid, ts: Date.now(), runId: 'other' }));
  assert.equal(heartbeatSlot(p, { pid: process.pid, ts: 0, runId: 'me' }), false);
  assert.equal(JSON.parse(fs.readFileSync(p, 'utf8')).runId, 'other', 'foreign slot must not be overwritten');
});

test('heartbeatSlot() does not resurrect a deleted slot file', () => {
  const p = slotFile('s6', 2); // never created
  assert.equal(heartbeatSlot(p, { pid: process.pid, ts: 0, runId: 'me' }), false);
  assert.ok(!fs.existsSync(p), 'a lost slot must never be recreated by its old holder');
});

test('a fresh unparseable slot file is not reclaimed (peer may be mid-write)', async () => {
  const p = slotFile('s7', 0);
  fs.writeFileSync(p, '{"pid":12'); // truncated JSON, fresh mtime
  const slot = await acquireSlot('s7', { limit: 1, runId: 'x', queueTimeoutMs: 150, pollMs: 20 });
  assert.equal(slot, null, 'fresh corrupt file must be left for its writer to finish');
  assert.ok(fs.existsSync(p));
});

test('an old unparseable slot file is reclaimed so the queue never wedges', async () => {
  const p = slotFile('s8', 0);
  fs.writeFileSync(p, 'not json at all');
  const old = (Date.now() - 600_000) / 1000; // utimes takes seconds
  fs.utimesSync(p, old, old);
  const slot = await acquireSlot('s8', { limit: 1, runId: 'x', queueTimeoutMs: 500, pollMs: 20 });
  assert.ok(slot, 'abandoned garbage must not wedge the queue');
  slot.release();
});
