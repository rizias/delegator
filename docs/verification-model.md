# Verification model — honest receipts, not worker claims

delegator runs your build/test commands itself, in the worker's worktree, and derives the run status
from **facts** (did the patch extract, did verification pass, was the judge untouched) — never from the
worker's own text. This page is the operational contract for that.

## 1. Concurrency (per provider)

A provider runs **unbounded by default**; set `maxConcurrent: 1` on it to force one active run at a time
(and `concurrencyGroup` to share a limit across providers; a model can also cap itself with
`limits.concurrent`). Either way, shared-state writes (`state.json`, semaphore, breaker) are made
**atomic immediately** (temp file + rename), so concurrent runs cannot corrupt them.

## 2. What "safe verification" means (the network is NOT cut)

Verification = running the worker's code on your machine, inside the worker worktree. The protection
is what actually helps and what real agents do, without invented constraints:

- **a separate git checkout** — verification runs in a disposable git worktree created from `HEAD`;
  tracked files are present, while untracked files such as `.env` are not copied by the git-worktree
  path. A non-git workspace copy mode would need its own rules;
- **with a time limit** — verification runs under a wall-clock timeout, so it cannot hang without end;
- **minimal rights to your tree** — the worker operates in its own worktree; the main tree is outside
  the run path.

**The network is not disabled during verification.** Real agents (Claude Code, Cursor, Copilot) don't
cut it; a worker is an agent that already had the network for the whole work phase, so cutting it only
at the verify step is pointless against exfiltration — and many projects genuinely need the network in
tests (dependencies, integration tests), which a ban would break. An optional *offline / reproducible*
mode may return later as a determinism convenience — never as a security claim, and off by default.

## 3. Judge-path detection

Verification runs against the worker's own files. Delegator checks extracted changed paths against
judge globs for test sources, test/CI configs, manifests and lockfiles, and snapshot/fixture files.
If a changed path matches, the run becomes `requires-review` and is never auto-applied, even if
verification is green. It does not snapshot, hash, restore, or overlay judge files.

"Judge" classification is a glob list, not a static set of names.

## 4. Work preservation and identity

- **Patch extraction is atomic:** if extraction fails, the status is NOT `completed`; the sandbox and
  raw output are preserved and the failure is recorded.
- **Result identity:** the receipt records the base commit, the patch SHA-256, and the apply target, so
  what gets applied is exactly the diff that was verified.
- Shared state is written atomically even in single-run mode (§1).

## 5. Honest statuses (derived from facts, not the worker's words)

- **completed** — the worker finished without a terminal failure. It does not guarantee a patch or that
  verification ran; a run with no patch has verification skipped.
- **partial** — a patch exists, but verification is not green.
- **failed** — no patch / extraction failed / crash / provider failure.
- **requires-review** (do not auto-apply) — a judge file was touched (§3), even if "tests passed".
- **not-run / not-applicable** — verification did not run or is irrelevant to the change. In that case
  never display "passed".

## 6. Negative properties (what verification must NOT let through)

The judge-path guard forces `requires-review` when extracted changed paths match judge globs. It does
not freeze judge files, and an empty/no-op successful run can be `completed` with verification skipped.

## 7. The boundary: honesty ≠ correctness

This model records whether verification ran and flags judge-path changes for review. It does **not**
deliver **correctness** (that "passed" means "done right"): on weak or absent tests a green signal means
little, and that is a common case. There is no frozen judge or verification-strength label.
