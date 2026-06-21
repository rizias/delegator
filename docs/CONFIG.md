# Config reference

This page documents the shipped provider-first config shape. It is the shape users should write in
`~/.delegator/providers.yaml`. All handles below are examples; yours depend on your config:

```yaml
version: 1

defaults:
  model: anthropic/claude-opus-4-8
  policy: review
  budget: { wallClock: 15m }
  checkpointSeconds: 90
  stallSeconds: 300
  silenceKillSeconds: 600
  retries: { rateLimit: 3, server: 2 }
  breaker: { failures: 3, cooldown: 10m }

privacy:
  sensitivePaths:
    - "**/.github/workflows/**"
    - "**/*.lock"

providers:
  anthropic:
    protocol: anthropic
    auth: subscription
    models:
      claude-opus-4-8: {}
```

Current top-level config keys are `version`, `defaults`, `privacy`, `providers`, `verify`, `restrict`, and `runtimes`. There is no
current `workers:`, `tiers:`, `trust`, `card`, or `autoApply` routing model. Legacy `kind:`,
`workers:`, and `tiers:` configs still load for back-compat, but they are not the documented shape
for new config.

Durations accept `500ms`, `90s`, `10m`, `2h`, or a plain millisecond number.

## Files

- `~/.delegator/providers.yaml` - provider/model registry. Safe for agents to read and edit.
- `~/.delegator/runtimes.yaml` - optional runtime descriptor overrides/additions.
- packaged `runtimes.default.yaml` - built-in descriptors loaded before user overrides.
- `~/.delegator/secrets.yaml` - API keys only. Agents must never read it.
- `<repo>/.delegator.yaml` - project overrides for defaults/privacy/verify/restrict; it cannot define providers.

## Minimal viable config

```yaml
version: 1

defaults:
  model: local/qwen3-coder
  policy: review
  budget: { wallClock: 15m }

privacy:
  sensitivePaths: []

providers:
  local:
    protocol: openai
    auth: none
    baseUrl: http://localhost:1234/v1
    models:
      qwen3-coder:
        contextWindow: 65536
```

`dlg run` with no `-w` uses `defaults.model`.

## Providers

A provider is where a model comes from: protocol, auth, endpoint, concurrency, and its model list.

```yaml
providers:
  openai:
    protocol: openai
    auth: api-key
    baseUrl: https://api.openai.com/v1
    keyEnv: OPENAI_API_KEY
    defaultRuntime: api
    maxConcurrent: 2
    concurrencyGroup: paid-openai
    rateLimit: { rps: 1 }
    models:
      gpt-5.5:
        contextWindow: 128000
```

Current provider fields:

| Field | Values | Meaning |
|---|---|---|
| `protocol` | `anthropic`, `openai`, `opencode`, `none` | Wire/API compatibility. It is not a CLI brand. |
| `auth` | `subscription`, `api-key`, `none` | How this provider authenticates. |
| `baseUrl` | URL string | API endpoint for HTTP-compatible providers. |
| `keyEnv` | env var name | Optional environment-variable fallback. This is the name, not the key value. |
| `defaultRuntime` | runtime id | Pin the harness when `protocol` + `auth` matches more than one runtime. |
| `maxConcurrent` | non-negative integer | Provider-level concurrency cap; extra runs queue. |
| `concurrencyGroup` | string | Shared concurrency bucket for several providers. |
| `rateLimit.rps` | number | Client-side request-per-second cap. |
| `models` | mapping or list | Models owned by this provider. |

Accepted compatibility/support fields in the zod schema:

| Field | Status |
|---|---|
| `kind` | Legacy provider shorthand; it still loads and is normalized to `protocol`/`auth`. Do not use it in new config. |
| `apiKey` | Legacy inline secret rescue field. Keys are migrated out; do not write it. |
| `apiKeyEnv` | Legacy spelling of `keyEnv`. New config should use `keyEnv`. |
| `modelCatalog` | Optional catalog descriptor for model listing. |
| `quota` | Human metadata; not enforced by the core. |
| `notes` | Human metadata. |

Local inference providers need no key when `baseUrl` host is `localhost`, `127.0.0.1`, `[::1]`, or
`::1`, even if their compatible protocol would normally use API keys.

```yaml
providers:
  lmstudio:
    protocol: openai
    auth: api-key
    baseUrl: http://127.0.0.1:1234/v1
    models:
      liquid/lfm2.5-1.2b: {}
```

## Models

Models live under `providers.<provider>.models.<model>`.

```yaml
providers:
  openai:
    protocol: openai
    auth: api-key
    keyEnv: OPENAI_API_KEY
    models:
      gpt-5.5:
        contextWindow: 128000
        budget:
          wallClock: 15m
        limits:
          concurrent: 1
        tools: [Read, Edit, Bash]
        reasoningEffort:
          levels: [minimal, low, medium, high]
          default: medium
        fallback:
          - opencode/opencode/north-mini-code-free
          - local/gpt-5.5
```

Current model fields:

| Field | Values | Meaning |
|---|---|---|
| `contextWindow` | positive integer | Model context size in tokens. |
| `budget.wallClock` / `budget.wallClockMs` | duration or milliseconds | Model-level time budget override. |
| `limits.concurrent` | positive integer | Model-level concurrency cap. |
| `tools` | string list | Optional model-level tool allowlist. |
| `reasoningEffort` | string or `{ levels, default }` | Supported reasoning levels for this model. Use the model's own level names. |
| `fallback` | handle or handle list | Candidate(s) to try when this model cannot run. |

Accepted compatibility/metadata fields in the zod schema:

| Field | Status |
|---|---|
| `card.goodFor`, `card.avoidFor`, `card.notes` | Advisory metadata accepted by the schema; not part of the current routing surface. |
| `price.inPerMtok`, `price.outPerMtok` | Cost metadata accepted by the schema. |

`fallback` is transitive and cycle-safe. It is used when the selected model cannot run because a
provider, key, runtime, concurrency slot, breaker, or binary is unavailable. A model with no
`fallback` runs or fails; the orchestrator may then choose a different handle.

```yaml
providers:
  anthropic:
    protocol: anthropic
    auth: subscription
    models:
      claude-opus-4-8:
        fallback: openai/gpt-5.5
  openai:
    protocol: openai
    auth: api-key
    keyEnv: OPENAI_API_KEY
    models:
      gpt-5.5:
        fallback: local/gpt-5.5
```

## Handles

A runnable model handle is:

```text
[runtime/]provider/model
```

Examples:

```yaml
defaults:
  model: anthropic/claude-opus-4-8

providers:
  opencode:
    protocol: opencode
    auth: subscription
    models:
      opencode/north-mini-code-free: {}
```

- `provider/model` lets delegator infer the runtime from the provider's `protocol` and `auth`.
- `runtime/provider/model` forces a runtime, for example `pi/openai-codex/gpt-5.5`.
- Resolution is provider-greedy: if `opencode/opencode/north-mini-code-free` matches provider
  `opencode` and model id `opencode/north-mini-code-free`, it is treated as that provider/model, not
  as runtime `opencode`.
- Slash-bearing model ids such as `opencode/north-mini-code-free` and `liquid/lfm2.5-1.2b` are valid.

## Reasoning effort

Reasoning effort is a per-**runtime** catalog. A runtime descriptor declares which levels its CLI's
reasoning flag accepts plus a default; a model **inherits** that catalog unless it narrows it. Each
built-in runtime maps its `effortLevels` to a different flag and vocabulary:

| Runtime | CLI surface | `effortLevels.levels` | `default` |
|---|---|---|---|
| `codex` | `-c model_reasoning_effort=` | `minimal, low, medium, high, xhigh` | `medium` |
| `claude` | `--effort` | `low, medium, high, xhigh` | `medium` |
| `opencode` | `--variant` | `low, medium, high, xhigh` | `medium` |
| `pi` | `--thinking` | `low, medium, high, xhigh` | `medium` |
| `api` | request body `reasoning.effort` | `minimal, low, medium, high` | `medium` |

A descriptor carries the catalog as `effortLevels` (in `runtimes.yaml`, or the packaged
`runtimes.default.yaml`):

```yaml
runtimes:
  codex:
    effortLevels:
      levels: [minimal, low, medium, high, xhigh]
      default: medium
```

A model **inherits** its runtime's `effortLevels` and default — declare nothing and the model accepts
the full runtime catalog:

```yaml
providers:
  openai-codex:
    protocol: openai
    auth: subscription
    defaultRuntime: codex
    models:
      gpt-5.5: {}          # inherits codex's [minimal…xhigh]; default medium
```

A model MAY narrow the catalog with its own `reasoningEffort: { levels, default }`. It must be a
**subset** of the runtime catalog: a level outside the runtime catalog is a load warning, not an
error:

```yaml
    models:
      gpt-5.5:
        reasoningEffort:
          levels: [minimal, low, medium, high]   # narrows codex's catalog (drops xhigh)
          default: low                            # overrides the runtime default of medium
```

For a fixed single-level model, use a plain string — the model accepts exactly that one level:

```yaml
        reasoningEffort: high
```

Precedence is three tiers. The **effective level set** is the model's `levels` when it declares
`reasoningEffort`, otherwise the runtime catalog; `--effort` is validated against that set and a value
outside it is rejected at run time:

```text
CLI --effort <level>  >  model reasoningEffort.default  >  runtime effortLevels.default
```

## Defaults

`defaults` supplies run-level behavior and the bare `dlg run` target.

```yaml
defaults:
  model: anthropic/claude-opus-4-8
  policy: review
  tools: [Read, Edit, Bash]
  budget:
    wallClock: 15m
  checkpointSeconds: 90
  stallSeconds: 300
  silenceKillSeconds: 600
  retries:
    rateLimit: 3
    server: 2
  breaker:
    failures: 3
    cooldown: 10m
```

Current defaults fields:

| Field | Values | Meaning |
|---|---|---|
| `model` | handle | Target for bare `dlg run`. |
| `policy` | `auto`, `review`, `plan-first` | Apply/review behavior for results. |
| `tools` | string list | Optional global tool allowlist. |
| `budget.wallClock` / `budget.wallClockMs` | duration or milliseconds | Default wall-clock budget; use this for normal run sizing. |
| `checkpointSeconds` | positive integer | Progress check interval. |
| `stallSeconds` | positive integer | Stop threshold for stale progress. |
| `silenceKillSeconds` | positive integer | Stop threshold for total worker silence. |
| `retries.rateLimit` | non-negative integer | Retry count for rate-limit failures. |
| `retries.server` | non-negative integer | Retry count for server/network failures. |
| `breaker.failures` | positive integer | Consecutive hard failures before opening the circuit breaker. |
| `breaker.cooldown` | duration or milliseconds | Time before a failed provider/model is tried again. |

Accepted compatibility/operations fields in the zod schema:

| Field | Status |
|---|---|
| `isolation` | Tolerated input field; current shipped isolation is worktree-based. |
| `keepRuns` | How many finished-run receipts (envelope + `patch.diff` + logs — light, KB each) are kept per project; oldest pruned. |
| `worktreeRetention` | Fate of a run's heavy git checkout (often 100s of MB); `patch.diff` is kept either way, so `dlg apply` always works. `keep-unfinished` (default): drop it for completed runs, keep it for killed/failed/partial so their work stays recoverable. `on-finish`: always drop when the run ends. `keep`: never auto-drop (only `keepRuns` prunes it). Reclaim existing piles with `dlg clean --worktrees`. |
| `queueTimeoutSeconds` | Queue wait timeout. |
| `queuePollSeconds` | Queue poll interval. |
| `keyCooldown` | Duration a failed key is parked after key-specific failures. |
| `escapeIgnore` | Legacy ignored field. Do not use it. |
| `autoApply.maxFiles`, `autoApply.maxLines` | Legacy auto-apply thresholds accepted by schema; not part of the current documented shape. |

Precedence summary:

```text
CLI flag > model field > defaults field
```

This applies to budget, tool allowlists, and reasoning effort where the runtime supports them.

## Privacy

```yaml
privacy:
  sensitivePaths:
    - "**/.github/workflows/**"
    - "**/package.json"
    - "**/*.lock"
```

`privacy.sensitivePaths` is a list of glob strings. If a diff touches a matching path, delegator
forces manual review. `privacy.externalWorkers` and provider `trust` are removed and are not accepted
as current config.

## Secrets

API key values live in `~/.delegator/secrets.yaml`, keyed by provider id:

```yaml
openai: "sk-..."
deepseek:
  - "key-1"
  - "key-2"
```

`keyEnv` in `providers.yaml` is only an environment variable name:

```yaml
providers:
  openai:
    protocol: openai
    auth: api-key
    keyEnv: OPENAI_API_KEY
```

Never put raw keys in `providers.yaml`, project `.delegator.yaml`, docs, logs, or worker briefs.

## Runtime descriptors

Runtime descriptors are loaded from packaged `runtimes.default.yaml`, then optional
`~/.delegator/runtimes.yaml`, then any legacy global runtime block. A runtime says how to execute a
model; the trust fabric sits outside it.

> **Codex is Responses-API only.** The built-in `codex` runtime speaks the OpenAI Responses API
> exclusively — a Chat-Completions-only provider (z.ai/GLM, MiMo over OpenAI, …) cannot be driven
> through `codex`; route those via the `claude` runtime (anthropic endpoint) or the `api` runtime
> (chat/completions).

```yaml
runtimes:
  echo:
    mode: command
    command: node
    args:
      - -e
      - "process.stdin.pipe(process.stdout)"
    prompt: { mode: stdin }
    parser: builtin:generic-lines
```

Descriptor fields:

| Field | Values | Meaning |
|---|---|---|
| `mode` | `command`, `direct-api` | Spawn a command or execute in-process HTTP. Default is `command`. |
| `command` | string | Binary/command for `mode: command`. |
| `protocol` | `anthropic`, `openai`, `opencode`, `none` | Provider compatibility used for runtime inference. |
| `auth` | auth value or list | Compatible provider auth modes. |
| `args` | list of strings or string arrays | argv template. Nested arrays are conditional groups. |
| `prompt.mode` | `stdin`, `argv-last`, `file` | How the brief is delivered. |
| `env` | string map | Environment template. Empty rendered values are dropped. |
| `authEnv` | list of name-prefixes | Host env var name-prefixes this runtime's CLI uses for its OWN subscription login (e.g. `[ANTHROPIC, CLAUDE]` for `claude`). Before spawning a worker, delegator strips credential-looking host env vars so a worker can't read other providers' keys; `authEnv` is the exception, preserved **only** for `auth: subscription` workers so the runtime's own login survives. An `api-key` worker still gets the host stripped — its key arrives via `env` — so one provider's login never leaks into another's worker. |
| `parser` | parser id or `none` | Output parser. `none` is used for in-process direct API descriptors. |
| `output.parser` | parser id | Alternate parser location; normalized into `parser`. |
| `output.itemsPath`, `output.idPath` | strings | Optional catalog-output selectors. |
| `request.method` | string | Direct-api HTTP method. |
| `request.path` | string | Direct-api HTTP path. |
| `request.headers` | string map | Direct-api headers template. |
| `request.json` | any JSON value | Direct-api JSON body template. |
| `equipment` | mapping | Descriptor-owned equipment metadata; runtime-specific code may interpret it. |

Nested-array args are dropped as a group when any placeholder inside that group renders empty:

```yaml
args:
  - exec
  - --json
  - - -m
    - "{{model.id}}"
```

The closed placeholder set used by command descriptors is:

| Placeholder | Meaning |
|---|---|
| `{{model.id}}` | Selected model id. |
| `{{reasoningEffort}}` | Resolved reasoning effort, if any. |
| `{{permissionMode}}` | Resolved permission mode, if any. |
| `{{worktree}}` | Run worktree path. |
| `{{promptFile}}` | Temp prompt file path for `prompt.mode: file`. |
| `{{budget.wallClockMs}}` | Wall-clock budget in milliseconds. |
| `{{provider.baseUrl}}` | Provider base URL, if any. |
| `{{provider.id}}` | Provider id. |
| `{{secret}}` | Resolved provider secret. |
| `{{secret(provider.id)}}` | Resolved provider secret. |
| `{{tier.tools}}` | Legacy tier tool list joined by commas, if present. |
| `{{worktreeBoundaryPrompt}}` | Runtime-specific worktree boundary prompt. |

Defaulted token syntax is accepted; shipped descriptors use:

```yaml
args:
  - "{{reasoningEffort:medium}}"
  - "{{permissionMode:bypassPermissions}}"
```

Builtin parser preset ids in `src/parsers/registry.ts` are exactly:

```text
builtin:generic-lines
builtin:claude-stream-json-events
builtin:codex-exec-json-events
builtin:opencode-run-json-events
builtin:pi-json-events
builtin:openai-chat        # response parser for the direct-api (openai-compatible) runtime
```

`parser: none` is not a preset; it marks an in-process direct-api descriptor in the shipped runtime
loader. A descriptor that names `builtin:generic-lines` needs no parser code. Adding an agent is a
`runtimes.yaml` block plus a new parser preset only when the output format is novel.

