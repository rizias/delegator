# Delegator architecture

Status: the shipped config/runtime model.

---

## 1. Roles

Delegator splits work into three roles:

| Role | Responsibility |
|---|---|
| Brain | The current host agent writes the brief, chooses the model handle, reviews the result, and applies or rejects patches. |
| Dispatch | `delegator` creates bounded runs, isolates work, launches runtimes, watches progress, verifies output, and writes envelopes. |
| Hands | A command-line agent or direct API call executes one bounded task in its run context. |

Core invariants:

- The core makes no LLM routing or planning decisions.
- Every run is bounded by a wall-clock budget. Spawned command runtimes additionally get stall and
  silence detection from a checkpoint watchdog; a `direct-api` run is a single abortable HTTP call,
  so wall-clock is its only bound.
- Workers are untrusted: verification and apply decisions belong to the core and the Brain, not to worker self-report.
- The common interface is the CLI plus host skills for agents.

---

## 2. Config model

The shipped user-facing registry is provider-first. The handles below are examples; yours depend on
your config:

```yaml
version: 1

defaults:
  model: anthropic/claude-opus-4-8
  policy: review
  budget: { wallClock: 15m }

privacy:
  sensitivePaths: []

providers:
  anthropic:
    protocol: anthropic
    auth: subscription
    models:
      claude-opus-4-8:
        fallback: openai/gpt-5.5
```

Models live under providers and are addressed as `[runtime/]provider/model`. Routing fallback is a
per-model property:

```yaml
providers:
  openai:
    protocol: openai
    auth: api-key
    keyEnv: OPENAI_API_KEY
    models:
      gpt-5.5:
        fallback:
          - opencode/opencode/north-mini-code-free
          - local/gpt-5.5
```

New docs, examples, and scaffolds use provider/model handles plus `defaults.model`. The older
surfaces still work and are validated by the schema: named `workers:` profiles and `tiers:` (an
ordered `chain` with its own `fallback` mode) remain a supported routing path — `dlg run --tier <name>`
walks the chain. Legacy `kind:` also still loads.

`trust` and `privacy.externalWorkers` are removed. Privacy uses `privacy.sensitivePaths`; provider
selection is explicit in the Brain's chosen handle and optional model fallback chain.

### Parking a provider or model

A provider or a single model may carry `disabled: true`. A parked entry keeps its configuration and
comments but receives no work:

```yaml
providers:
  zai:
    disabled: true            # whole provider parked
    models:
      glm-5.2: {}
  openai-codex:
    models:
      gpt-5.3-codex-spark:
        disabled: true        # one model parked, siblings stay live
```

Parked entries are excluded from selection, fallback chains, council membership, model discovery and
queue capacity, and a direct run against one fails with a config error naming the re-enable command.
They remain **visible** in `dlg providers` with status `disabled` — parking hides a worker from
routing, not from inspection. `dlg provider disable|enable <provider> [model]` edits the toggle line
in place; formatting and comments are preserved, except that disabling a model inside a shorthand
`models: [a, b]` list converts that list into a mapping, which is the one case that reflows.

Keys never belong in provider config. For compatibility, a raw `apiKey:` value (or a key pasted into
`apiKeyEnv:`) found in the **global** `providers.yaml` is migrated into `secrets.yaml` on load; a
project config that carries a secret is rejected outright.

---

## 3. Runtime descriptors

Runtimes are descriptors, not a hardcoded TypeScript map. The loader merges, in order:

1. packaged `runtimes.default.yaml`;
2. user `~/.delegator/runtimes.yaml`;
3. `runtimes:` declared in the loaded config.

An override **replaces** the packaged runtime's identity — `command`, `protocol`, `auth`, `args`,
`parser`, `prompt`: omitting one of those there means "unset". It still **inherits** the packaged
additive defaults: the `env` map is merged key-by-key (override values win) and `authEnv` carries
over unless an explicit `authEnv: []` opts out. That inheritance exists because a copied
`runtimes.yaml` goes stale the moment delegator adds an env var, and a flat replace silently dropped
the login namespace.

A descriptor declares mechanism:

```yaml
runtimes:
  codex:
    mode: command
    command: codex
    protocol: openai
    auth: subscription
    args:
      - exec
      - --json
      - --sandbox
      - workspace-write
      - - -m
        - "{{model.id}}"
      - - -c
        - model_reasoning_effort="{{reasoningEffort:medium}}"
      - "-"
    prompt: { mode: stdin }
    parser: builtin:codex-exec-json-events
```

Runtime modes:

- `mode: command` spawns a process with rendered `args`, rendered `env`, an isolated `cwd`, and a
  prompt delivered by `stdin`, `argv-last`, or a temp `file`.
- `mode: direct-api` represents an in-process HTTP call using a descriptor `request` block
  (`method`, `path`, `headers`, `json`).

Parser presets are named code hooks for output formats. The shipped preset ids are:

```text
builtin:generic-lines
builtin:claude-stream-json-events
builtin:codex-exec-json-events
builtin:opencode-run-json-events
builtin:pi-json-events
builtin:openai-chat        # response parser for the direct-api (openai-compatible) runtime
```

Adding a typical command-line agent is a `runtimes.yaml` block. If it can be parsed as generic line
output, `builtin:generic-lines` needs no code. A new parser preset is only needed for a novel event
format.

The trust fabric is outside runtime adapters: isolation, verification, circuit breakers, key
cooldown, concurrency, retry, fallback planning, envelopes, and apply policy are core behavior.
A runtime descriptor can launch a tool; it does not decide whether the result is trusted.

---

## 4. Routing and availability

The Brain selects a handle directly, names a tier, or lets `dlg run` use `defaults.model`.

```text
provider/model
runtime/provider/model
```

Handle resolution is provider-greedy so slash-bearing model ids address directly:

```text
opencode/opencode/north-mini-code-free
lmstudio/liquid/lfm2.5-1.2b
pi/openai-codex/gpt-5.5
```

Per-model `fallback` expands into an ordered candidate chain. The chain is transitive and cycle-safe;
parked (`disabled`) entries are dropped from it. The envelope records the candidate that actually ran
and any skipped candidates.

Fallback is attempted when a candidate cannot run — provider, key, runtime, or binary unavailable,
breaker open — and when a run fails with a classified provider failure. **Concurrency saturation is
not a fallback trigger**: a run waits for a slot in its scope, and if the queue times out the run
ends `rejected` rather than moving down the chain. A handle that is explicitly selected but
unconfigured or disabled fails immediately with a config error instead of silently falling over.

Availability combines config validation, the `disabled` toggle, key presence, local-provider
detection, binary presence, provider/model concurrency, and breaker state. Local OpenAI-compatible
providers on `localhost`, `127.0.0.1`, `[::1]`, or `::1` do not require a key.

---

## 5. Run lifecycle

A run record moves through these states:

```text
queued -> preparing -> running -> collecting -> verifying -> done
```

- `preparing`: resolve handle/fallback chain, create the isolated work area (spawned runtimes only —
  a direct-api run skips it), write the brief, render runtime descriptor inputs.
- `running`: execute the command runtime or direct-api runtime, stream events, update heartbeat. For
  spawned runtimes a checkpoint watchdog runs alongside, enforcing the wall-clock budget, stall
  detection, silence detection, and process cleanup. Checkpointing is that watchdog, not a state.
- `collecting`: gather final summary, usage, diff, and stop reason.
- `verifying`: run configured build/test/lint commands in the worker's work area.
- `done`: write the envelope with status, attempts, diff, verification, usage, errors, and stop reason.

`awaiting-approval` also exists in the state vocabulary but is never entered today — see §8.

Terminal statuses include `completed`, `partial`, `requires-review`, `failed`, `killed-timeout`,
`killed-no-progress`, and `rejected`.

**Finalization guarantee.** Once the run record exists, it always reaches a terminal state. Any
unexpected throw is recorded as a terminal `rejected` envelope rather than leaving the run stranded
in `preparing`; a config error still propagates to the caller (exit 2) but only after the run is
closed. An explicit `--effort` level the resolved worker does not declare is a clean skipped
candidate, not a crash.

**Orphan reaping.** Every run is stamped with its owning delegator process id at creation. If that
process exits before the run finishes (crash, Ctrl-C, a killed `dlg council` parent), the next run
listing (`dlg status`) closes the run as `failed` (reason: orphaned), so a dead process never leaves
a run stuck in a non-terminal state. Known limitation: reaping closes the run *record* only. A
spawned worker that outlived its owner is deliberately **not** killed — liveness here is judged by
PID, and a recycled (or zero) PID would mean signalling an unrelated process. Reclaiming such a
worker safely needs process-birth identity and is not implemented.

### Council fan-out

`dlg council` composes this same lifecycle N times in parallel — every member is a plain
`executeRun` (forced `review` policy, `skipPrune` so retention cannot delete an early-finished
sibling before gathering; pruning happens once after the gather). The command validates the model
list (≥2 distinct handles; same-family pairs warn), fails fast on unknown handles, and returns
candidates plus an aggregate-and-synthesize bundle.

Unless a member declares its own `reasoningEffort`, council asks each worker to think as hard as
**that worker** can: the intent resolves against the worker's own declared levels (ordered
weakest→strongest) rather than a fixed cross-model literal, so no member is sent a level its CLI
rejects.

By default the core produces no final answer — synthesis belongs to the calling agent, which holds
the conversation context. Naming an `--aggregate <handle>` runs one more worker to synthesize and
fills `final`; that is intended for headless callers, and avoiding it interactively is host policy,
not a core restriction. Hang protection is the ordinary per-run machinery; a dead member becomes a
`failed`/`killed-*` candidate with a warning, and a shortfall below `minProposers` is reported
(`quorumMet`, `stopReason: degraded`) — that degraded result may hold zero, one, or several usable
answers, and is never auto-repaired.

---

## 6. Isolation and verification

A spawned run works in an isolated copy of the target directory, never in the user's tree:

- a **git worktree** created from the current `HEAD` when the target is a git repository — workers
  see tracked files there and return a patch;
- a **copied workspace** plus a `pristine` baseline when it is not; the patch is the diff between the
  two.

`dlg apply` is the path back to the user's tree. A `direct-api` run is one HTTP call with no work
area and no patch.

Verification is core-owned. Project config may declare:

```yaml
verify:
  build: "npm run build"
  test: "npm test"
  lint: "npm run lint"
```

Worker claims do not substitute for verification output. If a patch touches files that judge the run
itself — tests, test config, CI, snapshots, fixtures, package manifests or lockfiles — the run is
forced to `requires-review`.

Verification runs your configured build/test/lint commands inside the worker's work area. Isolation
is not an offline or network-sandbox guarantee.

Codex sandbox handling fails closed: codex runs with `--sandbox workspace-write`, and structured
file-change events are checked so paths outside the work area fail the run as isolation-unverified.
The runtime adapter does not own this policy; it is core safety behavior.

**Teardown safety.** Removing a work area must never follow a link out of it. Git-for-Windows
`git worktree remove --force` walks junctions and symlinks — a linked or pnpm-materialized
`node_modules` — into the real repository and deletes their targets, so delegator does **not** call
it. Teardown instead detaches every reparse point it finds (removing each as a link, never
descending into it), deletes the tree itself with `fs.rm`, and then prunes only git's admin metadata.
A containment guard refuses any path that is not a delegator worktree, and copied workspace/pristine
pairs are removed through their own lock-tolerant path. A directory held by a lock is left for a
later pass rather than failing cleanup.

---

## 7. Secrets and local state

Runtime state lives outside the repo under the delegator config/state home. API keys live in
`~/.delegator/secrets.yaml` or in environment variables named by provider `keyEnv`. Provider config
may name where to find a key; a raw key found in the global registry is migrated into `secrets.yaml`
(see §2), and a project config carrying a secret is rejected.

Worker environments receive only the resolved key for the selected provider. Keys are never printed
into docs, logs, envelopes, or worker briefs.

Telemetry is local: run records and envelopes stay on the user's machine.

---

## 8. Policies

`defaults.policy` controls patch handling:

| Policy | Behavior |
|---|---|
| `review` | Default. Never apply automatically; the Brain/user reviews and applies. |
| `auto` | May apply only when verification and strict safety gates pass. |
| `plan-first` | Accepted by the CLI and schema, but **not implemented** — it currently behaves exactly like `review`. |

`plan-first` is the reason `awaiting-approval` exists in the state vocabulary; no code path enters
that state today. To get a plan instead of a patch, say so in the brief — a worker told not to modify
files returns its analysis as the answer.

Sensitive-path matches, judge tampering, large diffs, verification failures, patch conflicts, and
isolation problems force manual review or failure. Threshold breaches suppress auto-apply; they do
not by themselves change a run's status.

---

## 9. Interfaces

Primary CLI commands:

```text
dlg init
dlg doctor
dlg providers [--json]
dlg models [provider]
dlg provider disable|enable <provider> [model]
dlg route [-w handle]
dlg plan [-w handle]
dlg run [-w handle] (-f brief.md | --task "text") [--budget 10m] [--effort level] [--policy p] [--json]
dlg council -w <h1,h2,h3> (-f brief.md | -m "task") [--budget 10m] [--min-proposers N] [--aggregate handle]
dlg status [runId]
dlg result <runId>
dlg logs <runId> [--tail N]
dlg compare-runs <runId...>
dlg apply <runId>
dlg undo <runId>
dlg kill <runId>
dlg clean <runId | --all | --worktrees>

(plus key, restrict, skill, gain, queue, update — run `dlg --help` for the full set)
```
