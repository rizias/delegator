# Using delegator from any host (and several at once)

The core insight: **delegator is one CLI on your machine.** Every orchestrator — Claude Code, Codex, OpenCode, Gemini CLI, Pi — drives the *same* `dlg` binary (`delegator` is the same command) and the *same* `~/.delegator/` config. The host is just the brain that decides; the dispatch, isolation, and bounding are identical everywhere.

See [GLOSSARY.md](GLOSSARY.md) for the public terms used here.

## Authenticate your workers first

Each worker CLI owns its **own** login. delegator only spawns that CLI; it does not log in for it.
Before first use, open the worker CLI in its own terminal and authenticate there: `claude` then
`/login`, `codex login`, `opencode auth login`, or the equivalent for your runtime.

A binary shown as found by `dlg doctor` is not the same as a logged-in worker. A missing login surfaces
as a 401 / "not logged in", and sometimes as a timeout while the CLI retries.

## How a host "uses" delegator

There is nothing to connect. If the host can run a shell command, it can delegate:

```bash
dlg providers --json                       # what can I use here?
dlg run -w zai/glm-5.2 -f brief.md --json  # -w is a [runtime/]provider/model handle
dlg apply <runId>
```

Handles shown here are examples; yours depend on your config.

Two levels of integration, both optional:

1. **Bare CLI** — works in any agent today, zero setup. The brain runs `dlg …` like any tool.
2. **Host adapter (skill)** — teaches that specific host *when* and *how* to delegate, in its native format. Same CLI underneath.

| Target | Command | Where it goes |
|---|---|---|
| Claude Code | `dlg skill install claude-code` | `~/.claude/skills/delegator/` (`--project` → `.claude/skills/delegator/`) |
| Codex | `dlg skill install codex` | `~/.codex/skills/delegator/` (`--project` → `.codex/skills/delegator/`) |
| **Any Agent Skills-compatible agent** | `dlg skill install agent-skills` | `~/.agents/skills/delegator/` (`--project` → `.agents/skills/delegator/`) |
| **Literally anything else** | `dlg skill show` | prints the skill — paste it into that agent's instruction file (GEMINI.md, rules, system prompt, …) |

So "I have 50 different agents" needs no 50 integrations: one `dlg skill install agent-skills` writes a host-neutral skill into `~/.agents/skills/` that every Agent Skills-compatible agent discovers, and the escape hatch `dlg skill show` covers every other format by copy-paste. The adapter is just text. The guarantee that delegator *works* comes from the CLI; the adapter only improves *when the brain reaches for it*.

**Keeping skills current.** Each installed skill records a version stamp in its frontmatter (`metadata.delegator-skill-version`, a UTC timestamp). After you upgrade `dlg`, run `dlg skill update` to refresh any installed skill whose content differs from the one this `dlg` ships — `--check` previews without writing, and `dlg doctor` flags a stale skill so you know when to run it.

## Several agents at once

Open Claude Code, Codex, and OpenCode in the same repo simultaneously — all three can delegate, because:

- They share `~/.delegator/` (providers, secrets, key pools) — one place to configure.
- Runs are grouped per project and each run gets its own git worktree, so concurrent runs never collide in the filesystem.
- A *provider* runs **unbounded by default** — cap it with `maxConcurrent` (e.g. `maxConcurrent: 1` for one run at a time; a model can also cap itself with `limits.concurrent` — see [verification-model.md](verification-model.md) §1). Dispatches past a cap queue rather than overlap. Parallelism across *different* providers/hosts is always free.
- A run id is global; `dlg status` from any host sees all runs for that project.

So "I want each of them to use delegator" = install each host's adapter once (or just rely on the bare CLI). No per-host servers, no coordination.

## Restricting a project to specific models

Drop a `.delegator.yaml` in the repo root (config-first; or run `dlg restrict`):

```yaml
# Only these worker handles may run in this repo
restrict:
  workers: [openai-codex/gpt-5.5, zai/glm-5.2]   # entries are [runtime/]provider/model handles
```

Now `dlg providers` reports every other worker as `restricted`, and any attempt to run one is refused with a message naming the allowed set. This is the "open the project in Codex and say *use only your own models*" case: the allow-list is the hard cap — the global registry can only be narrowed here, never widened. Pin a repo to a chosen vendor in three lines. (`restrict.tiers` does the same if you still use the optional legacy `tiers:` block.)

## Run statuses and exit codes

`dlg run` (blocking) exits with:

| Exit code | Meaning |
|---|---|
| `0` | Run completed (and applied, under `auto` policy) |
| `1` | Internal CLI error |
| `2` | Usage / config error |
| `3` | Run rejected before it started (no available worker, validation) |
| `4` | Run finished with a NON-success status — `partial`, `requires-review`, `failed`, or `killed-*` (the envelope is still valid) |

**`requires-review` (exit 4):** the patch is kept but is **never auto-applied**. This happens when the worker edited a judge file — test sources, test config, CI workflows, snapshots, or fixtures — making the verification result untrustworthy (see the frozen-judge model in [verification-model.md](verification-model.md)). Under `policy: auto` the apply is refused. Inspect the kept worktree/patch, then `dlg apply <id>` to apply manually after review.

**Patch-loss protection:** if patch extraction fails after the worker exits cleanly, the run is `failed` (not silently `completed` with an empty diff) and the worktree is preserved so the work is recoverable via `dlg apply <id>`.

Whether the heavy git checkout survives is governed by `defaults.worktreeRetention`
(default `keep-unfinished`); `patch.diff` is persisted either way, so `dlg apply <id>`
works regardless.

| Status | What it means | Worktree kept? (default `keep-unfinished`) |
|---|---|---|
| `completed` | Verification green, diff within thresholds | No — checkout dropped, `patch.diff` kept. Set `worktreeRetention: keep` to retain |
| `partial` | Worker exited but verification failed, or killed mid-run | Yes — kept for inspection/recovery |
| `requires-review` | Patch exists; verification not trustworthy (judge-tampered) | Yes |
| `failed` | No usable patch, or a hard error | Yes |
| `killed-timeout` / `killed-no-progress` | Killed by a control bound | Yes |
| `rejected` | Never started (unavailable worker, quota, validation) | No |

## Run statistics

Every run reports statistics in `envelope.usage`: wall-clock duration (`wallClockMs`), top-level
model turns (`iterations`, when available), and token usage (`tokens.total`, including
`tokens.reasoning` when the runtime reports it). `dlg run` prints the same summary, and
`dlg result <id> [--json]` shows the stored usage for any run.

## Can a host refuse to use the skill?

Honestly: a model *can* ignore a skill — skill/MCP invocation is probabilistic. Delegator mitigates this in layers, strongest last:

1. **The CLI is always there.** Even with no skill, the brain can run `dlg` — and the user can say "use delegator" explicitly.
2. **Adapter instruction** raises the odds the brain reaches for it on the right tasks.
3. **Project rule** (`CLAUDE.md` / `AGENTS.md` line: "for mechanical/standard coding, delegate via `dlg run`") makes it a standing instruction, not a suggestion.
4. **Hook (hard guarantee, Claude Code).** A `PreToolUse`/prompt hook can *require* delegation for matching tasks — the harness enforces it, not the model. This is the only true guarantee and is the M3 deliverable for hosts that support hooks.

Pick the level you want per host; the CLI floor means delegator is never unavailable, only under-used at worst.
