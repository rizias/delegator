// Orphan reaper: a run whose owning delegator process died before it finalized must be closed on
// the next listing instead of lingering non-terminal forever (the process-death zombie path the
// executeRun try/catch cannot catch). Owner liveness is the oracle: dead owner + non-terminal = reap.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-reaper-home-'));

const { createRun, listRuns, readMeta, readEnvelope, writeEnvelope, updateMeta } = await import('../dist/runstore.js');

const DEAD_PID = 2147483646; // far above any real pid on Windows/macOS/Linux — never a live process

let seq = 0;
function mkMeta(overrides = {}) {
  seq += 1;
  return {
    id: `dlg_reap${String(seq).padStart(4, '0')}`,
    createdAt: new Date(0).toISOString(),
    state: 'preparing',
    request: { workerId: 'w', cwd: process.cwd(), policy: 'review', budget: { wallClockMs: 1 } },
    workerId: 'w', providerId: 'p', runtime: 'claude', worktree: '', baseCommit: '',
    ...overrides,
  };
}

test('listRuns reaps a non-terminal run whose owner process is dead (orphan -> terminal failed)', () => {
  const m = createRun(mkMeta({ ownerPid: DEAD_PID }), 'brief');
  assert.equal(readMeta(m.id).state, 'preparing', 'precondition: created as a live/preparing run');

  const listed = listRuns().find((r) => r.id === m.id);
  assert.equal(listed.state, 'done', 'the orphan is flipped to a terminal state in the returned list');
  assert.equal(readMeta(m.id).state, 'done', 'and the flip is persisted');

  const env = readEnvelope(m.id);
  assert.ok(env, 'a terminal envelope is written so `dlg result` is not empty for a reaped run');
  assert.equal(env.status, 'failed');
  assert.match(env.stopReason, /orphaned/);
});

test('listRuns does NOT reap a non-terminal run whose owner is still alive', () => {
  const m = createRun(mkMeta({ ownerPid: process.pid }), 'brief'); // this test process IS alive
  const listed = listRuns().find((r) => r.id === m.id);
  assert.equal(listed.state, 'preparing', 'a live-owner run is genuinely in progress — leave it');
  assert.equal(readEnvelope(m.id), null, 'no premature terminal envelope for a live run');
});

test('listRuns leaves a legacy run with no ownerPid stamp untouched (liveness cannot be judged)', () => {
  const id = 'dlg_legacy01';
  const dir = path.join(process.env.DELEGATOR_HOME, 'projects', 'default', id);
  fs.mkdirSync(dir, { recursive: true });
  const meta = mkMeta({ id }); // mkMeta sets no ownerPid unless overridden
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');

  const listed = listRuns().find((r) => r.id === id);
  assert.equal(listed.state, 'preparing', 'without an ownerPid the reaper must not guess — leave it');
  assert.equal(readEnvelope(id), null);
});

test('createRun stamps ownerPid = process.pid by default (the production orphan-detection anchor)', () => {
  // Guards against silently breaking the production stamp: without this, crashed runs become
  // unreapable while the explicit-ownerPid tests above would still pass.
  const m = createRun(mkMeta(), 'brief'); // mkMeta sets NO ownerPid
  assert.equal(m.ownerPid, process.pid, 'the returned meta carries the owner stamp');
  assert.equal(readMeta(m.id).ownerPid, process.pid, 'and it is persisted to disk');
});

test('reaper does NOT overwrite a real result: dead owner + real envelope present -> meta closed, envelope kept', () => {
  // The gpt-5.6-sol review flagged that an unconditional updateMeta/writeEnvelope could clobber a run
  // that finalized for real in the gap. A dead-owner run that already has a real envelope must have its
  // meta closed WITHOUT replacing the real result with the synthetic `failed` one.
  const m = createRun(mkMeta({ ownerPid: DEAD_PID }), 'brief'); // meta still 'preparing'
  const realEnv = {
    envelopeVersion: 1, runId: m.id, status: 'completed', workerId: 'w', runtime: 'claude',
    summary: 'REAL RESULT', changes: { diffStat: '', filesTouched: [], applied: false },
    verification: { build: { status: 'skipped' }, test: { status: 'skipped' }, lint: { status: 'skipped' } },
    usage: { wallClockMs: 5 }, stopReason: 'done', errors: [], logsPath: '',
  };
  writeEnvelope(m.id, realEnv); // envelope written, but meta was never flipped to done

  const listed = listRuns().find((r) => r.id === m.id);
  assert.equal(listed.state, 'done', 'the orphan meta is closed so it stops showing as live');
  const env = readEnvelope(m.id);
  assert.equal(env.status, 'completed', 'the REAL envelope is preserved, not replaced with failed');
  assert.equal(env.summary, 'REAL RESULT');
});

test('reaping is idempotent — a second listing does not rewrite the reaped run', () => {
  const m = createRun(mkMeta({ ownerPid: DEAD_PID }), 'brief');
  listRuns(); // first pass reaps
  const envAfterFirst = JSON.stringify(readEnvelope(m.id));
  listRuns(); // second pass must be a no-op for this already-done run
  assert.equal(JSON.stringify(readEnvelope(m.id)), envAfterFirst, 'the terminal envelope is stable across listings');
  assert.equal(readMeta(m.id).state, 'done');
});
