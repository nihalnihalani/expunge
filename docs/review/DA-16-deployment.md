# DA-16: `packages/deployment`, D1 (admitted-report loader) and D2 (descriptor and grant)

Reviewer: devils-advocate (`claude-opus-5-5`), 2026-10-11. This is a static read of the working tree:
- `src/report.ts`, `src/descriptor.ts`, `src/grant.ts`, `src/testing/admitted-report.ts`;
- `test/support.ts` and the two integration tests;
- for context, `harness-compiler/src/classify.ts`, `mongo/src/deployment.ts` and `mongo/src/roles.ts`.

I ran nothing. D3 (promotion and rollback races) and D4 (pinning) will follow in this file.

## Dispositions

| Piece | Disposition |
|---|---|
| **D1: `loadAdmittedReport`** | **ACCEPT-WITH-FOLLOWUP.** DP-1 and DP-2 are required before a service uses it. DP-3 is required before the first provider campaign, together with DA-11 F1-b. |
| **D2: `renderDescriptor` and `answerApproval`** | **ACCEPT-WITH-FOLLOWUP.** DP-5 (a flip mislabelled as "removed") should be fixed in this packet. DP-6 and DP-7 can follow. |

## Answers to the lead's questions

### Can a fixture or test path admit in production?

Not by default. But the defence is a label and an argument, not a control.

- **DP-1 (MEDIUM, DEMONSTRATED): the test fixture can be told apart only by its label.**
  - `src/testing/admitted-report.ts` stores its admit through `GateStore(grader).saveReport`, exactly as `runGate` does,
    with `portKind: 'worker'` and `modelKind: 'provider'`.
  - The only thing that marks it as a fixture is the `portLabel` prefix `LABELED TEST FIXTURE` (`report.ts:89`).
  - Any grader-principal holder could store a hand-built admit with any other label, and the loader would accept it.
  - `allowTestFixtures` is a plain argument on `loadAdmittedReport`, `renderDescriptor` and `answerApproval`, all
    exported from the package index. Any service caller can set it. "Never set in a service" is a comment, not a check.
  - Every test in both suites runs with `allowTestFixtures: true` (`report.integration.test.ts:9`,
    `grant.integration.test.ts:11`). No test loads a report that a gate run actually produced.
  - Required:
    - Remove the option from the exported production functions. Tests can wrap an internal loader or inject a reader.
    - Add one test that loads a report from a real `runGate` result (the gate's live rig exists).
- **DP-3 (MEDIUM, LIKELY; required before any provider campaign): the loader cannot re-verify the evidence.**
  - It trusts that a stored `admit` came from `runGate`, because the report body carries the run ids but nothing the
    loader can check.
  - Once `run_attestations` is authoritative (DA-11 F1-b), the loader should confirm, for every paired trial's
    `parentRunId` and `candidateRunId`, that the run's job exists and its attestation rows carry the frozen provider
    model.
  - Then a forged or hand-stored admit requires the worker principal, not just the grader principal.

### Can a stale or forged descriptor get a grant? No.

- The client sends only `{descriptorDigest, decision}`.
- `answerApproval` re-renders the descriptor from storage and compares digests (`grant.ts:40-41`).
  - The digest covers the pointer revision, scope revision, authorization revision and gate report digest.
  - So a moved pointer, a bumped authority, or a changed or edited report makes the old digest stale.
  - Tests cover pointer movement, an authority bump and report edits (`grant.integration.test.ts:121-175`,
    `report.integration.test.ts:171`).
- Every grant field is derived from the stored report and pointer.
- Note: the other request fields (`reportId`, hashes, `target`, `actor`) come from the server route, not the human. The
  approval service must bind `actor` to its configured owner, as the domain service's approval token already does.

### Is the human reviewing what actually executes? Partly.

- **DP-5 (MEDIUM, DEMONSTRATED): some authority expansions are labelled "removed".**
  - `changeOf` maps a component's `reason` text with regexes evaluated in order: `/added/`, then `/removed/`, then the
    widening patterns (`descriptor.ts:37-44`).
  - The classifier emits two **authority_expansion** reasons that contain "removed" (`classify.ts:44,101`):
    - `restrictive rule removed`;
    - `prerequisite removed`.
  - Both therefore appear in `flipSet` as `change: 'removed'`, which reads as a reduction even though both widen what the
    worker may do.
  - The `consequences` line is correct ("Expands authority: ..."), but `flipSet` is digest-bound and is what a UI is
    likely to render as a badge.
  - Fix:
    - An `authority_expansion` component may only be `added` (a tool grant added) or `widened` (everything else). Never
      `removed` or `tightened`.
    - Derive the label from the component's structured fields, not from prose.
    - Add a test for both reasons.
- **DP-6 (LOW-MEDIUM): the human sees authority flips only, not the full change.**
  - `consequencesOf` lists only authority expansions. Otherwise it says "Changes how the worker runs; grants it no new
    authority."
  - Behavioural components are never shown, such as raised limits (`limit raised`), workflow or context changes, and an
    increased `referenceDepth`. Neither is a before/after of the changed units.
  - Spec section 13 asks for a meaningful before/after harness diff and clear consequences.
  - Fix: include every classified component (unit, kind, reason) and the before/after values of changed units in the
    digest-bound body.
  - Optionally include the gate summary as well: trigger gain, protected regressions, cost and attempt or resume count.
    A human approving a behavioural change then sees the evidence and the actual delta.

### Grant expiry and replay

- **Expiry** is bounded `[1 s, MAX_GRANT_LIFETIME_MS]`, defaults to 15 minutes and is server-supplied, not set by the
  human (`grant.ts:44-46`). `ApprovalRepository.issue` re-checks the maximum (`deployment.ts:130`).
- **DP-7 (LOW; verify in D3): one descriptor can yield several grants.** Approving the same digest twice issues two
  grants with different `grantId` and `nonce`; I saw no uniqueness on (proposal, descriptor digest). Each grant binds
  `parentRevision`, which is the pointer revision at render time.
  - If promotion requires `grant.parentRevision === pointer.revision` and consumes each grant once, a spare grant dies at
    the first promotion or rollback, so it cannot re-promote the child after a rollback without a new human approval.
    I will confirm both properties in D3.
  - Simpler still: make `issue` idempotent per (proposalId, gateReportDigest, parentRevision).
- **Declines are not recorded.** That is by design ("records nothing"), but it leaves no audit trail of a human refusal.
  Consider an insert-only decline row.

### Does anything trust the candidate row? No.

- D1 and D2 never read `candidates`. `proposalId` is `report.candidateId`, which is the gate's free-text candidate id
  (DA-11 F-12, unchecked).
- It is display-only and bound into the grant here. If D3's promotion moves a `candidates` row by `proposalId`, the
  unchecked id could move the wrong row. I will check this in D3.

## Other

- **DP-2 (MEDIUM, DEMONSTRATED by the role manifest): the approval issuer cannot run the taint check under real RBAC.**
  - `loadAdmittedReport` calls `ProvenanceRepository.tainted`, which reads `artifact_eligibility` and `provenance_edges`.
  - The `approval_issuer` role has FIND only on `candidates`, `gate_reports`, `deployments`, `artifacts` and
    `authority_revisions` (`roles.ts`, approval_issuer block). The promoter does have both reads.
  - Local tests do not show this, because the local environment labels principals without enforcing RBAC.
  - On Atlas, `renderDescriptor` run as the issuer fails closed: no grant can ever be issued.
  - Fix: grant `approval_issuer` FIND on `artifact_eligibility`, `provenance_edges` and `provenance_closures`, and add a
    row to the RBAC matrix.
- **Sound:**
  - the report id is recomputed from the stored child's projection;
  - `childHash` must equal the promoted hash (closes DA-11 N-2);
  - class and flips are recomputed;
  - evaluator, generator, compiler and rule hashes must equal the running modules (D8-11);
  - taint is re-checked for the child and its evidence hashes in the target scope.

## D3: promotion and rollback (`src/promote.ts` over `DeploymentRepository.promote`/`rollback`)

**Disposition: ACCEPT-WITH-FOLLOWUP** (DP-8 to DP-10). The transaction design is sound. I read `promote.ts` and
`mongo/src/deployment.ts:272-460, 520-620`, and the test list in `promote.integration.test.ts`. I did not run the
tests; the owner reports 10 live.

### Can a promotion commit without consuming its grant, or consume a grant and then fail to promote? No.

- Inside one `service.transaction`, `DeploymentRepository.promote` does all of the following, in order:
  - re-reads the stored report;
  - checks the report's digest, verdict, ids, runtime and evaluator against the request;
  - fences live authority and checks the floor;
  - re-checks taint;
  - derives `requiresApproval` from the stored `computedClass` and the stored policy;
  - when approval is required, consumes the grant by inserting a unique `grant_consumptions` row, after an exact binding
    check against stored rows (an unexpired grant per `$$NOW`, with scope, target, proposal, hashes, parent, scope and
    authorization revisions, flip set, report id and digest, and descriptor);
  - moves the pointer only by compare-and-set on `{activeHash: parent, revision, scopeRevision}`;
  - writes the receipt and the outbox row.
- If the compare-and-set fails (`StaleParent`), the whole transaction aborts, and the consumption row with it. The barrier
  race test shows exactly one grant consumed.
- A lost acknowledgement is answered from the saved receipt (`committedPromotion`), never re-executed.
- Rollback consumes its grant in the same transaction as its own compare-and-set, and fails closed without
  `expectedScopeRevision`.
- **DP-7 is resolved.** A grant must match `parentRevision` (the pointer revision read before the transaction), and the
  compare-and-set is on that revision. A spare grant from a double approval is therefore dead after the next promotion or
  rollback, and each grant is consumed at most once.

### Are the RaceHooks reachable in production? Yes, as fields of the exported request types.

- **DP-8 (LOW-MEDIUM).** `PromoteRequest.hooks` and `RollbackRequest.hooks` (`promote.ts:13-32, 89-96`) are part of the
  public API, so any service that builds a request can pass them.
- `inTransaction` runs arbitrary async code inside the retried transaction callback (`promote.ts:82-85, 120-123`). The
  spec forbids HTTP or model calls inside a retried transaction.
- No authority bypass follows from this: the hook runs after the fence and before the compare-and-set, and a throw only
  aborts. But it is a test seam on the production surface.
- Fix: remove `hooks` from the exported types and inject them through a test-only internal entry point (or a module-level
  seam that the package index does not export).

### Does anything trust the candidate row? No, for authority. One cosmetic risk.

- **DP-9 (LOW).** After the compare-and-set, promotion runs
  `candidates.updateOne({ candidateId: input.candidateId }, { $set: { state: 'promoted' } })` (`deployment.ts`,
  "lifecycle mirror only").
- `candidateId` is the gate's unchecked free-text id (DA-11 F-12), and `updateOne` touches the first matching row. A
  gate run with a wrong or reused `candidateId` would therefore mark another candidate's row `promoted`.
- This does not affect authority, but the lineage view would show it.
- Fix: bind the gate's `candidateId` to a stored `candidates` row whose `childHash` equals the report's child (DA-11
  F-12), and update by `{ candidateId, childHash }`.

### Other

- **DP-10 (LOW-MEDIUM, LIKELY): the evidence check before the transaction can go stale.**
  - The in-transaction taint check covers only `[input.childHash]` (`deployment.ts`, `tainted(key, [input.childHash],
    session)`).
  - The child's evidence content hashes are checked only before the transaction, in `loadAdmittedReport`.
  - Unless every evidence source is a provenance ancestor of the child artifact (so that `blockedByAncestry` covers it),
    a source revoked between the load and the commit does not stop the promotion.
  - Fix: pass the child's evidence hashes to the in-transaction `tainted` call too. Spec section 10 asks that live source
    eligibility be fenced, not only checked.
- **DP-1 extends here.** `promoteAdmitted` forwards `LoadOptions`, so a caller passing `allowTestFixtures: true` would
  promote a fixture admit. Remove the option from production exports, as asked under D1.

### Updated summary

| Piece | Disposition |
|---|---|
| D1 | ACCEPT-WITH-FOLLOWUP (DP-1, DP-2 required before service use; DP-3 before a provider campaign) |
| D2 | ACCEPT-WITH-FOLLOWUP (DP-5 fix in packet; DP-6) |
| D3 | ACCEPT-WITH-FOLLOWUP (DP-8, DP-9, DP-10; DP-7 resolved) |
