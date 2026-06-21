// Windows: a PowerShell-only shim (codex.ps1) cannot be spawned directly (spawn EPERM).
// resolveBinary must prefer a runnable sibling (Codex on Windows).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const { preferExecutableSibling } = await import('../dist/proc.js');

test('a .ps1 shim resolves to its runnable .cmd sibling when present', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-shim-'));
  const ps1 = path.join(dir, 'codex.ps1');
  const cmd = path.join(dir, 'codex.cmd');
  fs.writeFileSync(ps1, '# powershell shim');
  fs.writeFileSync(cmd, '@echo off');
  assert.equal(preferExecutableSibling(ps1), cmd, 'should hand back the .cmd, not the unspawnable .ps1');
});

test('a lone .ps1 shim with no runnable sibling is returned unchanged (PowerShell fallback handles it)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-shim-'));
  const ps1 = path.join(dir, 'tool.ps1');
  fs.writeFileSync(ps1, '# powershell shim');
  assert.equal(preferExecutableSibling(ps1), ps1);
});

test('non-.ps1 paths and null pass through untouched', () => {
  assert.equal(preferExecutableSibling('C:\\bin\\git.exe'), 'C:\\bin\\git.exe');
  assert.equal(preferExecutableSibling('/usr/bin/codex'), '/usr/bin/codex');
  assert.equal(preferExecutableSibling(null), null);
});
