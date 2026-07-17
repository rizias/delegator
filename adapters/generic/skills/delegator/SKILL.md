---
name: delegator
description: Dispatch well-specified coding tasks to a separate-pool worker via the delegator CLI (dlg) instead of burning your own tokens. Use when the user says "delegator", "delegate this", "hand it to a worker", asks to save tokens on a mechanical or standard coding task, or a well-specified task needs no conversation context. Do not use for trivial one-off edits, tasks needing conversation context, or security-sensitive code.
metadata:
  delegator-skill-version: "2026-07-17T00:00:00Z"
---

# Delegator — dispatch work to a separate-pool worker

`dlg` (alias `delegator`) is a brainless dispatcher: **you** decide and judge; it spawns a bounded
worker in an isolated git worktree and returns a result envelope. Call `dlg` directly (this skill
teaches you when and how). Requires: the target project is a git repo with at least one commit.

> This **host** skill teaches *you, the orchestrator*, when and how to delegate. It is a different
> concern from **worker equipment** (`equip.skills` in config / a worker's `--skill` toggle), which
> loads a skill *into a spawned worker*. Don't conflate them.

## When to delegate (first match wins)

1. Secrets / auth / payments in scope → do it yourself; never hand secret material to a worker.
2. Trivial one-off (one read, one-line edit) → yourself; delegation overhead exceeds the task.
3. Needs this conversation's context → yourself; workers start cold (repo + brief only).
4. Mechanical or standard implementation, fully specifiable → delegate to a cheap worker.
5. **Commit before delegating** — workers see HEAD, not your dirty tree.

Fan-out discipline: ≤2–3 parallel runs, sequential work = **one** worker, state the batch cost
before launching, workers never spawn workers.

## You provision this machine (first run only)

When the user wants delegator installed or a fresh machine set up, do it for them — they should
never have to learn config formats:

1. **Install:** `npm i -g @rizias/delegator`. To upgrade later, run the same command again.
2. **`dlg init`** — creates `~/.delegator/` with `providers.yaml`, `runtimes.yaml`, and
   `secrets.yaml` templates. Safe to re-run: it creates only missing files, never overwrites.
3. **Discover what THIS machine actually has:** `dlg doctor` (node version; whether `git`/`claude`/
   `codex` resolve; how many workers are available) and check the user's PATH for other CLIs
   (opencode, pi…) and for API-key env-var **names** (`OPENAI_API_KEY`, `DEEPSEEK_API_KEY`, …).
   **Never** read `secrets.yaml`.
4. **Confirm intent in plain words** with the user — which CLIs and providers they want to use.
5. **Write `~/.delegator/providers.yaml` containing ONLY what this machine has.** Per provider:
   `protocol`, `auth`, `defaultRuntime` only if ambiguous (see Provider shape), and
   `keyEnv: <ENV-VAR-NAME>` (a **name** — the user pastes the actual key into `secrets.yaml`). Never
   invent a provider the user lacks. Copy patterns from the shipped `examples/providers.example.yaml`;
   for an OpenAI-compatible vendor not shown there (DeepSeek, NVIDIA, Gemini, …) follow the `openai`
   stanza's shape and take its `baseUrl` from the vendor's API docs (ask the user — don't guess a URL).
   Use the model ids the user names; refine with `dlg models <provider>` after the key is in
   `secrets.yaml` (a key-less provider can't be queried yet).
6. **Verify before declaring done:** `dlg providers` — every provider you wrote resolves (status
   `available`, or `unconfigured` only until the user adds its key); spot-check `dlg plan -w <handle>`.
   Resolve any "matches multiple runtimes" error by pinning `defaultRuntime`.
7. **Install the host skill** for every orchestrator they run: `dlg skill install agent-skills`
   (universal — any Agent Skills-compatible agent), plus `dlg skill install claude-code` or
   `dlg skill install codex` for those specific orchestrators, so each session knows how to delegate.

To reconfigure from scratch: `rm -rf ~/.delegator && dlg init`, then redo discovery (this also
removes `secrets.yaml`, so the user re-adds their keys).

## How delegator works (the model you must hold)

**Selection = the handle.** `dlg run -w [runtime/]provider/model`:
- `-w openai-codex/gpt-5.5` — runtime inferred from the provider's `protocol` + `auth`.
- `-w opencode/opencode/north-mini-code-free` — slash-bearing model ids are valid.
- `-w pi/openai-codex/gpt-5.5` — force a specific runtime.
- Bare `dlg run --task "..."` (no `-w`) uses `defaults.model`.

  Resolution is **provider-greedy**: `a/b/c` is provider `a` + model `b/c` when that model exists,
  and only reads the leading segment as a runtime otherwise.

**Fallback is a property of the model.** A model may declare `fallback: <handle>` or
`fallback: [h1, h2]` in `providers.yaml`. It is tried **only** when the primary cannot run — circuit
breaker open, rate-limited, missing key, or binary absent. It is transitive (each fallback follows
its own) and cycle-safe. A model with no `fallback` runs or fails; then you re-dispatch. Inspect any
chain with `dlg route -w <handle>`.

**Reasoning effort** is per-task: `dlg run -w <handle> --effort <level>`, validated against the
model's declared `reasoningEffort.levels`. Precedence: CLI `--effort` > model default > runtime
default.

**Provider shape:** `protocol` (`anthropic` | `openai` | `opencode`) + `auth`
(`subscription` | `api-key` | `none`); the runtime is inferred from those, or pinned with
`defaultRuntime`. `keyEnv` is an env-var **name** only — never a key value.

Runtime inference is unambiguous **except** `openai` + `subscription`, which matches both `codex` and
`pi` → set `defaultRuntime: codex` (or `pi`). **Codex speaks only the OpenAI Responses API: a
Chat-Completions-only provider (z.ai / GLM, MiMo over OpenAI, etc.) cannot run through the `codex`
runtime** — reach it via `claude` (its anthropic endpoint) or `api` (chat/completions) instead.

## Model economy

You are the orchestrator: you plan, write briefs, and verify. Delegate the **volume** to a worker in
a **separate usage pool** from your own — a worker on the same subscription or account gives no token
relief. Whatever orchestrator you are, pick a worker on a *different* pool: a Claude orchestrator uses
codex / GLM / opencode (not another `claude/*`); a Codex orchestrator uses Claude / GLM (not
`codex/*`). A worker's pool is the **account it bills** (its key or login), not the runtime it uses:
a z.ai/GLM worker runs on the `claude` runtime yet draws on your z.ai key — a separate pool that
*does* relieve you. Only a worker on your own subscription/login shares your pool.
Keep ≤2–3 parallel runs; sequential work = one worker; state the batch cost before fanning out;
workers never spawn workers. Never read `secrets.yaml`; never copy anyone's auth tokens.

Self-review counts as delegation too: if you would spawn several agents to review or analyse your
own work, prefer separate-pool workers when practical — one `dlg run` per review angle, or
`dlg council` for independent full passes; the usual fan-out discipline applies.

Cheap-worker discipline still applies: give a cheap worker small, self-contained units (state
classes, DTOs, tests, simple hooks, mechanical edits) — never large cross-system integration. Ask
for the smallest COMPILABLE patch first; name the exact files in Scope; keep wiring, tricky logic,
and architecture with yourself. Iterate with a second run rather than asking for everything at once.

## Commands

```bash
dlg providers [--json]                 # what's available / unconfigured right now
dlg models <provider>                  # live model list a provider offers (fetched, never hardcoded)
dlg route -w <handle>                  # resolved fallback chain + each candidate's availability
dlg plan -w <handle> [-f brief.md]     # dry run: chain, context-fit — NO tokens spent
dlg run -w <handle> [-f brief.md | --task "..."] [--effort ..] [--budget 10m] [--policy review] [--json]
dlg council -w <h1>,<h2>,<h3> [-f brief.md | -m "task"] [--budget 10m] [--min-proposers 2] [--aggregate <model>]
dlg status [id]                        # runs / live state with last-activity age
dlg logs <id> --tail 20                # worker event stream (works mid-run)
dlg result <id> --json                 # the result envelope
dlg apply <id> · dlg undo <id>         # apply a reviewed patch / roll it back (the only write paths)
dlg doctor · dlg gain --history        # diagnose env · per-run savings report
```

Run long tasks in the background; poll `dlg status <id>` or read the final envelope when done.

## Council — one task across several models

`dlg council -w <h1,h2,h3> -m "<task>"` fans ONE task out to several workers **in parallel** (each is a
plain `dlg run`: review policy forced, own sandbox, per-worker `--budget`) and returns every worker's FULL
answer + diff + tokens, plus a ready aggregate-and-synthesize `bundle`. **The command produces NO final
answer — YOU are the aggregator:** read `candidates` + `bundle` and synthesize the final yourself with
conversation context (evaluate critically, discard weak or wrong parts, do not merge blindly, do not
reward length). `--aggregate <model>` exists ONLY for headless runs with no live orchestrator; never use
it interactively — a same-family aggregator is a redundant pass.

- **When:** open-ended tasks with no test/oracle (design decisions, reviews, analysis, research) where one
  model's blind spots matter. NOT for mechanical coding — delegate that to ONE worker. NOT for short-form
  writing (a 15-line quickstart, a ≤120-word blurb): synthesis bloats tight prose. Expect ~4x worker-pool
  tokens per task versus one model.
- **Picking models:** YOU decide, per task — 2–4 DIFFERENT strong families (diversity comes from different
  families; self-ensembling one model adds nothing measurable — 2026-07-03 evals). A model's `card.goodFor` in
  providers.yaml is a hint when present — it may be absent entirely, which is fine and never blocks you;
  judge fit yourself, ask the user only at a genuine fork. Avoid weak models: a weak member drags the
  aggregate DOWN (quality beats diversity).
- **No council config exists.** Models are always passed per invocation; knobs are plain flags: `--budget`
  (per worker — size with headroom for hard tasks), `--min-proposers` (default 2) — an honesty quorum, not
  control: with fewer usable answers the envelope says `quorumMet: false`, `stopReason: degraded` and the
  result is a single model's opinion, not a council.
- **On `quorumMet: false`:** report it honestly; you MAY offer to add your own independent take (solve the
  task cold yourself as one more voice) — only WITH the user's consent, never silently.
- **Point `--cwd` at the CODE the council must SEE.** Each worker gets its OWN isolated worktree/copy of
  `--cwd` — that is the only code they can read. To review or analyse a codebase, set `--cwd` to the
  project root so they read the LIVE source; a scratch dir holding only a pasted brief makes them review
  BLIND and guess. The brief (`-f <file>`) is read by the orchestrator and may live anywhere. A plain
  `--cwd` is right only for a code-free question (pure design or research).
- **Read the envelope:** every candidate carries `runId` (`dlg logs/result <id>` for its trace), full
  `answer`, `tokens` incl. reasoning (report per-worker + totals to the user — always), and `warnings`
  (failed workers, same-family pairs). Works in a plain folder without git.

## Budget choice and recovery

Use `--budget` (wall-clock) for normal run sizing, especially for review, research, and exploration.

## Brief (recommended shape — not enforced)

The only hard rule is the brief is non-empty. A clear brief still wins; this structure works well:

```markdown
## Goal               — one outcome-oriented paragraph
## Scope              — files/dirs in play; explicit non-goals
## Constraints        — style, deps, APIs to use/avoid
## Definition of done — verifiable statements
## Output             — what the final message must contain (keep it a few lines)
## Forbidden          — what must not be touched; "no commits"
```

## Reading the envelope

- `completed` + patch → review `patch.diff` (path in the envelope), then `dlg apply <id>`.
- `partial` / `requires-review` → work may be **finished**; review the patch
  before re-running.
- `killed-*` → read `stopReason` + last worker output; apply useful partial work or re-dispatch with
  the previous run id and remaining work.
- `rejected` (unconfigured) → check `dlg providers`; do not retry the same handle.
- `failed` → stderr tail is in `errors[].detail`; one retry on a fallback is reasonable, then
  escalate to the user.
- Never trust worker claims over the envelope's verification block.

## Filing a bug (optional)

If a run misbehaves and the user wants to report it, assemble a **facts-only** report they can paste
straight into https://github.com/rizias/delegator/issues. **Do not analyze or narrate the logs** —
just collect the details:

- `dlg --version`, and `dlg doctor` (node, OS, resolved binaries — it has no keys)
- the exact command and worker handle
- from `dlg result <id> --json`: `status`, `stopReason`, and `errors[].detail`
- the relevant `providers.yaml` / `runtimes.yaml` snippet — **strip every key; never include `secrets.yaml`**
- minimal steps to reproduce

Present it as one ready-to-paste fenced block. Filing is always the user's choice — never automatic.

## Keys & safety

**Never read `~/.delegator/secrets.yaml`**, and never copy anyone's auth tokens anywhere. API keys
live there; adding a key is the user's action: `echo <KEY> | dlg key set <provider>`. The registry
`~/.delegator/providers.yaml` is safe to read and edit; `keyEnv` there is a name, not a key.
A worker's key resolves as `secrets.yaml[provider]` first, then the `keyEnv` env var — so make `keyEnv`
the provider's OWN variable, never a generic one already in the shell (a stray `OPENAI_API_KEY` would
otherwise be used as a wrong-key fallback).
