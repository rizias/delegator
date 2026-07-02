# Glossary

Use one public term per concept. Synonyms below are accepted for orientation, but docs should prefer
the first term.

| Term | Synonym | Meaning |
|---|---|---|
| Orchestrator | Architect | The deciding host agent that writes the brief, chooses the worker, reviews the envelope, and applies or rejects patches. |
| Worker | Executor | The spawned CLI or direct API call that performs one bounded task. |
| Runtime | CLI adapter | The execution adapter for a worker, such as `claude`, `codex`, `opencode`, `pi`, or `api`. |
| Provider | Credentialed endpoint | A configured source of models and authentication, such as a subscription CLI, API endpoint, or local endpoint. |
| Handle | `[runtime/]provider/model` | The runnable worker identifier selected with `-w` or `defaults.model`. |
| Envelope | Typed result object | The structured result for a run: status, attempts, diff, verification, usage, errors, and stop reason. |
| Receipt | Kept run record | The lightweight retained run record, including the envelope, patch, and logs. |
| Worktree | Isolated checkout | The separate git checkout where a worker runs and verification executes. |
| Council | Multi-model fan-out | Running ONE task across several DIFFERENT worker models in parallel (`dlg council`), gathering every answer plus a synthesis `bundle`; the orchestrator (or an `--aggregate` model) writes the final. |
| Bundle | Synthesis prompt | The ready aggregate-and-synthesize prompt `dlg council` returns, concatenating all candidates' answers for the orchestrator to synthesize a final from. |
| Candidate | Council member result | One council worker's entry in the envelope: its `runId`, status, full answer, diff, and tokens. |
| Quorum | Minimum proposers | The minimum count of usable council answers (`--min-proposers`, default 2); below it the envelope reports `quorumMet: false` / `stopReason: degraded`. |
