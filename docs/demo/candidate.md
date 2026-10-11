# Demo candidate: operator-authored child of W0

**Label: OPERATOR-AUTHORED.** This child was written by a person, not proposed by the evolver. No provider model is wired
for the evolver, so there is no real evolver call. The real harness-compiler judges it exactly as it would judge an
evolver proposal. Regenerate with `node --import tsx scripts/demo/candidate.ts`; the output is deterministic.

## Result

| Item | Value |
|---|---|
| Parent (W0 built on this checkout) | `071c465725c0b2cb6ba58d17b9cf86534debd98c5844c1cdd8795f7b183f5efe` |
| Child | `f1eb5184978a3be88938cab96e2f0858cfb6c4321182f2c34cb8015775a4a9d8` |
| Runtime hash baked in | `528ff3c9390b9f6dc37e47d0a0030b6b68c2f945746ef1b343d616ff394c9334` (this checkout's `runtimeHash()`) |
| Computed authority class | `behavioral` |
| `requiresGrant` | `false` (the demo's owner policy still asks for a human grant for behavioural changes) |
| Compiler diagnostics | none |
| Bundle file | `.expunge/demo/candidate.bundle.json` (bare `HarnessBundle`), sha256 `41edcf1d1bc0c98effa58e6de342fad8686b27ec0bcc7a4e685b71f2b7f1d66b` |
| Report file | `.expunge/demo/candidate.json` (diff, class components, patches, parent bundle) |

If `runtimeHash()` changes (it hashes the runtime and `apps/worker/src`), re-run the script; pass `--runtime-hash <hex>` to
match another build.

## Executable diff

The aim is W0's miss on `direct_nested`: it deleted the customer record and left the rest. W0 shows selected fields only
(so identity fields such as `subjectKey` on messages and notes are invisible to discovery), ignores nested arrays and
follows references one hop.

| Unit | W0 | Child | Classifier reading |
|---|---|---|---|
| `contextPolicy.schemaMode` | `selected_fields` | `all_registered_fields` | behavioral (execution behavior changed) |
| `contextPolicy.includeNestedArrays` | false | true | behavioral (execution behavior changed) |
| `limits.traversalDepth` | 1 | 5 | behavioral (limit raised) |

The compiler's edit budget is three, and a context reference depth may not exceed the traversal bound, so `referenceDepth`
stays at its default. Earlier variants, from stored-step analysis of real runs (one run each, anecdotes): nested arrays plus
`referenceDepth`/`traversalDepth` 5 left 2 residuals (messages, notes: identity fields hidden); `schemaMode` plus the two
depths without nested arrays left 4; adding `completionPolicy: verified_receipt` instead blew the 24,000-token cap. All
three edits stay inside the owner floor. Nothing else differs from W0 except one `evidence` entry (below).

## Evidence

The patches cite the baseline run's record ids: `job_eea9d347`, `receipt_a685d993`, `effect_5d0815f2`. These are the
abbreviated ids from the brief. The compiler refuses a citation that is not in an evidence catalog, and this checkout
cannot read the observer's real bundles. The script therefore builds one catalog entry from an operator
**transcription**: ids only, tool inputs and failure witnesses empty, `withheld` and `truncated` set. That entry is also
the one `evidence` item on the child. It is provenance, not verified evidence, and nothing in the compile or the gate
treats it as a measured result. Pass `--baseline-job`, `--baseline-receipt` and `--baseline-effect` to use full ids.
