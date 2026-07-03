// Regression: the workspace-patch pipeline (git diff --no-index, used for NON-git workers like
// opencode) must NOT rewrite `\` -> `/` in file bodies. A prior global normalizeDiffPath(patch)
// mangled every backslash in delivered code — regexes, escape sequences, Windows paths — while
// the run still reported `completed`. Paths in headers stay normalized to `/`; bodies are
// byte-for-byte. See extractWorkspacePatch / rewriteWorkspacePatchPaths in src/worktree.ts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-bs-home-'));
process.env.DELEGATOR_HOME = home;
const { extractWorkspacePatch } = await import('../dist/worktree.js');

// pristine/ and workspace/ must be siblings: extractWorkspacePatch runs
// `git diff --no-index -- <basename(pristine)> <basename(workspace)>` from their shared parent.
function snapshots(prefix) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `dlg-bs-${prefix}-`));
  const pristine = path.join(base, 'pristine');
  const workspace = path.join(base, 'workspace');
  fs.mkdirSync(pristine);
  fs.mkdirSync(workspace);
  return { pristine, workspace };
}

test('backslashes in file bodies survive byte-for-byte; headers stay normalized', () => {
  const { pristine, workspace } = snapshots('body');
  fs.writeFileSync(path.join(pristine, 'lint.py'), 'x = 1\n');
  // Real backslashes via String.raw so the file on disk holds literal `\`.
  const body =
    'import re\n' +
    String.raw`LINK_RE = re.compile(r'\d+')` + '\n' +
    'text = "a\\b"\n' +                       // on disk:  text = "a\b"
    'p = raw.replace("\\\\", "/")\n';         // on disk:  p = raw.replace("\\", "/")
  fs.writeFileSync(path.join(workspace, 'lint.py'), body);

  const { patch } = extractWorkspacePatch(pristine, workspace);

  assert.ok(patch.includes(String.raw`re.compile(r'\d+')`), 'regex backslash was mangled');
  assert.ok(patch.includes('text = "a\\b"'), 'string escape backslash was mangled');
  assert.ok(patch.includes('raw.replace("\\\\", "/")'), 'Windows-path replace was mangled');
  assert.ok(/^diff --git a\/lint\.py b\/lint\.py$/m.test(patch), 'header path not normalized to /');
});

test('a removed body line that looks like a `---` header is left untouched', () => {
  const { pristine, workspace } = snapshots('hdr');
  // Removing this line prints it as `--- keep C:\Users\x` in the diff — it MUST NOT be treated
  // as a file header (which would strip/normalize the Windows path).
  fs.writeFileSync(path.join(pristine, 'note.txt'), '-- keep C:\\Users\\x\n');
  fs.writeFileSync(path.join(workspace, 'note.txt'), 'changed\n');

  const { patch } = extractWorkspacePatch(pristine, workspace);

  assert.ok(patch.includes('-- keep C:\\Users\\x'), 'a body line resembling a header was rewritten');
});

test('the `\\ No newline at end of file` marker is preserved (not mangled to `/ No newline`)', () => {
  const { pristine, workspace } = snapshots('nonl');
  fs.writeFileSync(path.join(pristine, 'tail.txt'), 'old\n');
  fs.writeFileSync(path.join(workspace, 'tail.txt'), 'new'); // no trailing newline

  const { patch } = extractWorkspacePatch(pristine, workspace);

  assert.ok(patch.includes('\\ No newline at end of file'),
    'the diff-format no-newline marker was corrupted');
});
