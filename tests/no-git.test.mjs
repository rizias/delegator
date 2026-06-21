import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-home-'));
const { createWorkspace, extractWorkspacePatch } = await import('../dist/worktree.js');
const { pristineDir } = await import('../dist/paths.js');

test('no-git workspace patch captures modified added and deleted files', () => {
  const src = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-nogit-src-'));
  fs.writeFileSync(path.join(src, 'modify.txt'), 'before\n');
  fs.writeFileSync(path.join(src, 'delete.txt'), 'remove me\n');

  const { dir: workspace, baseCommit } = createWorkspace(src, 'dlg_test1234');
  const pristine = pristineDir(src, 'dlg_test1234');

  assert.equal(baseCommit, 'no-git');
  fs.writeFileSync(path.join(workspace, 'modify.txt'), 'after\n');
  fs.writeFileSync(path.join(workspace, 'add.txt'), 'new\n');
  fs.rmSync(path.join(workspace, 'delete.txt'));

  const result = extractWorkspacePatch(pristine, workspace);

  assert.match(result.patch, /a\/modify\.txt/);
  assert.match(result.patch, /b\/modify\.txt/);
  assert.match(result.patch, /a\/add\.txt/);
  assert.match(result.patch, /b\/add\.txt/);
  assert.match(result.patch, /a\/delete\.txt/);
  assert.match(result.patch, /b\/delete\.txt/);
  assert.doesNotMatch(result.patch, /[ab]\/(?:pristine|workspace)\//);
  assert.deepEqual(
    [...result.filesTouched].sort(),
    ['add.txt', 'delete.txt', 'modify.txt'],
  );
  assert.notEqual(result.diffStat, '');
});
