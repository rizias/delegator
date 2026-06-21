// `dlg compare-runs` view. buildComparison lays
// finished runs side by side from their envelopes and surfaces: which are apply-ready,
// which produced a byte-identical patch (convergence), the fastest, and the cheapest.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildComparison } from '../dist/compare.js';

function env(id, over = {}) {
  return {
    envelopeVersion: 1, runId: id, status: 'completed', workerId: 'w', runtime: 'codex',
    summary: '', stopReason: '', errors: [], logsPath: '',
    verification: { build: { status: 'passed' }, test: { status: 'passed' }, lint: { status: 'skipped' } },
    changes: { diffStat: '1 file', filesTouched: ['a.ts'], applied: false },
    usage: { wallClockMs: 1000 },
    ...over,
  };
}

test('completed runs and identical-patch convergence are surfaced', () => {
  const a = env('dlg_a', { changes: { diffStat: 'x', filesTouched: ['a'], applied: false, patchSha256: 'HASH1' }, usage: { wallClockMs: 5000, tokens: { total: 1200 } } });
  const b = env('dlg_b', { changes: { diffStat: 'x', filesTouched: ['a'], applied: false, patchSha256: 'HASH1' }, usage: { wallClockMs: 3000, tokens: { total: 900 } } }); // same hash as a
  const c = env('dlg_c', { status: 'partial', verification: { build: { status: 'passed' }, test: { status: 'failed' }, lint: { status: 'skipped' } }, changes: { diffStat: 'y', filesTouched: ['a', 'b'], applied: false, patchSha256: 'HASH2' }, usage: { wallClockMs: 9000, tokens: { total: 2100 } } });

  const v = buildComparison([a, b, c]);
  assert.deepEqual(v.completedRunIds, ['dlg_a', 'dlg_b']);        // c is partial
  assert.deepEqual(v.identicalPatchGroups, [['dlg_a', 'dlg_b']]); // a and b converged byte-for-byte
  assert.equal(v.fastestRunId, 'dlg_b');                          // 3000ms
  assert.equal(v.fewestTokensRunId, 'dlg_b');                     // 900 tokens
  const rowC = v.rows.find((r) => r.runId === 'dlg_c');
  assert.equal(rowC.test, 'failed');
  assert.equal(rowC.filesTouched, 2);
});

test('runs with no patch hash never group as identical', () => {
  const v = buildComparison([env('dlg_a'), env('dlg_b')]); // neither has patchSha256
  assert.deepEqual(v.identicalPatchGroups, []);
});
