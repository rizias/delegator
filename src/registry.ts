import { spawnSync } from 'node:child_process';
import {
  ConfigError,
  inferRuntimeForProviderConfig,
  mergedRuntimeDescriptors,
  normalizeRuntimeId,
  parseHandle,
  withModelDefaults,
} from './config.js';
import { fetchProviderModels } from './models.js';
import type {
  DelegatorConfig,
  ProviderConfig,
  WorkerConfig,
  WorkerInfo,
  ResolvedWorker,
  TierConfig,
} from './types.js';

// ---------- resolveSecret ----------
// Order: legacy inline apiKey (pre-migration) > secrets.yaml > env var.

import { loadSecretPools, loadSecrets, nextPoolKey } from './config.js';
import { workerBreakerView } from './breaker.js';
import { readState, type DelegatorState } from './state.js';

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Availability view: is ANY key reachable (no rotation side effects). */
export function resolveSecret(p: ProviderConfig, providerId: string): string | undefined {
  return (
    p.apiKey ??
    loadSecrets()[providerId] ??
    (p.apiKeyEnv && ENV_NAME_RE.test(p.apiKeyEnv) ? process.env[p.apiKeyEnv] : undefined)
  );
}

/** Run view: rotates through the provider's key pool (round-robin cursor). */
export function resolveSecretForRun(p: ProviderConfig, providerId: string): string | undefined {
  if (p.apiKey) return p.apiKey;
  const pool = loadSecretPools()[providerId];
  if (pool && pool.length) return nextPoolKey(providerId, pool);
  return p.apiKeyEnv && ENV_NAME_RE.test(p.apiKeyEnv) ? process.env[p.apiKeyEnv] : undefined;
}

// ---------- binaryOnPath ----------

const _binaryCache = new Map<string, boolean>();

/** Test seam: treat these binaries as present, so the fallback integration test
 *  can run without the real claude/codex CLIs installed (and without ever
 *  spawning them — runtimes are injected). No effect unless a test calls it. */
const _assumedBinaries = new Set<string>();
export function _assumeBinariesForTest(names: string[]): void {
  for (const n of names) _assumedBinaries.add(n);
}

export function binaryOnPath(name: string): boolean {
  if (_assumedBinaries.has(name)) return true;
  const cached = _binaryCache.get(name);
  if (cached !== undefined) return cached;
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(cmd, [name], { encoding: 'utf8' });
  const found = result.status === 0;
  _binaryCache.set(name, found);
  return found;
}

// ---------- workerInfo ----------

export function runtimeBinary(cfg: Pick<DelegatorConfig, 'runtimes'>, id: string): string | undefined {
  const descriptor = mergedRuntimeDescriptors(cfg)[normalizeRuntimeId(id)];
  return descriptor?.command;
}

export function isLocalProvider(p: ProviderConfig): boolean {
  if (!p.baseUrl) return false;
  try {
    const host = new URL(p.baseUrl).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
  } catch {
    return false;
  }
}

export function resolveWorkerHandle(id: string, cfg: DelegatorConfig): WorkerConfig | undefined {
  const worker = cfg.workers[id];
  if (worker) return { ...worker, runtime: normalizeRuntimeId(worker.runtime) };

  let parsed: ReturnType<typeof parseHandle>;
  try {
    parsed = parseHandle(id, cfg);
  } catch {
    return undefined;
  }
  if ('profileAlias' in parsed) return undefined;

  const provider = cfg.providers[parsed.provider];
  if (!provider || !parsed.model) return undefined;
  let runtime: WorkerConfig['runtime'] | undefined;
  try {
    runtime = normalizeRuntimeId(parsed.runtime ?? inferRuntimeForProviderConfig(parsed.provider, provider, cfg) ?? '');
  } catch {
    return undefined;
  }
  if (runtime === undefined || runtime === '') return undefined;
  // A bare `provider/model` handle has no named profile, so inherit the provider's per-model
  // defaults (reasoningEffort / budget / contextWindow / card) the way load-time profiles do.
  return withModelDefaults({ provider: parsed.provider, model: parsed.model, runtime }, provider);
}

export function workerInfo(id: string, cfg: DelegatorConfig, snapshot?: DelegatorState): WorkerInfo {
  const worker = resolveWorkerHandle(id, cfg);
  if (!worker) {
    // Common slip: `dlg run -w lmstudio` where lmstudio is a PROVIDER, not a worker.
    // Name it instead of a bare "not found" — point them at declaring a worker on
    // that provider (provider: <name>, model: <id>).
    const provider = cfg.providers[id];
    if (provider) {
      return {
        id, status: 'unconfigured',
        reason: `"${id}" is a provider, not a worker — declare a worker (provider: ${id}, model: <model-id>) and run against that`,
        provider: id, runtime: 'claude', tierMembership: [],
      };
    }
    const firstSegment = id.split('/')[0]!;
    const handleProvider = cfg.providers[firstSegment];
    if (handleProvider && id.split('/').slice(1).join('/').trim() === '') {
      return {
        id, status: 'unconfigured',
        reason: `handle "${id}" names provider "${firstSegment}" but has no model`,
        provider: firstSegment, runtime: 'claude', tierMembership: [],
      };
    }
    return {
      id, status: 'unconfigured', reason: `worker "${id}" not found in config (unknown worker/handle)`,
      provider: '', runtime: 'claude', tierMembership: [],
    };
  }

  const providerId = worker.provider;
  const provider = cfg.providers[providerId];

  // One base shape for every status (no field drift between branches).
  const base: WorkerInfo = {
    id,
    status: 'available',
    provider: providerId,
    model: worker.model,
    runtime: worker.runtime,
    tierMembership: _tierMembership(id, cfg),
    card: worker.card,
    contextWindow: worker.contextWindow,
    price: worker.price,
  };
  const as = (status: WorkerInfo['status'], reason?: string): WorkerInfo => ({ ...base, status, reason });

  // 1. Project allow-list (restrict): a worker outside the list is off-limits here.
  const allow = cfg.restrict?.workers;
  if (allow && allow.length && !allow.includes(id)) {
    return as('restricted', 'not in restrict.workers for this project (.delegator.yaml)');
  }

  // 2. Unknown provider
  if (!provider) return as('unconfigured', `unknown provider ${providerId}`);

  // 3. API key required but missing. Localhost providers and subscription/no-auth
  //    providers never need a delegator-managed key.
  if (
    !isLocalProvider(provider) &&
    provider.auth !== 'none' &&
    provider.auth !== 'subscription' &&
    (provider.kind === 'anthropic-compatible' || provider.kind === 'openai-compatible') &&
    !resolveSecret(provider, providerId)
  ) {
    // NEVER echo raw config values - a pasted secret would leak.
    const envOk = provider.apiKeyEnv !== undefined && ENV_NAME_RE.test(provider.apiKeyEnv);
    const envHint = envOk ? ` or env ${provider.apiKeyEnv}` : '';
    return as('unconfigured', `missing API key for provider "${providerId}" (edit ~/.delegator/secrets.yaml${envHint})`);
  }

  // 4. Runtime availability. api-oneshot runs IN-PROCESS (one HTTP call) — it needs
  //    no binary and is always available here. The spawn runtimes (claude/codex/opencode)
  //    need their binary on PATH. A runtime name this build doesn't implement (a future
  //    or unbuilt one) lands as unconfigured with a clear "not available in this build".
  const runtimeId = worker.runtime;
  if (runtimeId === undefined) {
    return as('unconfigured', `worker "${id}" has no runtime (provider "${providerId}" kind "${provider.kind}" maps to none)`);
  }
  if (runtimeId !== 'api') {
    const binaryName = runtimeBinary(cfg, runtimeId);
    if (binaryName === undefined) {
      return as('unconfigured', `worker "${id}" needs runtime "${runtimeId}", not available in this build (running "${provider.kind}" models is unsupported here; 'dlg models ${providerId}' can still list them)`);
    }
    if (!binaryOnPath(binaryName)) {
      return as('unconfigured', `binary not found: ${binaryName}`);
    }
  }

  // 6. Configured & reachable in principle — but the circuit breaker
  //    may have seen it fail live: overlay degraded/unavailable from persisted state.
  const view = workerBreakerView(id, cfg, Date.now(), snapshot);
  if (view.status !== 'available') {
    return as(view.status, view.reason);
  }

  // 7. Available
  return base;
}

function _tierMembership(workerId: string, cfg: DelegatorConfig): string[] {
  return Object.entries(cfg.tiers)
    .filter(([, tier]) => tier.chain.includes(workerId))
    .map(([name]) => name);
}

// ---------- listWorkers ----------

export function listWorkers(cfg: DelegatorConfig): WorkerInfo[] {
  const snapshot = readState(); // one state.json read; breaker view is shared across workers
  const seen = new Set<string>();
  const out: WorkerInfo[] = [];
  // Named profiles first (if any).
  for (const id of Object.keys(cfg.workers)) {
    out.push(workerInfo(id, cfg, snapshot));
    const w = cfg.workers[id];
    if (w?.provider && w.model) seen.add(`${w.provider}/${w.model}`);
  }
  // The fleet: every provider/model declared under a provider, addressable as a handle. Skipped if a
  // named profile already covers that provider+model. This keeps `dlg providers` complete in the
  // provider-first shape where models live under providers and there is no `workers:` block.
  for (const [pid, prov] of Object.entries(cfg.providers)) {
    for (const model of Object.keys(prov.models ?? {})) {
      const key = `${pid}/${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(workerInfo(key, cfg, snapshot));
    }
  }
  return out;
}

// ---------- resolveForRun ----------

export async function resolveForRun(
  cfg: DelegatorConfig,
  sel: { workerId?: string; tier?: string },
): Promise<{ resolved: ResolvedWorker; tierCfg?: TierConfig; tierName?: string }> {
  const defaultWorkerId = sel.workerId ?? (sel.tier === undefined ? cfg.defaults.model : undefined);
  const hasWorker = defaultWorkerId !== undefined;
  const hasTier = sel.tier !== undefined;

  if (hasWorker === hasTier) {
    throw new ConfigError(
      hasWorker
        ? 'Specify exactly one of workerId or tier, not both'
        : 'Specify exactly one of workerId or tier',
    );
  }

  if (hasWorker) {
    const wid = defaultWorkerId!;
    const info = workerInfo(wid, cfg);

    if (info.status === 'restricted') {
      const allow = cfg.restrict?.workers ?? [];
      throw new ConfigError(
        `Worker "${wid}" is not allowed in this project. Allowed: ${allow.join(', ') || '(none)'} ` +
          '(edit restrict.workers in .delegator.yaml)',
      );
    }

    if (info.status === 'unconfigured') {
      throw new ConfigError(info.reason ?? `Worker "${wid}" is unconfigured`);
    }

    const chain = buildFallbackChain(cfg, wid);
    const candidate = chain.find((c) => c.available);
    if (!candidate) {
      throw new ConfigError(
        `No available worker for "${wid}". Candidates:\n` +
          chain.map((c) => `  ${c.workerId}: ${c.skipReason ?? 'unavailable'}`).join('\n'),
      );
    }
    const resolved = await resolveCandidate(candidate, cfg);
    return { resolved };
  }

  // Tier resolution
  const tierName = sel.tier!;
  const tierCfg = cfg.tiers[tierName];
  if (!tierCfg) {
    throw new ConfigError(`Tier "${tierName}" not found in config`);
  }

  const allowTiers = cfg.restrict?.tiers;
  if (allowTiers && allowTiers.length && !allowTiers.includes(tierName)) {
    throw new ConfigError(
      `Tier "${tierName}" is not allowed in this project. Allowed: ${allowTiers.join(', ')} ` +
        '(edit restrict.tiers in .delegator.yaml)',
    );
  }

  const reasons: string[] = [];

  for (const wid of tierCfg.chain) {
    const info = workerInfo(wid, cfg);

    if (info.status !== 'available') {
      reasons.push(`${wid}: ${info.reason ?? info.status}`);
      continue;
    }

    // status === 'available' implies worker and provider exist
    const worker = resolveWorkerHandle(wid, cfg)!;
    const prov = cfg.providers[worker.provider]!;
    const resolved = await resolveCandidate(
      { workerId: wid, available: true, worker, provider: prov, providerId: worker.provider },
      cfg,
    );
    return { resolved, tierCfg, tierName };
  }

  throw new ConfigError(
    `No available worker in tier "${tierName}". Candidates:\n` +
      reasons.map((r) => `  ${r}`).join('\n'),
  );
}

// ---------- resolveRunPlan (fallback-aware) ----------
// The ordered candidate chain a run will try. A direct worker may expand through
// per-model fallback links. A tier remains the whole chain with each worker's
// live availability (breaker included), so the runner can fall over on a provider
// failure (ARCHITECTURE §5) instead of giving up at the first one.

export interface RunCandidate {
  workerId: string;
  available: boolean;
  skipReason?: string;          // why this candidate is not runnable now
  // Present when the worker handle resolves; runnable only when available is true.
  worker?: WorkerConfig;
  provider?: ProviderConfig;
  providerId?: string;
}

export interface RunPlan {
  candidates: RunCandidate[];
  tierCfg?: TierConfig;
  tierName?: string;
  fallback: 'auto' | 'report';
}

function candidateForWorker(
  handle: string,
  cfg: DelegatorConfig,
  snapshot?: DelegatorState,
): RunCandidate | undefined {
  const worker = resolveWorkerHandle(handle, cfg);
  if (worker === undefined) return undefined;
  const info = workerInfo(handle, cfg, snapshot);
  if (info.status === 'available' || info.status === 'degraded') {
    const prov = cfg.providers[worker.provider]!;
    return { workerId: handle, available: true, worker, provider: prov, providerId: worker.provider };
  }
  const prov = cfg.providers[worker.provider];
  return {
    workerId: handle,
    available: false,
    skipReason: info.reason ?? info.status,
    worker,
    ...(prov !== undefined ? { provider: prov, providerId: worker.provider } : {}),
  };
}

function buildFallbackChain(
  cfg: DelegatorConfig,
  head: string,
  snapshot?: DelegatorState,
): RunCandidate[] {
  const candidates: RunCandidate[] = [];
  const seen = new Set<string>();
  const queue = [head];

  while (queue.length > 0 && candidates.length < 12) {
    const handle = queue.shift()!;
    const worker = resolveWorkerHandle(handle, cfg);
    if (worker === undefined) continue;

    const key = `${worker.provider}/${worker.model ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const candidate = candidateForWorker(handle, cfg, snapshot);
    if (candidate !== undefined) candidates.push(candidate);

    const fallback = worker.fallback;
    if (typeof fallback === 'string') {
      queue.push(fallback);
    } else if (Array.isArray(fallback)) {
      queue.push(...fallback);
    }
  }

  return candidates;
}

function providerLabel(provider: ProviderConfig, providerId: string): string {
  return (provider.baseUrl ?? '').replace(/\/+$/, '') || providerId;
}

async function resolveWorkerModel(
  cfg: DelegatorConfig,
  workerId: string,
  worker: WorkerConfig,
  provider: ProviderConfig,
  providerId: string,
): Promise<string | undefined> {
  if (worker.model !== undefined || normalizeRuntimeId(worker.runtime) !== 'api') return worker.model;

  const result = await fetchProviderModels(providerId, cfg, { preferRunning: true });
  const at = providerLabel(provider, providerId);
  if (result.source === 'running' && result.models.length > 0) {
    process.stderr.write(
      `[delegator] worker "${workerId}": auto-selected running model "${result.models[0]}" at ${at} ` +
        '(set model: to pin a specific one).\n',
    );
    return result.models[0];
  }
  if (result.models.length === 1) return result.models[0];
  if (result.models.length === 0) throw new ConfigError(`no running or pulled model at ${at} — pin model: or load one`);
  // Multiple models loaded and none pinned: pick the FIRST and run — a local worker should "just
  // work", not block on a choice the user never made. Log which one and how to override.
  process.stderr.write(
    `[delegator] worker "${workerId}": ${result.models.length} models loaded at ${at}; ` +
      `auto-selected "${result.models[0]}" (set model: to pin a specific one).\n`,
  );
  return result.models[0];
}

/** Build a ResolvedWorker for an available candidate, rotating to a live pool key
 *  (cooldown-aware via nextPoolKey). Called at attempt time, not plan time, so a
 *  worker that never runs never burns a key rotation. */
export async function resolveCandidate(cand: RunCandidate, cfg: DelegatorConfig): Promise<ResolvedWorker> {
  const worker0 = cand.worker!;
  const provider = cand.provider!;
  const providerId = cand.providerId!;
  const model = await resolveWorkerModel(cfg, cand.workerId, worker0, provider, providerId);
  const worker = model === worker0.model ? worker0 : { ...worker0, model };
  return {
    workerId: cand.workerId,
    worker,
    provider,
    providerId,
    apiKey: resolveSecretForRun(provider, providerId),
  };
}

export function resolveRunPlan(
  cfg: DelegatorConfig,
  sel: { workerId?: string; tier?: string },
  opts: { tolerant?: boolean } = {},
): RunPlan {
  const defaultWorkerId = sel.workerId ?? (sel.tier === undefined ? cfg.defaults.model : undefined);
  const hasWorker = defaultWorkerId !== undefined;
  const hasTier = sel.tier !== undefined;
  if (hasWorker === hasTier) {
    throw new ConfigError(
      hasWorker
        ? 'Specify exactly one of workerId or tier, not both'
        : 'Specify exactly one of workerId or tier',
    );
  }

  const snapshot = readState(); // one breaker snapshot for the whole plan

  // ----- direct worker: for a run, head config problems throw (exit 2, unchanged
  // messages); fallback candidates are reported as skipped instead of aborting the plan.
  // In tolerant mode (`dlg route` inspection) NOTHING throws — an unconfigured/restricted head
  // is shown as a skipped candidate so the chain is always inspectable.
  if (hasWorker) {
    const wid = defaultWorkerId!;
    const info = workerInfo(wid, cfg, snapshot);

    if (!opts.tolerant && info.status === 'restricted') {
      const allow = cfg.restrict?.workers ?? [];
      throw new ConfigError(
        `Worker "${wid}" is not allowed in this project. Allowed: ${allow.join(', ') || '(none)'} ` +
          '(edit restrict.workers in .delegator.yaml)',
      );
    }
    if (!opts.tolerant && info.status === 'unconfigured') {
      throw new ConfigError(info.reason ?? `Worker "${wid}" is unconfigured`);
    }
    const candidates = buildFallbackChain(cfg, wid, snapshot);
    return {
      candidates,
      fallback: candidates.length > 1 ? 'auto' : 'report',
    };
  }

  // ----- tier: the full ordered chain with per-worker availability.
  const tierName = sel.tier!;
  const tierCfg = cfg.tiers[tierName];
  if (!tierCfg) throw new ConfigError(`Tier "${tierName}" not found in config`);

  const allowTiers = cfg.restrict?.tiers;
  if (allowTiers && allowTiers.length && !allowTiers.includes(tierName)) {
    throw new ConfigError(
      `Tier "${tierName}" is not allowed in this project. Allowed: ${allowTiers.join(', ')} ` +
        '(edit restrict.tiers in .delegator.yaml)',
    );
  }

  const candidates: RunCandidate[] = [];
  for (const wid of tierCfg.chain) {
    const info = workerInfo(wid, cfg, snapshot);
    if (info.status === 'available' || info.status === 'degraded') {
      const worker = resolveWorkerHandle(wid, cfg)!;
      const prov = cfg.providers[worker.provider]!;
      candidates.push({ workerId: wid, available: true, worker, provider: prov, providerId: worker.provider });
    } else {
      candidates.push({ workerId: wid, available: false, skipReason: info.reason ?? info.status });
    }
  }

  return { candidates, tierCfg, tierName, fallback: tierCfg.fallback };
}

export interface PlanCandidateView {
  n: number;
  workerId: string;
  available: boolean;
  skipReason?: string;
  model?: string;
  runtime?: string;
  pool?: string;        // provider id
  contextWindow?: number;
  price?: { inPerMtok?: number; outPerMtok?: number };
  fitsContext?: boolean; // present iff a brief was given AND the worker declares a window
}

export interface PlanView {
  selector: string;     // 'tier "X"' | 'worker "Y"'
  fallback: 'auto' | 'report';
  briefChars?: number;
  briefEstTokens?: number;
  candidates: PlanCandidateView[];
  wouldRunWorkerId?: string; // the first AVAILABLE candidate, or undefined if none
}

/** Render a RunPlan as a dry-run preview (no spawn, no key rotation): the resolved
 *  candidate chain with availability, provider pool, context-window fit, and which worker
 *  would actually run first. Token counts are a rough chars/4 ESTIMATE — for fit/cost
 *  intuition only, not a billing figure. */
export function buildPlanView(plan: RunPlan, brief?: string): PlanView {
  const briefChars = brief !== undefined ? brief.length : undefined;
  const briefEstTokens = briefChars !== undefined ? Math.ceil(briefChars / 4) : undefined;
  const candidates: PlanCandidateView[] = plan.candidates.map((c, i) => {
    const ctx = c.worker?.contextWindow;
    return {
      n: i + 1,
      workerId: c.workerId,
      available: c.available,
      ...(c.skipReason ? { skipReason: c.skipReason } : {}),
      ...(c.worker?.model ? { model: c.worker.model } : {}),
      ...(c.worker?.runtime ? { runtime: c.worker.runtime } : {}),
      ...(c.providerId ? { pool: c.providerId } : {}),
      ...(ctx !== undefined ? { contextWindow: ctx } : {}),
      ...(c.worker?.price ? { price: c.worker.price } : {}),
      ...(briefEstTokens !== undefined && ctx !== undefined ? { fitsContext: briefEstTokens <= ctx } : {}),
    };
  });
  const wouldRun = plan.candidates.find((c) => c.available)?.workerId;
  const selector = plan.tierName !== undefined
    ? `tier "${plan.tierName}"`
    : `worker "${plan.candidates[0]?.workerId ?? '?'}"`;
  return {
    selector,
    fallback: plan.fallback,
    ...(briefChars !== undefined ? { briefChars } : {}),
    ...(briefEstTokens !== undefined ? { briefEstTokens } : {}),
    candidates,
    ...(wouldRun ? { wouldRunWorkerId: wouldRun } : {}),
  };
}
