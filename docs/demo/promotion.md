# Demo promotion run

**TEST-FIXTURE ADMIT, NOT A REAL ADMISSION.** The gate report in this run is inserted by the test-only fixture path
(`packages/deployment/test/admitted-report.ts`). No gate campaign produced it; a real admit needs a provider-model campaign
of 76 episodes, which this demo does not run. Real: the descriptor from stored rows, the human grant flow, the atomic
promotion, job pinning, the real worker and domain gateway with the provider model from `.env`, the grader read-back, and the
rollback. Run it with `node --import tsx --env-file-if-exists=.env scripts/demo/promote.ts` (throwaway local replica set,
default 27218; `--no-model` skips the jobs).

## Run (one run each; an anecdote, not a result)

| Step | Output |
|---|---|
| Harnesses | W0 `071c465725c0b2cb6ba58d17b9cf86534debd98c5844c1cdd8795f7b183f5efe`, child `f1eb5184978a3be88938cab96e2f0858cfb6c4321182f2c34cb8015775a4a9d8` (operator-authored, see `candidate.md`) |
| Gate report (FIXTURE) | id `74588fbf6af58c15389ffd21bd5d8afbf153d3951f9fff82fb931693a681f084`, digest `392859fcaacfeddd91b771a2cff73886172760829d240340505c1b2757358aac`, class `behavioral` |
| Descriptor | digest `317a04b704859f6050c0b96fcf9594296d8387688bfc0b75b8087ace15b7d8a9`; changes: `contextPolicy.schemaMode` selected_fields -> all_registered_fields, `contextPolicy.includeNestedArrays` false -> true, `limits.traversalDepth` 1 -> 5; "grants it no new authority" |
| Grant | `8c39f567a1e52a4f5d5dd8c53da709371650801cdba142d6745cf78cecae7936` (approve; the owner policy asks for a grant on behavioural changes) |
| Promotion | `188616ac-75c1-4c74-a7c2-d0199619ec51`, W0 -> child, revision 0 -> 1, grant consumed in the same transaction |
| Rollback | `7a67cf23-ba47-49bb-add9-5fbcb53a35c7`, child -> W0, revision 1 -> 2, gate report id `rollback`, own grant `a372a095-5d86-47ac-99f7-70f6be104981` consumed |

## W0 vs child, side by side

Each arm is one job on an identically seeded fresh `direct_nested` world (same spec and seed, a scope of its own), same
model (`openai / gpt-6-luna`, stamped `source: provider` by the worker). Every gateway decision row of each run names its
own pinned harness. Jobs: `demo-job-w0-mv4g7bwh` and `demo-job-child-mv4g7iew`.

| | W0 | Child (after promotion) |
|---|---|---|
| Targeted residuals (grader read-back) | 5 | 0 |
| Useful completion (grader) | no | yes |
| Collateral changes / retention violations | 0 / 0 | 0 / 0 |
| Completion receipt | `incomplete` | `complete_in_registered_scope` |
| Job status | failed | succeeded |
| Model calls | 5 | 6 |
| Tokens (input + output) | 6,682 | 18,065 |
| Cost (micro-USD, as metered) | 738 | 1,867 |
| Tool calls | inspect, resolve, discover, preview, apply x1, complete | inspect, resolve, discover, preview, apply x2, complete |

W0 left accounts, events, archives (delete) and messages, notes (redact). The child left nothing, and the child costs about
2.5 times as much (more context: every registered field is shown).

## How the child got there (and what did not work)

Stored-step analysis of earlier runs showed the cause of W0's misses was discovery, not the model stopping early (my first
guess, which was wrong): with `selected_fields` the identity fields on messages and notes are invisible, so those records
were never selected; with `referenceDepth` 1 and nested arrays off, the records behind references were not found. Variants,
one run each: nested arrays + depth 5 left 2 residuals; `schemaMode` + depth without nested arrays left 4;
`completionPolicy: verified_receipt` ran out of tokens (`TokenBudgetExceeded`, 3 residuals). The final three-edit child
cleared all residuals on this world. That is one fresh world and one run per arm: it says the mechanism works, not that
the child is better in general. The unfixed worlds of the other families, protected cases and preservation were not run.
