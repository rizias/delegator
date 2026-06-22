# Changelog

All notable changes to Delegator are documented here. This project adheres to
[Semantic Versioning](https://semver.org), and the format is based on
[Keep a Changelog](https://keepachangelog.com).

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
