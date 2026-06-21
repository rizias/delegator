// Verification reports what actually ran. A check that did not run is 'skipped'
// WITH a reason — never a bare skip, and never a false 'passed'.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { runVerification, skippedBecause } from '../dist/verify.js';

function tmpWt() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-verify-'));
}

test('skippedBecause carries the reason in outputTail (never a bare skip)', () => {
  const r = skippedBecause('no patch produced');
  assert.equal(r.status, 'skipped');
  assert.equal(r.outputTail, 'no patch produced');
});

test('no verify config → every slot skipped WITH a reason, never passed', () => {
  const v = runVerification(undefined, tmpWt());
  for (const slot of ['build', 'test', 'lint']) {
    assert.equal(v[slot].status, 'skipped', `${slot} must be skipped, not passed`);
    assert.ok(v[slot].outputTail && v[slot].outputTail.length > 0, `${slot} skip must state why`);
    assert.match(v[slot].outputTail, /configured/i, `${slot} reason names the missing config`);
  }
});

test("a command that actually runs and exits 0 is 'passed' (and only then)", () => {
  const v = runVerification({ build: 'exit 0' }, tmpWt());
  assert.equal(v.build.status, 'passed');
  assert.equal(v.build.exitCode, 0);
  // unconfigured slots stay skipped-with-reason, not passed
  assert.equal(v.test.status, 'skipped');
  assert.equal(v.lint.status, 'skipped');
});

test("a command that runs and exits non-zero is 'failed', not skipped or passed", () => {
  const v = runVerification({ test: 'exit 3' }, tmpWt());
  assert.equal(v.test.status, 'failed');
  assert.notEqual(v.test.exitCode, 0);
});
