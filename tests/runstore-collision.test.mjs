import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

process.env.DELEGATOR_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dlg-runstore-home-'));

const { createRun } = await import('../dist/runstore.js');

test('createRun retries when the first short run id already exists', () => {
  const first = 'dlg_00000000';
  const second = 'dlg_11111111';
  fs.mkdirSync(path.join(process.env.DELEGATOR_HOME, 'projects', 'default', first), { recursive: true });

  const meta = {
    id: first,
    createdAt: new Date(0).toISOString(),
    state: 'preparing',
    request: {
      workerId: 'w',
      cwd: process.cwd(),
      policy: 'review',
      budget: { wallClockMs: 1 },
    },
    workerId: 'w',
    providerId: 'p',
    runtime: 'claude',
    worktree: '',
    baseCommit: '',
  };

  const created = createRun(meta, 'brief', () => second);

  assert.equal(created.id, second);
  assert.equal(fs.existsSync(path.join(process.env.DELEGATOR_HOME, 'projects', 'default', second, 'meta.json')), true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(process.env.DELEGATOR_HOME, 'projects', 'default', second, 'meta.json'), 'utf8')).id, second);
});
