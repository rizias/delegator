// Core contracts. Everything else implements against this file.
// Mirrors docs/ARCHITECTURE.md §3–5.

export type TerminalStatus =
  | 'completed'
  | 'partial'
  | 'requires-review'
  | 'failed'
  | 'killed-timeout'
  | 'killed-no-progress'
  | 'rejected';

export type RunState =
  | 'queued'
  | 'preparing'
  | 'running'
  | 'collecting'
  | 'verifying'
  | 'awaiting-approval'
  | 'done';

export type Policy = 'auto' | 'review' | 'plan-first';
export type RuntimeId = 'claude' | 'codex' | 'opencode' | 'pi' | 'api' | (string & {});
export type ProviderProtocol = 'anthropic' | 'openai' | 'opencode' | 'none';
export type ProviderAuth = 'api-key' | 'subscription' | 'none';

// ---------- config (providers.yaml / .delegator.yaml) ----------

export interface BudgetSpec {
  wallClockMs: number;
}

export interface ProviderConfig {
  kind: 'anthropic' | 'anthropic-compatible' | 'openai-compatible' | 'codex-cli' | 'opencode';
  disabled?: true;
  protocol?: ProviderProtocol;
  auth?: ProviderAuth;
  baseUrl?: string;
  apiKey?: string;     // inline secret — migrated out to secrets.yaml on load
  apiKeyEnv?: string;  // env var name holding the key; YAML keyEnv is normalized here
  defaultRuntime?: string;
  models?: Record<string, ModelConfig>;
  modelCatalog?: ModelCatalogDescriptor;
  rateLimit?: { rps: number };
  maxConcurrent?: number;      // simultaneous runs allowed; runs beyond it QUEUE
  concurrencyGroup?: string;   // providers sharing a group share one limit (e.g. "local-gpu")
  quota?: Record<string, unknown>;
  notes?: string;
}

export interface WorkerCard {
  goodFor?: string[];
  avoidFor?: string[];
  notes?: string;
}

export type ReasoningEffort = string;

export type RuntimeMode = 'command' | 'direct-api';
export type RuntimeArg = string | string[];

export interface RuntimePromptDescriptor {
  mode: 'stdin' | 'argv-last' | 'file';
}

export interface RuntimeRequestDescriptor {
  method: string;
  path: string;
  headers?: Record<string, string>;
  json?: unknown;
  output?: RuntimeOutputDescriptor;
}

export interface RuntimeOutputDescriptor {
  parser: string;
  itemsPath?: string;
  idPath?: string;
}

export interface RuntimeDescriptor {
  mode?: RuntimeMode;
  command?: string;
  protocol?: ProviderProtocol;
  auth?: ProviderAuth | ProviderAuth[];
  prompt?: RuntimePromptDescriptor;
  args?: RuntimeArg[];
  env?: Record<string, string>;
  request?: RuntimeRequestDescriptor;
  output?: RuntimeOutputDescriptor;
  equipment?: Record<string, unknown>;
  parser?: string;
  effortLevels?: { levels: string[]; default?: string };
  /** Host env name-prefixes this runtime's CLI uses for its OWN subscription login. Preserved past
   *  workerEnv's credential denylist ONLY when the worker's provider auth is `subscription`. */
  authEnv?: string[];
}

export interface ModelCatalogDescriptor {
  mode?: RuntimeMode;
  command?: string;
  args?: RuntimeArg[];
  method?: string;
  path?: string;
  output?: RuntimeOutputDescriptor;
  [key: string]: unknown;
}

export interface ModelConfig {
  disabled?: true;
  card?: WorkerCard;
  budget?: Partial<BudgetSpec>;
  fallback?: string | string[];
  limits?: { concurrent?: number };
  tools?: string[];
  reasoningEffort?: string | { levels: string[]; default?: string };
  contextWindow?: number;
  price?: { inPerMtok?: number; outPerMtok?: number };
}

export interface Equipment {
  profile?: 'inherit' | 'clean';
  skills?: string[];
  mcp?: string[];
  tools?: string[];
}

export interface WorkerConfig {
  provider: string;
  model?: string;
  /** How hard a reasoning model thinks — a typed field so the config reads clearly,
   *  instead of burying `-c model_reasoning_effort="high"` in extraArgs. The runtime maps
   *  it to the tool's own flag (codex: `-c model_reasoning_effort`); runtimes without a
   *  reasoning knob ignore it. */
  reasoningEffort?: string;
  /** The reasoning levels this worker accepts, ordered WEAKEST → STRONGEST (contract). The council's
   *  `highest` effort intent resolves to the last entry, so keep custom lists in ascending strength. */
  reasoningEffortLevels?: string[];
  runtime: RuntimeId;  // filled in by loadConfig from the provider's kind when omitted in YAML
  budget?: Partial<BudgetSpec>;
  fallback?: string | string[];
  limits?: { concurrent?: number };
  tools?: string[];
  card?: WorkerCard;
  contextWindow?: number;                              // tokens, surfaced via discovery
  price?: { inPerMtok?: number; outPerMtok?: number }; // USD per Mtok, surfaced via discovery
  extraArgs?: string[]; // appended verbatim to the runtime argv (e.g. codex -c model_reasoning_effort="low")
  equip?: Equipment;
}

export interface WorkerProfile extends WorkerConfig {}

export interface TierConfig {
  chain: string[];               // ordered worker ids
  fallback: 'auto' | 'report';
  tools?: string[];              // allowed tools for claude-headless workers
  budget?: Partial<BudgetSpec>;
}

export interface VerifyCommand {
  command: string;               // shared form
  win?: string;                  // platform overrides
  posix?: string;
}

export interface VerifySpec {
  build?: string | VerifyCommand;
  test?: string | VerifyCommand;
  lint?: string | VerifyCommand;
  timeoutMs?: number;
  shell?: string;
}

export interface DelegatorConfig {
  version: 1;
  defaults: {
    policy: Policy;
    budget: BudgetSpec;
    model?: string;
    tools?: string[];
    checkpointSeconds: number;
    stallSeconds: number;        // heartbeat staleness threshold (combined with diff hash)
    silenceKillSeconds: number;  // hard kill when the worker emits nothing at all this long
    keepRuns: number;            // retention: finished runs kept per project, oldest pruned
    /** When to delete a run's heavy git checkout. patch.diff is persisted regardless, so
     *  `dlg apply <id>` works whether or not the worktree survives.
     *  keep-unfinished (default): drop it for completed runs, keep it for killed/failed (recoverable).
     *  on-finish: always drop when the run ends. keep: never auto-drop (only keepRuns prunes it). */
    worktreeRetention: 'keep-unfinished' | 'on-finish' | 'keep';
    queueTimeoutSeconds: number; // how long a run waits for a concurrency slot before giving up
    queuePollSeconds: number;    // how often a queued run re-checks for a free slot
    autoApply: { maxFiles: number; maxLines: number };
    /** Bounded retries for transient provider failures within one worker attempt (ARCHITECTURE §5). */
    retries: { rateLimit: number; server: number };
    /** Per-worker circuit breaker: open after N consecutive hard failures. */
    breaker: { failures: number; cooldownMs: number };
    /** Per-key cooldown: how long a pool key is parked after a 429/auth. */
    keyCooldownMs: number;
  };
  privacy: {
    sensitivePaths: string[];
  };
  providers: Record<string, ProviderConfig>;
  workers: Record<string, WorkerConfig>;
  tiers: Record<string, TierConfig>;
  runtimes?: Record<string, RuntimeDescriptor>;
  verify?: VerifySpec;           // usually set in project-level .delegator.yaml
  restrict?: RestrictSpec;       // per-project allow-list (usually in .delegator.yaml)
  /** Non-fatal load diagnostics (e.g. identity-drift). Derived, not from YAML; surfaced
   *  by config-inspection commands (providers/doctor), never on the hot path. */
  warnings?: string[];
}

/** Project-level cap on what the Brain may use here. Allow-lists; empty/absent = no cap. */
export interface RestrictSpec {
  workers?: string[];            // only these worker ids are usable
  tiers?: string[];              // only these tier names are usable
}

// ---------- discovery ----------

export type WorkerStatus = 'available' | 'degraded' | 'unavailable' | 'unconfigured' | 'restricted' | 'disabled';

export interface WorkerInfo {
  id: string;
  status: WorkerStatus;
  reason?: string;               // why unconfigured/unavailable
  provider: string;
  model?: string;
  runtime: RuntimeId;
  tierMembership: string[];
  card?: WorkerCard;
  contextWindow?: number;
  price?: { inPerMtok?: number; outPerMtok?: number };
  canonicalHandle?: string;
}

// ---------- runs ----------

export interface RunRequest {
  workerId?: string;             // exactly one of workerId | tier
  tier?: string;
  brief: string;
  cwd: string;                   // project root (must be a git repo)
  policy: Policy;
  budget: BudgetSpec;
  tools?: string[];
}

export interface ResolvedWorker {
  workerId: string;
  worker: WorkerConfig;
  provider: ProviderConfig;
  providerId: string;
  apiKey?: string;               // resolved secret value (never persisted)
}

export interface RunMeta {
  id: string;                    // dlg_<8 hex>
  createdAt: string;             // ISO
  state: RunState;
  request: Omit<RunRequest, 'brief'>; // brief stored separately as brief.md
  workerId: string;
  providerId: string;
  model?: string;
  runtime: RuntimeId;
  worktree: string;
  baseCommit: string;
  pid?: number;                  // worker child process (spawn runtimes), set when the run reaches `running`
  ownerPid?: number;             // the delegator process that owns this run, stamped at creation — a run whose
                                 // ownerPid is no longer alive while still non-terminal is an orphan (reaped on listing)
  endedAt?: string;
}

export interface WorkerEvent {
  ts: number;                    // epoch ms
  stream: 'stdout' | 'stderr' | 'system';
  kind: 'output' | 'turn' | 'usage' | 'result' | 'error' | 'noise';
  raw: string;                   // original line (may be truncated to 4000 chars)
  /** Full text extracted from the line at parse time (e.g. an assistant message). `raw`
   *  is truncated for the log, so the summary reads this instead of re-parsing a clipped
   *  line and silently losing a long final message. */
  text?: string;
  /** The line was fabricated LOCALLY by the worker CLI (e.g. claude's `<synthetic>` notices) and
   *  never reached the provider — it carries no provider verdict, so failure classification must
   *  skip it (a stray "unauthorized" in such a notice must not trip the auth breaker). */
  synthetic?: boolean;
  /** file_change paths extracted from the FULL line at parse time. `raw` is truncated for the
   *  log, so the sandbox-escape check reads these instead of re-parsing a clipped line — a long
   *  file_change would otherwise re-parse to [] and FALSELY report the run as confined. */
  filePaths?: string[];
  tokens?: TokenUsage;
  /** The `result` field of a claude `result` line — the authoritative final answer — captured
   *  from the FULL line at parse time. `raw` is truncated for the log, so the summary reads this
   *  instead of re-parsing a clipped line and silently dropping a long final answer. */
  resultText?: string;
  /** Error diagnostics from a claude `result` line (`is_error`/`subtype`/`errors`), captured from
   *  the FULL line. Same reason as resultText: on a truncated raw, re-parsing loses the diagnosis. */
  isError?: boolean;
  subtype?: string;
  errors?: string[];
  /** Iteration/turn count reported inline on a terminal event (claude's `num_turns`), captured from
   *  the FULL line so finalUsage need not re-parse a truncated raw and lose the count. */
  iterations?: number;
}

export interface TokenUsage {
  input?: number;
  output?: number;
  reasoning?: number;
  total?: number;
}

export interface CouncilModelRef {
  handle: string;
  reasoningEffort?: string;
}

/** Per-invocation council options. There is NO council config file: the caller (normally the
 *  orchestrator) picks the models for THIS task from the one shared provider pool
 *  (providers.yaml, using each model's card.goodFor), and passes them here. */
export interface CouncilOptions {
  models: CouncilModelRef[];   // >= 2 different models, handles from the shared provider pool
  budget?: string;             // wall-clock per worker, same format as `dlg run --budget`
  minProposers: number;        // quorum: fewer completed answers -> quorumMet=false, degraded
  maxRetriesPerWorker: number; // retries on the SAME model only; never substitutes another model
}

export interface CouncilCandidate {
  workerId: string;
  /** Underlying dlg run id — provenance for `dlg logs/result <id>`. Absent when the worker never produced an envelope. */
  runId?: string;
  status: TerminalStatus;
  answer: string;
  diff?: string;
  filesTouched: string[];
  tokens?: TokenUsage;
  reasoningUnavailable?: boolean;
  attempts: number;
  durationMs: number;
}

export interface CouncilEnvelope {
  kind: 'council';
  councilId: string;
  candidates: CouncilCandidate[];
  bundle: string;
  /** headless --aggregate only */
  final?: {
    answer: string;
    workerId: string;
    tokens?: TokenUsage;
  };
  usage: {
    inputTokens: number;
    outputTokens: number;
    reasoningTokens: number;
    totalTokens: number;
    calls: number;
    wallClockMs: number;
  };
  lowSignal: boolean;
  quorumMet: boolean;
  stopReason: 'completed' | 'degraded';
  warnings: string[];
}

export type CmdStatus = 'passed' | 'failed' | 'skipped';

export interface CmdResult {
  status: CmdStatus;
  exitCode?: number;
  outputTail?: string;           // last ~2000 chars
  durationMs?: number;
}

export interface VerificationResult {
  build: CmdResult;
  test: CmdResult;
  lint: CmdResult;
}

export interface ErrorEntry {
  type:
    | 'unconfigured' | 'auth' | 'rate-limit' | 'server' | 'cli-missing'
    | 'worker-crash' | 'timeout' | 'no-progress'
    | 'verification-failed' | 'patch-conflict' | 'brief-invalid'
    | 'isolation-unverified' | 'judge-tampered' | 'internal';
  message: string;
  detail?: string;
}

/** One worker's part in a run. For a single-worker run there is one `ran` entry
 *  (and `attempts` is usually omitted). For a tier with fallback, the chain is
 *  recorded: which workers were skipped, which failed over, and which finally ran
 *  — silent substitution is forbidden (ARCHITECTURE §5). */
export interface AttemptRecord {
  workerId: string;
  model?: string;
  outcome: 'ran' | 'failed-over' | 'skipped';
  status?: TerminalStatus;       // for ran / failed-over
  errType?: ErrorEntry['type'];
  reason?: string;               // skip reason or short failure diagnosis
}

export interface Envelope {
  envelopeVersion: 1;
  runId: string;
  status: TerminalStatus;
  workerId: string;              // the worker that actually produced this result
  model?: string;
  runtime: RuntimeId;
  summary: string;               // worker's final message (tail) or stop diagnosis
  changes: {
    diffStat: string;
    filesTouched: string[];
    patchFile?: string;          // absolute path to patch.diff (present when diff non-empty)
    applied: boolean;
    baseCommit?: string;         // HEAD the run's worktree was branched from — run identity
    patchSha256?: string;        // SHA-256 of the exact patch bytes — tamper/identity check
  };
  verification: VerificationResult;
  usage: {
    wallClockMs: number;
    iterations?: number;
    tokens?: TokenUsage;
    /** The wall-clock limit this run was bounded by. */
    budget?: { wallClockMs: number };
  };
  stopReason: string;
  errors: ErrorEntry[];
  logsPath: string;              // events.jsonl
  worktree?: string;             // kept for non-completed runs
  /** The fallback chain, when more than one worker was in play (tier runs). */
  attempts?: AttemptRecord[];
}

// ---------- runtime adapter contract (ARCHITECTURE §3.4) ----------

export interface SpawnSpec {
  command: string;               // binary name, resolved on PATH by proc layer
  args: string[];
  env: Record<string, string>;   // ADDITIONS to process env (never replaces it)
  cwd: string;                   // the worktree
  /** Written to the worker's stdin then closed. Multiline briefs travel here —
   *  argv cannot carry newlines through Windows .cmd shims. */
  stdinData?: string;
  /** Host env var name-prefixes to PRESERVE even if they look like a credential. A
   *  subscription runtime authenticates through its CLI's own login, which lives in host env
   *  vars in this runtime's namespace (the ANTHROPIC and CLAUDE prefixes for `claude`); those
   *  are this worker's OWN credential, not an unrelated host secret, so must not be stripped. */
  preserveEnv?: string[];
}

export interface RuntimeContext {
  brief: string;
  worktree: string;
  resolved: ResolvedWorker;
  tier?: TierConfig;
  budget: BudgetSpec;
  toolsOverride?: string[];
  defaultsTools?: string[];
}

export interface WorkerRuntimeAdapter {
  id: RuntimeId;
  binary: string;                                    // e.g. 'claude', 'codex'
  buildSpawn(ctx: RuntimeContext): SpawnSpec;
  parseLine(line: string, stream: 'stdout' | 'stderr'): WorkerEvent;
  /** Extract the worker's final summary after exit. stdoutTail = last ~8000 chars. */
  finalSummary(stdoutTail: string, events: WorkerEvent[]): string;
  /** Extract aggregate token usage if the runtime reports it. */
  finalUsage(events: WorkerEvent[]): { tokens?: TokenUsage; iterations?: number };
  /** Reinterpret a non-zero exit when the runtime knows better. */
  classifyExit?(exitCode: number | null, events: WorkerEvent[]):
    { status: 'partial'; stopReason: string; errType: 'timeout' } | null;
  /** Pre-spawn environment gate (fail-closed). Return non-null to SKIP this worker
   *  before any worktree/slot is created — e.g. codex below the version whose OS
   *  sandbox delegator has verified confines writes to the worktree. */
  preflight?(): { errType: ErrorEntry['type']; reason: string } | null;
  /** Post-run isolation signal read from the worker's structured output.
   *  `confined:false` → an escape was observed and the run is failed closed. */
  assessSandbox?(events: WorkerEvent[], worktree: string): { confined: boolean; detail?: string } | null;
}

// ---------- in-process runtime contract (api-oneshot / ARCHITECTURE §3.4) ----------
// A NON-AGENTIC runtime: one HTTP POST to an OpenAI Chat Completions endpoint, return
// the text. No spawned process, no worktree, no patch, no tool loop. The runner takes
// a MINIMAL in-process branch for these (it still reuses the concurrency slot, breaker
// feedback, and key-cooldown behavior unchanged) — a generation run simply has no diff.

/** A provider-class failure an in-process call can surface (mirrors classify.ts classes).
 *  Drives fallover + the breaker; `null` means success or a non-provider error. */
export interface InProcessFailure {
  class: 'rate-limit' | 'auth' | 'server';
  errType: 'rate-limit' | 'auth' | 'server';
  reason: string;
  evidence?: string;
  retryAfterMs?: number;
}

/** The outcome of one in-process call. */
export interface InProcessResult {
  status: 'completed' | 'failed';
  /** The model's reply (completed) or a clear diagnosis (failed). */
  summary: string;
  stopReason: string;
  tokens?: TokenUsage;
  /** ErrorEntry type to record when status === 'failed' (irrelevant when completed). */
  errType: ErrorEntry['type'];
  /** Provider-class failure → fallover + breaker; null = success or non-provider error. */
  failure: InProcessFailure | null;
}

/** A runtime that runs IN-PROCESS rather than by spawning a worker. */
export interface InProcessRuntime {
  id: RuntimeId;
  /** One call. `fetchImpl` is injectable so tests never need a live server; `timeoutMs`
   *  bounds the request (the runner passes the run's wall-clock budget). */
  execute(
    ctx: RuntimeContext,
    opts: { timeoutMs: number; fetchImpl?: typeof fetch },
  ): Promise<InProcessResult>;
}

/** Any runtime the runner can dispatch: a spawn-based adapter OR an in-process one. */
export type AnyRuntime = WorkerRuntimeAdapter | InProcessRuntime;
