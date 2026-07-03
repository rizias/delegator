// Concurrency queue: bakery-ordered write-once tickets — limit, queueing,
// doorway wait, dead-holder GC, occupancy, no-residue release.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Isolate the config home so tests never touch the real ~/.delegator.
process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-test-'));
const { acquireSlot, scopeOccupancy } = await import('../dist/semaphore.js');

function lockDir(scope) {
  const dir = path.join(process.env.DELEGATOR_HOME, 'locks', scope);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
const touch = (dir, name) => fs.closeSync(fs.openSync(path.join(dir, name), 'w'));

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

test('a dead holder ticket is garbage-collected and its slot freed', async () => {
  const dir = lockDir('s3');
  // 999999: virtually guaranteed dead; the pid lives in the NAME, files are empty.
  touch(dir, 'ticket-0000000001-999999-dead');
  const slot = await acquireSlot('s3', { limit: 1, runId: 'live', queueTimeoutMs: 500, pollMs: 20 });
  assert.ok(slot, 'a dead holder must not wedge the queue');
  assert.ok(!fs.existsSync(path.join(dir, 'ticket-0000000001-999999-dead')), 'the dead ticket must be GCed');
  assert.equal(scopeOccupancy('s3').held, 1);
  slot.release();
  assert.equal(scopeOccupancy('s3').held, 0);
});

test('a live earlier ticket keeps the slot; a later arrival waits and cleans up', async () => {
  const dir = lockDir('s4');
  // A live foreign holder (our own pid is guaranteed alive). However long it
  // stalls, it is never displaced — there is no staleness eviction at all.
  const holder = `ticket-0000000001-${process.pid}-stalled`;
  touch(dir, holder);
  const thief = await acquireSlot('s4', { limit: 1, runId: 'thief', queueTimeoutMs: 150, pollMs: 20 });
  assert.equal(thief, null, 'a live holder must never be displaced');
  assert.ok(fs.existsSync(path.join(dir, holder)), 'the holder ticket must be untouched');
  const residue = fs.readdirSync(dir).filter((f) => f.includes('thief'));
  assert.deepEqual(residue, [], 'a timed-out waiter must remove its own ticket');
});

test('a live chooser blocks admission until it finishes (doorway wait)', async () => {
  const dir = lockDir('s5');
  const chooser = `choosing-${process.pid}-other`;
  touch(dir, chooser); // a live peer stuck mid-doorway: order is undecidable
  const slot = await acquireSlot('s5', { limit: 1, runId: 'me', queueTimeoutMs: 150, pollMs: 20 });
  assert.equal(slot, null, 'no admission while a live peer is choosing');
  fs.rmSync(path.join(dir, chooser));
  const slot2 = await acquireSlot('s5', { limit: 1, runId: 'me2', queueTimeoutMs: 500, pollMs: 20 });
  assert.ok(slot2, 'once the chooser is gone the queue moves');
  slot2.release();
});

test('a dead chooser is ignored and garbage-collected', async () => {
  const dir = lockDir('s6');
  touch(dir, 'choosing-999999-crashed');
  const slot = await acquireSlot('s6', { limit: 1, runId: 'x', queueTimeoutMs: 500, pollMs: 20 });
  assert.ok(slot, 'a crashed chooser must not wedge the doorway');
  assert.ok(!fs.existsSync(path.join(dir, 'choosing-999999-crashed')));
  slot.release();
});

test('release leaves an empty scope dir (no residue of any kind)', async () => {
  const dir = lockDir('s8');
  const a = await acquireSlot('s8', { limit: 1, runId: 'a', queueTimeoutMs: 500, pollMs: 20 });
  assert.ok(a);
  assert.equal(scopeOccupancy('s8').held, 1);
  a.release();
  assert.deepEqual(fs.readdirSync(dir), [], 'release must remove the ticket and the held marker');
});

test('two concurrent acquirers past one dead ticket admit exactly one', async () => {
  const dir = lockDir('s10');
  touch(dir, 'ticket-0000000001-999999-dead');
  const [a, b] = await Promise.all([
    acquireSlot('s10', { limit: 1, runId: 'a', queueTimeoutMs: 200, pollMs: 20 }),
    acquireSlot('s10', { limit: 1, runId: 'b', queueTimeoutMs: 200, pollMs: 20 }),
  ]);
  const winners = [a, b].filter(Boolean);
  assert.equal(winners.length, 1, `exactly one of two racers must win (got ${winners.length})`);
  assert.equal(scopeOccupancy('s10').held, 1, 'occupancy must never exceed the limit');
  winners[0].release();
  assert.deepEqual(fs.readdirSync(dir), [], 'loser and winner must both leave no residue');
});

test('occupancy reports holders, not waiters', async () => {
  const a = await acquireSlot('s11', { limit: 1, runId: 'a', queueTimeoutMs: 2000, pollMs: 20 });
  assert.ok(a);
  const bP = acquireSlot('s11', { limit: 1, runId: 'b', queueTimeoutMs: 2000, pollMs: 20 });
  await new Promise((r) => setTimeout(r, 80)); // b is now queued with a ticket on disk
  const occ = scopeOccupancy('s11');
  assert.equal(occ.held, 1, 'a queued waiter must not count as a holder');
  assert.equal(occ.holders[0].runId, 'a');
  assert.ok(occ.holders[0].pid === process.pid, 'holder identity comes from the marker name');
  a.release();
  const b = await bP;
  assert.ok(b, 'the waiter takes over after release');
  assert.equal(scopeOccupancy('s11').held, 1);
  b.release();
  assert.equal(scopeOccupancy('s11').held, 0);
});
