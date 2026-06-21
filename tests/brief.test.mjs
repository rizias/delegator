// Brief validation (regression for the footgun every model kept hitting): a brief is
// accepted unless it is empty. The `## Goal` / `## Definition of done` structure is
// recommended, never required — demanding those exact headers rejected legitimate briefs
// (known since 2026-06-14). Relaxed 2026-06-18.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-test-'));
const { briefIsValid } = await import('../dist/runner.js');

test('a freeform brief (no ## Goal / ## Definition of done) is ACCEPTED', () => {
  assert.equal(briefIsValid('Review the architecture and write REVIEW.md'), true);
  assert.equal(briefIsValid('# Task\nfix the flaky test in foo.spec.ts'), true);
  // the parenthetical that used to break the strict `## Definition of done` match
  assert.equal(briefIsValid('## Definition of done (your output)\nthe thing works'), true);
});

test('a structured brief is still accepted', () => {
  assert.equal(briefIsValid('## Goal\ndo X\n## Definition of done\nX works'), true);
});

test('only an empty / whitespace brief is rejected', () => {
  assert.equal(briefIsValid(''), false);
  assert.equal(briefIsValid('   \n\t '), false);
});
