# Delegator

<p align="center">
  <img src="docs/logo.png" alt="Delegator" width="760">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@rizias/delegator"><img alt="npm" src="https://img.shields.io/npm/v/@rizias/delegator"></a>
  <img alt="Node.js 20+" src="https://img.shields.io/badge/node-%3E%3D20-339933">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

> Your coding agent is the architect. Delegator gives it executors. Verified patches, not model claims.

A CLI your agent uses to hand bounded tasks to other models. Each agentic run gets an isolated worktree,
hard budgets, your build/tests, and a patch you apply or undo. Delegator dispatches and verifies;
it never calls an LLM to decide.

Delegator ships no models. Use a subscription CLI, an API-backed provider, or a local server:
Claude Code, Codex, OpenCode, GLM, MiMo, DeepSeek, LM Studio, Ollama, vLLM, and compatible runtimes.

## Install

```shell
npm install -g @rizias/delegator   # the dlg CLI
dlg init                           # scaffold ~/.delegator/
dlg skill install claude-code      # or: codex | agents-md (one AGENTS.md — OpenCode, Gemini, any reader)
```

`dlg skill show` prints the block for any other instruction format. Or tell your agent *"set up
Delegator for this project"* — it runs these and drafts `providers.yaml`.

Each worker logs in itself (`claude` → `/login`, `codex login`, `opencode auth login`, …); Delegator
spawns it, never logs in for it. API keys go in `~/.delegator/secrets.yaml`.
[Quickstart](docs/QUICKSTART.md): install to first run in five minutes.

## Why use it

Delegator runs *alongside* native subagents — it does not replace them:

| You want to… | A native subagent… | A Delegator worker… |
| --- | --- | --- |
| Work off your own context window | runs in-process and **shares your session** | is a **separate process** with its own pool |
| Not get burned by a multi-hour runaway | inherits your session's limits | runs under a **hard wall-clock + no-progress budget** |
| Not trust a worker's "it's done" | is trusted by default | is **checked by your own build and tests** in a throwaway worktree |
| Stay in control of your tree | edits your working tree directly | changes nothing until **`dlg apply`** (default policy); `dlg undo` reverses it |

A worker on a *different* subscription frees your usage window; one on the *same* shares it. Point it
at anything — a local model, a second account, a spare API key, an agent CLI. Each is one YAML entry.

## How it works

<p align="center">
  <img src="docs/architecture.svg" alt="Architecture: your coding agent dispatches verified tasks to many workers" width="100%">
</p>

Your agent picks the worker; Delegator spawns it as a separate process in its own git worktree,
enforces the budget, runs your verification, and returns a patch — with logs and usage — to apply,
compare, or undo.

## Configure a worker

A worker is any `provider/model` in `~/.delegator/providers.yaml` — a subscription CLI, an API key, or
a local server:

```yaml
version: 1
providers:
  openai-codex:                 # your ChatGPT/Codex plan
    protocol: openai
    auth: subscription
    defaultRuntime: codex
    models: { gpt-5.5: {} }

  anthropic:                    # native Claude Code on your subscription
    protocol: anthropic
    auth: subscription
    models: { claude-sonnet-4-6: {} }

  local:                        # a local server (LM Studio, Ollama, vLLM…)
    protocol: openai
    auth: none
    baseUrl: http://localhost:1234/v1
    models: { qwen3-coder: {} }
```

API-key providers (GLM, MiMo, DeepSeek, …) look the same — the key lives in
`~/.delegator/secrets.yaml`, never in this file.

```shell
dlg providers      # every worker, and whether it can run now
dlg doctor         # binaries, keys, login reminders
```

To verify patches, add `.delegator.yaml` to your project:

```yaml
verify:
  build: npm run build
  test: npm test
```

Verification runs inside the worktree — the worker cannot mark itself green. See
[docs/CONFIG.md](docs/CONFIG.md).

## Run a task

Write a brief — a goal and a definition of done:

```markdown
## Goal
Add tests for provider fallback behavior.

## Definition of done
- Successful and exhausted fallback are both covered.
- The project test command passes.
```

Preview, run, inspect, then apply or undo:

```shell
dlg plan   -f brief.md                  # preview the route, no run
dlg run    -f brief.md --budget 10m     # default policy: review
dlg result <runId>                      # status, diff, usage
dlg logs   <runId>                      # full worker exchange
dlg apply  <runId>                      # write the reviewed patch to your tree
dlg undo   <runId>                      # reverse an applied run
```

Target one worker with a `[runtime/]provider/model` handle; compare receipts to pit workers against
each other:

```shell
dlg run -w local/qwen3-coder -f brief.md
dlg run -w api/openai/gpt-5.5 -f brief.md --effort high
dlg compare-runs <id1> <id2>
```

## Security model

Delegator assumes workers are useful but not fully trusted.

- Runtime state lives outside the repo, under `~/.delegator/projects/...`.
- Untracked files such as `.env` are never copied into a worktree.
- API keys live in `~/.delegator/secrets.yaml`, never in project config; a worker receives only its
  own provider's credential.
- Delegator never touches your logins — it only spawns worker CLIs.
- Verification is run by Delegator, never accepted from worker prose.
- A diff that edits tests, test config, CI, snapshots, fixtures, or lockfiles is flagged for review
  and never auto-applied.

[docs/verification-model.md](docs/verification-model.md) — how verification stays honest.

## Documentation

| Document | Purpose |
| --- | --- |
| [Quickstart](docs/QUICKSTART.md) | Install, add a worker, first run, reset |
| [Config](docs/CONFIG.md) | Provider, model, runtime, secret, and project config |
| [Usage](docs/USAGE.md) | Host integration and CLI workflows |
| [Model guide](docs/MODEL-GUIDE.md) | Which model or provider for which kind of task |
| [Architecture](docs/ARCHITECTURE.md) | Components, lifecycle, statuses, trust model |
| [Verification model](docs/verification-model.md) | How verification stays separate from worker claims |
| [Glossary](docs/GLOSSARY.md) | Orchestrator, worker, runtime, handle, envelope, receipt |
| [Provider config recipe](examples/providers.example.yaml) | Annotated, copy-paste provider and secret config |

## FAQ

**Is this an agent framework, or a 1000-in-1 super-agent?** Neither. It hands bounded tasks to the
models and agents you already run. It does not replace Claude Code, Codex, OpenCode, Ollama, or LM Studio.

**Why not just configure another model inside Codex?** Use a model picker when one agent on one model
is the right workflow. Delegator is one architect assigning bounded work to many executors, then
comparing verified receipts.

**Does the core call an LLM to route or plan?** No — you or your host agent choose the worker. The
core dispatches, bounds, isolates, and verifies. Fallback between workers is deterministic.

**Does it give me free model access?** No. You bring the subscriptions, API keys, or accounts;
Delegator makes that access bounded, isolated, and verifiable.

## Contributing

Issues and pull requests welcome. `npm run build` to build, `npm test` to run the suite.

## License

MIT. See [LICENSE](LICENSE).
