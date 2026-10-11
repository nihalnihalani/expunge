# @expunge/privacy

Privacy and learning eligibility (spec section 12) and the external erasure contract (spec section 8). It is protocol
logic over ports: every storage or provider dependency is an interface in `src/ports.ts`, so the same code runs against
the real repositories or against labeled fakes. Nothing here promises instant vendor deletion.

## What is real and what is not

| Part | Status |
|---|---|
| Retraction state machine, closure over fanout, deep chain, cycle and concurrent derivation | REAL against `ProvenanceRepository` on a local replica set (`MONGODB_TEST_URI`). Not Atlas. |
| `artifact_eligibility`, `external_deletions`, run cancellation (`jobs.cancellationRequested`) | REAL Mongo adapters in `src/mongo.ts`, written for the `privacy_controller` principal. |
| Raw source, subject token and lesson stores (`raw_artifacts`, `subject_tokens`, `lessons`) | PORTS ONLY. `privacy_controller` has FIND and REMOVE but no INSERT or UPDATE on them, and `packages/mongo` has no repository or validator for them yet. Tests use labeled in-memory fakes (`test/fakes.ts`). |
| Raindrop user deletion | The request and status contract is exercised against the labeled FAKE Raindrop server (`packages/observability/test/fake-raindrop.ts`) through the real `RaindropQueryClient`. Live deletion is BLOCKED: no root `.env`, and it also needs explicit human authorization (`erasure.live.test.ts`). |
| Wiring into a running process | NONE. `RetractionRunner`, `ErasureService` and the observer's `OutboxDispatcher` (with its suppression source) are constructed only in tests. No worker, operator or service runs them yet, so nothing here is an integrated privacy path. |
| CopilotKit Intelligence conversations | A retention boundary is registered. No purge API exists and none is invented. |

## Retraction (`retract.ts`)

`RetractionRunner.run(scope, sourceId, reason, { bounds, maxSteps })` has three phases:

1. `closing`: the repository marks the source ineligible and walks the bounded closure. Its frontier is persisted in
   `provenance_closures`; `permitted` denies the source, everything reached, and every descendant whose ancestry is not
   fully read. An incomplete closure never means "nothing more to revoke".
2. `disposing`, only after the closure is complete: each affected artifact is deleted, queued for regeneration or kept
   revoked for its owner, by `OwnerPolicy` (the policy hash is recorded). Raw sources become non-personal tombstones
   with no content hash and no size. `source_deleted` edges are written.
3. `complete`, only when both finished. `failClosed(state)` is true in every other phase.

Progress event ids carry a per-run id, so a resumed run never reuses an id with different content. A stopped run resumes by calling `run` again, from any process: the frontier is in the database and disposal is
idempotent (tested with a fresh runner after one closure step). Live runs that hold revoked content are cancelled by the
repository and reported by `MongoRunObserver`; restarting them with permitted context is the worker's job.

## Scan (`scan.ts`, `structure.ts`, `registry.ts#guardFor`)

`guardFor` builds the C1c leak guard (`@expunge/observability` `leak.ts`) from the registered subject handles and the
grader's salted private-id set. It refuses to exist with nothing to look for. `scanRetained` runs the guard over retained
artifact and lesson content (keys and values, folded, split, URL-, base64- and hex-encoded) and separately classifies
retention: a lesson may keep identifiers, counts and hashes, never source text. `enforceScan` retracts every violating
artifact that is still permitted, and for a leak hit (subject literal, private id, held-out) on ANY artifact, revoked or not, removes the bytes through a `ContentPurger` (revoked is not removed). In `RetractionRunner` a leak reason purges the bytes before any owner disposition, and `keep_revoked` never keeps them. The `ContentPurger` has no Mongo adapter yet (same blocker as the raw, subject and lesson stores). Immutability and content addressing are never an exemption.

## External erasure (`erasure.ts`)

`ErasureService` keeps the provider's words and ours separate:

| State | Meaning |
|---|---|
| `unsubmitted` | Recorded locally; export suppression is active; nothing sent. |
| `submitting` | A local compare-and-swap claim taken BEFORE the provider is called; a second concurrent submit loses the swap and sends nothing. |
| `submission_ambiguous` | The provider call may or may not have been accepted (lost response, crash, a store write that failed after acceptance). Never re-sent automatically; resolved only by reading a stored remote id (GET) or by a named human decision that nothing was sent. These two local states are not in the contract's status union or the projection vocabulary yet; they are stored as strings and not announced. |
| `pending` | The provider acknowledged the request (2xx) with a due date. Acknowledged is not erased. |
| `in_progress` | The provider reports it is working. |
| `completed` | Only when the provider's own status says so and `completed_at` is present. |
| `rejected` | The provider refused. |
| `cancelled` | Every subject was removed from the pending job; their data is kept. |

A provider job is applied to a request only when its `user_ids` equal the request's exact namespaced ids (`RemoteJobMismatch` otherwise, nothing changes). Before anything is sent, `submit` requires the credential's provider organization to be known and equal to the recorded `providerOrganizationId` (`bindOrganization` takes it from trusted configuration, because the Query API has no endpoint that reports it: the binding is CONFIGURED, NOT PROVIDER-VERIFIED, and the error text says so); unknown refuses with `OrganizationUnverified`, a difference with `OrganizationMismatch`.

Wire contract (organization-wide, no project narrowing): `POST /v1/deletions/users` with `{ user_ids (1 to 100),
requester, regulation: gdpr | ccpa | other }` requests erasure; `GET /v1/deletions/users/{id}` tracks it;
`DELETE /v1/deletions/users/{id}/{user_id}` cancels a pending deletion and keeps the data. It is never an erasure
command, and `cancelPendingSubject` is allowed only while the job is `pending`. `completionView` lets a UI show a
succeeded domain job next to a still-pending external erasure; `fullyErased` needs both.

Export suppression: while a request is open (until `releaseExportSuppression`), `suppressedUserIds(providerOrganizationId)` lists the
telemetry user ids that must not leave, across every scope of that organization. `ErasureService` satisfies `ExportSuppression` from `@expunge/observer`, whose
`OutboxDispatcher` takes it as `deps.suppression` and holds (does not send, does not dead-letter) an `event` intent for a
suppressed id, and does not send at all when the list cannot be read. Honest limit: SDK episode events are produced live
in the worker before an erasure can exist, and signals carry only an event id, so what was already exported is the
provider erasure's job, not this gate's.

## Tests

`MONGODB_TEST_URI='mongodb://127.0.0.1:27018/?replicaSet=expunge-local&directConnection=true' npx vitest run packages/privacy`

Fakes are labeled in the `describe` names. The live Raindrop deletion test skips with its reason and fails under
`EXPUNGE_REQUIRE_LIVE_TESTS=1`.

## Guards

Immutable archive is not a privacy exemption. Log deletion may remove learning evidence, so provenance policy is gated
before a lesson is retained. No promise of instant vendor deletion and no unverified Intelligence purge.
