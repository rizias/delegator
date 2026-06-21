// `dlg compare-runs`. Given several finished
// runs of (usually) the same brief, lay them side by side from their envelopes — status,
// verification, diff size, cost, and whether any two produced a byte-identical patch.
// Pure: takes envelopes, returns a view. No spawning, no judging — the human picks.
import type { Envelope } from './types.js';

export interface RunCompareRow {
  runId: string;
  status: string;
  workerId: string;
  model?: string;
  runtime: string;
  build: string;          // passed | failed | skipped
  test: string;
  lint: string;
  filesTouched: number;
  diffStat: string;
  wallClockMs?: number;
  tokensTotal?: number;
  tokensReasoning?: number;
  applied: boolean;
  patchSha256?: string;
  errorCount: number;
}

export interface ComparisonView {
  rows: RunCompareRow[];
  completedRunIds: string[];          // status === 'completed' (clean, apply-ready)
  identicalPatchGroups: string[][];   // groups (size > 1) whose patch bytes are identical
  fastestRunId?: string;
  fewestTokensRunId?: string;
}

export function buildComparison(envelopes: Envelope[]): ComparisonView {
  const rows: RunCompareRow[] = envelopes.map((e) => ({
    runId: e.runId,
    status: e.status,
    workerId: e.workerId,
    ...(e.model ? { model: e.model } : {}),
    runtime: e.runtime,
    build: e.verification?.build?.status ?? 'skipped',
    test: e.verification?.test?.status ?? 'skipped',
    lint: e.verification?.lint?.status ?? 'skipped',
    filesTouched: e.changes.filesTouched.length,
    diffStat: e.changes.diffStat,
    ...(e.usage?.wallClockMs !== undefined ? { wallClockMs: e.usage.wallClockMs } : {}),
    ...(e.usage?.tokens?.total !== undefined ? { tokensTotal: e.usage.tokens.total } : {}),
    ...(e.usage?.tokens?.reasoning !== undefined ? { tokensReasoning: e.usage.tokens.reasoning } : {}),
    applied: e.changes.applied,
    ...(e.changes.patchSha256 ? { patchSha256: e.changes.patchSha256 } : {}),
    errorCount: e.errors.length,
  }));

  const completedRunIds = rows.filter((r) => r.status === 'completed').map((r) => r.runId);

  // Group runs by identical patch bytes (the SHA-256 the receipt records). A group of
  // size > 1 means independent workers converged on the exact same patch — a strong
  // signal in a tournament. Runs with no patch (no hash) never group.
  const byHash = new Map<string, string[]>();
  for (const r of rows) {
    if (!r.patchSha256) continue;
    const g = byHash.get(r.patchSha256) ?? [];
    g.push(r.runId);
    byHash.set(r.patchSha256, g);
  }
  const identicalPatchGroups = [...byHash.values()].filter((g) => g.length > 1);

  const withTime = rows.filter((r) => r.wallClockMs !== undefined);
  const fastestRunId = withTime.length
    ? withTime.reduce((a, b) => (a.wallClockMs! <= b.wallClockMs! ? a : b)).runId
    : undefined;
  const withTokens = rows.filter((r) => r.tokensTotal !== undefined);
  const fewestTokensRunId = withTokens.length
    ? withTokens.reduce((a, b) => (a.tokensTotal! <= b.tokensTotal! ? a : b)).runId
    : undefined;

  return {
    rows,
    completedRunIds,
    identicalPatchGroups,
    ...(fastestRunId ? { fastestRunId } : {}),
    ...(fewestTokensRunId ? { fewestTokensRunId } : {}),
  };
}
