# Delegator architecture

Status: the shipped config/runtime model.

---

## 1. Roles

Delegator splits work into three roles:

| Role | Responsibility |
|---|---|
| Brain | The current host agent writes the brief, chooses the model handle, reviews the result, and applies or rejects patches. |
| Dispatch | `delegator` creates bounded runs, isolates worktrees, launches runtimes, watches progress, verifies output, and writes envelopes. |
| Hands | A command-line agent or direct API call executes one bounded task in its run context. |

Core invariants:

- The core makes no LLM routing or planning decisions.
- Every run is bounded by wall-clock time, stall detection, and silence detection.
- Workers are untrusted: verification and apply decisions belong to the core and the Brain, not to worker self-report.
- The common interface is CLI/MCP plus instruction packs for host agents.

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

There is no current `tiers:` routing surface and no current `workers:` profile surface. Legacy
`kind:`, `workers:`, and `tiers:` still load for older configs, but new docs, examples, and scaffolds
use provider/model handles plus `defaults.model`.

`trust` and `privacy.externalWorkers` are removed. Privacy now uses `privacy.sensitivePaths`; provider
selection is explicit in the Brain's chosen handle and optional model fallback chain.

---

## 3. Runtime descriptors

Runtimes are descriptors, not a hardcoded TypeScript map. The loader merges:

1. packaged `runtimes.default.yaml`;
2. optional user `~/.delegator/runtimes.yaml`;
3. any legacy runtime descriptors still accepted by config loading.

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

- `mode: command` spawns a process with rendered `args`, rendered `env`, a worktree `cwd`, and a
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

The trust fabric is outside runtime adapters: worktree isolation, verification, circuit breakers,
key cooldown, concurrency, retry, fallback planning, envelopes, and apply policy are core behavior.
A runtime descriptor can launch a tool; it does not decide whether the result is trusted.

---

## 4. Routing and availability

The Brain selects a handle directly or lets `dlg run` use `defaults.model`.

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

Per-model `fallback` expands into an ordered candidate chain. The chain is transitive and cycle-safe.
Fallback is attempted when a candidate cannot run because its provider, key, runtime, binary,
concurrency slot, or breaker state blocks it. The envelope records the candidate that actually ran
and any skipped candidates.

Availability combines config validation, key presence, local-provider detection, binary presence,
provider/model concurrency, and breaker state. Local OpenAI-compatible providers on `localhost`,
`127.0.0.1`, `[::1]`, or `::1` do not require a key.

---

## 5. Run lifecycle

```text
QUEUED -> PREPARING -> RUNNING <-> CHECKPOINT -> COLLECTING -> VERIFYING -> DONE
```

- `PREPARING`: resolve handle/fallback chain, create a git worktree, write the brief, render runtime
  descriptor inputs.
- `RUNNING`: execute the command runtime or direct-api runtime, stream events, update heartbeat.
- `CHECKPOINT`: enforce wall-clock budget, stall detection, silence detection, and
  process cleanup.
- `COLLECTING`: gather final summary, usage, diff, and stop reason.
- `VERIFYING`: run configured build/test/lint commands in the worker worktree.
- `DONE`: write the envelope with status, attempts, diff, verification, usage, errors, and stop reason.

Terminal statuses include `completed`, `partial`, `requires-review`, `failed`, `killed-timeout`,
`killed-no-progress`, and `rejected`.

---

## 6. Isolation and verification

Each run uses a separate git worktree created from the current `HEAD`. Workers see tracked files in
that worktree and return a patch. `dlg apply` is the path back to the user's tree.

Verification is core-owned. Project config may declare:

```yaml
verify:
  build: "npm run build"
  test: "npm test"
  lint: "npm run lint"
```

Worker claims do not substitute for verification output. If a patch touches files that judge the run
itself, such as tests, test config, CI, snapshots, or fixtures, the run is forced to
`requires-review`.

Verification runs your configured build/test/lint commands inside the worker worktree. Worktree
isolation is not an offline or network-sandbox guarantee.

Codex sandbox handling fails closed: codex runs with `--sandbox workspace-write`, and structured
file-change events are checked so paths outside the worktree fail the run as isolation-unverified.
The runtime adapter does not own this policy; it is core safety behavior.

---

## 7. Secrets and local state

Runtime state lives outside the repo under the delegator config/state home. API keys live in
`~/.delegator/secrets.yaml` or in environment variables named by provider `keyEnv`. Provider config
may name where to find a key, but must not contain raw key values.

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
| `plan-first` | Worker returns a plan first; execution resumes only after approval. |

Sensitive-path matches, judge tampering, large diffs, verification failures, patch conflicts, and
isolation problems force manual review or failure.

---

## 9. Interfaces

Primary CLI commands:

```text
dlg init
dlg doctor
dlg providers [--json]
dlg models [provider]
dlg route [-w handle]
dlg plan [-w handle]
dlg run [-w handle] (-f brief.md | --task "text") [--budget 10m] [--effort level] [--json]
dlg status [runId]
dlg result <runId>
dlg logs <runId>
dlg compare-runs <runId...>
dlg apply <runId>
dlg undo <runId>
dlg kill <runId>
dlg clean <runId | --all | --worktrees>

(plus key, restrict, skill, gain, queue, update — run `dlg --help` for the full set)
```

MCP tools mirror the same operations for host agents that prefer tool calls over shell commands.

