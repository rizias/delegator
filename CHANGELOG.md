# Changelog

All notable changes to Delegator are documented here. This project adheres to
[Semantic Versioning](https://semver.org), and the format is based on
[Keep a Changelog](https://keepachangelog.com).

## [Unreleased]

### Fixed
- A local "synthetic" notice from the Claude CLI (e.g. an interrupted turn) is no longer misread as an
  authentication failure, so it can't wrongly bench a subscription worker on the circuit breaker.

### Documentation
- Host skills now advise running self-review fan-outs through separate-pool workers when practical.

## [0.4.1] — 2026-07-03

### Fixed
- The concurrency gate no longer admits more workers than its limit when a slot holder stalls,
  crashes, or races another run for the same slot.
- Non-git worker patches (e.g. opencode) no longer corrupt backslashes in file bodies, so regexes,
  escape sequences, and Windows paths arrive intact.

### Documentation
- Council guidance now recommends mixing different model families, backed by measured evals, and
  drops the inaccurate note that sampling temperature is unavailable through harnesses.

## [0.4.0] — 2026-07-02

### Added
- **`dlg council`** — fan ONE task out to several workers in parallel (`-w h1,h2,h3`) and gather every
  full answer, diff, per-worker tokens (incl. reasoning) and a ready aggregate-and-synthesize `bundle`.
  The command never picks a winner: the calling agent synthesizes the final answer from the bundle
  (headless callers may pass `--aggregate <model>` to attach a `final` from one more worker). Members
  run under forced `review` policy with deferred retention pruning; a failed/hung member becomes a
  `failed`/`killed-*` candidate with a warning instead of sinking the run; fewer usable answers than
  `--min-proposers` (default 2) marks the envelope `quorumMet: false` / `degraded`. No config: models
  are chosen per invocation. Works in plain non-git folders. A completed member survives a workspace
  cleanup failure — reclaim is best-effort, so a Windows `EBUSY` on `rmSync` (now retried) becomes a
  non-fatal warning folded into the result instead of discarding the answer or stranding the run.
- **executeRun `skipPrune` option** (used by council): callers that gather several sibling runs defer
  retention pruning until every envelope is read, so an early-finished run can no longer be pruned away
  mid-gather. `createRun` is also collision-safe now (regenerates the id on an existing directory).
- **codex runtime: `--skip-git-repo-check`** — codex refused to run in the no-git workspace sandbox
  ("Not inside a trusted directory"); delegator-created sandboxes are trusted by construction.

## [0.3.23] — 2026-06-23

### Added
- **Universal Agent Skill install:** `dlg skill install agent-skills` (alias `agents-skills`) writes a
  host-neutral `delegator/SKILL.md` into `~/.agents/skills/delegator/` — discovered by any Agent
  Skills-compatible agent, with no Claude/Codex flavor. `dlg skill show` now prints this generic skill.
  Host skills install globally only.
- **Skills auto-update with the binary:** every installed host skill carries a
  `metadata.delegator-skill-version` timestamp; on startup `dlg` silently refreshes an installed global
  skill whose stamp differs from the one this `dlg` ships (compared by stamp, never by content) — no
  command and no flag, updating `dlg` is what updates the skills. The check is cached in the same
  `update-check.json` (whose writer now merges fields instead of overwriting the whole file).
- **Per-model concurrency cap:** a model's `limits.concurrent` is now actually enforced — it caps
  concurrent runs of that one model, nested under the provider's `maxConcurrent` (acquired
  provider-first; reads the model's config so it works for both bare `provider/model` handles and
  named workers). Previously the field was accepted but silently ignored.

### Removed
- **`dlg skill install agents-md`** and its managed `AGENTS.md` block: a pasted AGENTS.md section is
  not a discoverable Agent Skill. Use `dlg skill install agent-skills` (or `dlg skill show` to paste
  into any instruction file) instead.

### Fixed
- **`dlg key … --json`:** the key subcommands (`set`/`add`/`list`) now actually emit JSON — a
  duplicate `--json` on the parent `key` command had been swallowing the flag (same root cause as the
  `skill` subcommands).
- **z.ai / GLM reasoning effort:** the `claude` runtime catalog and the shipped z.ai example now
  declare the full Claude-Code effort vocabulary — `low, medium, high, xhigh, max, ultracode` — matching
  z.ai's published table, so `--effort max`/`ultracode` are accepted instead of rejected. z.ai folds them
  (`low`/`medium`/`high` → GLM `high`; `xhigh`/`max`/`ultracode` → GLM `max`); the example defaults to
  `xhigh` (= GLM `max`) so a bare run gets GLM's deepest mode. The config docs explain that delegator
  validates a level against the model's catalog but the provider may *map* levels — so a "valid" level
  can still be reinterpreted provider-side.
- **Documentation accuracy:** corrected the Claude Code install path
  (`.claude/skills/delegator/`); clarified that the worktree + patch flow applies to command-runtime
  (agentic) runs while a direct `api` worker returns text with no worktree/patch; fixed the stale
  "one run at a time" wording (a provider is unbounded by default — set `maxConcurrent: 1` for
  one-at-a-time); added `secrets.yaml` to the `dlg init` file list; removed stale references to an
  unimplemented MCP server.
- **Release workflow:** `release.yml` now pushes the version commit + tag *before* publishing to npm,
  and serializes concurrent release runs.

## [0.3.22] — 2026-06-22

### Fixed
- **Codex skill install:** `dlg skill install codex` now installs to
  `~/.codex/skills/delegator/SKILL.md` (with YAML frontmatter) — the standard
  skill layout Codex actually discovers, matching `claude-code`. It previously
  wrote a bare `CODEX-SKILL.md` at the `.codex` root that Codex never loaded.
  `--project` installs to `.codex/skills/delegator/SKILL.md`. Thanks to
  [@Noviel](https://github.com/Noviel) ([#1](https://github.com/rizias/delegator/pull/1))
  for independently catching and fixing this, and for the frontmatter regression test.

## [0.3.21] — 2026-06-21

### Fixed
- **Windows:** the background update check and `dlg update` did nothing silently
  (Node refuses to spawn `npm.cmd` without a shell). Both now pass `shell` on Windows.

## [0.3.20] — 2026-06-21

### Docs
- Rewrote the README as a lean, provider-neutral entrypoint. No code changes.

## [0.3.19] — 2026-06-21

First public release.

### Highlights
- Dispatch a bounded coding task to a separate-pool agentic CLI worker
  (`codex` / `claude` / `opencode` / `pi` / `api`), isolated in a git worktree,
  budget-bounded, verified, and returned as a typed envelope.
- Wall-clock (`--budget`) plus a stall detector are the only run limits.
- Config-driven runtimes and providers (global + project), key pools with
  round-robin rotation and per-key cooldown, and a per-worker circuit breaker.
- Agent-guided onboarding: host instruction packs (`dlg skill install
  claude-code` / `codex` / `agents-md`) so your agent provisions the machine, a
  copy-paste annotated `examples/providers.example.yaml`, a QUICKSTART, and
  reset/uninstall docs. The `codex` runtime is Responses-API only — documented so
  Chat-Completions-only providers (z.ai/GLM, …) are routed via `claude`/`api`.

### Fixed
- **Native Claude subscription workers no longer fail with `401`** — the runtime's
  own login env (`ANTHROPIC*` / `CLAUDE*`) is preserved past the credential
  denylist for `auth: subscription` workers, and restored even when a user
  `runtimes.yaml` override omits it.
- **API-key Claude workers (z.ai/GLM, MiMo) no longer fail with `401`** when the
  host is logged into Claude Code — they run with an isolated `CLAUDE_CONFIG_DIR`
  so the injected provider key is used instead of the host subscription OAuth.
- **Windows:** a PowerShell-only worker shim (`codex.ps1`) resolves to its runnable
  `.cmd` / `.exe` sibling, or runs via `powershell.exe`.

### Changed
- Current Claude model ids across examples and docs (`claude-opus-4-8`,
  `claude-sonnet-4-6`, `claude-haiku-4-5`); no aliases.
