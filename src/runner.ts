// Run lifecycle state machine (ARCHITECTURE 3.3). Deliberately brainless:
// resolve -> isolate -> spawn -> bound -> collect -> verify -> envelope.
//
// A run may try MORE than one worker: when a tier declares `fallback: auto` and
// the chosen worker fails with a provider-class error (rate-limit/auth/server,
// NOT a task/code error), the run falls over to the next worker in the chain.
// Every worker tried is recorded in the envelope — silent substitution is
// forbidden (ARCHITECTURE §5). The loop stays brainless: which classes fall over
// is fixed, the chain order is config, no model decides anything.

import type {
  BudgetSpec, DelegatorConfig, Envelope, ErrorEntry, Policy, RunMeta,
  RuntimeContext, TokenUsage, VerificationResult, WorkerEvent,
  WorkerRuntimeAdapter, ResolvedWorker, TierConfig, AttemptRecord, TerminalStatus, ReasoningEffort,
  AnyRuntime, InProcessRuntime,
} from './types.js';
import { createHash } from 'node:crypto';
import { pristineDir, tailOf } from './paths.js';
import { resolveRunPlan, resolveCandidate } from './registry.js';
import { initProject } from './scaffold.js';
import {
  applyPatch, applyWorkspacePatch, reverseApplyPatch, reverseApplyWorkspacePatch,
  assertGitRepo, countDiffLines, createWorkspace, createWorktree, currentCommit, diffHash,
  extractPatch, extractWorkspacePatch, removeWorkspace, removeWorktree, workspaceDiffHash,
} from './worktree.js';
import { spawnStreaming, killTree, type SpawnedProc } from './proc.js';
import { acquireSlot, type SlotHandle } from './semaphore.js';
import { Checkpointer } from './control.js';
import { classifyFailure, retryPlan, type FailureVerdict } from './classify.js';
import { recordWorkerOutcome } from './breaker.js';
import { parkKey } from './keycooldown.js';
import { ConfigError, loadSecretPools, normalizeRuntimeId } from './config.js';
import { buildRuntimeRegistry } from './runtimes/index.js';
import { runVerification, skippedBecause } from './verify.js';
import * as store from './runstore.js';

/** Discriminator: an in-process runtime (api-oneshot: HTTP call) carries `execute`. */
function isInProcess(r: AnyRuntime): r is InProcessRuntime {
  return typeof (r as InProcessRuntime).execute === 'function';
}

export interface ExecuteRequest {
  workerId?: string;
  tier?: string;
  brief: string;
  cwd: string;
  policy: Policy;
  budgetOverride?: Partial<BudgetSpec>;
  effortOverride?: ReasoningEffort;  // per-run reasoning effort, overrides the worker's default
  toolsOverride?: string[];
  skipPrune?: boolean;
}

/** Every verification slot skipped for the SAME stated reason — never a bare "skipped",
 *  which reads as a bug ("did it pass? did it run?"). Honest states only. */
const skippedAll = (reason: string): VerificationResult => ({
  build: skippedBecause(reason),
  test: skippedBecause(reason),
  lint: skippedBecause(reason),
});
// Pre-run exits (rejected brief, no available worker, preflight skip): no worker ran, so
// there is nothing in the worktree to verify. Say that, rather than an unexplained skip.
const SKIPPED: VerificationResult = skippedAll('run ended before a worker produced a patch — nothing to verify');

// Accept any real task description. A `## Goal` / `## Definition of done` structure is
// RECOMMENDED (clearer for the worker) but NOT required: demanding those exact headers
// rejected legitimate briefs and EVERY model kept tripping on it — e.g.
// `## Definition of done (your output)` failed the strict match. The only hard rule is "not empty".
export function briefIsValid(brief: string): boolean {
  return brief.trim().length > 0;
}

function globToRegex(glob: string): RegExp {
  const esc = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    // `**/` is an *optional* directory prefix: it must match zero or more leading
    // dirs INCLUDING none, so `**/package.json` matches a root `package.json` too
    // (not only `sub/package.json`). Handle it before the bare `**` rule.
    .replace(/\*\*\//g, '<<DSTARSLASH>>')
    .replace(/\*\*/g, '<<DSTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<DSTARSLASH>>/g, '(?:.*/)?')
    .replace(/<<DSTAR>>/g, '.*');
  return new RegExp('^' + esc + '$', 'i');
}

export function touchesSensitive(files: string[], patterns: string[]): string | null {
  const regs = patterns.map(globToRegex);
  for (const f of files) {
    const norm = f.replace(/\\/g, '/');
    if (regs.some((r) => r.test(norm))) return f;
  }
  return null;
}

// The "judge" of a run is whatever decides pass/fail: the test sources, the test/CI
// runner config, and the golden/snapshot/fixture oracles. Verification runs INSIDE the
// worker's own worktree (verify.ts), against the files it just wrote — so a worker that
// edits its own judge (rewrites a test to pass, weakens an assertion, swaps a snapshot,
// neuters a CI step) can turn a broken patch green. A patch touching any of these cannot
// be trusted as a clean pass → it is forced to `requires-review` (verification-model.md
// §3). Package manifests + lockfiles ARE judged too: a worker that rewrites a build/test
// script (e.g. `package.json` → `"test": "exit 0"`) or swaps a dependency is redefining what
// "passing" means just as much as editing a test. The sensitive-path apply guard is NOT an
// equivalent backstop — `privacy.sensitivePaths` can be empty in config, so the frozen judge
// must not depend on it. Touching one only FLAGS requires-review (below) — it does not reset
// the file, so a legitimate dependency/script change still verifies; it just isn't auto-trusted.
export const DEFAULT_JUDGE_GLOBS = [
  // test sources
  '**/*.test.*', '**/*.spec.*', '**/*_test.*', '**/test_*.*',
  '**/test/**', '**/tests/**', '**/__tests__/**', '**/spec/**',
  // config that defines what "passing" means
  '**/jest.config.*', '**/vitest.config.*', '**/playwright.config.*',
  '**/cypress.config.*', '**/.mocharc.*', '**/karma.conf.*',
  '**/pytest.ini', '**/tox.ini', '**/conftest.py',
  // CI definitions
  '**/.github/workflows/**', '**/.gitlab-ci.yml', '**/Jenkinsfile', '**/azure-pipelines.yml',
  // golden / snapshot / fixture oracles
  '**/__snapshots__/**', '**/*.snap', '**/fixtures/**', '**/testdata/**',
  // package manifests + lockfiles — they carry the build/test scripts and the dependency oracle
  '**/package.json', '**/package-lock.json', '**/npm-shrinkwrap.json', '**/yarn.lock', '**/pnpm-lock.yaml',
  '**/pyproject.toml', '**/requirements*.txt', '**/Pipfile', '**/Pipfile.lock', '**/poetry.lock',
  '**/Cargo.toml', '**/Cargo.lock', '**/go.mod', '**/go.sum',
  '**/Gemfile', '**/Gemfile.lock', '**/pom.xml', '**/build.gradle*', '**/composer.json', '**/composer.lock',
  '**/Makefile',
];

function mergeBudget(
  cfg: DelegatorConfig,
  tier: TierConfig | undefined,
  worker: { budget?: Partial<BudgetSpec> },
  override?: Partial<BudgetSpec>,
): BudgetSpec {
  return { ...cfg.defaults.budget, ...tier?.budget, ...worker.budget, ...override };
}

function firstErrType(errors: ErrorEntry[]): ErrorEntry['type'] | undefined {
  return errors[0]?.type;
}

/** Attach the attempt chain to the envelope only when it carries information:
 *  a plain single-worker run gets no `attempts` noise. */
function attemptsForEnvelope(attempts: AttemptRecord[]): AttemptRecord[] | undefined {
  if (attempts.length === 0) return undefined;
  if (attempts.length === 1 && attempts[0]!.outcome === 'ran') return undefined;
  return attempts;
}

interface KillInfo {
  reason: 'timeout' | 'no-progress';
  diagnosis: string;
}

/** All of the worker's output (both streams), tail-bounded, for failure classification.
 *  Provider errors land on stdout (claude's stream-json result) OR stderr (codex),
 *  and codex tags some stderr as `noise` — so we scan every line, not just non-noise. */
function failureText(events: WorkerEvent[]): string {
  const joined = events.map((e) => e.raw).join('\n');
  return tailOf(joined, 12000);
}

/** Runtime-parsed fatal/error events. These are stronger than generic output text:
 *  a normal successful answer may mention "401", but only the runtime can mark a
 *  line as an actual worker/provider error. */
function errorSignalText(events: WorkerEvent[]): string {
  const joined = events.filter((e) => e.kind === 'error').map((e) => e.raw).join('\n');
  return tailOf(joined, 12000);
}

function genericErrorSignal(text: string): FailureVerdict {
  const evidence = text.split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? 'runtime error event';
  return {
    class: 'server',
    errType: 'server',
    transient: true,
    reason: 'worker emitted a structured runtime error event',
    evidence: evidence.length > 300 ? evidence.slice(0, 300) + '…' : evidence,
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Everything a finished attempt produced, before the apply gate / envelope. */
interface AttemptOutcome {
  ran: boolean;                  // did the worker actually spawn (vs queue/worktree reject)
  status: TerminalStatus;
  stopReason: string;
  errors: ErrorEntry[];
  verification: VerificationResult;
  summary: string;
  wallClockMs: number;           // this attempt's own wall clock
  tokens?: TokenUsage;
  iterations?: number;
  diffStat: string;
  filesTouched: string[];
  patch: string;                 // raw patch text ('' if none) — written to store only if this attempt wins
  worktree: string;              // '' if none created
  pristine: string;              // no-git reference tree; '' for git worktrees
  noGit: boolean;
  shouldFallback: boolean;       // a provider-class failure → eligible to fall over to the next worker
}

function useGitIsolation(cwd: string): boolean {
  try {
    assertGitRepo(cwd);
    currentCommit(cwd);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort reclamation of one attempt's workspace/worktree. Reclaim is the LAST step of a
 *  run and must NEVER throw past the caller: on Windows fs.rmSync can hit EBUSY when an AV,
 *  indexer, or just-exited worker still holds a handle on the temp dir — that must not sink an
 *  already-finished run. Returns a warning string on failure (temp dir left on disk) or null. */
export function reclaimAttemptWorkspace(outcome: AttemptOutcome, reqCwd: string, keepWorktree = false): string | null {
  try {
    if (outcome.noGit && outcome.worktree) removeWorkspace(outcome.pristine, outcome.worktree);
    else if (outcome.worktree && !keepWorktree) removeWorktree(reqCwd, outcome.worktree);
    return null;
  } catch (e) {
    return 'workspace cleanup failed — left on disk: ' + String(e instanceof Error ? e.message : e);
  }
}

function cleanupAttempt(reqCwd: string, outcome: AttemptOutcome): void {
  // A discarded (failed/fallover) attempt: reclaim best-effort, never abort the run over it.
  reclaimAttemptWorkspace(outcome, reqCwd);
}

export async function executeRun(
  req: ExecuteRequest,
  cfg: DelegatorConfig,
  runtimes?: Record<string, AnyRuntime>, // injectable for tests
): Promise<Envelope> {
  const runtimeRegistry = runtimes ?? buildRuntimeRegistry(cfg);
  const gitIsolation = useGitIsolation(req.cwd);
  store.setRunsProject(req.cwd);
  if (gitIsolation) initProject(req.cwd); // idempotent: keeps .delegator/ out of git status

  // The ordered candidate chain (one worker, or a tier). Config errors (unknown
  // tier, restricted, unconfigured direct worker) still throw → exit 2.
  const plan = resolveRunPlan(cfg, { workerId: req.workerId, tier: req.tier });

  let id = store.newRunId();
  const startedAt = Date.now();

  const first = plan.candidates[0];
  const firstBudget = first?.worker
    ? mergeBudget(cfg, plan.tierCfg, first.worker, req.budgetOverride)
    : { ...cfg.defaults.budget, ...req.budgetOverride };
  let baseMeta: RunMeta = {
    id,
    createdAt: new Date(startedAt).toISOString(),
    state: 'preparing',
    request: {
      workerId: req.workerId,
      tier: req.tier,
      cwd: req.cwd,
      policy: req.policy,
      budget: firstBudget,
      ...(req.toolsOverride !== undefined ? { tools: req.toolsOverride } : {}),
    },
    workerId: first?.workerId ?? (req.workerId ?? '?'),
    providerId: first?.providerId ?? '',
    model: first?.worker?.model,
    runtime: first?.worker?.runtime ?? 'claude',
    worktree: '',
    baseCommit: '',
  };

  // Brief lint happens before any worktree exists.
  if (!briefIsValid(req.brief)) {
    baseMeta = store.createRun(baseMeta, req.brief);
    id = baseMeta.id;
    const env = finalize(id, 'rejected', baseMeta.workerId, baseMeta.model, baseMeta.runtime, {
      summary: 'brief rejected before spawn',
      stopReason: 'brief is empty — pass a real task description (-f <file> or -m "<text>")',
      errors: [{ type: 'brief-invalid', message: 'brief is empty' }],
      verification: SKIPPED,
      wallClockMs: 0,
    });
    store.updateMeta(id, { state: 'done', endedAt: new Date().toISOString() });
    return env;
  }

  // Record the run now so onWait events have somewhere to go.
  baseMeta = store.createRun(baseMeta, req.brief);
  id = baseMeta.id;

  const attempts: AttemptRecord[] = [];

  for (let i = 0; i < plan.candidates.length; i++) {
    const cand = plan.candidates[i]!;
    if (!cand.available) {
      attempts.push({ workerId: cand.workerId, outcome: 'skipped', ...(cand.skipReason ? { reason: cand.skipReason } : {}) });
      continue;
    }

    const resolved = await resolveCandidate(cand, cfg);
    // Per-run reasoning-effort override (so one worker per model serves any effort,
    // instead of a separate `-high`/`-deep` worker per level).
    if (req.effortOverride) {
      const levels = resolved.worker.reasoningEffortLevels ?? [];
      if (levels.length > 0 && !levels.includes(req.effortOverride)) {
        throw new ConfigError(
          `--effort "${req.effortOverride}" is not a level of ${cand.workerId}; choose one of: ${levels.join(', ')}`,
        );
      }
      resolved.worker = { ...resolved.worker, reasoningEffort: req.effortOverride };
    }
    const runtimeId = normalizeRuntimeId(resolved.worker.runtime);
    const runtime = runtimeRegistry[runtimeId];
    if (!runtime) {
      attempts.push({ workerId: cand.workerId, outcome: 'skipped', reason: `unknown runtime: ${resolved.worker.runtime}` });
      continue;
    }

    // preflight is a spawn-runtime concept (e.g. codex's version gate). In-process
    // runtimes have nothing to check before the call.
    const pre = isInProcess(runtime) ? null : (runtime.preflight?.() ?? null);
    if (pre) {
      attempts.push({ workerId: cand.workerId, outcome: 'skipped', reason: pre.reason });
      store.appendEvent(id, {
        ts: Date.now(), stream: 'system', kind: 'output',
        raw: `skipped ${resolved.workerId}: ${pre.reason}`,
      });
      continue;
    }

    const budget = mergeBudget(cfg, plan.tierCfg, resolved.worker, req.budgetOverride);

    store.updateMeta(id, {
      workerId: resolved.workerId,
      providerId: resolved.providerId,
      model: resolved.worker.model,
      runtime: runtimeId,
    });
    if (attempts.length > 0) {
      const routeLabel = plan.tierName !== undefined ? `tier "${plan.tierName}"` : 'model fallback';
      store.appendEvent(id, {
        ts: Date.now(), stream: 'system', kind: 'output',
        raw: `fallback: ${routeLabel} advancing to ${resolved.workerId} (${attempts.length} prior attempt(s))`,
      });
    }

    const outcome = await runWorkerAttempt(id, resolved, runtime, budget, plan.tierCfg, req, cfg);

    const moreAvailableAhead = plan.candidates.slice(i + 1).some((c) => c.available);
    if (outcome.ran && outcome.shouldFallback && plan.fallback === 'auto' && moreAvailableAhead) {
      attempts.push({
        workerId: resolved.workerId, model: resolved.worker.model, outcome: 'failed-over',
        status: outcome.status, ...(firstErrType(outcome.errors) ? { errType: firstErrType(outcome.errors) } : {}),
        reason: outcome.stopReason,
      });
      store.appendEvent(id, {
        ts: Date.now(), stream: 'system', kind: 'output',
        raw: `worker ${resolved.workerId} failed (${outcome.stopReason}); falling over (${plan.tierName !== undefined ? 'tier.fallback' : 'model fallback'}: auto)`,
      });
      cleanupAttempt(req.cwd, outcome); // discard the failed attempt's worktree/workspace
      continue;
    }

    // Terminal: this attempt is the run's result.
    attempts.push({
      workerId: resolved.workerId, model: resolved.worker.model, outcome: 'ran',
      status: outcome.status, ...(firstErrType(outcome.errors) ? { errType: firstErrType(outcome.errors) } : {}),
    });
    const env = finalizeAttempt(id, resolved, outcome, budget, req, cfg, startedAt, attempts);
    store.updateMeta(id, { state: 'done', endedAt: new Date().toISOString() });
    // Council fan-out defers pruning until after gathering every sibling result.
    if (!req.skipPrune) store.pruneRuns(cfg.defaults.keepRuns); // retention: oldest finished runs beyond the cap
    return env;
  }

  // No candidate ever ran — every worker was skipped or unavailable (breaker open,
  // unconfigured in a tier, privacy-denied). Honest `rejected` with the reasons.
  const detail = attempts.map((a) => `${a.workerId}: ${a.reason ?? a.outcome}`).join('; ');
  const env = finalize(id, 'rejected', baseMeta.workerId, baseMeta.model, baseMeta.runtime, {
    summary: req.tier ? `no available worker in tier "${req.tier}"` : `worker "${baseMeta.workerId}" is not available`,
    stopReason: `all candidates were skipped or unavailable (${detail || 'none'})`,
    errors: [{ type: 'internal', message: 'no available worker', ...(detail ? { detail } : {}) }],
    verification: SKIPPED,
    wallClockMs: Date.now() - startedAt,
    attempts: attemptsForEnvelope(attempts),
  });
  store.updateMeta(id, { state: 'done', endedAt: new Date().toISOString() });
  return env;
}

/**
 * Run an IN-PROCESS runtime (api-oneshot): one HTTP call, no spawned worker, no
 * worktree, no patch. The concurrency slot is already held by the caller. We reuse
 * the same trust fabric as the spawn path — breaker feedback and per-key
 * cooldown — unchanged; the only difference is a generation run has no diff.
 * Returns an AttemptOutcome with empty patch, so finalize assembles an envelope with
 * empty `changes`, `summary` = the model's reply, and `usage.tokens` from the response.
 */
async function runInProcessAttempt(
  id: string,
  resolved: ResolvedWorker,
  runtime: InProcessRuntime,
  budget: BudgetSpec,
  tier: TierConfig | undefined,
  req: ExecuteRequest,
  cfg: DelegatorConfig,
  slot: SlotHandle,
  attemptStart: number,
): Promise<AttemptOutcome> {
  // No worktree: the brief is the whole context (the call is non-agentic, no repo access).
  const ctx: RuntimeContext = {
    brief: req.brief,
    worktree: '',
    resolved,
    tier,
    budget,
    ...(req.toolsOverride !== undefined ? { toolsOverride: req.toolsOverride } : {}),
    ...(cfg.defaults.tools !== undefined ? { defaultsTools: cfg.defaults.tools } : {}),
  };

  store.updateMeta(id, { state: 'running' });
  store.appendEvent(id, {
    ts: Date.now(), stream: 'system', kind: 'output',
    raw: `budgets: wallClock ${Math.round(budget.wallClockMs / 1000)}s (api-oneshot: one HTTP call, no agent loop)`,
  });

  const result = await runtime.execute(ctx, { timeoutMs: budget.wallClockMs })
    .finally(() => slot.release()); // ALWAYS free the slot, even if execute rejects — otherwise the
                                    // provider's concurrency limit stays held and blocks later runs.

  // Record the reply / diagnosis as the run's result event (so `dlg log` shows it).
  store.appendEvent(id, {
    ts: Date.now(), stream: 'stdout', kind: 'result',
    raw: result.summary.length > 4000 ? result.summary.slice(0, 4000) : result.summary,
    ...(result.tokens ? { tokens: result.tokens } : {}),
  });

  // Breaker feedback + key cooldown — the SAME logic the spawn path runs at the end of
  // runWorkerAttempt. A completed call closes the circuit; a provider-class failure
  // counts/blames (and parks the key on rate-limit/auth with a multi-key pool); a
  // non-provider error (timeout, bad JSON, HTTP 400) is ignored — not the provider's health.
  if (result.status === 'completed') {
    recordWorkerOutcome(resolved.workerId, { kind: 'success' }, cfg);
  } else if (result.failure) {
    recordWorkerOutcome(resolved.workerId, {
      kind: 'provider-failure',
      class: result.failure.class,
      ...(result.failure.retryAfterMs !== undefined ? { retryAfterMs: result.failure.retryAfterMs } : {}),
      ...(result.failure.evidence ? { evidence: result.failure.evidence } : {}),
    }, cfg);
    if ((result.failure.class === 'rate-limit' || result.failure.class === 'auth') && resolved.apiKey) {
      const pool = loadSecretPools()[resolved.providerId];
      if (pool && pool.length > 1) {
        const raMs = result.failure.retryAfterMs; // honor a positive Retry-After even if shorter than the default
        const until = Date.now() + (raMs && raMs > 0 ? raMs : cfg.defaults.keyCooldownMs);
        parkKey(resolved.providerId, resolved.apiKey, until, result.failure.class);
      }
    }
  } else {
    recordWorkerOutcome(resolved.workerId, { kind: 'ignore' }, cfg);
  }

  const errors: ErrorEntry[] = [];
  if (result.status === 'failed') {
    errors.push({
      type: result.errType,
      message: result.failure ? result.failure.reason : result.summary,
      ...(result.failure?.evidence ? { detail: result.failure.evidence } : {}),
    });
  }

  return {
    ran: true,
    status: result.status === 'completed' ? 'completed' : 'failed',
    stopReason: result.stopReason,
    errors,
    verification: SKIPPED,
    summary: result.summary,
    wallClockMs: Date.now() - attemptStart,
    ...(result.tokens ? { tokens: result.tokens } : {}),
    iterations: 1,
    diffStat: '',
    filesTouched: [],
    patch: '',
    worktree: '',
    pristine: '',
    noGit: false,
    // Any provider-class failure is eligible to fall over to the next worker (tiers);
    // task/config/reachability errors that aren't provider-class are not.
    shouldFallback: result.failure !== null,
  };
}

/**
 * Run exactly ONE worker in its own slot + worktree, bound it, collect, verify,
 * and feed the breaker / key cooldown. Returns the outcome WITHOUT applying the
 * patch or writing the final envelope — the caller (executeRun) decides whether
 * this attempt wins or the run falls over to the next worker.
 */
async function runWorkerAttempt(
  id: string,
  resolved: ResolvedWorker,
  runtime: AnyRuntime,
  budget: BudgetSpec,
  tier: TierConfig | undefined,
  req: ExecuteRequest,
  cfg: DelegatorConfig,
): Promise<AttemptOutcome> {
  const attemptStart = Date.now();

  const reject = (
    status: TerminalStatus,
    stopReason: string,
    errs: ErrorEntry[],
    worktree: string,
    slot: SlotHandle | null,
    pristine = '',
    noGit = false,
  ): AttemptOutcome => {
    slot?.release();
    return {
      ran: false, status, stopReason, errors: errs, verification: SKIPPED,
      summary: stopReason, wallClockMs: Date.now() - attemptStart,
      diffStat: '', filesTouched: [], patch: '', worktree, pristine, noGit, shouldFallback: false,
    };
  };

  // Concurrency gate: claim a slot BEFORE creating a worktree so a
  // queued run holds no disk while it waits, and a queue timeout leaks nothing.
  // There are TWO nested gates, acquired in a fixed order (provider → model) to
  // avoid deadlock: the provider/group gate bounds total runs against a provider,
  // the model gate bounds concurrent runs OF ONE MODEL (limits.concurrent) on top.
  const scope = resolved.provider.concurrencyGroup ?? resolved.providerId;
  const limit = resolved.provider.maxConcurrent ?? 0; // 0 = unbounded
  // Model-level gate (limits.concurrent on the model/worker). Distinct, collision-safe
  // scope key so it never overlaps the provider scope. 0/absent = unbounded at the
  // model level → no second gate, behaves exactly as before.
  // limits.concurrent is merged onto the worker for bare `provider/model` handles
  // (config.ts withModelDefaults), but the named-worker `workers:` loop does NOT copy it
  // — so fall back to the model's own config so the cap works for both. The worker's own
  // value wins (an explicit override), then the model default.
  const modelId = resolved.worker.model ?? resolved.workerId;
  const modelLimit = resolved.worker.limits?.concurrent
    ?? (resolved.worker.model ? resolved.provider.models?.[resolved.worker.model]?.limits?.concurrent : undefined)
    ?? 0;
  const modelScope = `${resolved.providerId}/${modelId}`;
  if (limit > 0 || modelLimit > 0) store.updateMeta(id, { state: 'queued' });
  const providerSlot = await acquireSlot(scope, {
    limit,
    runId: id,
    queueTimeoutMs: cfg.defaults.queueTimeoutSeconds * 1000,
    pollMs: cfg.defaults.queuePollSeconds * 1000,
    onWait: (ms) => {
      store.appendEvent(id, {
        ts: Date.now(), stream: 'system', kind: 'output',
        raw: `queued: scope "${scope}" at capacity (${limit}); waiting for a free slot (${Math.round(ms / 1000)}s)`,
      });
    },
  });
  if (!providerSlot) {
    // A concurrency queue timeout is NOT a provider failure — it does not fall
    // over (§8: the Brain decides whether to wait or reroute on capacity).
    return reject(
      'rejected',
      `queue timeout: scope "${scope}" stayed full for ${cfg.defaults.queueTimeoutSeconds}s`,
      [{ type: 'internal', message: `concurrency queue timeout (scope ${scope}, limit ${limit})` }],
      '', null,
    );
  }

  // Second gate: the model-scoped cap. Acquired AFTER the provider slot, in the
  // same order on every run (no deadlock). If it times out, release the
  // already-held provider slot first and end the run exactly like a provider
  // queue timeout — same `rejected` status, clear queue-timeout reason, no leak.
  let slot: SlotHandle = providerSlot;
  if (modelLimit > 0) {
    const modelSlot = await acquireSlot(modelScope, {
      limit: modelLimit,
      runId: id,
      queueTimeoutMs: cfg.defaults.queueTimeoutSeconds * 1000,
      pollMs: cfg.defaults.queuePollSeconds * 1000,
      onWait: (ms) => {
        store.appendEvent(id, {
          ts: Date.now(), stream: 'system', kind: 'output',
          raw: `queued: model "${modelScope}" at capacity (${modelLimit}); waiting for a free slot (${Math.round(ms / 1000)}s)`,
        });
      },
    });
    if (!modelSlot) {
      providerSlot.release(); // give back the provider slot we are NOT going to use
      return reject(
        'rejected',
        `queue timeout: model "${modelScope}" stayed full for ${cfg.defaults.queueTimeoutSeconds}s`,
        [{ type: 'internal', message: `concurrency queue timeout (model ${modelScope}, limit ${modelLimit})` }],
        '', null,
      );
    }
    // Compose both handles into one: releasing it frees BOTH slots on every exit
    // path (success / failure / kill / timeout), so the existing single-slot
    // release sites below need no change.
    const prov = providerSlot;
    const mdl = modelSlot;
    slot = {
      slot: prov.slot,
      waitedMs: prov.waitedMs + mdl.waitedMs,
      release: () => { prov.release(); mdl.release(); },
    };
  }

  // In-process runtimes (api-oneshot: one HTTP call) take a separate path. There is no
  // spawned process, so no worktree and no patch — a generation run simply has no diff,
  // and the isolation/verify/judge machinery below does not apply. The trust fabric is
  // reused unchanged: the slot is already held, and the helper feeds the breaker + key
  // cooldown exactly like the spawn path.
  if (isInProcess(runtime)) {
    return runInProcessAttempt(id, resolved, runtime, budget, tier, req, cfg, slot, attemptStart);
  }

  const gitIsolation = useGitIsolation(req.cwd);

  // Slot held → create the isolated worktree/workspace. On isolation failure release the slot.
  let worktree = '';
  let pristine = '';
  let noGit = false;
  try {
    const wt = gitIsolation ? createWorktree(req.cwd, id) : createWorkspace(req.cwd, id);
    worktree = wt.dir;
    noGit = !gitIsolation;
    pristine = noGit ? pristineDir(req.cwd, id) : '';
    store.updateMeta(id, { worktree, baseCommit: wt.baseCommit });
  } catch (e) {
    return reject(
      'rejected',
      String(e instanceof Error ? e.message : e),
      [{ type: 'internal', message: gitIsolation ? 'createWorktree failed' : 'createWorkspace failed', detail: String(e) }],
      '',
      slot,
    );
  }

  const ctx: RuntimeContext = {
    brief: req.brief,
    worktree,
    resolved,
    tier,
    budget,
    ...(req.toolsOverride !== undefined ? { toolsOverride: req.toolsOverride } : {}),
    ...(cfg.defaults.tools !== undefined ? { defaultsTools: cfg.defaults.tools } : {}),
  };
  const spec = runtime.buildSpawn(ctx);

  store.updateMeta(id, { state: 'preparing' });
  // Announce the effective limits up front - "what budget killed me" must never
  // be a mystery.
  store.appendEvent(id, {
    ts: Date.now(), stream: 'system', kind: 'output',
    raw: `budget: wallClock ${Math.round(budget.wallClockMs / 1000)}s (time is the only limit; iterations are counted for stats, not capped)`,
  });

  // One spawn of the worker. Each call gets a fresh event buffer + checkpointer so
  // a retry's assessment reflects only the latest spawn. Returns the spawn result,
  // or an error sentinel (spawn ENOENT / wait failure) for the caller to reject.
  type SpawnOk = { ok: true; exitCode: number | null; events: WorkerEvent[]; stdoutBuf: string; iterations: number; killInfo: KillInfo | null };
  type SpawnErr = { ok: false; msg: string; isEnoent: boolean };
  const runSpawn = async (): Promise<SpawnOk | SpawnErr> => {
    const events: WorkerEvent[] = [];
    let stdoutBuf = '';
    let lastEventTs = Date.now();
    let iterations = 0;
    let killInfo: KillInfo | null = null;
    let proc: SpawnedProc;
    try {
      proc = spawnStreaming(spec, (line, stream) => {
        const ev = runtime.parseLine(line, stream);
        ev.ts = Date.now();
        lastEventTs = ev.ts;
        // Count top-level model turns for the run's statistics (envelope.usage.iterations).
        // The terminal 'result' is not a turn.
        if (ev.kind === 'turn') iterations += 1;
        // Keep the first 2500 AND the last 2500 events (drop the middle once over 5000):
        // the head holds startup signals and the tail
        // holds late provider errors — a 429 arriving after thousands of events — plus
        // the final result. A flat "drop everything after 5000" silently lost late 429s,
        // so they never classified as provider failures (no fallover / retry).
        events.push(ev);
        if (events.length > 5000) events.splice(2500, 1);
        store.appendEvent(id, ev);
        if (stream === 'stdout' && ev.kind !== 'noise') stdoutBuf = tailOf(stdoutBuf + line + '\n', 16000);
      });
    } catch (e) {
      const msg = String(e instanceof Error ? e.message : e);
      return { ok: false, msg, isEnoent: msg.includes('ENOENT') };
    }

    store.updateMeta(id, { state: 'running', pid: proc.pid });

    const checkpointer = new Checkpointer({
      checkpointMs: cfg.defaults.checkpointSeconds * 1000,
      stallMs: cfg.defaults.stallSeconds * 1000,
      silenceKillMs: cfg.defaults.silenceKillSeconds * 1000,
      budget,
      getDiffHash: () => noGit ? workspaceDiffHash(pristine, worktree) : diffHash(worktree),
      getLastEventTs: () => lastEventTs,
      onKill: (reason, diagnosis) => {
        if (killInfo === null) killInfo = { reason, diagnosis };
        void killTree(proc.pid);
      },
    });
    checkpointer.start();
    try {
      const res = await proc.wait();
      checkpointer.stop();
      return { ok: true, exitCode: res.exitCode, events, stdoutBuf, iterations, killInfo };
    } catch (e) {
      checkpointer.stop();
      const msg = String(e instanceof Error ? e.message : e);
      return { ok: false, msg, isEnoent: msg.includes('ENOENT') };
    }
  };

  // Retry loop (ARCHITECTURE §5): re-spawn on a transient provider failure that
  // produced no work yet (honoring Retry-After / exp backoff, bounded by
  // defaults.retries). The worktree stays clean across retries (empty patch is the
  // gate), so re-spawning is safe. A partial patch, auth, crash, or kill never loops.
  const errors: ErrorEntry[] = [];
  let exitCode: number | null = null;
  let events: WorkerEvent[] = [];
  let stdoutBuf = '';
  let iterations = 0;
  let killInfo: KillInfo | null = null;
  let patch = '';
  let diffStat = '';
  let filesTouched: string[] = [];
  let extractFailed = false;
  let providerFailure: FailureVerdict | null = null;
  let exitVerdict: ReturnType<NonNullable<WorkerRuntimeAdapter['classifyExit']>> = null;
  let retries = 0;

  for (;;) {
    const spawned = await runSpawn();
    if (!spawned.ok) {
      return reject(
        'rejected',
        spawned.msg,
        [{ type: spawned.isEnoent ? 'cli-missing' : 'internal', message: spawned.msg }],
        worktree,
        slot,
        pristine,
        noGit,
      );
    }
    ({ exitCode, events, stdoutBuf, iterations, killInfo } = spawned);

    store.updateMeta(id, { state: 'collecting' });
    patch = ''; diffStat = ''; filesTouched = []; extractFailed = false;
    try {
      const p = noGit ? extractWorkspacePatch(pristine, worktree) : extractPatch(worktree);
      patch = p.patch;
      diffStat = p.diffStat;
      filesTouched = p.filesTouched;
    } catch (e) {
      extractFailed = true;
      errors.push({ type: 'internal', message: 'patch extraction failed', detail: String(e) });
    }

    // Classify provider/runtime failures once here — it drives both the retry
    // decision and the final status. Some CLIs (opencode) emit a structured
    // error event but still exit 0, so runtime error signals are checked
    // independently of the process exit code.
    providerFailure = null;
    exitVerdict = null;
    if (!killInfo) {
      if (exitCode !== 0) {
        exitVerdict = runtime.classifyExit?.(exitCode, events) ?? null;
        if (!exitVerdict) providerFailure = classifyFailure(failureText(events));
      }
      if (!exitVerdict && !providerFailure) {
        const errorText = errorSignalText(events);
        if (errorText) providerFailure = classifyFailure(errorText) ?? genericErrorSignal(errorText);
      }
    }

    const remainingMs = budget.wallClockMs - (Date.now() - attemptStart);
    const plan = retryPlan(providerFailure, !patch.trim(), retries, cfg.defaults.retries, remainingMs);
    if (plan.retry && providerFailure) {
      retries += 1;
      const cap = providerFailure.class === 'rate-limit' ? cfg.defaults.retries.rateLimit : cfg.defaults.retries.server;
      store.appendEvent(id, {
        ts: Date.now(), stream: 'system', kind: 'output',
        raw: `transient ${providerFailure.class} from ${resolved.workerId}; retry ${retries}/${cap} after ${Math.round(plan.delayMs / 1000)}s`,
      });
      await sleep(plan.delayMs);
      continue;
    }
    break;
  }

  store.updateMeta(id, { state: 'verifying' });
  const verification = patch.trim()
    ? runVerification(cfg.verify, worktree)
    : skippedAll('no patch produced — nothing to verify');
  const verifyFailed = [verification.build, verification.test, verification.lint]
    .some((c) => c.status === 'failed');
  if (verifyFailed) {
    errors.push({ type: 'verification-failed', message: 'one or more verification commands failed in the worktree' });
  }

  const usage = runtime.finalUsage(events);
  const workerSummary = runtime.finalSummary(tailOf(stdoutBuf, 8000), events);

  const ki = killInfo;
  const retrySuffix = retries > 0 ? ` after ${retries} retr${retries === 1 ? 'y' : 'ies'}` : '';
  let status: TerminalStatus;
  let stopReason: string;
  if (ki) {
    if (ki.reason === 'timeout') status = 'killed-timeout';
    else status = 'killed-no-progress';
    stopReason = ki.diagnosis;
    errors.push({ type: ki.reason, message: ki.diagnosis });
  } else if (exitVerdict) {
    status = exitVerdict.status;
    stopReason = exitVerdict.stopReason;
    errors.push({ type: exitVerdict.errType, message: exitVerdict.stopReason });
  } else if (providerFailure) {
    // The provider handed us a 429/401/5xx in the stream — a provider failure
    // (rate-limit/auth/server), not a worker crash (ARCHITECTURE §5). Some runtimes
    // surface this as an explicit error event even when the process exits 0.
    status = 'failed';
    const source = exitCode === 0 ? 'worker emitted an error event' : `worker exited (code ${exitCode})`;
    stopReason = `${source}${retrySuffix}: ${providerFailure.reason}`;
    errors.push({ type: providerFailure.errType, message: providerFailure.reason, ...(providerFailure.evidence ? { detail: providerFailure.evidence } : {}) });
  } else if (exitCode !== 0) {
    status = 'failed';
    stopReason = 'worker exited with code ' + String(exitCode);
    const stderrTail = events.filter((e) => e.stream === 'stderr').slice(-5).map((e) => e.raw).join('\n');
    errors.push({ type: 'worker-crash', message: stopReason, detail: stderrTail });
  } else if (verifyFailed) {
    status = 'partial';
    stopReason = 'worker finished but verification failed';
  } else if (extractFailed) {
    // Worker exited 0 but patch extraction threw. NEVER report this as `completed`
    // with an empty diff — that silently loses the worker's real work (the
    // `patch extraction failed` error is already recorded above). Fail loudly; the
    // git worktree is kept (see finalizeAttempt) so the work can still be recovered.
    // No-git workspaces are cleaned up per the no-git isolation contract.
    status = 'failed';
    stopReason = noGit
      ? 'worker exited 0 but patch extraction failed'
      : 'worker exited 0 but patch extraction failed — work is preserved in the worktree, not lost';
  } else {
    status = 'completed';
    stopReason = 'worker finished';
  }

  // Fail-closed sandbox verification: codex exec --json reports file
  // writes as structured file_change events. Any path outside the worktree is an
  // observed escape and makes the run untrustworthy.
  const sandboxVerdict = runtime.assessSandbox?.(events, worktree) ?? null;
  if (sandboxVerdict && !sandboxVerdict.confined) {
    errors.push({ type: 'isolation-unverified', message: 'worker ran without an enforcing worktree sandbox', detail: sandboxVerdict.detail });
    if (status === 'completed' || status === 'partial') {
      status = 'failed';
      stopReason = `sandbox not enforced: ${sandboxVerdict.detail}. Refusing to trust this result.`;
    } else {
      stopReason += ` · also ran without an enforcing sandbox`;
    }
  }

  // Frozen-judge integrity (verification-model.md §3): verification ran INSIDE the
  // worker's worktree, so if the patch edits a file that judges it (a test, a test/CI
  // config, a snapshot/fixture oracle), the pass/fail signal is the worker's own and
  // cannot be trusted. Such a run is never a clean `completed`: it becomes
  // `requires-review` — patch + worktree are kept for a human to inspect and explicitly
  // `dlg apply`; auto-apply is refused. Isolation/sandbox breaches above are more severe
  // and already forced `failed`, so we only downgrade an otherwise-clean verdict.
  const judgeTouched = touchesSensitive(filesTouched, DEFAULT_JUDGE_GLOBS);
  if (judgeTouched && (status === 'completed' || status === 'partial')) {
    errors.push({
      type: 'judge-tampered',
      message: `worker modified a file that judges it (${judgeTouched}); verification ran against the worker's own tests/oracles and cannot be trusted`,
      detail: `The judge in this patch is not frozen. Review the diff before applying — first matching judge file: ${judgeTouched}`,
    });
    status = 'requires-review';
    stopReason = noGit
      ? `verification is not trustworthy: the patch edits a file that judges it (${judgeTouched}). Inspect the patch, then \`dlg apply\` if correct.`
      : `verification is not trustworthy: the patch edits a file that judges it (${judgeTouched}). Patch kept in the worktree for review — inspect, then \`dlg apply\` if correct.`;
  }

  // Breaker feedback: a reachable provider (completed / partial /
  // requires-review — it answered and produced output) closes the circuit; a
  // classified provider failure counts toward opening it. A crash, kill, or
  // queue/worktree reject is NOT a provider-health signal and leaves the breaker
  // untouched.
  if (status === 'completed' || status === 'partial' || status === 'requires-review') {
    recordWorkerOutcome(resolved.workerId, { kind: 'success' }, cfg);
  } else if (providerFailure) {
    recordWorkerOutcome(resolved.workerId, {
      kind: 'provider-failure',
      class: providerFailure.class,
      ...(providerFailure.retryAfterMs !== undefined ? { retryAfterMs: providerFailure.retryAfterMs } : {}),
      ...(providerFailure.evidence ? { evidence: providerFailure.evidence } : {}),
    }, cfg);
    // Per-key cooldown: a 429/auth usually blames the KEY, not the
    // worker. If this provider runs a multi-key pool, park the used key so the
    // next run rotates past it (breaker handles whole-worker outages separately).
    if ((providerFailure.class === 'rate-limit' || providerFailure.class === 'auth') && resolved.apiKey) {
      const pool = loadSecretPools()[resolved.providerId];
      if (pool && pool.length > 1) {
        const raMs = providerFailure.retryAfterMs; // honor a positive Retry-After even if shorter than the default
        const until = Date.now() + (raMs && raMs > 0 ? raMs : cfg.defaults.keyCooldownMs);
        parkKey(resolved.providerId, resolved.apiKey, until, providerFailure.class);
      }
    }
  }

  slot.release(); // free the concurrency slot the moment the worker is done

  return {
    ran: true,
    status,
    stopReason,
    errors,
    verification,
    summary: ki ? ki.diagnosis + '\n---\nlast worker output:\n' + workerSummary : workerSummary,
    wallClockMs: Date.now() - attemptStart,
    ...(usage.tokens ? { tokens: usage.tokens } : {}),
    iterations: usage.iterations ?? (iterations > 0 ? iterations : undefined),
    diffStat,
    filesTouched,
    patch,
    worktree,
    pristine,
    noGit,
    // Any provider-class failure (rate-limit / auth / server) is eligible to fall
    // over to the next worker; task/code failures (crash, verify, kill) are not.
    shouldFallback: providerFailure !== null,
  };
}

/** Apply gate + worktree disposition + envelope for the winning attempt. */
function finalizeAttempt(
  id: string,
  resolved: ResolvedWorker,
  outcome: AttemptOutcome,
  budget: BudgetSpec,
  req: ExecuteRequest,
  cfg: DelegatorConfig,
  startedAt: number,
  attempts: AttemptRecord[],
): Envelope {
  const errors = [...outcome.errors];
  // Only the winning attempt's patch becomes the run's patch.diff.
  const patchFile = outcome.patch.trim() ? store.writePatch(id, outcome.patch) : undefined;
  // Run identity (verification-model.md §4): the exact base commit + a hash of the
  // exact patch bytes, so the receipt names what was reviewed and what gets applied.
  const patchSha256 = outcome.patch.trim() ? createHash('sha256').update(outcome.patch).digest('hex') : undefined;
  const baseCommit = store.readMeta(id).baseCommit;

  let applied = false;
  if (outcome.status === 'completed' && patchFile && req.policy === 'auto') {
    const sensitive = touchesSensitive(outcome.filesTouched, cfg.privacy.sensitivePaths);
    const lines = countDiffLines(outcome.diffStat);
    if (sensitive) {
      errors.push({ type: 'internal', message: 'auto-apply downgraded to review: sensitive path touched (' + sensitive + ')' });
    } else if (outcome.filesTouched.length > cfg.defaults.autoApply.maxFiles || lines > cfg.defaults.autoApply.maxLines) {
      errors.push({ type: 'internal', message: 'auto-apply downgraded to review: diff exceeds thresholds (' + String(outcome.filesTouched.length) + ' files, ' + String(lines) + ' lines)' });
    } else {
      try {
        if (baseCommit === 'no-git') applyWorkspacePatch(req.cwd, patchFile);
        else applyPatch(req.cwd, patchFile);
        applied = true;
      } catch (e) {
        errors.push({
          type: 'patch-conflict',
          message: baseCommit === 'no-git' ? 'git apply failed' : 'git apply --3way failed',
          detail: String(e),
        });
      }
    }
  }

  // no-git workspaces are always reclaimed (plain copies, not git worktrees). For git
  // worktrees, defaults.worktreeRetention decides whether the heavy checkout survives —
  // patch.diff is persisted either way, so `dlg apply <id>` works regardless. keepWorktree
  // also drives whether the envelope records the worktree path (below).
  let keepWorktree = false;
  if (!outcome.noGit && outcome.worktree) {
    const wr = cfg.defaults.worktreeRetention;
    const cleanlyDone = outcome.status === 'completed';
    keepWorktree =
      wr === 'keep' ? !applied                          // keep for inspect/resume unless auto-applied
      : wr === 'on-finish' ? false                      // always drop the checkout
      : !cleanlyDone && !applied;                       // keep-unfinished: keep only killed/failed/partial
  }

  // Reclaim the workspace/worktree BEFORE finalizing. Reclaim is a best-effort last step that
  // never throws (reclaimAttemptWorkspace returns a warning string on failure) — the patch is
  // already written to the run store and any auto-apply already ran against req.cwd, so nothing
  // here needs the workspace. Folding a cleanup warning into `errors` before the SINGLE finalize()
  // keeps the envelope and the journal in agreement and avoids a second, unguarded envelope write.
  const cleanupWarning = reclaimAttemptWorkspace(outcome, req.cwd, keepWorktree);
  const finalErrors: ErrorEntry[] = cleanupWarning
    ? [...errors, { type: 'internal', message: cleanupWarning }]
    : errors;

  return finalize(id, outcome.status, resolved.workerId, resolved.worker.model, normalizeRuntimeId(resolved.worker.runtime), {
    summary: outcome.summary,
    stopReason: outcome.stopReason,
    errors: finalErrors,
    verification: outcome.verification,
    wallClockMs: Date.now() - startedAt, // total run wall clock, including any fallover attempts
    ...(outcome.tokens ? { tokens: outcome.tokens } : {}),
    ...(outcome.iterations !== undefined ? { iterations: outcome.iterations } : {}),
    budget,
    diffStat: outcome.diffStat,
    filesTouched: outcome.filesTouched,
    patchFile,
    applied,
    ...(baseCommit ? { baseCommit } : {}),
    ...(patchSha256 ? { patchSha256 } : {}),
    worktree: keepWorktree && outcome.worktree ? outcome.worktree : undefined,
    attempts: attemptsForEnvelope(attempts),
  });
}

interface FinalizeExtras {
  summary: string;
  stopReason: string;
  errors: ErrorEntry[];
  verification: VerificationResult;
  wallClockMs: number;
  tokens?: TokenUsage;
  iterations?: number;
  budget?: BudgetSpec;
  diffStat?: string;
  filesTouched?: string[];
  patchFile?: string;
  applied?: boolean;
  baseCommit?: string;
  patchSha256?: string;
  worktree?: string;
  attempts?: AttemptRecord[];
}

function finalize(
  id: string,
  status: Envelope['status'],
  workerId: string,
  model: string | undefined,
  runtime: Envelope['runtime'],
  x: FinalizeExtras,
): Envelope {
  const env: Envelope = {
    envelopeVersion: 1,
    runId: id,
    status,
    workerId,
    model,
    runtime,
    summary: x.summary,
    changes: {
      diffStat: x.diffStat ?? '',
      filesTouched: x.filesTouched ?? [],
      patchFile: x.patchFile,
      applied: x.applied ?? false,
      ...(x.baseCommit ? { baseCommit: x.baseCommit } : {}),
      ...(x.patchSha256 ? { patchSha256: x.patchSha256 } : {}),
    },
    verification: x.verification,
    usage: { wallClockMs: x.wallClockMs, iterations: x.iterations, tokens: x.tokens, budget: x.budget },
    stopReason: x.stopReason,
    errors: x.errors,
    logsPath: store.eventsPath(id),
    worktree: x.worktree,
    ...(x.attempts ? { attempts: x.attempts } : {}),
  };
  store.writeEnvelope(id, env);
  store.journalAppend(env);
  return env;
}

/** Explicit apply step - the review-policy path from worktree to main tree. */
export function applyRun(id: string): Envelope {
  const meta = store.readMeta(id);
  const env = store.readEnvelope(id);
  if (!env) throw new Error('run ' + id + ' has no envelope yet');
  if (env.changes.applied) throw new Error('run ' + id + ' is already applied');
  if (!env.changes.patchFile) throw new Error('run ' + id + ' has no patch to apply');
  if (meta.baseCommit === 'no-git') applyWorkspacePatch(meta.request.cwd, env.changes.patchFile);
  else applyPatch(meta.request.cwd, env.changes.patchFile);
  env.changes.applied = true;
  store.writeEnvelope(id, env);
  if (meta.worktree && meta.baseCommit !== 'no-git') removeWorktree(meta.request.cwd, meta.worktree);
  return env;
}

/** Roll back an applied run: reverse its patch out of the main tree (verification-model.md
 *  §4 — the apply step must be undoable). Fails closed — if the tree moved since apply so
 *  the reverse is not clean, nothing is touched and the caller is told to resolve by hand. */
export function undoRun(id: string): Envelope {
  const meta = store.readMeta(id);
  const env = store.readEnvelope(id);
  if (!env) throw new Error('run ' + id + ' has no envelope yet');
  if (!env.changes.applied) throw new Error('run ' + id + ' was not applied — nothing to undo');
  if (!env.changes.patchFile) throw new Error('run ' + id + ' has no patch on record to reverse');
  try {
    if (meta.baseCommit === 'no-git') reverseApplyWorkspacePatch(meta.request.cwd, env.changes.patchFile);
    else reverseApplyPatch(meta.request.cwd, env.changes.patchFile);
  } catch (e) {
    throw new Error(
      'could not cleanly reverse run ' + id + ' — the tree likely changed since it was applied; '
      + 'nothing was modified. Resolve by hand if needed (patch: ' + env.changes.patchFile + '). '
      + String(e instanceof Error ? e.message : e),
    );
  }
  env.changes.applied = false;
  store.writeEnvelope(id, env);
  return env;
}
