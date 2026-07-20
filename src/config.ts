import fs from 'node:fs';
import path from 'node:path';
import { isAlias, isMap, isScalar, isSeq, parse as parseYaml, parseDocument } from 'yaml';
import { z } from 'zod';
import type {
  DelegatorConfig,
  ProviderConfig,
  WorkerConfig,
  TierConfig,
  VerifySpec,
  BudgetSpec,
  RuntimeId,
  RuntimeDescriptor,
  ProviderProtocol,
  ProviderAuth,
  ModelConfig,
} from './types.js';
import { configHome, ensureDir, globalConfigPath, projectConfigPath, runtimesConfigPath, secretsPath } from './paths.js';
import { mutateState } from './state.js';
import { activeParkedHashes, hashKey } from './keycooldown.js';

export const RUNTIME_ALIASES: Record<string, RuntimeId> = {
  'claude-headless': 'claude',
  'codex-exec': 'codex',
  'opencode-run': 'opencode',
  'api-oneshot': 'api',
};

export function normalizeRuntimeId(id: string): string {
  return RUNTIME_ALIASES[id] ?? id;
}

// ---------- ConfigError ----------

export class ConfigError extends Error {
  hint?: string;
  constructor(message: string, hint?: string) {
    super(message);
    this.name = 'ConfigError';
    this.hint = hint;
  }
}

/** The mapping pair whose scalar key equals `key`, or undefined. */
function findMapPair(map: { items: Array<{ key: unknown; value: unknown }> }, key: string): { key: unknown; value: unknown } | undefined {
  return map.items.find((p) => isScalar(p.key) && (p.key as { value: unknown }).value === key);
}

/** The whitespace indentation of the source line that contains `offset`. */
function indentAt(source: string, offset: number): string {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1;
  let i = lineStart;
  while (i < source.length && source[i] === ' ') i += 1;
  return source.slice(lineStart, i);
}

/**
 * Add or remove exactly one `disabled: true` entry on `targetMap`, editing the ORIGINAL source
 * string in place (via parsed node ranges) so every OTHER byte of the hand-maintained file is
 * preserved. `parentMap`/`key` locate the target's own key line (to place a new block entry).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toggleDisabledEntry(source: string, parentMap: any, key: string, targetMap: any, disabled: boolean): string {
  const existing = findMapPair(targetMap, 'disabled') as any;

  if (disabled) {
    if (existing) {
      if (isScalar(existing.value) && existing.value.value === true) return source; // already parked
      const [vs, ve] = existing.value.range;
      return `${source.slice(0, vs)}true${source.slice(ve)}`; // normalise a hand-written `disabled: <other>`
    }
    if (targetMap.flow) {
      if (targetMap.items.length === 0) {
        return `${source.slice(0, targetMap.range[0])}{ disabled: true }${source.slice(targetMap.range[1])}`;
      }
      const open = targetMap.range[0];
      const at = source[open + 1] === ' ' ? open + 2 : open + 1;
      return `${source.slice(0, at)}disabled: true, ${source.slice(at)}`;
    }
    // Block mapping: insert `disabled: true` as the first child, right after the target key line.
    const pair = findMapPair(parentMap, key) as any;
    const nl = source.indexOf('\n', pair.key.range[1]);
    const at = nl === -1 ? source.length : nl + 1;
    const childIndent = targetMap.items.length
      ? indentAt(source, targetMap.items[0].key.range[0])
      : `${indentAt(source, pair.key.range[0])}  `;
    const prefix = nl === -1 ? '\n' : '';
    return `${source.slice(0, at)}${prefix}${childIndent}disabled: true\n${source.slice(at)}`;
  }

  // Enable: remove the `disabled` entry if present, otherwise leave the file untouched.
  if (!existing) return source;
  if (targetMap.flow) {
    if (targetMap.items.length === 1) {
      return `${source.slice(0, targetMap.range[0])}{}${source.slice(targetMap.range[1])}`;
    }
    let start = existing.key.range[0];
    let end = existing.value ? existing.value.range[1] : existing.key.range[1];
    const fwd = source.slice(end).match(/^\s*,\s*/);
    const bwd = source.slice(0, start).match(/,\s*$/);
    if (fwd) end += fwd[0].length;
    else if (bwd) start -= bwd[0].length;
    return source.slice(0, start) + source.slice(end);
  }
  const lineStart = source.lastIndexOf('\n', existing.key.range[0] - 1) + 1;
  const valueEnd = existing.value ? existing.value.range[1] : existing.key.range[1];
  const nl = source.indexOf('\n', valueEnd);
  const removeEnd = nl === -1 ? source.length : nl + 1;
  return source.slice(0, lineStart) + source.slice(removeEnd);
}

/** Park or revive one existing provider/model without rebuilding hand-maintained YAML. */
export function updateProviderDisabled(providerId: string, modelId: string | undefined, disabled: boolean): string {
  const file = globalConfigPath();
  let source: string;
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(`Cannot read ${file}: ${(e as Error).message}`);
  }

  const doc = parseDocument(source, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    throw new ConfigError(`${file} is not valid unambiguous YAML; refusing to write: ${doc.errors.map((e) => e.message).join('; ')}`);
  }

  const providers = doc.get('providers', true);
  if (isAlias(providers)) throw new ConfigError('providers mapping is an alias; refusing an ambiguous target');
  if (!isMap(providers)) throw new ConfigError(`${file} has no providers mapping`);

  const providerPath = ['providers', providerId];
  const provider = doc.getIn(providerPath, true);
  if (provider === undefined) throw new ConfigError(`provider "${providerId}" does not exist in ${file}`);
  if (isAlias(provider)) throw new ConfigError(`provider "${providerId}" is an alias; refusing an ambiguous target`);
  if (!isMap(provider)) throw new ConfigError(`provider "${providerId}" is not a mapping; refusing to write`);

  let edited: string;

  if (modelId === undefined) {
    edited = toggleDisabledEntry(source, providers, providerId, provider, disabled);
  } else {
    const modelsPath = [...providerPath, 'models'];
    const models = doc.getIn(modelsPath, true);
    if (models === undefined) throw new ConfigError(`model "${modelId}" does not exist under provider "${providerId}"`);
    if (isAlias(models)) throw new ConfigError(`models for provider "${providerId}" is an alias; refusing an ambiguous target`);

    if (isSeq(models)) {
      const sequence = models;
      // Enable only needs the TARGET to exist as a plain scalar id — it rewrites nothing, so an
      // unrelated alias or non-scalar entry elsewhere in the list is irrelevant and must not make it
      // fail. This still rejects `enable p <typo>` (a false success before), without over-rejecting.
      if (!disabled) {
        const targetHits = sequence.items.filter((item) => isScalar(item) && (item as { value: unknown }).value === modelId).length;
        if (targetHits !== 1) {
          throw new ConfigError(`model "${modelId}" does not exist uniquely under provider "${providerId}"`);
        }
        return file; // a shorthand list carries no per-model fields → nothing is disabled → validated no-op
      }
      // Disable converts the whole `[a, b]` list into a mapping — the one reflow path — so the ENTIRE
      // list must be unambiguous (plain scalar ids, no aliases) before we rewrite it. Convert via the
      // AST (carrying comments) and re-serialize.
      if (sequence.items.some(isAlias)) throw new ConfigError(`models for provider "${providerId}" contains an alias; refusing an ambiguous target`);
      if (!sequence.items.every((item) => isScalar(item) && typeof item.value === 'string')) {
        throw new ConfigError(`models for provider "${providerId}" is not an unambiguous list of model ids`);
      }
      const ids = sequence.items.map((item) => (item as { value: string }).value);
      if (ids.filter((id) => id === modelId).length !== 1) {
        throw new ConfigError(`model "${modelId}" does not exist uniquely under provider "${providerId}"`);
      }
      const replacement = doc.createNode(Object.fromEntries(ids.map((id) => [id, {}])));
      if (!isMap(replacement)) throw new ConfigError('internal error converting models list');
      replacement.commentBefore = sequence.commentBefore;
      replacement.comment = sequence.comment;
      replacement.spaceBefore = sequence.spaceBefore;
      replacement.items.forEach((pair, index) => {
        const old = sequence.items[index];
        if (isScalar(pair.key) && isScalar(old)) {
          pair.key.commentBefore = old.commentBefore;
          pair.key.comment = old.comment;
          pair.key.spaceBefore = old.spaceBefore;
        }
      });
      doc.setIn(modelsPath, replacement);
      doc.setIn([...modelsPath, modelId, 'disabled'], true);
      edited = doc.toString({ lineWidth: 0 });
    } else if (isMap(models)) {
      const model = doc.getIn([...modelsPath, modelId], true);
      if (model === undefined) throw new ConfigError(`model "${modelId}" does not exist under provider "${providerId}"`);
      if (isAlias(model)) throw new ConfigError(`model "${providerId}/${modelId}" is an alias; refusing an ambiguous target`);
      if (isMap(model)) {
        edited = toggleDisabledEntry(source, models, modelId, model, disabled);
      } else if (isScalar(model) && model.value === null) {
        if (!disabled) return file; // a bare `model:` carries no fields to remove
        const pair = findMapPair(models as any, modelId) as any;
        const nl = source.indexOf('\n', pair.key.range[1]);
        const at = nl === -1 ? source.length : nl + 1;
        const childIndent = `${indentAt(source, pair.key.range[0])}  `;
        const prefix = nl === -1 ? '\n' : '';
        edited = `${source.slice(0, at)}${prefix}${childIndent}disabled: true\n${source.slice(at)}`;
      } else {
        throw new ConfigError(`model "${providerId}/${modelId}" is not a mapping; refusing to write`);
      }
    } else {
      throw new ConfigError(`provider "${providerId}" has no model mapping`);
    }
  }

  if (edited === source) return file; // already in the requested state — leave the file byte-for-byte

  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
  try {
    fs.writeFileSync(tmp, edited, { encoding: 'utf8', flag: 'wx', mode: fs.statSync(file).mode });
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
  return file;
}

// ---------- parseDuration ----------

export function parseDuration(s: string): number {
  if (typeof s !== 'string' || s.trim() === '') {
    throw new ConfigError(`Invalid duration: ${JSON.stringify(s)}`);
  }
  const t = s.trim();
  // plain integer string (ms)
  if (/^\d+$/.test(t)) return Number(t);
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(t);
  if (!m) {
    throw new ConfigError(
      `Invalid duration "${s}": expected e.g. "500ms", "90s", "10m", "2h" or plain integer (ms)`,
    );
  }
  const n = parseFloat(m[1]!);
  switch (m[2]) {
    case 'ms': return Math.round(n);
    case 's':  return Math.round(n * 1_000);
    case 'm':  return Math.round(n * 60_000);
    case 'h':  return Math.round(n * 3_600_000);
  }
  // unreachable
  throw new ConfigError(`Invalid duration "${s}"`);
}

// ---------- Zod helpers ----------

/** Accept a duration string or plain number (ms). Always produces a number. */
const durationSchema = z
  .union([z.string(), z.number()])
  .transform((v, ctx) => {
    let ms: number;
    if (typeof v === 'number') ms = v;
    else {
      try { ms = parseDuration(v); }
      catch (e) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: (e as Error).message }); return z.NEVER; }
    }
    // A numeric duration must satisfy the SAME constraint as the wallClockMs form: a positive
    // integer of milliseconds. Previously `wallClock: 0 / -1 / 1.5` slipped through the numeric branch.
    if (!Number.isInteger(ms) || ms <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duration must be a positive integer of milliseconds, got ${ms}` });
      return z.NEVER;
    }
    return ms;
  });

/** YAML budget block: accept {wallClock: "10m"} OR {wallClockMs: number} */
const budgetInputSchema = z.union([
  z.object({ wallClock: durationSchema }).strict(),
  z.object({ wallClockMs: z.number().int().positive() }).strict(),
]);

function normaliseBudget(raw: z.infer<typeof budgetInputSchema>): { wallClockMs: number } {
  if ('wallClock' in raw) {
    return { wallClockMs: raw.wallClock };
  }
  return { wallClockMs: raw.wallClockMs };
}

// Partial budget — used in worker/tier overrides (both keys optional)
const partialBudgetInputSchema = z.union([
  z.object({ wallClock: durationSchema.optional() }).strict(),
  z.object({ wallClockMs: z.number().int().positive().optional() }).strict(),
]);

function normalisePartialBudget(
  raw: z.infer<typeof partialBudgetInputSchema>,
): Partial<BudgetSpec> {
  if ('wallClock' in raw) {
    const out: Partial<BudgetSpec> = {};
    if (raw.wallClock !== undefined) out.wallClockMs = raw.wallClock;
    return out;
  }
  const r = raw as { wallClockMs?: number };
  const out: Partial<BudgetSpec> = {};
  if (r.wallClockMs !== undefined) out.wallClockMs = r.wallClockMs;
  return out;
}

// ---------- Zod schemas ----------

const ProviderProtocolSchema = z.enum(['anthropic', 'openai', 'opencode', 'none']);
const ProviderAuthSchema = z.enum(['api-key', 'subscription', 'none']);
const RuntimeAuthSchema = z.union([ProviderAuthSchema, z.array(ProviderAuthSchema).min(1)]);

const RuntimeArgSchema = z.union([z.string(), z.array(z.string())]);
const RuntimePromptSchema = z.object({ mode: z.enum(['stdin', 'argv-last', 'file']) }).strict();
const RuntimeOutputSchema = z
  .object({
    parser: z.string(),
    itemsPath: z.string().optional(),
    idPath: z.string().optional(),
  })
  .strict();
const RuntimeRequestSchema = z
  .object({
    method: z.string(),
    path: z.string(),
    headers: z.record(z.string()).optional(),
    json: z.unknown().optional(),
    output: RuntimeOutputSchema.optional(),
  })
  .strict();

const RuntimeEffortLevelsSchema = z
  .object({
    levels: z.array(z.string()).min(1),
    default: z.string().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.default === undefined || v.levels.includes(v.default)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['default'],
      message: `effortLevels.default '${v.default}' is not in levels [${v.levels.join(', ')}]`,
    });
  });

const RuntimeDescriptorSchema = z
  .object({
    mode: z.enum(['command', 'direct-api']).default('command'),
    command: z.string().optional(),
    protocol: ProviderProtocolSchema.optional(),
    auth: RuntimeAuthSchema.optional(),
    prompt: RuntimePromptSchema.optional(),
    args: z.array(RuntimeArgSchema).optional(),
    env: z.record(z.string()).optional(),
    request: RuntimeRequestSchema.optional(),
    output: RuntimeOutputSchema.optional(),
    equipment: z.record(z.unknown()).optional(),
    parser: z.string().optional(),
    effortLevels: RuntimeEffortLevelsSchema.optional(),
    // Host env name-prefixes this runtime's CLI uses for its OWN subscription login (e.g.
    // [ANTHROPIC, CLAUDE] for claude). Preserved past the credential denylist ONLY for
    // auth: subscription workers — so a runtime's own login survives while api-key workers
    // still get the host stripped. See proc.ts workerEnv / SpawnSpec.preserveEnv.
    authEnv: z.array(z.string()).optional(),
  })
  .strict()
  .transform((v) => ({
    ...v,
    output: v.output ?? v.request?.output,
    parser: v.parser ?? v.output?.parser ?? v.request?.output?.parser,
  }));

const RuntimeDescriptorsFileSchema = z
  .object({
    runtimes: z.record(RuntimeDescriptorSchema).optional(),
  })
  .strict();

const ModelCatalogDescriptorSchema = z
  .object({
    mode: z.enum(['command', 'direct-api']).optional(),
    command: z.string().optional(),
    args: z.array(RuntimeArgSchema).optional(),
    method: z.string().optional(),
    path: z.string().optional(),
    output: RuntimeOutputSchema.optional(),
  })
  .passthrough();

const WorkerCardSchema = z
  .object({
    goodFor: z.array(z.string()).optional(),
    avoidFor: z.array(z.string()).optional(),
    notes: z.string().optional(),
  })
  .strict();

const ReasoningEffortSpecSchema = z
  .union([
    z.string(),
    z.object({
      levels: z.array(z.string()).min(1),
      default: z.string().optional(),
    }).strict(),
  ])
  .superRefine((v, ctx) => {
    if (typeof v === 'string' || v.default === undefined || v.levels.includes(v.default)) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['default'],
      message: `reasoningEffort.default '${v.default}' is not in levels [${v.levels.join(', ')}]`,
    });
  });

const ModelConfigSchema = z
  .object({
    disabled: z.literal(true).optional(),
    card: WorkerCardSchema.optional(),
    budget: partialBudgetInputSchema.optional(),
    fallback: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
    limits: z.object({ concurrent: z.number().int().positive().optional() }).strict().optional(),
    tools: z.array(z.string()).optional(),
    reasoningEffort: ReasoningEffortSpecSchema.optional(),
    contextWindow: z.number().int().positive().optional(),
    price: z.object({ inPerMtok: z.number().optional(), outPerMtok: z.number().optional() }).strict().optional(),
  })
  .strict();

// A model entry may be written `glm-5.2: {…}` or bare `glm-5.2:` (null) when it carries no per-model
// config — treat the bare/null form as an empty model config so hand-edited configs don't error.
const ModelEntrySchema = z.preprocess((v) => (v == null ? {} : v), ModelConfigSchema);
const ModelsInputSchema = z.union([z.array(z.string()), z.record(ModelEntrySchema)]);

const ProviderConfigSchema = z
  .object({
    kind: z.enum(['anthropic', 'anthropic-compatible', 'openai-compatible', 'codex-cli', 'opencode']),
    disabled: z.literal(true).optional(),
    protocol: ProviderProtocolSchema.optional(),
    auth: ProviderAuthSchema.optional(),
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    apiKeyEnv: z.string().optional(),
    defaultRuntime: z.string().optional(),
    models: z.record(ModelEntrySchema).optional(),
    modelCatalog: ModelCatalogDescriptorSchema.optional(),
    rateLimit: z.object({ rps: z.number() }).strict().optional(),
    maxConcurrent: z.number().int().nonnegative().optional(),
    concurrencyGroup: z.string().optional(),
    quota: z.record(z.unknown()).optional(),
    notes: z.string().optional(),
  })
  .strict();

const RawProviderCommonShape = {
  disabled: z.literal(true).optional(),
  protocol: ProviderProtocolSchema.optional(),
  auth: ProviderAuthSchema.optional(),
  baseUrl: z.string().optional(),
  apiKey: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  keyEnv: z.string().optional(),
  defaultRuntime: z.string().optional(),
  models: ModelsInputSchema.optional(),
  modelCatalog: ModelCatalogDescriptorSchema.optional(),
  rateLimit: z.object({ rps: z.number() }).strict().optional(),
  maxConcurrent: z.number().int().nonnegative().optional(),
  concurrencyGroup: z.string().optional(),
  quota: z.record(z.unknown()).optional(),
  notes: z.string().optional(),
};

const RawProviderConfigSchema = z
  .object({
    kind: z.enum(['anthropic', 'anthropic-compatible', 'openai-compatible', 'codex-cli', 'opencode']),
    ...RawProviderCommonShape,
  })
  .strict();

const NewProviderConfigSchema = z
  .object(RawProviderCommonShape)
  .strict();

const AnyProviderConfigSchema = z.union([RawProviderConfigSchema, NewProviderConfigSchema]);

const EquipmentSchema = z
  .object({
    profile: z.enum(['inherit', 'clean']).optional(),
    skills: z.array(z.string()).optional(),
    mcp: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
  })
  .strict();

const WorkerConfigSchema = z
  .object({
    provider: z.string(),
    model: z.string().optional(),
    runtime: z.string().optional(), // inferred from provider.kind/defaultRuntime when omitted
    budget: partialBudgetInputSchema.optional(),
    limits: z.object({ concurrent: z.number().int().positive().optional() }).strict().optional(),
    card: WorkerCardSchema.optional(),
    contextWindow: z.number().int().positive().optional(),
    price: z.object({ inPerMtok: z.number().optional(), outPerMtok: z.number().optional() }).strict().optional(),
    reasoningEffort: z.string().optional(),
    reasoningEffortLevels: z.array(z.string()).optional(),
    fallback: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
    extraArgs: z.array(z.string()).optional(),
    tools: z.array(z.string()).optional(),
    equip: EquipmentSchema.optional(),
  })
  .strict();

const TierConfigSchema = z
  .object({
    chain: z.array(z.string()).min(1),
    fallback: z.enum(['auto', 'report']),
    tools: z.array(z.string()).optional(),
    budget: partialBudgetInputSchema.optional(),
  })
  .strict();

const VerifyCommandSchema = z
  .object({
    command: z.string(),
    win: z.string().optional(),
    posix: z.string().optional(),
  })
  .strict();

const VerifySpecSchema = z
  .object({
    build: z.union([z.string(), VerifyCommandSchema]).optional(),
    test: z.union([z.string(), VerifyCommandSchema]).optional(),
    lint: z.union([z.string(), VerifyCommandSchema]).optional(),
    timeoutMs: z.number().int().positive().optional(),
    shell: z.string().optional(),
  })
  .strict();

const RestrictSchema = z
  .object({
    workers: z.array(z.string()).optional(),
    tiers: z.array(z.string()).optional(),
  })
  .strict();

/** Full DelegatorConfig schema (after normalisation — wallClockMs number). */
const DelegatorConfigSchema = z
  .object({
    version: z.literal(1),
    defaults: z
      .object({
        policy: z.enum(['auto', 'review', 'plan-first']),
        model: z.string().optional(),
        tools: z.array(z.string()).optional(),
        budget: z.object({ wallClockMs: z.number().int().positive() }).strict(),
        checkpointSeconds: z.number().int().positive(),
        stallSeconds: z.number().int().positive(),
        silenceKillSeconds: z.number().int().positive(),
        keepRuns: z.number().int().positive(),
        worktreeRetention: z.enum(['keep-unfinished', 'on-finish', 'keep']).default('keep-unfinished'),
        queueTimeoutSeconds: z.number().int().positive(),
        queuePollSeconds: z.number().int().positive(),
        autoApply: z.object({ maxFiles: z.number().int().positive(), maxLines: z.number().int().positive() }).strict(),
        retries: z.object({ rateLimit: z.number().int().nonnegative(), server: z.number().int().nonnegative() }).strict(),
        breaker: z.object({ failures: z.number().int().positive(), cooldownMs: z.number().int().nonnegative() }).strict(),
        keyCooldownMs: z.number().int().nonnegative(),
      })
      .strict(),
    privacy: z
      .object({
        sensitivePaths: z.array(z.string()),
      })
      .strict(),
    providers: z.record(ProviderConfigSchema),
    workers: z.record(WorkerConfigSchema),
    tiers: z.record(TierConfigSchema),
    runtimes: z.record(RuntimeDescriptorSchema).optional(),
    verify: VerifySpecSchema.optional(),
    restrict: RestrictSchema.optional(),
  })
  .strict();

// ---------- YAML raw schemas (before normalisation) ----------

const RawDefaultsSchema = z
  .object({
    policy: z.enum(['auto', 'review', 'plan-first']).optional(),
    model: z.string().optional(),
    tools: z.array(z.string()).optional(),
    isolation: z.string().optional(), // tolerated in global YAML (a legacy field, not in types)
    budget: budgetInputSchema.optional(),
    checkpointSeconds: z.number().int().positive().optional(),
    stallSeconds: z.number().int().positive().optional(),
    silenceKillSeconds: z.number().int().positive().optional(),
    keepRuns: z.number().int().positive().optional(),
    worktreeRetention: z.enum(['keep-unfinished', 'on-finish', 'keep']).optional(),
    queueTimeoutSeconds: z.number().int().positive().optional(),
    queuePollSeconds: z.number().int().positive().optional(),
    retries: z
      .object({
        rateLimit: z.number().int().nonnegative().optional(),
        server: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    breaker: z
      .object({
        failures: z.number().int().positive().optional(),
        cooldown: durationSchema.optional(),
      })
      .strict()
      .optional(),
    keyCooldown: durationSchema.optional(),
    escapeIgnore: z.array(z.string()).optional(), // legacy, ignored
    autoApply: z
      .object({ maxFiles: z.number().int().positive().optional(), maxLines: z.number().int().positive().optional() })
      .strict()
      .optional(),
  })
  .strict();

const RawPrivacySchema = z
  .object({
    sensitivePaths: z.array(z.string()).optional(),
  })
  .strict();

/** Top-level YAML before merging/normalising */
const RawGlobalYamlSchema = z
  .object({
    version: z.literal(1).optional(),
    defaults: RawDefaultsSchema.optional(),
    privacy: RawPrivacySchema.optional(),
    runtimes: z.record(RuntimeDescriptorSchema).optional(),
    providers: z.record(AnyProviderConfigSchema).optional(),
    workers: z.record(WorkerConfigSchema).optional(),
    tiers: z.record(TierConfigSchema).optional(),
    verify: VerifySpecSchema.optional(),
    restrict: RestrictSchema.optional(),
  })
  // NOTE: NOT strict — global file may carry extension fields we don't need to error on
  ;

/** Project config: only these top-level keys allowed */
const RawProjectYamlSchema = z
  .object({
    defaults: RawDefaultsSchema.optional(),
    privacy: RawPrivacySchema.optional(),
    tiers: z.record(TierConfigSchema).optional(),
    verify: VerifySpecSchema.optional(),
    restrict: RestrictSchema.optional(),
  })
  .strict();

// ---------- helpers ----------

function zodError(err: z.ZodError, context: string): ConfigError {
  const msg = err.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  return new ConfigError(`${context}:\n${msg}`);
}

function parseYamlFile(filePath: string, label: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
  try {
    return parseYaml(raw);
  } catch (e) {
    throw new ConfigError(`Failed to parse ${label}: ${(e as Error).message}`);
  }
}

function normalizeRuntimeDescriptors(raw: unknown, label: string): Record<string, RuntimeDescriptor> {
  const parsed = RuntimeDescriptorsFileSchema.safeParse(raw ?? {});
  if (!parsed.success) throw zodError(parsed.error, label);
  const out: Record<string, RuntimeDescriptor> = {};
  for (const [runtimeId, runtime] of Object.entries(parsed.data.runtimes ?? {})) {
    out[normalizeRuntimeId(runtimeId)] = runtime;
  }
  return out;
}

export function loadPackagedRuntimes(): Record<string, RuntimeDescriptor> {
  const url = new URL('../runtimes.default.yaml', import.meta.url);
  let raw: string;
  try {
    raw = fs.readFileSync(url, 'utf8');
  } catch {
    throw new ConfigError('runtimes.default.yaml not found next to the package — reinstall');
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new ConfigError(`Failed to parse packaged runtimes.default.yaml: ${(e as Error).message}`);
  }
  return normalizeRuntimeDescriptors(parsed, 'packaged runtimes.default.yaml');
}

export function loadUserRuntimes(): Record<string, RuntimeDescriptor> {
  const p = runtimesConfigPath();
  if (!fs.existsSync(p)) return {};
  const parsed = parseYamlFile(p, 'user runtimes config');
  return normalizeRuntimeDescriptors(parsed, `User runtimes config (${p})`);
}

function assertNoRemovedFields(raw: unknown, label: string): void {
  if (raw === null || typeof raw !== 'object') return;
  const obj = raw as Record<string, unknown>;
  const privacy = obj.privacy;
  if (
    privacy !== null &&
    typeof privacy === 'object' &&
    Object.prototype.hasOwnProperty.call(privacy, 'externalWorkers')
  ) {
    throw new ConfigError(`${label}: removed field "privacy.externalWorkers" is no longer supported`);
  }
  const providers = obj.providers;
  if (providers === null || typeof providers !== 'object') return;
  for (const [providerId, provider] of Object.entries(providers as Record<string, unknown>)) {
    if (
      provider !== null &&
      typeof provider === 'object' &&
      Object.prototype.hasOwnProperty.call(provider, 'trust')
    ) {
      throw new ConfigError(`${label}: removed field "providers.${providerId}.trust" is no longer supported`);
    }
  }
}

// ---------- secrets ----------
// Keys live in secrets.yaml, a file only the core reads. The registry
// (providers.yaml) carries no secret values and is safe for agents to edit.

export type SecretsMap = Record<string, string>;
/** A provider may hold a POOL of keys (e.g. many free-tier keys); runs rotate through them. */
export type SecretPools = Record<string, string[]>;

function poolsFromParsed(parsed: Record<string, unknown>): SecretPools {
  const out: SecretPools = {};
  for (const [k, v] of Object.entries(parsed)) {
    if (typeof v === 'string' && v.trim() !== '') out[k] = [v.trim()];
    else if (Array.isArray(v)) {
      const keys = v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
      if (keys.length) out[k] = keys;
    }
  }
  return out;
}

/** Lenient load for READ paths (run-time key resolution): a missing OR unreadable/corrupt
 *  secrets.yaml yields {} so a run fails cleanly with "no key" rather than crashing. */
export function loadSecretPools(): SecretPools {
  const p = secretsPath();
  if (!fs.existsSync(p)) return {};
  try {
    const parsed = parseYaml(fs.readFileSync(p, 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object') return {};
    return poolsFromParsed(parsed as Record<string, unknown>);
  } catch {
    return {};
  }
}

/** STRICT load for the WRITE path (saveSecret): an existing-but-unreadable/unparseable
 *  secrets.yaml must NOT be silently treated as empty — that would let the rewrite wipe
 *  every stored key (AGENTS.md §6: never destroy the user's secrets). Distinguishes
 *  "absent" (ok → {}) from "present but broken" (throw, refuse to overwrite). */
function loadSecretPoolsStrict(): SecretPools {
  const p = secretsPath();
  if (!fs.existsSync(p)) return {};
  let raw: string;
  try {
    raw = fs.readFileSync(p, 'utf8');
  } catch (e) {
    throw new ConfigError(`cannot read ${p} (${(e as Error).message}) — refusing to overwrite it and risk losing existing keys`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new ConfigError(`${p} is present but not valid YAML (${(e as Error).message}) — fix or remove it before saving a key; refusing to overwrite and lose existing keys`);
  }
  if (parsed === null) return {}; // genuinely empty file — no keys yet
  if (typeof parsed !== 'object') {
    throw new ConfigError(`${p} does not contain a provider→key map — refusing to overwrite it`);
  }
  return poolsFromParsed(parsed as Record<string, unknown>);
}

/** Back-compat single-key view: the first key of each pool. */
export function loadSecrets(): SecretsMap {
  const pools = loadSecretPools();
  const out: SecretsMap = {};
  for (const [k, v] of Object.entries(pools)) {
    if (v[0] !== undefined) out[k] = v[0];
  }
  return out;
}

export function saveSecret(providerId: string, key: string, opts?: { append?: boolean }): void {
  ensureDir(configHome());
  const pools = loadSecretPoolsStrict();
  const k = key.trim();
  // Never let an empty/whitespace key through: `set` would replace the pool with [""]
  // and `add` would poison it — either way silently wiping a working key. Fail loudly.
  if (!k) {
    throw new ConfigError(`refusing to store an empty key for "${providerId}" — that would wipe the existing key pool`);
  }
  const existing = pools[providerId] ?? [];
  pools[providerId] = opts?.append
    ? (existing.includes(k) ? existing : [...existing, k])
    : [k];
  const body =
    '# delegator secrets - API key pools by provider id. Only the delegator core\n' +
    '# reads this file; agents and LLMs must NEVER read it.\n' +
    '# Managed by: dlg key set <provider> (replace) / dlg key add <provider> (pool)\n' +
    Object.entries(pools)
      .map(([pid, keys]) => (keys.length === 1 ? `${pid}: ${JSON.stringify(keys[0])}` : `${pid}: ${JSON.stringify(keys)}`))
      .join('\n') +
    '\n';
  // Atomic write: a crash/partial write must never corrupt the existing secrets file
  // (a corrupt file is exactly what would otherwise trip the strict-load guard above).
  const tmp = secretsPath() + '.tmp';
  fs.writeFileSync(tmp, body, 'utf8');
  if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, secretsPath());
}

// ---------- key rotation cursor (state.json, owned by src/state.ts) ----------

/**
 * Round-robin key selection that SKIPS keys on cooldown. Advances the
 * provider's persisted cursor to the next key whose hash is not parked. If every
 * key is parked, picks the one whose cooldown expires soonest (most likely to
 * have recovered) so a run still goes out — honest best-effort, not a hard stop.
 */
export function nextPoolKey(providerId: string, pool: string[]): string {
  if (pool.length === 1) return pool[0]!; // nothing to rotate to; cooldown is a no-op
  return mutateState((state) => {
    const now = Date.now();
    const parked = activeParkedHashes(state, providerId, now); // prunes expired in place
    const cursor = state.keyCursor ?? {};
    let idx = cursor[providerId] ?? -1;

    let chosen = -1;
    for (let step = 0; step < pool.length; step++) {
      idx = (idx + 1) % pool.length;
      if (!parked.has(hashKey(pool[idx]!))) { chosen = idx; break; }
    }

    if (chosen === -1) {
      // All keys parked → soonest-expiring wins.
      const entries = state.keyCooldown?.[providerId] ?? [];
      let bestUntil = Infinity;
      for (let i = 0; i < pool.length; i++) {
        const e = entries.find((x) => x.hash === hashKey(pool[i]!));
        const until = e ? e.until : 0;
        if (until < bestUntil) { bestUntil = until; chosen = i; }
      }
      if (chosen === -1) chosen = (idx + 1) % pool.length;
    }

    cursor[providerId] = chosen;
    state.keyCursor = cursor;
    return pool[chosen]!;
  });
}

/** A valid env var NAME. Anything else found in apiKeyEnv is a pasted secret. */
const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** How a worker is launched, derived from its provider's API dialect. */
const RUNTIME_BY_KIND: Record<string, RuntimeId | undefined> = {
  anthropic: 'claude',
  'anthropic-compatible': 'claude',
  'codex-cli': 'codex',
  opencode: 'opencode',        // opencode CLI owns its own auth; model = provider/model
  'openai-compatible': 'api', // single OpenAI Chat Completions POST
};

const ID_RE = /^[a-z0-9][a-z0-9._-]*$/;

function assertConfigId(kind: string, id: string): void {
  if (!ID_RE.test(id)) {
    throw new ConfigError(`Invalid ${kind} id "${id}": expected [a-z0-9][a-z0-9._-]*`);
  }
}

function assertNoEmptyHandleSegments(label: string, handle: string): void {
  if (handle.split('/').some((seg) => seg.trim() === '')) {
    throw new ConfigError(`Invalid ${label} "${handle}": empty handle segment`);
  }
}

function protocolAuthFromKind(kind: ProviderConfig['kind']): { protocol: ProviderProtocol; auth: ProviderAuth } {
  switch (kind) {
    case 'anthropic': return { protocol: 'anthropic', auth: 'subscription' };
    case 'anthropic-compatible': return { protocol: 'anthropic', auth: 'api-key' };
    case 'codex-cli': return { protocol: 'openai', auth: 'subscription' };
    case 'opencode': return { protocol: 'opencode', auth: 'subscription' };
    case 'openai-compatible': return { protocol: 'openai', auth: 'api-key' };
  }
}

function kindFromProtocolAuth(protocol?: ProviderProtocol, auth?: ProviderAuth): ProviderConfig['kind'] {
  if (protocol === 'anthropic' && auth === 'subscription') return 'anthropic';
  if (protocol === 'anthropic') return 'anthropic-compatible';
  if (protocol === 'openai' && auth === 'subscription') return 'codex-cli';
  if (protocol === 'opencode') return 'opencode';
  return 'openai-compatible';
}

function normaliseModelConfig(raw: z.infer<typeof ModelConfigSchema>) {
  const out = { ...raw };
  if (raw.budget !== undefined) out.budget = normalisePartialBudget(raw.budget);
  return out;
}

export function effortLevels(
  spec: ModelConfig['reasoningEffort'] | undefined,
): { levels: string[]; default?: string } {
  if (spec === undefined) return { levels: [] };
  if (typeof spec === 'string') return { levels: [spec], default: spec };
  return { levels: spec.levels, default: spec.default };
}

function effectiveEffortLevels(
  modelSpec: ModelConfig['reasoningEffort'] | undefined,
  runtimeSpec: RuntimeDescriptor['effortLevels'] | undefined,
): { levels: string[]; default?: string } {
  if (modelSpec === undefined) return runtimeSpec ?? { levels: [] };
  const modelEffort = effortLevels(modelSpec);
  return {
    levels: modelEffort.levels,
    default: modelEffort.default ?? runtimeSpec?.default,
  };
}

function normaliseModels(
  providerId: string,
  raw: z.infer<typeof ModelsInputSchema> | undefined,
  usingNewShape: boolean,
): Record<string, z.infer<typeof ModelConfigSchema>> | undefined {
  if (raw === undefined) return undefined;
  const entries = Array.isArray(raw)
    ? raw.map((modelId) => [modelId, {} as z.infer<typeof ModelConfigSchema>] as const)
    : Object.entries(raw);
  return Object.fromEntries(entries.map(([m, model]) => {
    if (usingNewShape) assertNoEmptyHandleSegments(`model ${providerId}`, m);
    return [m, normaliseModelConfig(model)];
  }));
}

function mergeCards(base?: WorkerConfig['card'], override?: WorkerConfig['card']): WorkerConfig['card'] | undefined {
  if (!base) return override;
  if (!override) return base;
  return { ...base, ...override };
}

/**
 * Apply a provider's per-model defaults (reasoningEffort / contextWindow / price / card / budget)
 * to a bare `provider/model` handle worker. Named worker profiles get this merge at load time
 * (see the workers loop in loadConfig); a model addressed straight from a tier chain as
 * `provider/model` has no profile, so it inherits the model's config here. Without this,
 * provider-first data under `providers.<p>.models.<m>` would be invisible to handle addressing —
 * e.g. `openai-codex/gpt-5.5` would silently lose its `reasoningEffort: high`.
 */
export function withModelDefaults(base: WorkerConfig, provider: ProviderConfig | undefined): WorkerConfig {
  const modelDefaults = base.model !== undefined ? provider?.models?.[base.model] : undefined;
  if (modelDefaults === undefined) return base;
  const card = mergeCards(modelDefaults.card, base.card);
  const runtimeEffort = runtimeDescriptorFor(base.runtime, mergedRuntimeDescriptors({}))?.effortLevels;
  const resolvedEffort = effectiveEffortLevels(modelDefaults.reasoningEffort, runtimeEffort);
  const w: WorkerConfig = {
    ...base,
    ...(base.reasoningEffort === undefined && resolvedEffort.default !== undefined
      ? { reasoningEffort: resolvedEffort.default }
      : {}),
    ...(base.reasoningEffortLevels === undefined && resolvedEffort.levels.length > 0
      ? { reasoningEffortLevels: resolvedEffort.levels }
      : {}),
    ...(modelDefaults.contextWindow !== undefined && base.contextWindow === undefined
      ? { contextWindow: modelDefaults.contextWindow }
      : {}),
    ...(modelDefaults.fallback !== undefined && base.fallback === undefined ? { fallback: modelDefaults.fallback } : {}),
    ...(modelDefaults.limits !== undefined && base.limits === undefined ? { limits: modelDefaults.limits } : {}),
    ...(modelDefaults.tools !== undefined && base.tools === undefined ? { tools: modelDefaults.tools } : {}),
    ...(modelDefaults.price !== undefined && base.price === undefined ? { price: modelDefaults.price } : {}),
    ...(card !== undefined ? { card } : {}),
  };
  if (modelDefaults.budget !== undefined && base.budget === undefined) {
    w.budget = normalisePartialBudget(modelDefaults.budget);
  }
  return w;
}

export function mergedRuntimeDescriptors(cfg: Pick<DelegatorConfig, 'runtimes'>): Record<string, RuntimeDescriptor> {
  // A user/project runtimes override REPLACES the packaged runtime's identity (command, protocol,
  // auth, args, parser, prompt) — omitting a field there means "unset", as it always has. But it must
  // still INHERIT packaged *additive* defaults: the `env` map (merged key-by-key) and `authEnv`. A
  // runtimes.yaml is typically a full copy (dlg init writes one) that goes STALE the moment delegator
  // adds an env var or authEnv; a flat replace silently dropped those — that is how the
  // Claude-subscription 401 slipped through here once. Override env values
  // win on conflict; an explicit `authEnv: []` opts out of the inherited login namespace.
  const merged: Record<string, RuntimeDescriptor> = { ...loadPackagedRuntimes() };
  const overrides = [
    loadUserRuntimes(),
    normalizeRuntimeDescriptors({ runtimes: cfg.runtimes ?? {} }, 'configured runtime descriptors'),
  ];
  for (const layer of overrides) {
    for (const [id, override] of Object.entries(layer)) {
      const base = merged[id];
      if (!base) { merged[id] = override; continue; }
      const env = { ...(base.env ?? {}), ...(override.env ?? {}) };
      merged[id] = {
        ...override,
        ...(Object.keys(env).length ? { env } : {}),
        ...(override.authEnv === undefined && base.authEnv !== undefined ? { authEnv: base.authEnv } : {}),
      };
    }
  }
  return merged;
}

function runtimeDescriptorFor(id: string, runtimes: Record<string, RuntimeDescriptor>): RuntimeDescriptor | undefined {
  return runtimes[normalizeRuntimeId(id)];
}

function runtimeMatchesProvider(
  runtimeId: string,
  runtime: RuntimeDescriptor,
  provider: Pick<ProviderConfig, 'protocol' | 'auth'>,
  opts?: { inference?: boolean },
): boolean {
  if (provider.protocol === undefined || provider.auth === undefined) {
    return !opts?.inference && runtime.protocol === undefined && runtime.auth === undefined;
  }
  if (runtime.protocol === undefined) return !opts?.inference;
  if (runtime.protocol !== provider.protocol) return false;
  const declaredAuth = runtime.auth;
  if (declaredAuth === undefined) return true;
  return Array.isArray(declaredAuth)
    ? declaredAuth.includes(provider.auth)
    : declaredAuth === provider.auth;
}

function compatibleRuntimes(
  providerId: string,
  provider: ProviderConfig,
  runtimes: Record<string, RuntimeDescriptor>,
  preferredRuntimeIds?: Set<string>,
): string[] {
  if (provider.protocol === undefined || provider.auth === undefined) {
    throw new ConfigError(`Provider "${providerId}" is missing protocol/auth`);
  }
  const matches: string[] = [];
  const preferredMatches: string[] = [];
  for (const [runtimeId, runtime] of Object.entries(runtimes)) {
    if (runtimeMatchesProvider(runtimeId, runtime, provider, { inference: true })) {
      matches.push(runtimeId);
      if (preferredRuntimeIds?.has(normalizeRuntimeId(runtimeId))) preferredMatches.push(runtimeId);
    }
  }
  return preferredMatches.length > 0 ? preferredMatches : matches;
}

function inferRuntimeForProvider(
  providerId: string,
  provider: ProviderConfig,
  runtimes: Record<string, RuntimeDescriptor>,
  preferredRuntimeIds?: Set<string>,
): RuntimeId {
  if (provider.defaultRuntime !== undefined) return normalizeRuntimeId(provider.defaultRuntime);
  const matches = compatibleRuntimes(providerId, provider, runtimes, preferredRuntimeIds);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new ConfigError(
      `Provider "${providerId}" matches multiple runtimes for protocol/auth; set defaultRuntime`,
    );
  }
  throw new ConfigError(
    `Provider "${providerId}" has no runtime compatible with protocol/auth ${provider.protocol}/${provider.auth}`,
  );
}

/** Like inferRuntimeForProvider but returns undefined instead of throwing — for best-effort enrichment
 *  (effort-levels inheritance) that must NEVER break config loading when a provider has no/ambiguous
 *  runtime in this config's descriptor set. */
function tryInferRuntimeForProvider(
  providerId: string,
  provider: ProviderConfig,
  runtimes: Record<string, RuntimeDescriptor>,
  preferredRuntimeIds?: Set<string>,
): RuntimeId | undefined {
  try {
    return inferRuntimeForProvider(providerId, provider, runtimes, preferredRuntimeIds);
  } catch {
    return undefined;
  }
}

export function inferRuntimeForProviderConfig(
  providerId: string,
  provider: ProviderConfig,
  cfg: Pick<DelegatorConfig, 'runtimes'>,
): RuntimeId | undefined {
  if (provider.defaultRuntime !== undefined) return normalizeRuntimeId(provider.defaultRuntime);
  if (cfg.runtimes !== undefined) {
    const preferred = new Set(Object.keys(cfg.runtimes).map(normalizeRuntimeId));
    return inferRuntimeForProvider(providerId, provider, mergedRuntimeDescriptors(cfg), preferred);
  }
  return RUNTIME_BY_KIND[provider.kind];
}

function declaredRuntimeIds(cfg: DelegatorConfig): Set<string> {
  const ids = new Set<string>(Object.keys(mergedRuntimeDescriptors(cfg)).map(normalizeRuntimeId));
  for (const w of Object.values(cfg.workers)) {
    if (w.runtime) ids.add(normalizeRuntimeId(w.runtime));
  }
  for (const rt of Object.values(RUNTIME_BY_KIND)) {
    if (rt) ids.add(rt);
  }
  return ids;
}

export function parseHandle(
  handle: string,
  cfg: DelegatorConfig,
): { runtime?: string; provider: string; model: string } | { profileAlias: string } {
  if (typeof handle !== 'string' || handle.trim() === '') {
    throw new ConfigError('Invalid handle: expected a non-empty string');
  }
  assertNoEmptyHandleSegments('handle', handle);
  const segments = handle.split('/');
  const provider = cfg.providers[segments[0]!];
  const providerModel = segments.slice(1).join('/');
  if (segments.length >= 2 && provider?.models?.[providerModel] !== undefined) {
    return {
      provider: segments[0]!,
      model: providerModel,
    };
  }
  const runtimes = declaredRuntimeIds(cfg);
  const runtimeSegment = normalizeRuntimeId(segments[0]!);
  if (runtimes.has(runtimeSegment) || Object.prototype.hasOwnProperty.call(RUNTIME_ALIASES, segments[0]!)) {
    if (segments.length < 3) {
      throw new ConfigError(`Invalid handle "${handle}": expected [runtime/]provider/model`);
    }
    return {
      runtime: runtimeSegment,
      provider: segments[1]!,
      model: segments.slice(2).join('/'),
    };
  }
  if (cfg.providers[segments[0]!]) {
    if (segments.length < 2) {
      throw new ConfigError(`Invalid handle "${handle}": expected provider/model`);
    }
    return {
      provider: segments[0]!,
      model: segments.slice(1).join('/'),
    };
  }
  return { profileAlias: handle };
}

function tierChainEntryResolves(id: string, cfg: DelegatorConfig): boolean {
  if (cfg.workers[id] !== undefined) return true;
  let parsed: ReturnType<typeof parseHandle>;
  try {
    parsed = parseHandle(id, cfg);
  } catch {
    return false;
  }
  if ('profileAlias' in parsed) return false;
  const provider = cfg.providers[parsed.provider];
  if (provider === undefined || parsed.model.trim() === '') return false;
  try {
    const runtime = normalizeRuntimeId(parsed.runtime ?? inferRuntimeForProviderConfig(parsed.provider, provider, cfg) ?? '');
    return runtime !== '';
  } catch {
    return false;
  }
}

function tierChainWarnings(cfg: DelegatorConfig): string[] {
  const warnings: string[] = [];
  for (const [tierId, tier] of Object.entries(cfg.tiers)) {
    for (const entry of tier.chain) {
      if (!tierChainEntryResolves(entry, cfg)) {
        warnings.push(
          `tier-chain: tiers.${tierId}.chain entry "${entry}" is not a declared worker id or resolvable [runtime/]provider/model handle`,
        );
      }
    }
  }
  return warnings;
}

/**
 * Move any secret values out of providers.yaml into secrets.yaml.
 * Covers both `apiKey: <value>` and the observed real-world mistake of pasting
 * the key into `apiKeyEnv:` (whose value must be an env var NAME).
 */
function migrateInlineKeys(globalPath: string): number {
  let text: string;
  try {
    text = fs.readFileSync(globalPath, 'utf8');
  } catch {
    return 0;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    return 0; // unparseable file will fail loudly later in loadConfig
  }
  const providers =
    (parsed as { providers?: Record<string, { apiKey?: unknown; apiKeyEnv?: unknown }> } | null)
      ?.providers ?? {};
  let moved = 0;
  const lineFilters: Array<(l: string) => boolean> = [];
  for (const [pid, pv] of Object.entries(providers)) {
    const k = pv?.apiKey;
    if (typeof k === 'string' && k.trim() !== '') {
      saveSecret(pid, k);
      moved++;
      lineFilters.push((l) => /^\s*apiKey\s*:/.test(l) && l.includes(k.trim()));
    }
    const ke = pv?.apiKeyEnv;
    if (typeof ke === 'string' && ke.trim() !== '' && !ENV_NAME_RE.test(ke.trim())) {
      // Not a legal env var name -> the user pasted the key itself here.
      saveSecret(pid, ke);
      moved++;
      lineFilters.push((l) => /^\s*apiKeyEnv\s*:/.test(l) && l.includes(ke.trim()));
    }
  }
  if (moved > 0) {
    const stripped = text
      .split(/\r?\n/)
      .filter((l) => !lineFilters.some((f) => f(l)))
      .join('\n');
    fs.writeFileSync(globalPath, stripped, 'utf8');
    process.stderr.write(
      `delegator: moved ${moved} API key(s) from providers.yaml to secrets.yaml\n`,
    );
  }
  return moved;
}

// ---------- loadConfig ----------

export function loadConfig(cwd: string): DelegatorConfig {
  // --- global ---
  const globalPath = globalConfigPath();
  migrateInlineKeys(globalPath); // inline keys are rescued into secrets.yaml
  const globalRaw = parseYamlFile(globalPath, 'global config');
  if (globalRaw === undefined) {
    throw new ConfigError(
      `Global config not found: ${globalPath}`,
      'run: dlg init',
    );
  }
  assertNoRemovedFields(globalRaw, `Global config (${globalPath})`);

  const globalParsed = RawGlobalYamlSchema.safeParse(globalRaw);
  if (!globalParsed.success) throw zodError(globalParsed.error, `Global config (${globalPath})`);
  const g = globalParsed.data;

  // --- project ---
  const projectPath = projectConfigPath(cwd);
  let p: z.infer<typeof RawProjectYamlSchema> | undefined;
  if (fs.existsSync(projectPath)) {
    let projectText: string;
    try {
      projectText = fs.readFileSync(projectPath, 'utf8');
    } catch (e) {
      throw new ConfigError(`Cannot read project config: ${(e as Error).message}`);
    }
    if (/\bapiKey\s*:/.test(projectText)) {
      throw new ConfigError(
        'secrets are not allowed in project config (.delegator.yaml)',
      );
    }
    const projectRaw = parseYaml(projectText) as unknown;
    assertNoRemovedFields(projectRaw, `Project config (${projectPath})`);
    // Check for unknown top-level keys
    const projectParsed = RawProjectYamlSchema.safeParse(projectRaw);
    if (!projectParsed.success) throw zodError(projectParsed.error, `Project config (${projectPath})`);
    p = projectParsed.data;
  }

  // --- merge: project wins over global per section ---

  // defaults
  const gDef = g.defaults ?? {};
  const pDef = p?.defaults ?? {};

  // budget: merge global budget then apply project override
  const gBudgetRaw = gDef.budget;
  const pBudgetRaw = pDef.budget;
  const gBudget = gBudgetRaw ? normaliseBudget(gBudgetRaw) : undefined;
  const pBudget = pBudgetRaw ? normaliseBudget(pBudgetRaw) : undefined;
  const mergedBudget: BudgetSpec = {
    // Wall-clock is the ONLY run limit. Iterations (top-level model turns) are counted for
    // statistics in the envelope, never capped; the stall detector guards stuck runs.
    wallClockMs: pBudget?.wallClockMs ?? gBudget?.wallClockMs ?? 900_000,
  };

  const gAutoApply = gDef.autoApply ?? {};
  const pAutoApply = pDef.autoApply ?? {};

  const defaults: DelegatorConfig['defaults'] = {
    policy: pDef.policy ?? gDef.policy ?? 'review',
    ...(pDef.model ?? gDef.model ? { model: pDef.model ?? gDef.model } : {}),
    ...(pDef.tools ?? gDef.tools ? { tools: pDef.tools ?? gDef.tools } : {}),
    budget: mergedBudget,
    checkpointSeconds: pDef.checkpointSeconds ?? gDef.checkpointSeconds ?? 90,
    stallSeconds: pDef.stallSeconds ?? gDef.stallSeconds ?? 120,
    silenceKillSeconds: pDef.silenceKillSeconds ?? gDef.silenceKillSeconds ?? 300,
    keepRuns: pDef.keepRuns ?? gDef.keepRuns ?? 30,
    worktreeRetention: pDef.worktreeRetention ?? gDef.worktreeRetention ?? 'keep-unfinished',
    queueTimeoutSeconds: pDef.queueTimeoutSeconds ?? gDef.queueTimeoutSeconds ?? 1800,
    queuePollSeconds: pDef.queuePollSeconds ?? gDef.queuePollSeconds ?? 3,
    autoApply: {
      maxFiles: pAutoApply.maxFiles ?? gAutoApply.maxFiles ?? 10,
      maxLines: pAutoApply.maxLines ?? gAutoApply.maxLines ?? 400,
    },
    retries: {
      rateLimit: pDef.retries?.rateLimit ?? gDef.retries?.rateLimit ?? 3,
      server: pDef.retries?.server ?? gDef.retries?.server ?? 2,
    },
    breaker: {
      failures: pDef.breaker?.failures ?? gDef.breaker?.failures ?? 3,
      // durationSchema already normalised `cooldown` to ms.
      cooldownMs: pDef.breaker?.cooldown ?? gDef.breaker?.cooldown ?? 600_000,
    },
    keyCooldownMs: pDef.keyCooldown ?? gDef.keyCooldown ?? 900_000,
  };

  // privacy
  const gPriv = g.privacy ?? {};
  const pPriv = p?.privacy ?? {};
  const privacy: DelegatorConfig['privacy'] = {
    sensitivePaths: pPriv.sensitivePaths ?? gPriv.sensitivePaths ?? [],
  };

  const rawProviders = g.providers ?? {};
  const usingNewShape =
    g.runtimes !== undefined ||
    Object.values(rawProviders).some((v) => !('kind' in (v as Record<string, unknown>)));

  const runtimes: Record<string, RuntimeDescriptor> = {};
  for (const [runtimeId, runtime] of Object.entries(g.runtimes ?? {})) {
    if (usingNewShape) assertConfigId('runtime', runtimeId);
    runtimes[normalizeRuntimeId(runtimeId)] = runtime as RuntimeDescriptor;
  }
  const runtimeDescriptors = mergedRuntimeDescriptors({ runtimes });
  const preferredRuntimeIds = new Set(Object.keys(runtimes).map(normalizeRuntimeId));

  if (usingNewShape) {
    for (const providerId of Object.keys(rawProviders)) assertConfigId('provider', providerId);
    for (const profileId of Object.keys(g.workers ?? {})) assertConfigId('profile', profileId);
    // A name MAY be both a runtime and a provider: a self-routing CLI (pi, opencode) is naturally
    // both — the launcher AND its own auth/model namespace. Handle positions disambiguate
    // (`pi/model` = provider pi; `pi/provider/model` = runtime pi), so there is no clash to forbid.
  }

  // providers — global only (project config cannot set providers). New-shape
  // provider/model trees are collapsed back into the legacy provider object so
  // registry/runner keep consuming ProviderConfig unchanged in Stage 1.
  const providers: Record<string, ProviderConfig> = {};
  for (const [providerId, raw] of Object.entries(rawProviders)) {
    const v = raw as z.infer<typeof AnyProviderConfigSchema>;
    if ('kind' in v) {
      const pa = protocolAuthFromKind(v.kind);
      const models = normaliseModels(providerId, v.models, usingNewShape);
      const { keyEnv, apiKeyEnv, models: _models, defaultRuntime, ...rest } = v;
      const normalizedApiKeyEnv = keyEnv ?? apiKeyEnv;
      providers[providerId] = {
        ...rest,
        ...(defaultRuntime !== undefined ? { defaultRuntime: normalizeRuntimeId(defaultRuntime) } : {}),
        ...(normalizedApiKeyEnv !== undefined ? { apiKeyEnv: normalizedApiKeyEnv } : {}),
        protocol: rest.protocol ?? pa.protocol,
        auth: rest.auth ?? pa.auth,
        ...(models !== undefined ? { models } : {}),
      } as ProviderConfig;
      continue;
    }

    const models = normaliseModels(providerId, v.models, true);
    const { keyEnv, apiKeyEnv, models: _models, defaultRuntime, ...rest } = v;
    const normalizedApiKeyEnv = keyEnv ?? apiKeyEnv;
    providers[providerId] = {
      ...rest,
      kind: kindFromProtocolAuth(v.protocol, v.auth),
      ...(defaultRuntime !== undefined ? { defaultRuntime: normalizeRuntimeId(defaultRuntime) } : {}),
      ...(normalizedApiKeyEnv !== undefined ? { apiKeyEnv: normalizedApiKeyEnv } : {}),
      ...(models !== undefined ? { models } : {}),
    } as ProviderConfig;
  }

  if (usingNewShape) {
    for (const [providerId, provider] of Object.entries(providers)) {
      if (provider.defaultRuntime !== undefined) {
        const runtime = runtimeDescriptorFor(provider.defaultRuntime, runtimeDescriptors);
        if (runtime === undefined) {
          throw new ConfigError(`Provider "${providerId}" defaultRuntime "${provider.defaultRuntime}" is not declared`);
        }
        if (!runtimeMatchesProvider(provider.defaultRuntime, runtime, provider)) {
          throw new ConfigError(
            `Provider "${providerId}" defaultRuntime "${provider.defaultRuntime}" does not match protocol/auth ${provider.protocol}/${provider.auth}`,
          );
        }
      }
      if (provider.protocol === undefined || provider.auth === undefined) continue;
      const matches = compatibleRuntimes(providerId, provider, runtimeDescriptors, preferredRuntimeIds);
      if (matches.length > 1 && provider.defaultRuntime === undefined) {
        throw new ConfigError(
          `Provider "${providerId}" matches multiple runtimes for protocol/auth; set defaultRuntime`,
        );
      }
    }
  }

  // workers — normalise partial budgets; INFER runtime from the provider's kind
  // for old shape, or from declared runtimes/provider.defaultRuntime for new shape.
  const workers: Record<string, WorkerConfig> = {};
  const driftWarnings = new Set<string>();
  const loadWarnings: string[] = [];

  for (const [providerId, provider] of Object.entries(providers)) {
    if (usingNewShape && provider.defaultRuntime === undefined && (provider.protocol === undefined || provider.auth === undefined)) {
      continue;
    }
    const selectedRuntime = provider.defaultRuntime !== undefined
      ? normalizeRuntimeId(provider.defaultRuntime)
      : usingNewShape
        ? tryInferRuntimeForProvider(providerId, provider, runtimeDescriptors, preferredRuntimeIds)
        : RUNTIME_BY_KIND[provider.kind];
    if (selectedRuntime === undefined) continue;
    const runtimeEffort = runtimeDescriptorFor(selectedRuntime, runtimeDescriptors)?.effortLevels;
    if (runtimeEffort === undefined) continue;
    for (const [modelId, model] of Object.entries(provider.models ?? {})) {
      if (model.reasoningEffort === undefined) continue;
      const modelEffort = effortLevels(model.reasoningEffort);
      for (const level of modelEffort.levels) {
        if (runtimeEffort.levels.includes(level)) continue;
        loadWarnings.push(
          `model "${providerId}/${modelId}" declares reasoningEffort level "${level}" outside runtime "${selectedRuntime}" effortLevels [${runtimeEffort.levels.join(', ')}]`,
        );
      }
    }
  }

  for (const [workerId, v] of Object.entries(g.workers ?? {})) {
    const provider = providers[v.provider];
    if (usingNewShape && provider === undefined) {
      throw new ConfigError(`Worker profile "${workerId}" references unknown provider "${v.provider}"`);
    }
    if (usingNewShape && v.model !== undefined) {
      assertNoEmptyHandleSegments(`model for profile ${workerId}`, v.model);
    }

    const modelDefaults = v.model !== undefined ? provider?.models?.[v.model] : undefined;
    const selectedRuntime = v.runtime !== undefined
      ? normalizeRuntimeId(v.runtime)
      : usingNewShape
        ? (provider ? tryInferRuntimeForProvider(v.provider, provider, runtimeDescriptors, preferredRuntimeIds) : undefined)
        : (provider?.kind ? RUNTIME_BY_KIND[provider.kind] : undefined);
    const runtimeEffort = selectedRuntime !== undefined
      ? runtimeDescriptorFor(selectedRuntime, runtimeDescriptors)?.effortLevels
      : undefined;
    const resolvedEffort: { levels: string[]; default?: string } = modelDefaults !== undefined
      ? effectiveEffortLevels(modelDefaults.reasoningEffort, runtimeEffort)
      : { levels: [] };
    const w = {
      ...v,
      ...(selectedRuntime !== undefined ? { runtime: selectedRuntime } : {}),
      ...(v.reasoningEffort === undefined && resolvedEffort.default !== undefined
        ? { reasoningEffort: resolvedEffort.default }
        : {}),
      ...(v.reasoningEffortLevels === undefined && resolvedEffort.levels.length > 0
        ? { reasoningEffortLevels: resolvedEffort.levels }
        : {}),
      ...(modelDefaults?.contextWindow !== undefined && v.contextWindow === undefined
        ? { contextWindow: modelDefaults.contextWindow }
        : {}),
      ...(modelDefaults?.price !== undefined && v.price === undefined
        ? { price: modelDefaults.price }
        : {}),
      card: mergeCards(modelDefaults?.card, v.card),
    } as WorkerConfig;
    const budgetFromWorker = v.budget !== undefined ? normalisePartialBudget(v.budget) : undefined;
    const budgetFromModel = modelDefaults?.budget !== undefined ? normalisePartialBudget(modelDefaults.budget) : undefined;
    if (budgetFromModel !== undefined || budgetFromWorker !== undefined) {
      w.budget = { ...(budgetFromModel ?? {}), ...(budgetFromWorker ?? {}) };
    }

    if (usingNewShape) {
      if (selectedRuntime !== undefined) {
        const runtime = runtimeDescriptorFor(selectedRuntime, runtimeDescriptors);
        if (runtime === undefined) {
          throw new ConfigError(`Worker profile "${workerId}" runtime "${selectedRuntime}" is not declared`);
        }
        if (provider !== undefined && !runtimeMatchesProvider(selectedRuntime, runtime, provider)) {
          throw new ConfigError(
            `Worker profile "${workerId}" runtime "${selectedRuntime}" does not match provider protocol/auth ${provider.protocol}/${provider.auth}`,
          );
        }
        w.runtime = selectedRuntime;
      }
    } else if (w.runtime === undefined) {
      if (selectedRuntime) w.runtime = selectedRuntime;
    }

    if (!usingNewShape) {
      const providerKind = provider?.kind;
      const model = w.model ?? '';
      const driftHandle =
        providerKind === 'opencode' && (workerId.startsWith(`${w.provider}/`) || model.startsWith(`${w.provider}/`))
          ? (workerId.startsWith(`${w.provider}/`) ? workerId : model)
          : undefined;
      if (driftHandle !== undefined && !driftWarnings.has(driftHandle)) {
        driftWarnings.add(driftHandle);
        // Collected, NOT written to stderr: the hot path (dlg run, --json) stays clean.
        // Surfaced only by config-inspection commands (providers/doctor).
        loadWarnings.push(
          `identity-drift: old handle "${driftHandle}" changes meaning under the new / grammar; declare it as an explicit profile alias`,
        );
      }
    }

    workers[workerId] = w;
  }

  // tiers — shallow-merge per tier name; normalise budgets
  const tiersG: Record<string, TierConfig> = {};
  for (const [k, v] of Object.entries(g.tiers ?? {})) {
    const t = { ...v } as TierConfig;
    if (v.budget !== undefined) {
      t.budget = normalisePartialBudget(v.budget);
    }
    tiersG[k] = t;
  }
  const tiersP: Record<string, TierConfig> = {};
  for (const [k, v] of Object.entries(p?.tiers ?? {})) {
    const t = { ...v } as TierConfig;
    if (v.budget !== undefined) {
      t.budget = normalisePartialBudget(v.budget);
    }
    tiersP[k] = t;
  }
  const tiers: Record<string, TierConfig> = { ...tiersG, ...tiersP };

  // verify — project wins over global
  const verify: VerifySpec | undefined = p?.verify ?? g.verify;

  // restrict — project wins over global (the project's allow-list is the cap)
  const restrict = p?.restrict ?? g.restrict;

  // --- assemble ---
  const assembled: DelegatorConfig = {
    version: 1,
    defaults,
    privacy,
    providers,
    workers,
    tiers,
    ...(usingNewShape ? { runtimes } : {}),
    ...(verify !== undefined ? { verify } : {}),
    ...(restrict !== undefined ? { restrict } : {}),
  };

  // final validation
  const finalCheck = DelegatorConfigSchema.safeParse(assembled);
  if (!finalCheck.success) throw zodError(finalCheck.error, 'Config validation failed');

  // Attach derived warnings AFTER validation: the schema is .strict() and would
  // reject this non-config field, so it is not a YAML input — purely a load diagnostic.
  const out = finalCheck.data as unknown as DelegatorConfig;
  loadWarnings.push(...tierChainWarnings(out));
  if (loadWarnings.length) out.warnings = loadWarnings;
  return out;
}
