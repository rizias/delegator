---
name: delegator
description: Dispatch well-specified coding tasks to a separate-pool worker via the delegator CLI (dlg) instead of burning your own tokens. Use when the user says "delegator", "delegate this", "hand it to a worker", asks to save tokens on a mechanical or standard coding task, or a well-specified task needs no conversation context. Do not use for trivial one-off edits, tasks needing conversation context, or security-sensitive code.
metadata:
  delegator-skill-version: "2026-07-02T12:00:00Z"
---

# delegator — for a Codex orchestrator

> **Host skill:** this teaches *you, the orchestrator*, when and how to delegate via `dlg`. It is a
> separate concern from **worker equipment** (`equip.skills` in config / a worker's `--skill`
> toggle), which loads a skill *into a spawned worker*.

`dlg` (alias `delegator`) is a brainless dispatcher: **you** decide and judge; it spawns a bounded
worker in an isolated git worktree and returns a result envelope. The target project must be a git
repo with at least one commit. **Commit before delegating** — workers see HEAD, not your dirty tree.

## When to delegate

- Secrets / auth / payments in scope → yourself; never hand secret material to a worker.
- Trivial one-off (one read, one-line edit) → yourself; overhead beats the task.
- Needs this conversation's context → yourself; workers start cold (repo + brief only).
- Mechanical or standard implementation, fully specifiable → delegate to a cheap worker.

≤2–3 parallel runs; sequential work = **one** worker; state the batch cost before fanning out;
workers never spawn workers.

## You provision this machine (first run only)

Do it for the user — they should never learn config formats:

1. `npm i -g @rizias/delegator` (same command upgrades later).
2. `dlg init` — creates `~/.delegator/` (`providers.yaml`, `runtimes.yaml`, `secrets.yaml`).
3. Discover what THIS machine has: `dlg doctor` (node; `git`/`claude`/`codex` resolution; available
   workers), plus the user's PATH for other CLIs (opencode, pi…) and API-key env-var **names**
   (`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, …). **Never** read `secrets.yaml`.
4. Confirm intent with the user in plain words — which CLIs/providers to use.
5. Write `~/.delegator/providers.yaml` with **only** what this machine has: per provider `protocol`,
   `auth`, `defaultRuntime` if ambiguous, `keyEnv: <ENV-VAR-NAME>` (a **name** — the user puts the
   key in `secrets.yaml`). Never invent a provider the user lacks. Copy patterns from the shipped
   `examples/providers.example.yaml`; for an OpenAI-compatible vendor not shown there, follow the
   `openai` stanza's shape and take `baseUrl` from the vendor's API docs (ask the user — don't guess).
6. Verify: `dlg providers` (each provider resolves — `available`, or `unconfigured` until its key is
   added) and `dlg plan -w <handle>`; fix any "matches multiple runtimes" by pinning `defaultRuntime`.
7. `dlg skill install codex` (and `… claude-code` for the other orchestrators they use).

To reconfigure from scratch: `rm -rf ~/.delegator && dlg init`, then redo discovery (this also
removes `secrets.yaml`, so the user re-adds keys).

## How it works

**Selection = the handle.** `dlg run -w [runtime/]provider/model`:
- `-w openai-codex/gpt-5.5` — runtime inferred from the provider's `protocol` + `auth`.
- `-w opencode/opencode/north-mini-code-free` — slash-bearing model ids are valid.
- `-w pi/openai-codex/gpt-5.5` — force a runtime.
- Bare `dlg run --task "..."` (no `-w`) uses `defaults.model`.

  Resolution is **provider-greedy**: `a/b/c` is provider `a` + model `b/c` when that model exists,
  and only reads the leading segment as a runtime otherwise.

**Fallback is a property of the model.** A model may declare `fallback: <handle>` or
`fallback: [h1, h2]` in `providers.yaml`, tried **only** when the primary cannot run — circuit
breaker open, rate-limited, missing key, or binary absent. Transitive and cycle-safe. No `fallback` →
runs or fails; then you re-dispatch. Inspect any chain with `dlg route -w <handle>`.

**Reasoning effort** is per-task: `dlg run -w <handle> --effort <level>`, validated against the
model's `reasoningEffort.levels`. Precedence: CLI `--effort` > model default > runtime default.
For a codex-routed model, delegator turns `--effort` into codex's own flag
(`-c model_reasoning_effort="<level>"`) — you still pass `--effort`, never the `-c` flag yourself.

**Provider shape:** `protocol` (`anthropic` | `openai` | `opencode`) + `auth`
(`subscription` | `api-key` | `none`); runtime inferred from those, or pinned with `defaultRuntime`.
`keyEnv` is an env-var **name** only — never a key value.

Runtime inference is unambiguous **except** `openai` + `subscription`, which matches both `codex` and
`pi` → set `defaultRuntime: codex`. **Codex speaks only the OpenAI Responses API: a
Chat-Completions-only provider (z.ai / GLM, etc.) cannot run through the `codex` runtime** — reach it
via `claude` (its anthropic endpoint) or `api` (chat/completions) instead.

## Model economy

You are the orchestrator: you plan, write briefs, and verify. Delegate the **volume** to a worker in
a **separate usage pool** from your own — a worker on the same subscription as you gives zero relief.
Under a Codex orchestrator that means Claude / GLM / local / API-key models — **not** `codex/*` (same
OAuth pool). Keep ≤2–3 parallel runs; sequential work = one worker; state the batch cost before
fanning out; workers never spawn workers. Never read `secrets.yaml`; never copy anyone's auth tokens.

Cheap-worker discipline: small self-contained units (state classes, DTOs, tests, simple hooks,
mechanical edits) — never large cross-system integration. Ask for the smallest COMPILABLE patch
first; name exact files in Scope; keep wiring, tricky logic, and architecture for yourself.

## Commands

```bash
dlg providers [--json]                 # what's available / unconfigured
dlg models <provider>                  # live model list (fetched, never hardcoded)
dlg route -w <handle>                  # resolved fallback chain + availability
dlg plan -w <handle> [-f brief.md]     # dry run: chain, context-fit — NO tokens spent
dlg run -w <handle> [-f brief.md | --task "..."] [--effort ..] [--budget 10m] [--policy review] [--json]
dlg council -w <h1>,<h2>,<h3> [-f brief.md | -m "task"] [--budget 10m] [--min-proposers 2] [--aggregate <model>]
dlg status [id] · dlg logs <id> --tail 20 · dlg result <id> --json
dlg apply <id> · dlg undo <id>         # apply a reviewed patch / roll it back (the only write paths)
dlg doctor · dlg gain --history        # diagnose env · per-run savings report
```

## Council — one task across several models

`dlg council -w <h1,h2,h3> -m "<task>"` fans ONE task to several workers **in parallel** (each a plain
`dlg run`: review policy, own sandbox, per-worker `--budget`) and returns every worker's full answer +
diff + tokens plus an aggregate-and-synthesize `bundle`. **No final answer is produced — YOU aggregate:**
read `candidates` + `bundle` and synthesize yourself (evaluate critically, drop weak parts, don't reward
length). `--aggregate <model>` is for headless runs only; never interactively.

- **When:** open-ended tasks with no oracle (design, review, analysis, research). NOT mechanical coding
  (one worker), NOT short-form writing (synthesis bloats tight prose). ~4x pool tokens vs one model.
- **Models:** 2–4 DIFFERENT strong families, per task (diversity = different families; no temperature
  through harnesses). `card.goodFor` is an optional hint; avoid weak members (they drag the aggregate down).
- **No config.** Flags: `--budget` (per worker), `--min-proposers` (default 2). Fewer usable answers →
  `quorumMet: false`, `stopReason: degraded` (a single opinion, not a council) — report it honestly.
- **Envelope:** each candidate has `runId`, full `answer`, `tokens` incl. reasoning (report per-worker +
  totals — always), `warnings`. Works without git.

## Budget choice and recovery

Use `--budget` (wall-clock) for normal run sizing, especially for review, research, and exploration.

## Brief & envelope

The only hard brief rule is non-empty; a clear structure (Goal / Scope / Constraints /
Definition of done / Output / Forbidden) still wins. On the envelope: `completed` → review
`patch.diff` then `dlg apply`; `partial`/`requires-review` → work may be finished,
review before re-running; `killed-*` → read `stopReason`, inspect logs/result, then apply partial
work or re-dispatch;
`rejected` (unconfigured) → check `dlg providers`; `failed` → one retry on a fallback, then
escalate. Trust the envelope's verification block, not the worker's claims.

**Filing a bug (optional):** if the user wants to report a failure, collect facts only — **don't
narrate the logs** — into a paste-ready block for https://github.com/rizias/delegator/issues:
`dlg --version`, `dlg doctor`, the command + handle, `status`/`stopReason`/`errors[].detail` from
`dlg result <id> --json`, and the relevant config snippet **with every key stripped** (never
`secrets.yaml`). Filing is the user's choice, never automatic.

Keys live in `~/.delegator/secrets.yaml` — **never** read it. Adding a key is the user's action:
`echo <KEY> | dlg key set <provider>`.
