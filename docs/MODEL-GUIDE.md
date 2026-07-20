# Model Guide — who does what

These are **priors, not measurements** — informed starting assumptions you calibrate with
`dlg gain --history` and your own outcomes. Model lineups shift fast; recheck quarterly. delegator
ships **no built-in model assignments**: every worker is a handle *you* declared in
`~/.delegator/providers.yaml`, so read the names below as *examples* — yours depend on your config —
and map them to your own handles.

---

## 1. Routing: you pick the worker, fallback covers the gap

delegator has **no router model**: the orchestrator (you) chooses a worker; the core only
dispatches, bounds, isolates, and verifies. Two ways to choose:

- **A handle** — `dlg run -w <handle>`, where a handle is `[runtime/]provider/model`
  (e.g. `zai/glm-5.2`, `openai-codex/gpt-5.5`, `pi/openai-codex/gpt-5.5`, `anthropic/claude-sonnet-4-6`). This is
  the primary path.
- **Per-model `fallback:`** — a model can declare `fallback: <handle>` (or a list). If the primary
  can't run (breaker open, rate-limited, missing key, binary absent) the core transparently advances
  down the chain. `defaults.model` is the worker a bare `dlg run` uses.

`dlg plan -w <handle>` and `dlg route -w <handle>` show the resolved chain, availability, and skip
reasons **without launching a worker** — use them before committing a real run.

You still choose by **task shape**. The classes below are guidance for *which kind of worker fits* —
not config you must create:

| Task shape | Examples | Reach for |
|---|---|---|
| Mechanical, fully specified | scaffolding, DTOs, renames across files, tests from a written spec, format migrations | a fast mechanical worker (a GLM / MiMo / codex-spark-style handle) |
| Standard implementation from a clean brief | a function/class to spec, CRUD endpoints, doc edits, a bugfix with a repro | a solid mid worker (e.g. `zai/glm-5.2`, a mid codex) at `policy: review` |
| Hard but delegable reasoning | cross-file refactor, bounded debugging with a repro, perf work with a profile | a strong worker at higher `--effort` (e.g. `openai-codex/gpt-5.5` high) |
| Cross-vendor second opinion | review my diff, critique this design | a worker from a *different vendor* than the orchestrator — different blind spots |
| Long-context digestion | analyze a giant log, summarize a whole module, repo-wide inventory | a large-context handle; output a summary, never a diff |
| Context-free one-shot | boilerplate config, regex, SQL from a schema, sample data | a `mode: direct-api` handle (one HTTP call, no agent loop) |

**Never delegated** — stays with the orchestrator or its native top-tier subagents: architecture
decisions, security-sensitive changes, novel algorithms, anything where the brief would be longer than
the diff, anything needing conversation context the worker can't recover from the repo.

## 2. Decision tree for the orchestrator

Apply in order; first match wins.

1. **Sensitive scope** (touches secrets/auth/payments)? → do it yourself, or use only a worker on a
   provider you control; keep it off external clouds. delegator never copies your keys, and a worker
   only ever receives its own provider's credential — but the *judgment* is still yours.
2. **Trivial one-off** (one read, a one-line edit, a single command)? → do it yourself; delegation
   overhead exceeds the task.
3. **Needs your session context** (depends on the conversation, on decisions written nowhere)? → do it
   yourself, or a native subagent that inherits your harness. Workers start cold — they only know the
   repo + the brief.
4. **Mechanical and fully specifiable?** → a fast mechanical handle from the right pool. Write the
   spec once, precisely.
5. **Standard implementation from a clean brief?** → a mid handle, `policy: review`, with verification
   commands set. The bread-and-butter case.
6. **Hard but delegable reasoning** (a repro exists, scope is bounded)? → a strong handle at higher
   `--effort`, budget ~20m, `policy: review` or `plan-first`.
7. **Want vendor diversity on a judgment call?** → a handle from a *different* vendor. This is where
   distinct failure modes matter.
8. **Many independent sub-tasks?** → fan out N runs (each its own worktree); integrate the patches
   yourself. Check concurrency first (§2.1).
9. **Huge artifact to digest?** → a long-context handle; the output is a summary, never a diff.

### 2.1 Fan-out discipline

Parallel workers are a power tool with a documented failure mode: **over-orchestration**. Real case
(2026-06, frontier $200 plan): a routine documentation task spawned ~40 subagents and burned ~half of
a 5-hour usage window. One standard worker with a good brief would have done it.

- Default concurrency is 2–3 runs. Raise only after `gain --history` shows a batch actually paying off.
- Fan out only over *genuinely independent* units (separate modules/files, no shared decisions).
  Sequential work — read, then synthesize, then write — is ONE worker, not a pipeline of swarms.
- Bound the batch before launching: N runs × budget each, stated out loud. A batch is an orchestration
  decision, not a default.
- Orchestration depth is one by default: workers should not spawn workers. The Claude runtime descriptor
  excludes its `Task` tool; other runtimes have no equivalent core-wide restriction. Anything deeper
  reinvents the runaway loop with extra steps.
- "50 agents built a startup overnight" is marketing until proven on your own `runs.jsonl`. Default to
  skepticism; let telemetry promote parallelism.

### 2.2 Mechanical-worker discipline (from real-world feedback, 2026-06)

A user who ran mechanical workers on a real Java repo distilled rules we adopt verbatim:

- **No large integration tasks** for mechanical workers — pure state classes, DTOs, tests, simple hooks,
  mechanics only.
- **Smallest compilable patch first**; grow by follow-up runs, not by bigger briefs.
- **Fewer files, less freedom**: exact file list in Scope, everything else in Forbidden.
- **Wiring and hard parts** go to a strong worker or stay with the orchestrator.
- **No exploration budgets**: give paths in the brief; Claude runtime workers have the `Task` tool disabled.

**Native subagents vs delegator** — the practical split when the orchestrator is Claude Code:

- Native (haiku/sonnet subagents): when the task needs harness trust, session integration, or the
  tight tool permissions you already configured. They also *share Claude's pool*.
- Delegator: separate worker pools, vendor diversity, local/open model support, and runaway protection
  with hard budgets. Your review surface is the brief plus the envelope.
- Rule of thumb: *judgment near the session → native; volume away from the session → delegator.*

### 2.3 Council — fan one task across several models

When a task is open-ended with no test/oracle (design decisions, reviews, analysis, research),
`dlg council -w m1,m2,m3 -m "<task>"` is best used with 2–4 strong, different-family models in parallel;
the code requires at least two distinct handles, warns on same-family choices, and has no upper limit. It
returns every answer plus a synthesis `bundle`; the orchestrator writes the final (or a headless caller
passes `--aggregate <model>`). In practice it beats the strongest single model on judgment tasks but
LOSES on short-form writing (synthesis bloats tight prose), at ~4x the worker-pool tokens. Diversity
comes from different families — self-ensembling ONE model (repeat sampling, with or without a
temperature dial, prompt or aggregation tricks) showed no judge-distinguishable gain over a single
call in measured evals (2026-07-03); a weak member drags the aggregate down. Not for mechanical
coding — that is one worker. Full envelope: [USAGE.md](USAGE.md).

## 3. The pool rule — shared vs separate pools

**The win is about shared vs separate *usage pools*, not pricing shape.** A worker on the *same*
subscription as the orchestrator shares its usage window, so delegating to it does **not** relieve the
orchestrator's limit — the work just moves inside the same pool. A worker on a *different* subscription
is a separate pool and genuinely buys back the orchestrator's own window.

- Orchestrator = **Claude** → `anthropic/*` (claude) workers **share** Claude's pool (no relief);
  Codex, GLM, MiMo, OpenCode are **separate** pools → delegate volume there.
- Orchestrator = **Codex** → it flips: `anthropic/*` workers become the separate pool that offloads
  Codex.

Claude Code and Codex both use **OAuth subscription logins** (website login, no key in `secrets.yaml`): a native
`anthropic/claude-sonnet-4-6` worker rides your installed `claude` CLI's subscription exactly the way an
`openai-codex/*` worker rides your ChatGPT/Codex login. Only API-key providers (GLM, MiMo, DeepSeek,
NVIDIA, Google, local) read a key from `secrets.yaml`.

So use native Claude workers for Sonnet-quality standard work **only when Claude is NOT the
orchestrator** (otherwise it's the same pool); for volume under a Claude orchestrator, prefer
Codex / GLM / MiMo. As a capability ladder: haiku ≈ mechanical, sonnet ≈ standard
engineering/docs/test interpretation, opus/Fable stays the orchestrator.

## 4. Worker priors (examples — map to your own handles)

Treat these as starting priors, not a shipped roster. Your handles and effort levels live in your
config; calibrate with `gain`.

- **GLM (Z.ai)** — fast mechanical/standard workhorse from a separate provider pool.
  Scaffolding, boilerplate, bulk edits, tests-from-spec, medium refactors. Avoid: subtle concurrency,
  security, anything underspecified.
- **MiMo (Xiaomi)** — capable mid coder with a separate pool; useful for parallel bulk work and a
  second mechanical/standard option.
- **DeepSeek** — a solid standard fallback (Flash) and the reasoning / long-context worker (Pro,
  large context). Keep hard budgets on long agentic runs.
- **Codex family (ChatGPT subscription, `codex` runtime, model set by the handle)** — `*-codex-spark`
  is the speed lane (mechanical/rapid edits, weak on architecture); mid `gpt-5.x` fits standard work
  and refactors; `gpt-5.5` at high `--effort` is the heavy cross-vendor brain for
  hard debugging and complex refactors. A different vendor's distinct failure modes are the whole
  point of keeping Codex for second opinions. **Note:** the `codex` runtime speaks only the OpenAI
  Responses API — it runs only OpenAI/Codex models; a Chat-Completions-only vendor (z.ai/GLM, MiMo
  over OpenAI, …) cannot be routed through `codex`, so reach those via the `claude` or `api` runtime.
- **Native Claude (`anthropic/claude-haiku-4-5`, `anthropic/claude-sonnet-4-6`, `anthropic/claude-opus-4-8`)** — no API key;
  they authenticate through your installed `claude` CLI subscription. Subject to the pool rule above.

Reasoning effort is set per worker by its runtime's own level names (e.g. claude
`low|medium|high|xhigh|max|ultracode`, codex `minimal|low|medium|high|xhigh`) via `reasoningEffort:` on the model, or
overridden per run with `--effort`. See [CONFIG.md](CONFIG.md) for the per-runtime effort catalog.

## 5. Calibration loop

1. Every run logs worker, status, duration, tokens, and verification outcome (`~/.delegator/runs.jsonl`).
2. Periodically: `dlg gain --history` — look for workers with high `partial`/`failed` rates on a kind
   of task.
3. Adjust your defaults and `fallback:` chains accordingly; note the change and date below.

## Changelog

- 2026-06-19 — rewritten for the shipped model: handle + per-model `fallback` routing,
  `trust` removed, per-runtime reasoning-effort levels. The old "tiers" framing is retired (a `tiers:`
  block remains supported as optional legacy).
- 2026-06-12 — initial priors (no run data yet).
