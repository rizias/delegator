# Quickstart

From install to your first delegated run in about five minutes. Delegator ships no models and no
subscription — it drives the agentic CLIs and API keys you already have.

## 1. Install

```bash
npm install -g @rizias/delegator      # the command is `dlg` (alias: `delegator`)
dlg --version
```

## 2. One-time setup

```bash
dlg init
```

Creates `~/.delegator/`:

- `providers.yaml` — the registry you edit (providers, models, `defaults`). Starts empty.
- `runtimes.yaml` — optional overrides for the built-in runtimes (most users never touch it).
- `secrets.example.yaml` — the format guide for your real `secrets.yaml`.

## 3. Add a worker

A *worker* is a `provider/model`. Each provider declares a `protocol` and an `auth` mode; together
they fix the **runtime** (the launcher) and how it logs in:

| `protocol` | `auth` | runtime | typical providers |
| --- | --- | --- | --- |
| `anthropic` | `subscription` | `claude` | native Claude Code |
| `anthropic` | `api-key` | `claude` | z.ai/GLM, MiMo |
| `openai` | `api-key` | `api` | OpenAI, DeepSeek, NVIDIA, local |
| `openai` | `subscription` | `codex` | Codex — pin `defaultRuntime: codex` |
| `opencode` | `subscription` | `opencode` | OpenCode |

The **`claude`** runtime appears twice on purpose: the same `claude` CLI runs native Claude on your
subscription **and** z.ai/GLM with an API key — that is exactly how Claude Code talks to z.ai.

> Runtimes are inferred automatically, except when one `protocol` is served by more than one: `openai`
> is shared by the `codex` CLI and the direct `api` runtime, so a Codex worker must add
> `defaultRuntime: codex`.
>
> **Codex speaks only the OpenAI Responses API.** A Chat-Completions-only provider (z.ai/GLM, MiMo
> over OpenAI, …) cannot run through the `codex` runtime — reach it via the `claude` runtime (its
> anthropic endpoint) or the `api` runtime (chat/completions) instead.

**Subscription worker** — no key; the CLI uses its own login (run e.g. `codex login` once):

```yaml
# ~/.delegator/providers.yaml
providers:
  openai-codex:
    protocol: openai
    auth: subscription
    defaultRuntime: codex
    models: { gpt-5.5: {} }
```

**API-key worker** — declare it and put the key in `secrets.yaml`:

```yaml
# ~/.delegator/providers.yaml
providers:
  zai:
    protocol: anthropic        # + auth: api-key → the claude runtime
    auth: api-key
    baseUrl: https://api.z.ai/api/anthropic   # exact URLs in examples/providers.example.yaml
    models: { glm-5: {} }
```

```yaml
# ~/.delegator/secrets.yaml   — NEVER commit this; agents never read it
zai: "your-real-key"
```

A fuller, annotated recipe lives in [examples/providers.example.yaml](../examples/providers.example.yaml).

## 4. Check it works

```bash
dlg doctor          # binaries found? CLIs logged in? keys present? workers available?
dlg providers       # every worker and whether it can run right now
```

## 5. Your first run

A *handle* picks **which runtime, provider, and model** runs the task: `[runtime/]provider/model`.
The **runtime** is the launcher — a CLI (`claude`, `codex`, `opencode`) or a direct HTTP call (`api`).
The **provider** carries the credentials: an API key in `secrets.yaml`, or a CLI's own login for a
subscription. **The key belongs to the provider, not the runtime.**

- `zai/glm-5` → the **claude** runtime, hitting z.ai's anthropic-compatible endpoint with your zai key.
- `openai-codex/gpt-5.5` → the **codex** CLI on your ChatGPT plan (its own login, no key).

Because the key is per-provider, one upstream service can be wired through **several** runtimes — e.g.
z.ai also exposes an OpenAI-compatible endpoint, so you can add a second provider that reuses the same key:

```yaml
providers:
  zai:                          # → claude runtime (z.ai's anthropic endpoint)
    protocol: anthropic
    auth: api-key
  zai-openai:                   # → api runtime (a direct OpenAI-Chat HTTP POST — no CLI)
    protocol: openai
    auth: api-key
```

Give a task, a time budget (`--budget`, the only limit you set), and a reasoning effort
(`--effort`, model-specific — `low | medium | high | …`; run `dlg providers` to see a model's levels):

```bash
dlg run -w zai/glm-5 --task "Add a --version flag to src/cli.ts" --budget 10m --effort medium
# …or from a brief file:
dlg run -w openai-codex/gpt-5.5 -f brief.md --budget 15m --effort high
```

Delegator isolates the work in a fresh git worktree, runs it bounded, verifies it, and prints a typed
**envelope**: status, the diff, and run stats (wall-clock time, model turns, tokens incl. reasoning).

## 6. Review and apply

Under the default `review` policy the patch is **not** applied automatically — you stay in control:

```bash
dlg result <runId>      # the envelope: status, diff, usage
dlg apply  <runId>      # apply the reviewed patch to your tree
dlg undo   <runId>      # roll an applied run back
```

## Let a host agent delegate (or drive `dlg` yourself)

Everything above you can run by hand in a terminal. To let a host **agent** (Claude Code, Codex)
*decide to delegate on its own*, install its instruction pack — it teaches the agent when and how to
call `dlg`, with nothing added to your project:

```bash
dlg skill install claude-code      # or: codex | agents-md
```

**Without the pack** delegator still works — but the agent doesn't know it exists, so you drive `dlg`
yourself (or tell the agent "use `dlg` to delegate this" each time). The pack is what makes an agent
delegate automatically.

## Reset / uninstall

**Start over** (wipe config and re-init):

```bash
rm -rf ~/.delegator     # deletes providers.yaml, runtimes.yaml, secrets.yaml, and run history
dlg init                # recreate fresh templates
```

> `~/.delegator` holds your config, **your API keys (`secrets.yaml`)**, and run receipts — back up
> `secrets.yaml` first if you want to keep your keys.

**Uninstall the CLI:**

```bash
npm uninstall -g @rizias/delegator
```

**Remove installed host packs** (only if you ran `dlg skill install`):

```bash
rm -rf ~/.claude/skills/delegator      # Claude Code  (project install: ./.claude/skills/delegator)
rm -rf ~/.agents/skills/delegator      # Codex        (project install: ./.agents/skills/delegator)
rm ~/.codex/CODEX-SKILL.md             # Legacy Codex pack from delegator <=0.3.21
# AGENTS.md: delete the block between the  delegator:begin  and  delegator:end  markers
```

## Next

- [docs/CONFIG.md](CONFIG.md) — full config reference: providers, models, runtimes, secrets, project `.delegator.yaml`.
- [docs/MODEL-GUIDE.md](MODEL-GUIDE.md) — which model/provider for which kind of task.
- [docs/USAGE.md](USAGE.md) — how a host agent uses delegator day to day.
