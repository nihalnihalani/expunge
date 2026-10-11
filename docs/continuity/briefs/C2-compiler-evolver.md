# Brief C2: typed harness compiler, evolver and as-of replay

Owner: **rsi-evolution** after A3-R. Owned paths: `packages/harness-compiler/`, `packages/evolution/`; takes over `packages/baselines/` from the lead. Depends on: A2-R contracts (path grammar, `contextInputs`), B1 decision ledger rows, C1 evidence bundles (can start against the frozen `EvidenceBundle` type with labeled fixtures). Frozen interfaces: `HarnessBundle`, `GuardrailAst`, `WorkflowGraph`, `ToolPolicy`, `Candidate`, `TypedPatch`, `MutationClass`; `DISCLOSED_PRIMITIVES` and `WORKER_TOOL_IDS` from `@expunge/baselines`.

Status: drafted 2026-10-11 11:10 UTC, not dispatched.

## Objective

All four surfaces evolve as typed artifacts (spec section 9): context/schema selection, workflow graph, guardrail AST, tool grants and prerequisites. The compiler is trusted code that rejects anything outside the vocabulary; the evolver is a model role that proposes one bounded, evidence-cited change; replay previews policy flips on recorded decisions; fresh trials (C3) decide admission.

## Compiler (packages/harness-compiler)

- Input: candidate `HarnessBundle` plus parent. Output: compiled artifact `{ bundleHash, compiledPredicates, workflowPlan, toolGrants, mutationClass, diagnostics }` or a typed rejection with reason codes.
- Guardrail predicates compile to MongoDB aggregation expressions (`$and/$or/$not/$cmp` over gateway-built facts) and to an equivalent TypeScript evaluator; one semantics, tested for parity on a corpus. Null/missing facts fail per a documented table. Unknown ops, fact IDs, bindings, operators, depth or node counts beyond `GUARDRAIL_MAX_*` are rejected.
- Workflow: entry reachable, every node reachable from entry, every terminal reachable, cycles only with `maxVisits`, edge conditions from the frozen enum, tool IDs from the vocabulary, no node can name grader, approval issuer or promoter routes.
- Tool policy: grants ⊆ owner floor; removing a prerequisite or adding a grant or effect kind is `authority_expansion`; adding prerequisites or deny rules is `tightening`; everything else `behavioral`. The computed class is authoritative; the model's claimed class is advisory and recorded.
- Rejections for: subject or task literals anywhere in the bundle (scan all strings against the forbidden-literal policy), hidden-test shortcuts (field IDs or record IDs not present in the public registry), no-op rules (a rule whose removal does not change any replayed decision), more than three independently justified edits, plugin bindings whose source and compiled hashes do not both verify, bundles that change `limits` above the owner maxima.
- Hashes: `compilerHash` and `vocabularyHash` from actual source bytes (reuse the `fixtureSourceCommitment` pattern).

## Evolver (packages/evolution)

- Reads: permitted `EvidenceBundle`s (training split only), parent bundle, public trial summaries, permitted structural lessons. Never reads private manifests or held-out answers.
- Proposes: one `Candidate` with 1 to 3 `TypedPatch`es, each with `sourceEvidenceIds` citing real event or span IDs and a hypothesis; a structured-output model call (no forced tool choice); labeled fake model for tests.
- Critic and pruner: retest accumulated rules for interaction and necessity; prune rules without standing; record losing candidates with reason codes.
- Controls: `score_only` and `wrong_incident` evidence formats produce candidates under the same budget; store which arm produced each candidate.
- As-of decision replay: re-evaluate the candidate's compiled predicates over `decisions` rows with facts as they were at decision time (no later receipts or outcomes); report flips and known authority flips; label results "decision replay"; never present as behavioral proof.

## Tests required

Compiler rejects: unknown node, malformed graph, unbounded loop, authority expansion without flag, subject literal, hidden-test shortcut, no-op rule, over-budget edits, source/compiled mismatch. Parity: Mongo expression versus TypeScript evaluator on at least 200 generated predicates and fact sets. Replay reproduces a known regression from a fixture ledger. Evolver (fake model) cites only IDs present in the bundle; a bundle citing nonexistent IDs is rejected before compilation.

## Evidence to report

Commands and exit codes; one generated candidate per surface against the W0 bundle with its computed class; the replay report for each; the rejection log for at least one unsafe candidate per rejection category.
