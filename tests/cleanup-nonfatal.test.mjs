// A workspace-cleanup failure must NOT sink an already-finished run. On Windows fs.rmSync can
// throw EBUSY when an AV/indexer/just-exited worker still holds a handle; delegator writes the
// envelope BEFORE reclaiming and treats a reclaim failure as a non-fatal warning. These tests
// exercise reclaimAttemptWorkspace directly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reclaimAttemptWorkspace } from '../dist/runner.js';

const NUL = String.fromCharCode(0);

test('reclaimAttemptWorkspace: a cleanup failure is non-fatal and reported (no throw)', () => {
  // Force the underlying rmSync to throw. A NUL byte in the path is rejected deterministically on
  // every platform — it stands in for the real trigger (a Windows EBUSY from an AV/indexer/just-
  // exited worker holding a handle), which cannot be reproduced in-process. The guarantee under
  // test is that ANY reclaim failure is caught and reported, never propagated to sink the run.
  const outcome = { noGit: true, worktree: 'bad' + NUL + '/workspace', pristine: 'bad' + NUL + '/pristine' };
  let warning;
  assert.doesNotThrow(() => { warning = reclaimAttemptWorkspace(outcome, 'x'); });
  assert.ok(warning && /cleanup failed/i.test(warning), 'returns a cleanup warning string');
});

test('reclaimAttemptWorkspace: success removes the workspace and returns null', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-cleanup-ok-'));
  const workspace = path.join(base, 'workspace');
  const pristine = path.join(base, 'pristine');
  fs.mkdirSync(workspace);
  fs.mkdirSync(pristine);
  const outcome = { noGit: true, worktree: workspace, pristine };
  const warning = reclaimAttemptWorkspace(outcome, base);
  assert.equal(warning, null, 'no warning on success');
  assert.ok(!fs.existsSync(workspace) && !fs.existsSync(pristine), 'temp dirs removed');
  fs.rmSync(base, { recursive: true, force: true });
});
