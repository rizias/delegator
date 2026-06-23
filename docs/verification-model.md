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

## 3. The frozen judge

The tension: "verify from the sandbox" includes the worker's own edits to tests — but a worker must
not be able to swap out the test that judges it. The resolution is a **frozen-judge overlay:**

1. At run start, snapshot the "judge" files — test sources, test configs, CI workflows,
   manifests/lockfiles, snapshots, generated fixtures — by a glob list plus content hashes.
2. The worker works in the sandbox as usual.
3. Before verification, the worker's patch is applied, and the judge files are re-checked by hash.
4. If the worker touched a judge file (by hash) **or added a new one** → status `requires-review`
   (never auto-applied), **even if the tests are green**. *(Restoring judge files to the snapshot and
   re-running against a clean judge is a deferred follow-up. The shipped slice is
   **detection → `requires-review`**, which already blocks a gamed green from auto-applying; it does
   not silently reset the worker's judge edits.)*

"Judge" classification is a glob list plus the rule **"no new judge files"** — not a static set of
names.

## 4. Work preservation and identity

- **Patch extraction is atomic:** if extraction fails, the status is NOT `completed`; the sandbox and
  raw output are preserved and the failure is recorded.
- **Result identity:** the receipt records the base commit, the patch SHA-256, and the apply target, so
  what gets applied is exactly the diff that was verified.
- Shared state is written atomically even in single-run mode (§1).

## 5. Honest statuses (derived from facts, not the worker's words)

- **completed** — patch extracted AND verification green AND the judge was untouched.
- **partial** — a patch exists, but verification is not green.
- **failed** — no patch / extraction failed / crash / provider failure.
- **requires-review** (do not auto-apply) — a judge file was touched (§3), even if "tests passed".
- **not-run / not-applicable** — verification did not run or is irrelevant to the change. In that case
  never display "passed".

## 6. Negative properties (what verification must NOT let through)

There must be tests proving a worker **cannot** earn a green result when: the host environment leaks
into the sandbox; the judge is swapped; the patch is empty/no-op; the build never ran; or the main tree
was changed by something other than this run. Without these, the model is a set of flags with no proven
protection.

## 7. The boundary: honesty ≠ correctness

This model delivers **honesty** (verification really ran, from the sandbox, against a frozen judge). It
does **not** deliver **correctness** (that "passed" means "done right"): on weak or absent tests a green
signal means little, and that is a common case. So for weakly-tested work, the proof is a separate
**reviewer worker** plus a **verification-strength label**; an "honestly green" run is never presented
as "correct".
