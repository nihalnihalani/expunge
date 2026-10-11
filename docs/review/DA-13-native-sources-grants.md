# DA-13: native owner sources (A) and grants (B)

Reviewer: devils-advocate (`claude-opus-5-5`), 2026-10-11. Static read of the working-tree packets in `packages/mongo`:
- `native-values.ts`, `owner-source.ts`, `native-adapter.ts`, `source-revision.ts`;
- the diffs to `roles.ts` and `authority.ts`;
- the new tests;
- `docs/MONGO.md` sections "Native owner sources" and "Campaign permits ...".

I did not run the integration suites for this pass.

## Dispositions

| Packet | Disposition |
|---|---|
| **A. Native owner sources** | **ACCEPT-WITH-FOLLOWUP.** It is a correct and careful foundation, and nothing in the gateway or worker uses it yet (disclosed). One documentation overclaim must be corrected in this packet (NA-1). NA-2 and NA-3 are required before the gateway uses the adapter. |
| **B. Grants** | **ACCEPT-WITH-FOLLOWUP.** No grant widens past what is named, but two have consequences that must be recorded (GB-1, GB-2). GB-1 needs a decision before any production scope exists on the same cluster. |

## A. Native owner sources

### Answers

**Can a missed precondition or a crash ever overwrite an external writer's value? No, I found no such path.**
- `applyEffect` writes only through a conditional filter.
  - Under `document_exact` that is the whole-document `$expr: {$eq: ['$$ROOT', {$literal: pre}]}`.
  - Under `version_field` it is the owner's version plus a guard on each value being replaced (`native-adapter.ts:545-558`).
- Writes are targeted `$set` with `arrayFilters`, or `deleteOne`.
- A miss re-reads. The adapter returns `replayed` only if the document already equals the expected post-image (`:560-568`).
- Driver `retryWrites` is safe for the same reason: a retried write finds the precondition false and falls into the
  replayed branch.
- Two disclosed caveats:
  - MongoDB equality compares numbers by value, so an int changed to a double of the same value passes `document_exact`.
    Nothing external is lost, but the read-back then throws `ReadbackMismatch`.
  - `version_field` trusts the owner's writers to bump the version. For `delete` and `restrict` it has no per-value
    guard (`guards` is empty for both), so an owner write that skips the version bump would be deleted or restricted
    over. That follows from the owner's own declaration. State it in the registration documentation as the contract of
    `version_field`.

**Is delete after a crash safe, given the source write and the receipt are separate operations? It is safe for the data
but not for the record.**
- After a crash, or after a `ReadbackMismatch` on a write that did commit, the source has changed and no receipt exists.
- For a delete, a re-apply sees the record absent and returns `SourceConflict('absent')`. Nobody can tell this from an
  external delete. A completion built afterwards would neither credit nor deny it.
- See NA-1 and NA-2.

**Can ownership be inferred or defaulted? No.**
- `owner` is required at registration (`owner-source.ts:179-180`, "never a default").
- `ownedClosure` skips `none` and walks only `to` incoming and `from` outgoing (`native-adapter.ts:301-337`).
- I found no inference path.
- One gap remains: the adapter does not check that an `applyEffect` target is inside the owned closure. See NA-3.

**Is anything still synthetic-only but claimed as native? No overclaim of integration.**
- MONGO.md says the gateway and worker do not use native sources yet.
- The tests use made-up records on a local replica set, and the docs disclose it.
- The contract types (`ReceiptCoverage`, `AppliedEffect`, `DomainAddress`) still assume numeric versions and four id
  types, also disclosed.
- The one overclaim is the recovery sentence (NA-1).

### Findings

- **NA-1 (DEMONSTRATED; fix the documentation in this packet).** MONGO.md says "recovery is idempotent re-apply
  (`replayed`) for updates". That is false after a real crash.
  - `applyEffect` compares the current document with `expectedPreimageHash` first, and throws
    `SourceConflict('preimage_changed')` when they differ (`:480-484`). The replay check sits behind that, at `:560-563`.
  - A process that restarts and re-applies with the original preimage hash therefore gets a conflict, not `replayed`.
  - The `replayed` test (`native-source.integration.test.ts:716-752`) only covers a write that lands between the
    adapter's own preimage read and its write, inside one call.
  - Correct the sentence to: "after a crash, an update re-applied with the old preimage is a conflict; re-preview, which
    finds nothing left to write". Or implement NA-2.
- **NA-2 (required before gateway use).** The control plane needs a write-ahead intent.
  - Before the source write, commit `{effectKey, address, preHash, expectedPostHash | null}` to the control database.
  - At recovery, decide from that intent:
    - current hash equals `expectedPostHash`: applied, so issue the receipt and label it `recovered`;
    - record absent and the intent was a delete: "applied or externally deleted", recorded as exactly that, never as
      Expunge's verified delete;
    - current hash equals `preHash`: not applied;
    - anything else: conflict.
  - Without this, every crash or `ReadbackMismatch` leaves a source change that no receipt explains.
- **NA-3 (LIKELY, for the gateway).** `applyEffect` and `planEffect` take any registered address that has an allowed
  effect.
  - Nothing ties the target to the subject's owned closure.
  - `planEffect` redacts every string in a `payload` field. Called on a shared parent, it would wipe that parent's
    content.
  - The stored plan in the gateway must pin target addresses from `ownedClosure`, or the adapter should take a closure
    token or a set of addresses.
- **NA-4 (LOW).** `DATABASE_NAME` refuses only the `expunge_` prefix (`owner-source.ts:93,136`).
  - It also accepts `admin`, `local` and `config`.
  - It accepts the deployment's actual control and world database names whenever `EXPUNGE_*_DB` is set to a name
    without that prefix.
  - Fix: refuse the system databases and the configured `EXPUNGE_*_DB` names, at registration and again at
    `connectOwnerSource`.
- Sound: `connectionRef` must match `^EXPUNGE_SOURCE_[A-Z0-9_]{1,48}_URI$`, so a registration cannot point the adapter at
  `MONGODB_SETUP_URI`. Retained fields and legal holds are never written. The read-back compares hashes byte for byte.
  Undeclared `_id` types are refused and counted. Closure truncation is reported.

## B. Grants

### Answers

**Does any grant widen beyond what is named?** No. Each grant is exactly the collection named. Consequences:

- **GB-1 (MEDIUM, DEMONSTRATED by the role manifest): the evaluation-only restriction lives in code, not in the
  database.**
  - The fixture builder's new `INSERT` on `authority_revisions` and `authority_touches` is a collection grant
    (`roles.ts` fixture_builder block). The "evaluation environment only, no worker pointer" rule exists only in
    `installForCampaign` (`authority.ts`, via `assertCampaignScope`, `campaign.ts:61-68`).
  - With the raw driver, the fixture-builder principal can insert a revision-1 authority row, with any floor hash, for
    **any scope that has none**: dev, demo or a production-named scope.
  - It **cannot** raise or alter an existing authority: INSERT only, unique `_id`, and the RBAC test confirms UPDATE and
    REMOVE are denied.
  - The worker's authority fence reads `authority_revisions` in every environment, so an inserted row would be honoured.
  - The same principal can already insert `schema_registry` and `world_scope_bindings` rows for any scope. With this
    grant it can stand up an authorized scope except for the deployment pointer. That pointer still needs `setup` or the
    promoter, so it cannot act alone.
  - Answer to the lead's question: it cannot raise authority on an existing scope, but it can create authority for a
    scope that had none, outside evaluation.
  - Fix, preferred: keep campaign authority in its own collection (for example `campaign_authority_revisions`). The
    fence consults it only for `env: 'evaluation'`, and the fixture builder gets no grant on production authority at all.
    The alternative is a recorded decision that every non-evaluation scope gets its authority row at setup, which closes
    the "has none" window.
- **GB-2 (LOW-MEDIUM): per-pair held-out results now reach the operator principal.**
  - `projection_reader` FIND on `gate_reports` (F-8) fixes the Evaluation view.
  - The report still carries per-pair protected and validation rows (DA-11 F-10).
  - Either the projection layer serves only aggregates for withheld splits, or that exposure is recorded as accepted.
- **GB-3 (LOW, note).** The grader's new FIND on `completion_receipts`, `effects` and `preview_plans` is cluster-wide,
  not campaign-scoped, as with its existing world read. `preview_plans.bindings` hold subject identity values from every
  scope, production included. That is acceptable for the privileged evaluator. Record it, and later scope the gate's
  reads by campaign scope in code.
- **Fine.** `domain_executor` INSERT and UPDATE on `owner_source_state` is advisory state only. The fixture builder loses
  UPDATE on `owner_sources`, so it is insert-only per revision; setup still has full rights. Fixture builder FIND on
  `deployments` and `authority_revisions` is benign.
