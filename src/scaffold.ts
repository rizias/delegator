import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { configHome, globalConfigPath, projectsRoot, runtimesConfigPath, secretsPath, ensureDir } from './paths.js';

// ---------- providers.yaml scaffold ----------

/** What `dlg init` writes: an EMPTY, vendor-neutral skeleton — operational
 *  defaults + privacy + a commented provider example, but no live providers and
 *  no pinned default model. Runtime descriptors are seeded separately in
 *  runtimes.yaml from the packaged defaults. See examples/providers.example.yaml for a
 *  fully populated recipe. */
export function minimalProvidersYaml(): string {
  return `# delegator provider registry - YOUR config. Full reference: docs/CONFIG.md
#
# Shape:
#   provider = where requests go (endpoint, auth type, model list).
#   model    = one model id declared under exactly one provider entry.
#   handle   = provider/model, for example anthropic/claude-opus-4-8.
#   runtime  = what launches the work; inferred from protocol/auth or defaultRuntime.
#
# This is an EMPTY registry on purpose. No providers and no default model are
# shipped — a new user may have none of the providers someone else picked, so the
# file would be dead on arrival. Add your own below, or let your agent draft it
# via discovery (dlg doctor + dlg models).
#
# API keys do NOT belong here. Put key values in ~/.delegator/secrets.yaml.
# keyEnv is only the NAME of an environment variable, not the key value.
#
# Per-model fallback is tried only when the selected model cannot run because the
# provider/key/runtime is unavailable. The fallback can point to another provider.
# dlg init also creates ~/.delegator/runtimes.yaml with editable launch commands.

version: 1                  # schema version; keep 1

defaults:
  # No default model is pinned: a bare "dlg" run with no providers yet will tell
  # you to add one. Set "model: provider/model" here once you declare a provider.
  policy: review            # auto | review | plan-first; review means inspect before apply
  isolation: worktree        # current isolation mode; runs in a separate git worktree
  budget:
    wallClock: 15m           # the run budget — the only limit you normally set; the worker stops at this time.
                             # (A high runaway backstop on model turns applies automatically; you don't tune it.)
  checkpointSeconds: 90      # progress check interval
  stallSeconds: 300          # stop if progress is stale this long
  silenceKillSeconds: 600    # stop if the worker prints nothing this long
  keepRuns: 30               # finished-run receipts (envelope + patch.diff + logs) kept per project; light, KB each
  worktreeRetention: keep-unfinished  # fate of a run's heavy git checkout (often 100s of MB); patch.diff is kept either way:
                             #   keep-unfinished  drop at once for completed runs, KEEP for killed/failed so their work is recoverable (default)
                             #   on-finish        always drop the checkout when the run ends
                             #   keep             never auto-drop (only keepRuns retention prunes it)
  queueTimeoutSeconds: 1800  # max wait for a provider/concurrency slot
  queuePollSeconds: 3        # how often a queued run checks for a free slot
  retries:
    rateLimit: 3             # retries for 429/rate-limit responses
    server: 2                # retries for 5xx/network failures
  breaker:
    failures: 3              # hard failures before this provider is treated as down
    cooldown: 10m            # wait before probing a failed provider again
  keyCooldown: 15m           # park a failed key from a key pool for this long

privacy:
  sensitivePaths:            # touching these paths forces manual review
    - "**/.github/workflows/**"  # CI can change what "tests pass" means
    - "**/package.json"          # dependency/script manifest
    - "**/pom.xml"               # dependency/script manifest
    - "**/*.lock"                # dependency lockfiles

providers: {}
  # example — delete and replace with YOUR providers; your agent fills this via
  # discovery (dlg doctor + dlg models). This is a comment-only template. To
  # activate it: delete the {} on the line above, then uncomment the block.
  #
  # my-openai:                            # provider id; one entry per endpoint/subscription
  #   protocol: openai                    # anthropic | openai | opencode | none (the API dialect)
  #   auth: api-key                       # api-key | subscription | none (how the worker logs in)
  #   baseUrl: https://api.openai.com/v1  # OpenAI-compatible endpoints only (not anthropic/opencode)
  #   keyEnv: OPENAI_API_KEY              # NAME of the env var holding the key (NOT the value);
  #                                       # key VALUES live in ~/.delegator/secrets.yaml
  #   maxConcurrent: 2                    # optional: cap simultaneous runs for this provider
  #   models:
  #     gpt-5.5:                          # one model id declared under exactly one provider
  #       contextWindow: 128000           # optional: token budget the runner plans against
  #       reasoningEffort:                # optional: provider/model reasoning effort
  #         levels: [low, medium, high]
  #         default: medium
  #       fallback: local/gpt-5.5         # optional: try this provider/model if this one can't run
  #
  # Codex worker:  protocol: openai + auth: subscription + defaultRuntime: codex
  #   (openai+subscription also matches the 'pi' runtime, so pin defaultRuntime).
  #   Codex speaks ONLY the OpenAI Responses API: a Chat-Completions-only provider (z.ai/GLM, etc.)
  #   CANNOT run through the codex runtime — use protocol: anthropic (claude runtime) or an openai
  #   api-key provider (api runtime) for those.
  #
  # Fuller annotated recipe with more providers: examples/providers.example.yaml
`;
}

/** Same empty skeleton `dlg init` writes. For a fully populated, annotated
 *  recipe see examples/providers.example.yaml (kept as an opt-in sample, not the default). */
export function defaultProvidersYaml(): string {
  return minimalProvidersYaml();
}

// ---------- defaultSecretsYaml ----------
// Primary way to add keys: open this file and edit it (cross-platform, no shell).
// `dlg key set/add` remain as a convenience for CI/scripts.

export function defaultSecretsYaml(): string {
  return `# delegator secrets - API keys by PROVIDER id (matches providers.yaml).
# EDIT THIS FILE BY HAND: uncomment a line and paste your key. That is the
# normal flow. (CLI alternative: echo <KEY> | dlg key set <provider>.)
#
# Agents/LLMs must NEVER read this file. It is git-ignored and chmod 600.
# Keys are mapped by provider id - the SAME key serves every worker on that provider.

# --- one key per provider (the common case) ---
# openai: "your-openai-key"

# --- key POOL: a YAML list. Runs rotate round-robin through it.
# ANY provider may use a pool.
# openai:
#   - "sk-...key-1"
#   - "sk-...key-2"
`;
}

// ---------- initConfigHome ----------

export function initConfigHome(): {
  created: boolean;
  path: string;
  runtimesCreated: boolean;
  runtimesPath: string;
  secretsCreated: boolean;
  secretsPath: string;
} {
  ensureDir(configHome());
  ensureDir(projectsRoot());

  const yamlPath = globalConfigPath();
  let created = false;
  if (!fs.existsSync(yamlPath)) {
    fs.writeFileSync(yamlPath, minimalProvidersYaml(), 'utf8');
    if (process.platform !== 'win32') fs.chmodSync(yamlPath, 0o600);
    created = true;
  }

  const rtPath = runtimesConfigPath();
  let runtimesCreated = false;
  if (!fs.existsSync(rtPath)) {
    const defaults = fs.readFileSync(new URL('../runtimes.default.yaml', import.meta.url), 'utf8');
    fs.writeFileSync(rtPath, defaults, 'utf8');
    if (process.platform !== 'win32') fs.chmodSync(rtPath, 0o600);
    runtimesCreated = true;
  }

  // Always (re)write a reference example next to the real file, so the format is
  // visible even when secrets.yaml already exists from an older version.
  const examplePath = path.join(configHome(), 'secrets.example.yaml');
  fs.writeFileSync(examplePath, defaultSecretsYaml(), 'utf8');

  const sPath = secretsPath();
  let secretsCreated = false;
  if (!fs.existsSync(sPath)) {
    fs.writeFileSync(sPath, defaultSecretsYaml(), 'utf8');
    if (process.platform !== 'win32') fs.chmodSync(sPath, 0o600);
    secretsCreated = true;
  }

  return { created, path: yamlPath, runtimesCreated, runtimesPath: rtPath, secretsCreated, secretsPath: sPath };
}

// ---------- initProject ----------

export function initProject(cwd: string): { excluded: boolean } {
  // Check if .git exists (directory or file — worktrees use a .git file)
  const gitEntry = path.join(cwd, '.git');
  let isGitRepo = false;
  try {
    fs.accessSync(gitEntry);
    isGitRepo = true;
  } catch {
    isGitRepo = false;
  }

  if (!isGitRepo) {
    return { excluded: false };
  }

  // Resolve git common dir (handles worktrees)
  const result = spawnSync(
    'git',
    ['rev-parse', '--git-common-dir'],
    { cwd, encoding: 'utf8' },
  );

  if (result.status !== 0) {
    return { excluded: false };
  }

  const gitCommonDir = result.stdout.trim();
  if (!gitCommonDir) {
    return { excluded: false };
  }

  // Resolve absolute path (git may return relative)
  const resolvedCommonDir = path.isAbsolute(gitCommonDir)
    ? gitCommonDir
    : path.resolve(cwd, gitCommonDir);

  const infoDir = path.join(resolvedCommonDir, 'info');
  const excludeFile = path.join(infoDir, 'exclude');

  const marker = '.delegator/';

  // Read existing exclude content
  let existing = '';
  try {
    existing = fs.readFileSync(excludeFile, 'utf8');
  } catch {
    // File doesn't exist yet — will create
  }

  // Only append if the entry isn't already present
  const lines = existing.split('\n');
  const alreadyPresent = lines.some((l) => l.trim() === marker);

  if (!alreadyPresent) {
    try {
      ensureDir(infoDir);
      const toWrite = existing.length > 0 && !existing.endsWith('\n')
        ? `${existing}\n${marker}\n`
        : `${existing}${marker}\n`;
      fs.writeFileSync(excludeFile, toWrite, 'utf8');
    } catch {
      // Best-effort — don't throw
      return { excluded: false };
    }
  }

  return { excluded: true };
}
