# Delegator

<p align="center">
  <img src="docs/logo.png" alt="Delegator" width="760">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@rizias/delegator"><img alt="npm" src="https://img.shields.io/npm/v/@rizias/delegator"></a>
  <img alt="Node.js 20+" src="https://img.shields.io/badge/node-%3E%3D20-339933">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-blue.svg"></a>
</p>

> One architect. Many executors. Verified patches, not model claims.

**Delegator is a CLI that hands bounded coding tasks from your main AI agent to the other models and agents you already have — and returns a verified patch, not a promise.**

Not another "1000-in-1" miracle agent. Just an orchestrator for the agents and models you already use. Expand, not replace.

Each task runs on whatever else you've got — a separate subscription, an API key, a free account, or a local model — isolated in a throwaway git worktree, under a hard budget, and checked by *your* build and tests. You apply or undo; the worker never touches your real tree.

**It ships no models and no subscription — you bring your own.** Works with Codex, Claude Code, OpenCode, GLM, MiMo, DeepSeek, Ollama, LM Studio, and any OpenAI-compatible endpoint.

## Why Delegator

Real problems, and what Delegator does about each.

### Point it at anything

- **Want a sub-agent on a local model?** Ask your agent to add one — Ollama or LM Studio on your own GPU becomes a worker.
- **Using an agent CLI Delegator doesn't ship?** Add it as a YAML descriptor — no code, no release, no waiting on us.
- **Same model on two free accounts?** Address each as its own handle and spread work across both.
- **Want a council of different LLMs on one question?** Run the brief across several pools, then `dlg compare-runs` them side by side.

### Stay in control

- **Afraid of a multi-hour runaway run?** Set a budget — wall-clock and no-progress limits kill it before it costs you.
- **Don't want anything applied behind your back?** Nothing touches your tree without `dlg apply` (review is the default). Wrong patch? `dlg undo` reverses it.
- **Want plain-config control, different rules per repo?** One global YAML registry defines every model you have; a per-repo `.delegator.yaml` locks that repo to a chosen subset and sets its own tests. Local only narrows the global set — it never overrides or conflicts with it.
- **Getting 429s on free accounts?** Set a cooldown — Delegator backs off the rate-limited key and retries.
- **A worker died mid-task?** Nothing is smeared across your real tree — the work stays in its isolated worktree, so you recover the partial patch and the full log (`dlg apply` / `dlg logs`). Transient failures just retry or fail over to the next worker.

### Trust the result, not the prose

- **Can't trust an external model's "it's done"?** It runs *your* build and tests in a throwaway worktree — you apply a verified patch.
- **Worried a worker faked a green test?** If it edits your tests or CI, the run is flagged for review and never auto-applies.
- **Don't know what the agent actually did?** Every run's full exchange is saved locally — replay it with `dlg logs <id>`.

### It's yours, and stays out of the way

- **Your main agent's own window maxed out?** Push work to a *separate* pool your session can't reach — and free your own capacity.
- **Worried a tool will juggle your logins and get you banned?** It never touches your auth — each worker CLI logs in itself.
- **Don't want clutter in your repo?** Per project it's one instruction pack — or none if you keep the skill global. Every worktree, log, and receipt lives in `~/.delegator`, never in your tree.

> **You bring the capacity.** Delegator orchestrates the subscriptions, API keys, or free accounts you *already have* — it makes that access bounded, isolated, and verifiable. It doesn't hand you free model access.

## How It Works

<p align="center">
  <img src="docs/architecture.svg" alt="Your favorite harness sends one task or question to Delegator, which dispatches it to any agent and model you already have — local, free, Codex, GLM, Opus — and returns every result verified by your own build and tests for the architect to apply, compare, or undo." width="100%">
</p>

The key difference is control. Delegator does not replace your main agent and it
does not ask you to trust another model's prose. It gives your architect a way
to spend other execution capacity, then bring back evidence: a patch, logs,
verification output, usage, and a clean apply/undo decision.

### And your harness's own subagents

Delegator does not replace the native subagents your harness already has (Claude
Code's Task agents, Codex's agents) — it runs alongside them. Keep using native
subagents for judgment near your session; use Delegator workers to offload volume
onto separate pools. Run both at once — there is no either/or.

| | Native subagent | Delegator worker |
| --- | --- | --- |
| Runs | in your harness, in-process | a separate CLI process |
| Pool | **shares your window** | **a separate pool — frees your window** |
| Trust | trusted by default | untrusted — verified by your own tests |
| Isolation | your working tree | a throwaway git worktree |
| Reach | your harness's models | local · free · Codex · GLM · Opus · … |
| Best for | judgment near the session | offloaded volume, verified |

## Contents

- [Get Started](#get-started)
- [Configure Models](#configure-models)
- [Run a Task](#run-a-task)
- [Common Workflows](#common-workflows)
- [Security Model](#security-model)
- [Documentation](#documentation)

## What a run gives you

- **Isolated worktree** - the executor never edits your live tree directly.
- **Execution bounds** - wall-clock limits, silence timeout, and
  no-progress detection.
- **Local verification** - Delegator runs your build/test commands instead of
  trusting executor text.
- **Patch receipt** - status, diff, base commit, SHA-256, verification, usage,
  and stop reason.
- **Explicit apply/undo** - your main tree changes only through `dlg apply` or a
  policy you chose.

## Model council, not just patch work

Delegator is built for coding patches, but the same dispatch model is useful
whenever you want multiple independent model opinions before deciding.

Run the same brief through several executors:

```shell
dlg run -w local/qwen3-coder -m "Review this design direction. Return risks and counterarguments."
dlg run -w opencode/opencode/north-mini-code-free -m "Review this design direction. Return risks and counterarguments."
dlg compare-runs <id1> <id2>
```

That gives your architect a small council: separate model pools, separate
answers, one place to compare convergence, disagreement, latency, and usage
metadata.

## Why not just configure another model inside Codex?

Use local and open models inside Codex when one agent using one selected model is
the right workflow. Delegator is for the next layer up: one architect assigning
bounded work to many executors, then comparing verified receipts.

| If you need... | Use... |
| --- | --- |
| One agent using one selected model | A model picker or provider config |
| One architect assigning work to many executors | Delegator |
| Local models, API models, and CLI agents in one workflow | Delegator |
| Disposable worktrees with budgets and verification | Delegator |
| Machine-readable patch receipts | Delegator |

## Get Started

There are two pieces:

1. Install the `dlg` CLI once.
2. Add an instruction pack to any project where you want an AI host to delegate.

```shell
npm install -g @rizias/delegator
dlg init
dlg skill install agents-md --project
```

> **New to delegator?** The [Quickstart](docs/QUICKSTART.md) takes you from install through configuring a worker to your first reviewed run.

For Claude Code:

```shell
dlg skill install claude-code --project
```

For Codex:

```shell
dlg skill install codex --project
```

`dlg` and `delegator` are the same command.

```shell
dlg --version
delegator --version
```

## Agent install prompt

If another coding agent is setting this up for you, give it this:

```text
Install Delegator for this project.

Use npm to install @rizias/delegator globally, run dlg init if needed, then
install the right host instruction pack for this repo. Do not read
~/.delegator/secrets.yaml. Help me configure ~/.delegator/providers.yaml for the
models and agent CLIs available on this machine.
```

## Configure models

Delegator config lives in `~/.delegator/providers.yaml`. Secrets live separately
in `~/.delegator/secrets.yaml`; agents should not read that file.

Minimal local-model config:

```yaml
version: 1

defaults:
  model: local/qwen3-coder
  policy: review
  budget: { wallClock: 15m }

privacy:
  sensitivePaths:
    - "**/.github/workflows/**"
    - "**/*.lock"

providers:
  local:
    protocol: openai
    auth: none
    baseUrl: http://localhost:1234/v1
    models:
      qwen3-coder:
        contextWindow: 65536
```

Provider config is intentionally plain text. If a model appears through a CLI,
an API endpoint, or a local OpenAI-compatible server, Delegator can usually
describe it.

Useful discovery commands:

```shell
dlg providers
dlg providers --json
dlg models <provider>
dlg doctor
```

## Configure project verification

Add a `.delegator.yaml` to the project you are working in:

```yaml
verify:
  build: npm run build
  test: npm test
```

These commands run in the run worktree. The executor does not get to mark
itself green.

## Run a task

Write a brief:

```markdown
## Goal

Add tests for provider fallback behavior.

## Definition of done

- Successful fallback is covered.
- Exhausted fallback is covered.
- The project test command passes.
```

Preview the route:

```shell
dlg plan -f brief.md
```

Run it:

```shell
dlg run -f brief.md --budget 10m --policy review
```

Inspect the receipt:

```shell
dlg result <runId>
dlg logs <runId>
```

Apply or undo:

```shell
dlg apply <runId>
dlg undo <runId>
```

Run a specific model handle:

```shell
dlg run -w local/qwen3-coder -f brief.md
dlg run -w opencode/opencode/north-mini-code-free -f brief.md
dlg run -w api/openai/gpt-5.5 -f brief.md --effort high
```

## Common workflows

### Claude Code as architect

Claude Code keeps the plan, judgment, and review loop. Delegator lets it send
bounded implementation slices to any configured executor.

```shell
dlg skill install claude-code --project
```

### Codex as architect

Codex keeps the high-level session. Delegator can still run other Codex
profiles, local models, OpenCode, API executors, and other CLI agents in separate
runs.

```shell
dlg skill install codex --project
```

### Any AGENTS.md-reading host

```shell
dlg skill install agents-md --project
```

This is the broad compatibility path for hosts that read repository
instructions.

### Skills: host instructions vs executor equipment

Delegator has two different skill paths:

| Skill path | What it does |
| --- | --- |
| `dlg skill install ...` | Teaches the architect when and how to call Delegator |
| `equip.skills` | Loads a skill into a spawned executor, when that runtime supports skill loading |

So the architect can use a Delegator instruction pack, while a selected executor
can also receive its own task-specific skill.

### Compare executors

```shell
dlg run -w local/qwen3-coder -f brief.md --policy review
dlg run -w opencode/opencode/north-mini-code-free -f brief.md --policy review
dlg compare-runs <id1> <id2>
```

Use this when you want competing patches and a structured comparison.

### Update Delegator

```shell
delegator update
```

## Security model

Delegator assumes executors are useful but not fully trusted.

- Runtime state lives outside the repository under `~/.delegator/projects/...`.
- Untracked files such as `.env` are not copied into run worktrees.
- API keys live in `~/.delegator/secrets.yaml`, not in project config.
- An executor receives only the credential material needed for its own provider.
- Verification is performed by Delegator, not accepted from executor prose.
- Sensitive or risky diffs can force human review.

## Documentation

| Document | Purpose |
| --- | --- |
| [docs/QUICKSTART.md](docs/QUICKSTART.md) | **Start here** — install, add a worker, first run, reset/uninstall |
| [docs/CONFIG.md](docs/CONFIG.md) | Provider, model, runtime, secret, and project config |
| [docs/USAGE.md](docs/USAGE.md) | Host integration and CLI workflows |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Components, lifecycle, statuses, and trust model |
| [docs/MODEL-GUIDE.md](docs/MODEL-GUIDE.md) | How to think about model/provider choices |
| [docs/verification-model.md](docs/verification-model.md) | How verification stays separate from executor claims |
| [docs/GLOSSARY.md](docs/GLOSSARY.md) | Public terms: orchestrator, worker, runtime, handle, envelope, receipt |
| [examples/providers.example.yaml](examples/providers.example.yaml) | Annotated provider config recipe |

## Non-goals

Delegator is not an agent framework, not a proxy for all model traffic, and not a
replacement for Claude Code, Codex, OpenCode, Ollama, or LM Studio.

It is the dispatch layer between a coding architect and the execution capacity
already available on your machine.

The core makes no LLM routing or planning decisions: it does not call an LLM to
decide what to do. The host agent or human remains responsible for planning,
routing, review, and final judgment.

## License

MIT. See [LICENSE](LICENSE).
