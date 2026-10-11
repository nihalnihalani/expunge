# Harness compiler

Trusted code. Input: a candidate `HarnessBundle`, its parent and the typed patches that produce it. Output: a compiled
artifact or a typed rejection. It runs no model and reads no database; it trusts no field it can re-derive.

`compileHarness({ candidate, parent, patches, claimedClass }, context)` runs these phases and stops at the first that
reports an issue: schema (`validateHarnessBundle`), infrastructure (compiler, vocabulary, floor, runtime and
eligibility hashes and the `parentHash` link), edits (patches must be exactly the difference between parent and child;
at most three; each with a hypothesis and permitted training evidence recorded in the bundle), shortcuts (subject and
task literals, record IDs, unregistered field IDs, held-out markers), structure (guardrails, workflow, tool policy and
floor, limits, plugins), classification (authoritative mutation class; an authority expansion needs an explicit flag)
and standing (every new or changed guardrail rule must change at least one replayed decision).

## Guardrail semantics (one semantics, two evaluators)

Predicates are three-valued (Kleene): a null, missing or wrongly typed operand makes a comparison unknown; `all` is the
minimum, `any` the maximum and `not` the complement on false < unknown < true. A rule fires when its predicate is true,
or when it is unknown and the rule is restrictive (`deny`, `ask`): missing information fails closed. An `allow` rule is
inert (the default is allow) and is rejected. Severity merges deny > ask > allow. `appliesTo` (worker tool IDs) scopes a
rule to those tools; absent or empty applies to every call, and a restrictive rule over receipts, prior effects or
nullable facts must set it (`unscoped_artifact_rule`). Facts must be canonical JSON (no NaN or infinities).

The same predicates compile to MongoDB aggregation expressions over `{ toolId, facts, bindings, prior }` yielding 0, 1
or 2, restricted to an operator whitelist (no `$where`, `$function` or accumulators). Parity is tested three ways: the
TypeScript evaluator against an interpreter of the emitted operator subset (400 generated predicates x 12 fact sets and
150 rule sets, in the default run), and against a real `mongod` through `$documents` aggregation when
`MONGODB_PARITY_URI` points at a throwaway local server:

    docker run -d --name expunge-c2-parity-mongo -p 127.0.0.1:27029:27017 mongo:8.0.15
    MONGODB_PARITY_URI=mongodb://127.0.0.1:27029 npx vitest run packages/harness-compiler
    docker rm -f expunge-c2-parity-mongo

## Mutation classes

Computed from the bundles, never from the proposer's claim (which is recorded): adding a tool grant, removing a
prerequisite, removing or weakening a restrictive rule (lower severity, a scope that no longer covers every call it
covered, a predicate that is not a provable superset), weakening `completionPolicy`, or raising `changedDocuments` is an
`authority_expansion`; adding a prerequisite or restrictive rule, removing a grant, lowering a limit or requiring a
committed receipt is a `tightening`; everything else is `behavioral`.

## Hashes and vocabulary

`COMPILER_HASH` commits to the bytes of every compiler module and the contracts module; `VOCABULARY_HASH` to the
resolved primitive tables and the bytes of `vocabulary.ts`, `@expunge/baselines` `primitives.ts` and contracts. A bundle
records them in `compilerHash` and `vocabularyHash`. The human-authored primitives (facts, bindings, comparators,
enum domains, patch paths) live in `@expunge/baselines` and are disclosed there.

## Rejections

`REJECTION_CODES` is the whole vocabulary of reasons. A rejection carries codes, vocabulary paths and fixed messages,
never bundle text. `test/rejection-catalog.ts` is a complete `Record<RejectionCode, () => CompileResult>`: one unsafe
candidate per code, enforced by the type system, run case by case in `test/rejection-catalog.test.ts`.

Verification: `npx vitest run packages/harness-compiler`.
