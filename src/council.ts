import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { ConfigError, parseDuration } from './config.js';
import { resolveRunPlan } from './registry.js';
import { executeRun } from './runner.js';
import * as store from './runstore.js';
import type { CouncilCandidate, CouncilEnvelope, CouncilModelRef, CouncilOptions, DelegatorConfig, Envelope } from './types.js';

export interface RunCouncilRequest {
  task: string;
  cwd: string;
  options: CouncilOptions;
  aggregateWith?: string;
}

export function buildBundle(task: string, candidates: CouncilCandidate[]): string {
  const usable = candidates.filter((c) => c.answer.trim() !== '');
  const parts = [
    `You have been provided with ${usable.length} responses from different models to the user task below. Critically evaluate them — some parts may be biased or incorrect. Discard weak or wrong parts; do not merge blindly; do not reward length. Synthesize ONE refined, accurate, coherent answer.`,
    '',
    '## Task',
    task,
  ];

  usable.forEach((candidate, i) => {
    parts.push('', `## Candidate ${i + 1}: ${candidate.workerId}`, candidate.answer);
    if (candidate.diff?.trim()) {
      parts.push('', '### Diff', '```diff', candidate.diff, '```');
    }
  });

  return parts.join('\n');
}

export function sumCouncilUsage(
  candidates: CouncilCandidate[],
  wallClockMs: number,
): CouncilEnvelope['usage'] {
  return candidates.reduce<CouncilEnvelope['usage']>((usage, c) => ({
    inputTokens: usage.inputTokens + (c.tokens?.input ?? 0),
    outputTokens: usage.outputTokens + (c.tokens?.output ?? 0),
    reasoningTokens: usage.reasoningTokens + (c.tokens?.reasoning ?? 0),
    totalTokens: usage.totalTokens + (c.tokens?.total ?? 0),
    calls: usage.calls + 1,
    wallClockMs,
  }), {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    calls: 0,
    wallClockMs,
  });
}

export function newCouncilId(): string {
  return `council_${Date.now()}_${randomBytes(3).toString('hex')}`;
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function readPatch(env: Envelope): string | undefined {
  const file = env.changes.patchFile;
  if (!file) return undefined;
  try {
    const text = fs.readFileSync(file, 'utf8');
    return text.trim() ? text : undefined;
  } catch {
    return undefined;
  }
}

async function runOneCouncilWorker(
  handle: string,
  req: RunCouncilRequest,
  cfg: DelegatorConfig,
): Promise<{ candidate: CouncilCandidate; warning?: string }> {
  const started = Date.now();
  let attempts = 0;
  let lastError: unknown;
  const maxAttempts = 1 + (req.options.maxRetriesPerWorker ?? 0);
  const budgetOverride = req.options.budget ? { wallClockMs: parseDuration(req.options.budget) } : undefined;

  for (; attempts < maxAttempts; attempts++) {
    const model = req.options.models.find((m) => m.handle === handle)!;
    const explicitEffort = model.reasoningEffort !== undefined;
    const effort = model.reasoningEffort ?? 'xhigh';
    try {
      const run = (effortOverride?: string) => executeRun({
        workerId: handle,
        brief: req.task,
        cwd: req.cwd,
        policy: 'review',
        skipPrune: true,
        ...(budgetOverride ? { budgetOverride } : {}),
        ...(effortOverride ? { effortOverride } : {}),
      }, cfg);
      let env: Envelope;
      try {
        env = await run(effort);
      } catch (e) {
        // The default council effort is xhigh, but older/simple workers may not declare it.
        // In that case keep the worker usable by falling back to its configured default.
        if (explicitEffort || !(e instanceof ConfigError) || !e.message.includes('--effort "xhigh"')) throw e;
        env = await run();
      }
      if ((env.status === 'failed' || env.status === 'rejected') && attempts + 1 < maxAttempts) {
        lastError = new Error(env.stopReason);
        continue;
      }
      const diff = readPatch(env);
      // A worker that ended failed/rejected without throwing must still leave a visible trace
      // beyond its status — the smoke run showed a silent 3s failure otherwise.
      const bad = env.status === 'failed' || env.status === 'rejected';
      return {
        ...(bad ? { warning: `${handle}: ${env.stopReason}` } : {}),
        candidate: {
          workerId: handle,
          runId: env.runId,
          status: env.status,
          answer: env.summary,
          ...(diff ? { diff } : {}),
          filesTouched: env.changes.filesTouched,
          ...(env.usage.tokens ? { tokens: env.usage.tokens } : {}),
          reasoningUnavailable: env.usage.tokens != null && env.usage.tokens.reasoning === undefined,
          attempts: attempts + 1,
          durationMs: env.usage.wallClockMs,
        },
      };
    } catch (e) {
      lastError = e;
    }
  }

  const msg = errorMessage(lastError);
  return {
    warning: `${handle}: ${msg}`,
    candidate: {
      workerId: handle,
      status: 'failed',
      answer: '',
      filesTouched: [],
      attempts,
      durationMs: Date.now() - started,
    },
  };
}

function addUsage(
  usage: CouncilEnvelope['usage'],
  tokens: Envelope['usage']['tokens'],
): CouncilEnvelope['usage'] {
  return {
    inputTokens: usage.inputTokens + (tokens?.input ?? 0),
    outputTokens: usage.outputTokens + (tokens?.output ?? 0),
    reasoningTokens: usage.reasoningTokens + (tokens?.reasoning ?? 0),
    totalTokens: usage.totalTokens + (tokens?.total ?? 0),
    calls: usage.calls + 1,
    wallClockMs: usage.wallClockMs,
  };
}

export async function runCouncil(
  req: RunCouncilRequest,
  cfg: DelegatorConfig,
): Promise<CouncilEnvelope> {
  const started = Date.now();
  const warnings = validateCouncilModels(req.options.models);
  // Fail fast on unknown/unconfigured handles (CLI exit 2): a typo in -w or --aggregate must abort
  // the council, not silently degrade after the other workers burn time and tokens.
  for (const m of req.options.models) resolveRunPlan(cfg, { workerId: m.handle });
  if (req.aggregateWith) resolveRunPlan(cfg, { workerId: req.aggregateWith });
  const results = await Promise.all(req.options.models.map((m) => runOneCouncilWorker(m.handle, req, cfg)));
  const candidates = results.map((r) => r.candidate);
  for (const r of results) if (r.warning) warnings.push(r.warning);

  const usable = candidates.filter((c) => c.answer.trim() !== '' && c.status !== 'failed' && c.status !== 'rejected');
  const quorumMet = usable.length >= req.options.minProposers;
  const stopReason = quorumMet ? 'completed' : 'degraded';
  if (!quorumMet) warnings.push(`quorum not met: ${usable.length} usable of ${req.options.minProposers} required`);
  if (usable.length === 1) warnings.push('single usable answer — council degenerates to a single model');

  const bundle = buildBundle(req.task, candidates);
  let usage = sumCouncilUsage(candidates, Date.now() - started);
  let final: CouncilEnvelope['final'];
  if (req.aggregateWith) {
    const env = await executeRun({
      workerId: req.aggregateWith,
      brief: bundle,
      cwd: req.cwd,
      policy: 'review',
      skipPrune: true,
    }, cfg);
    // `final` is a SYNTHESIS contract: a failed/rejected aggregate must not surface its error text
    // as if it were the synthesized answer — report it as a warning and omit `final` instead.
    const usable = env.summary.trim() !== '' && env.status !== 'failed' && env.status !== 'rejected';
    if (usable) {
      final = { answer: env.summary, workerId: req.aggregateWith, ...(env.usage.tokens ? { tokens: env.usage.tokens } : {}) };
    } else {
      warnings.push(`aggregate ${req.aggregateWith}: ${env.stopReason}`);
    }
    // Aggregate is not a candidate, but it is still a paid model call.
    usage = addUsage(usage, env.usage.tokens);
  }
  usage.wallClockMs = Date.now() - started;
  store.pruneRuns(cfg.defaults.keepRuns);

  return {
    kind: 'council',
    councilId: newCouncilId(),
    candidates,
    bundle,
    ...(final ? { final } : {}),
    usage,
    lowSignal: true,
    quorumMet,
    stopReason,
    warnings,
  };
}

/** Vendor family of a model handle — council diversity comes from DIFFERENT families, so two
 *  members from one family are worth a warning. opencode handles wrap a marketplace model, so the
 *  vendor-like prefix of the model id says more than the literal first segment. */
function councilModelFamily(handle: string): string {
  const parts = handle.split('/');
  if (parts[0] === 'opencode' && parts.length >= 3) {
    return parts[parts.length - 1]!.split(/[-_/.]/)[0] || parts[0]!;
  }
  return parts[0]!;
}

/** Validate a per-invocation council model list (there is no council config file — the caller
 *  picks models from the shared provider pool for each task). Throws on unusable input, returns
 *  advisory warnings. */
export function validateCouncilModels(models: CouncilModelRef[]): string[] {
  if (models.length < 2) {
    throw new ConfigError('council needs at least 2 different models — pass a comma-separated worker list');
  }
  const seen = new Set<string>();
  for (const m of models) {
    if (seen.has(m.handle)) throw new ConfigError(`Duplicate council model handle "${m.handle}"`);
    seen.add(m.handle);
  }
  const warnings: string[] = [];
  for (let i = 0; i < models.length; i++) {
    for (let j = i + 1; j < models.length; j++) {
      if (councilModelFamily(models[i]!.handle) === councilModelFamily(models[j]!.handle)) {
        warnings.push(`models ${models[i]!.handle} and ${models[j]!.handle} are from the same family — less diversity`);
      }
    }
  }
  return warnings;
}
