<!-- delegator:begin (managed by `dlg skill install` — do not edit inside markers) -->
## Delegating work to a separate-pool worker (delegator)

This machine has `dlg` (delegator): dispatch well-specified coding tasks to a worker in a **separate
usage pool** instead of doing the bulk work yourself. You decide and review; delegator isolates,
bounds, and verifies. This teaches **you, the orchestrator**, when/how to delegate — a separate
concern from **worker equipment** (`equip.skills` / a worker's `--skill` toggle, which loads a skill
*into* a spawned worker).

**When to delegate:** mechanical or standard implementation that is fully specifiable and needs no
conversation context. Don't delegate secrets/auth/payments, trivial one-offs, or context-dependent
work. **Commit first** — workers see HEAD. Keep ≤2–3 parallel runs; sequential work = one worker;
state the batch cost before fanning out; workers never spawn workers. Never read
`~/.delegator/secrets.yaml`.

### How it works

- **Selection = the handle:** `dlg run -w [runtime/]provider/model` — e.g. `-w openai-codex/gpt-5.5`
  (runtime inferred from the provider's `protocol`+`auth`), `-w opencode/opencode/north-mini-code-free`
  (slash-bearing model ids are valid), `-w pi/openai-codex/gpt-5.5` (force a runtime). Bare
  `dlg run --task "..."` (no `-w`) uses `defaults.model`. Resolution is **provider-greedy**: `a/b/c` is provider `a`
  + model `b/c` when that model exists, and only reads the leading segment as a runtime otherwise.
- **Fallback = a property of the model:** `fallback: <handle>` or `fallback: [h1, h2]` in
  `providers.yaml`, tried **only** when the primary cannot run (breaker open / rate-limited / missing
  key / binary absent). Transitive and cycle-safe. No `fallback` → runs or fails; then re-dispatch.
  Inspect with `dlg route -w <handle>`.
- **Reasoning effort:** `dlg run -w <handle> --effort <level>`, validated against the model's
  `reasoningEffort.levels`. Precedence: CLI `--effort` > model default > runtime default.
- **Provider shape:** `protocol` (`anthropic`|`openai`|`opencode`) + `auth`
  (`subscription`|`api-key`|`none`); runtime inferred from those, or pinned with `defaultRuntime`.
  `keyEnv` is an env-var **name** only, never a key value. Inference is unambiguous except
  `openai`+`subscription` (matches `codex` AND `pi` → pin `defaultRuntime: codex`). **Codex is
  Responses-API only — Chat-Completions-only providers (z.ai/GLM, etc.) can't run through the `codex`
  runtime; use `claude` (anthropic) or `api` (chat/completions).**

### Model economy

You are the orchestrator: you plan, write briefs, and verify. Delegate the **volume** to a worker in
a **separate usage pool** — a worker on the same subscription/CLI you run in gives zero relief (under
a Claude orchestrator: codex / opencode / GLM, not `claude/*`; match the pool to whatever you
actually are). Keep cheap workers on small self-contained units and the smallest COMPILABLE patch;
keep wiring and tricky logic for yourself.

### First run — you provision this machine

`npm i -g @rizias/delegator` → `dlg init` → discover what THIS machine has (`dlg doctor` + the
user's PATH and API-key env-var **names**) → confirm intent with the user → write
`~/.delegator/providers.yaml` with **only** what this machine has (per provider: `protocol`, `auth`,
`defaultRuntime` if ambiguous, `keyEnv: <ENV-VAR-NAME>`; the user puts keys in `secrets.yaml`; copy
patterns from the shipped `examples/providers.example.yaml`; a vendor not shown → use the `openai`
shape with `baseUrl` from its API docs) → **verify** with `dlg providers` +
`dlg plan -w <handle>` → `dlg skill install agents-md` (and `… claude-code` / `… codex` for the other
orchestrators).

To reconfigure from scratch: `rm -rf ~/.delegator && dlg init`, then redo discovery (also removes
`secrets.yaml` — the user re-adds keys).

### Commands

```bash
dlg providers [--json]                 # what's available / unconfigured
dlg models <provider>                  # live model list (fetched, never hardcoded)
dlg route -w <handle>                  # resolved fallback chain + availability
dlg plan -w <handle> [-f brief.md]     # dry run: chain, context-fit — NO tokens spent
dlg run -w <handle> [-f brief.md | --task "..."] [--effort ..] [--budget 10m] [--policy review] [--json]
dlg status [id] · dlg logs <id> --tail 20 · dlg result <id> --json
dlg apply <id> · dlg undo <id>         # apply a reviewed patch / roll it back (the only write paths)
dlg doctor · dlg gain --history        # diagnose env · per-run savings report
```

### Budgets and recovery

Use `--budget` (wall-clock) for normal run sizing, especially for review, research, and exploration.

The only hard brief rule is non-empty (a Goal/Scope/Definition-of-done structure still wins). On the
envelope: `completed` → review `patch.diff` then `dlg apply`; `partial`/`requires-review` → work may
be finished, review first; `killed-*` → read `stopReason`, inspect logs/result, then apply partial
work or re-dispatch; `rejected` (unconfigured) → check `dlg providers`. Trust the envelope's
verification block, not the worker's claims.

**Filing a bug (optional):** if the user wants to report a failure, gather facts only (**don't narrate
the logs**) into a paste-ready block for https://github.com/rizias/delegator/issues: `dlg --version`,
`dlg doctor`, the command + handle, `status`/`stopReason`/`errors[].detail` from `dlg result <id>
--json`, and the relevant config snippet **with keys stripped** (never `secrets.yaml`). User's choice,
never automatic.
<!-- delegator:end -->
