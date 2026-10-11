# MongoDB foundation (packages/mongo)

MongoDB is the authority for consequential domain and control state. This file says what the code touches, who may do
what, and how to run the protocol tests. **Every test result below comes from a local replica set. It proves protocol
behavior (transactions, fences, validators, unique indexes). It is not evidence about the invited Atlas deployment, Atlas
RBAC, or Search/Vector, and none of those has been exercised: there is no root `.env`, so all live Atlas checks are BLOCKED.**

```mermaid
flowchart LR
  subgraph W[expunge_world]
    D[customers accounts messages events notes archives]
    R[schema_registry identity_edges retained_invoices]
    WR[world_revisions counter]
    WB[world_scope_bindings]
  end
  subgraph C[expunge_control]
    J[jobs decisions action_intents effects action_receipts completion_receipts]
    A[authority_revisions authority_touches authority_policies]
    P[artifacts candidates gate_reports deployments promotions approvals grant_consumptions]
    V[artifact_eligibility provenance_edges provenance_closures lessons evidence]
    E[projection_events projection_sequences stream_offsets wake_commands telemetry_outbox]
  end
  subgraph X[expunge_private]
    S[fixture_specs oracle_manifests expected_poststates preservation_hashes heldout_assignments grader_results campaign_keys]
  end
  EX[domain_executor] -->|update records, advance counter, insert decisions, touch fence| D & WR & J & A
  FB[fixture_builder] -->|registry and bindings| R & WB
  PR[proposer] -->|insert candidates, no class| P
  GR[grader] -->|insert gate_reports with computedClass| P & S
  AI[approval_issuer] -->|insert grants, bump authority| P & A
  PM[promoter] -->|CAS pointer, insert grant_consumptions| P
  PC[privacy_controller] -->|revoke closure| V
  OB[observer and projection_reader] --> E
```

## Principals (separate MongoClient and URI each; no fallback to setup)
| Principal | Does | Cannot (structurally) |
|---|---|---|
| setup | DDL, validators, indexes, seeds authority and policy, test administration | run in any model-accessible container |
| domain_executor | update domain records and the world counter, insert decisions, touch `authority_touches`, run cleanup jobs | write registry, bindings, `authority_revisions`, retained data, gate reports, grants |
| fixture_builder | create worlds, registry, bindings; private manifests | grants, authority, decisions |
| proposer | insert artifacts and candidate proposals | update anything, write a class, read private truth |
| grader | read private truth, insert gate reports (the only source of `computedClass`) | update a report, approvals, authority |
| approval_issuer | insert grants after checking them against the stored report; bump the authorization revision | edit or delete a grant, write reports |
| promoter | move deployment pointers, insert `grant_consumptions`, update candidate state | update `approvals`, `authority_revisions`, policy |
| privacy_controller / observer / projection_reader | revocation and retraction / evidence and outbox / read events | destructive domain tools, promotion |

Atlas privileges are additive and collection-level. `atlasRoleManifests()` is the body to apply through the Atlas
Administration API; driver `createRole` is used only by the local RBAC test.

## Protocol rules worth knowing
- **Approval is derived.** `promote` takes the class from the grader-written gate report and the requirement from the
  `authority_policies` row. `authority_expansion` always needs a grant, `tightening` never, `behavioral` per policy. The
  candidates row is a proposer's note and is never read for authorization. A grant must equal the binding derived from the
  stored report (hashes, flip-set digest, descriptor) at issue and at spend, and is spent by inserting a unique row.
- **Live authorization.** Effects, `complete`, `promote` and `rollback` read `authority_revisions` and conditionally write
  `authority_touches` under the expected revision; a bump rewrites both rows in one transaction, so a stale snapshot aborts.
  A stale run fails with `AuthorityRevisionStale`. An effect also needs a matching row in the `decisions` ledger
  (`decisionId`), and its `effectKey`, `argsDigest` and `targetHash` are derived by the repository, not supplied.
- **World = counter + binding.** The worker advances `world_revisions`; only setup and the fixture builder write
  `world_scope_bindings`, and rebinding also advances the counter so an in-flight effect conflicts.
  `JobRepository.create` requires an existing world under the actor's scope, at its scope revision, outside maintenance.
- **Scope paths.** Registered paths live under `data.*` (plus the read-only record key `_id`). `*` compiles to a filtered
  positional update or element `$pull`, never to a whole-array write.
- **Effects are bound to the versions the plan saw.** `commitEffect` requires `expectedDocumentVersions` to name exactly
  the intent's targets (once each, non-negative integer versions; otherwise `VersionBindingMismatch`), re-reads every
  target's `_rev` inside the transaction before `apply` runs (`StaleDocumentVersion`), and refuses an `apply` that returns
  fewer effects than targets (`PartialEffect`). A refused batch writes nothing: no effect row, receipt or counter move.
  The derived `argsDigest` binds those versions, so replaying an effect key at other versions is an
  `IdempotencyConflict`, never the saved receipt. Malformed version lists are reported as `VersionBindingMismatch`
  before the digest is compared.
- **No world write outside an effect.** `ScopeRepository.writeField` takes the effect transaction's session and throws
  `EffectTransactionRequired` without one; `applyEffect` is the single-update path the gateway uses.
- **A world key comes from a stored row.** `JobRepository.worldKey(actor, jobId)` reads the job and mints the `WorldKey`;
  `WorldRepository.bind` mints one from the stored world binding. `worldKeyOf` is package-internal and not exported from the
  index, so no caller can brand a job-shaped object of its own.
- **Receipt refusals have their own codes.** A wrong verdict is `IncompleteReceipt` (complete) or `ReceiptNotIncomplete`
  (incomplete); a receipt that does not cover the registry is `ReceiptCoverageIncomplete`.
- **Decision rows come back as stored.** Recording the same decision again returns the stored row (with its first inputs and
  digest), never the caller's object. The ledger is insert-only by privilege; it is not hash-chained (see the G6 note in the
  review) and makes no tamper-evidence claim.
- **Approval-gated workflows cannot proceed yet.** The gateway resolves the `approval_grant` binding to "absent", so a
  bundle prerequisite on it always denies (fails closed) until grants are wired to the decision path.
- **Incomplete receipts.** `EffectRepository.complete` commits only a `complete_in_registered_scope` receipt with zero
  residuals and finishes the job `succeeded`. `completeIncomplete` commits an `incomplete` receipt (at least one residual)
  under the same job binding, registry coverage, authority fence and world checks, and finishes the job `failed` with that
  receipt as its output, so a run that claims success without having cleaned the data leaves a truthful committed record.
  Neither method accepts the other's verdict.
- **Campaign keys.** `expunge_private.campaign_keys` holds one 32-byte key per campaign for the fixture builder and grader
  (strict validator, insert-only; fixture builder inserts, fixture builder and grader read, nobody updates or removes).
- **Provenance.** Revocation is a bounded, resumable closure persisted in `provenance_closures`. `permitted` re-derives
  ancestry on every read and denies anything under an unresolved closure.
- **Projection events.** Sequences are per job and contiguous from 1: the counter increment and the event insert share one
  transaction, so an aborted transaction gives its number back. Payloads are validated against strict per-kind schemas.

## Gate, campaign, fault and rollback collections (PKT-61)
- `campaign_freezes` (fixture builder inserts, grader and fixture builder read), `gate_claims`, `gate_attempts`, `gate_held_runs`
  (grader only), `world_faults` (fixture builder inserts, `domain_executor` and grader read), `rollback_refusals` (promoter
  inserts, projection reader reads) and `campaign_artifact_permits` (grader inserts, `domain_executor` and grader read) have
  strict validators and the exact holders pinned in `hardening.test.ts` plus named raw-driver denials in the RBAC lane.
- A collection grant cannot narrow WHICH fields or transitions a writer changes: the grader's UPDATE on `gate_claims` is
  limited to `open -> held | failed | decided` and `held -> open` by the gate's compare-and-set, and its UPDATE on
  `gate_attempts` to the atomic counter upsert. Those two are application-enforced.
- A campaign permit is its own collection, not an `artifact_eligibility` row: the grader has no write on eligibility, and
  `ArtifactRepository.readPermitted` consults a permit only in a campaign scope (evaluation env, no worker deployment
  pointer). `createCampaignJob` and `permitForCampaign` refuse any other scope.
- Rollback (`DeploymentRepository.rollback`) is one transaction on the scope revision the caller read: the pointer's hash,
  revision and scope revision are compare-and-set, the reverse class is derived from the two stored bundles, and a grant
  (`ApprovalRepository.issueRollback`) is consumed once in the same transaction when approval is required. Refusals are
  written to `rollback_refusals`.

## Campaign results, the meta draw record, privacy stores and splits (PKT-62)
- `campaign_artifacts` and `campaign_artifact_rows` hold a meta or Hider campaign's immutable result: the grader inserts,
  nobody updates or removes, the projection reader and the domain service read. `commitRow` announces each row on the
  stream `campaign:<campaignId>` in the same transaction; a different payload under an existing row or summary is a typed
  conflict. `adversary_campaigns` and `adversary_trials` are grader insert-only.
- `meta_draw_commitments` has three insert-only rows per campaign (`commitment`, `i1`, `freeze`), each inserted with a
  server-assigned ObjectId (`forceServerObjectId`), so the time of each row is the server's and no UPDATE is granted. The
  repository refuses a row unless the previous one exists and the server clock is more than a second past it. A raw writer
  could still insert the rows in another order or sooner; the grants cannot narrow that, the repository enforces it.
- `world_splits` is one insert-only row per world written at seed time; `splitOfJob` reads it (observer, grader).
- `raw_artifacts`, `subject_tokens`, `lessons` and `erasure_suppressions` belong to the privacy controller. A purge replaces
  a raw row or a lesson with a tombstone (UPDATE), which keeps no content, hash or size. The observer and the domain
  service read `erasure_suppressions` (keyed by provider organization and user) and nothing of `external_deletions`.
- The RBAC lane also runs these repositories with each principal's real privileges (`serviceFor`), which is how a missing
  read grant on a path (for example the grader's read of `deployments` for the campaign-scope check) shows up.

## Residuals that collection-level RBAC cannot close (application-enforced, with the test that covers each)
Atlas privileges are per collection and per verb, never per field or value. Three grants are therefore broader than the rule
they serve, and the rule lives in code:
| Grant | Application rule | Test |
|---|---|---|
| `domain_executor` UPDATE on `world_revisions` | The counter only moves by a conditional `findOneAndUpdate` at the revision the intent was planned at; scope revision and maintenance live in `world_scope_bindings`, which the executor cannot write. A hand-written counter edit cannot widen scope. | `authority.integration.test.ts` (world split, rebinding conflicts with an in-flight effect); `rbac.integration.test.ts` (executor denied on the binding row) |
| `proposer` INSERT on `candidates` | A candidate row is a note: `promote` never reads it for authorization. The validator rejects a `computedClass`; a forged `state` is inert. | `hardening.integration.test.ts` (L11), `promotion.integration.test.ts` ("does not read the candidate row at all") |
| six principals UPDATE on `jobs` (executor, observer, grader, promoter, privacy_controller, fixture_builder) | `JOB_KIND_PRINCIPALS` limits claim/renew/checkpoint/yield/finish to the worker principal of the kind; every lease write is conditional on owner, fence and a live lease; a cleanup job reaches `succeeded` only with a committed, job-bound completion receipt; cancellation is terminal. The database adds the strict BSON schema and a query validator rejecting `succeeded` with empty `outputRefs`. A raw writer that sets `succeeded` plus fabricated `outputRefs` is not stopped by the database. | `hardening.integration.test.ts` (L1, L3), `rbac.integration.test.ts` ("job status" asserts both the guard and the known limitation) |

World access never takes a world id from a caller: `ScopeRepository` methods require a `WorldKey`, which only
`worldKeyOf(job)` (the stored run binding) or `WorldRepository.bind` (the stored world row under a trusted scope) can issue.

## Test lanes
| Lane | Needs | Command |
|---|---|---|
| Fast | nothing | `npx vitest run packages/contracts packages/mongo` (live suites skip with a reason) |
| Replica-set protocol | `MONGODB_TEST_URI` | `docker compose -f packages/mongo/test/docker-compose.yml up -d`, then `MONGODB_TEST_URI='mongodb://127.0.0.1:27018/?replicaSet=expunge-local&directConnection=true' npx vitest run packages/mongo` |
| Local authenticated RBAC | `MONGODB_RBAC_TEST_URI` | `docker compose -f packages/mongo/test/auth-docker-compose.yml up -d`, then set `MONGODB_RBAC_TEST_URI` for 127.0.0.1:27019 (replica set `expunge-auth`, authSource `admin`) |

Set `EXPUNGE_REQUIRE_LIVE_TESTS=1` for acceptance runs: a missing URI then fails the suite instead of skipping it. The RBAC
lane runs raw-driver probes for every principal, collection and verb against `atlasRoleManifests()`, plus explicit named
denials. The auth compose file carries a published, localhost-only placeholder credential (tmpfs, bound to 127.0.0.1); never
use it for a deployed database. One command for the whole local run once both containers are up is the Fast command with
both URIs and the require flag set.

## Setup
`npm run setup:mongo` installs collections, validators and indexes idempotently. With `EXPUNGE_AUTHORITY_FLOOR_HASH`
(64 hex) plus `EXPUNGE_TENANT_ID`, `EXPUNGE_ENV`, `EXPUNGE_SCOPE_ID` it also seeds that scope's authority row and a policy
per target; behavioral changes need approval unless `EXPUNGE_BEHAVIORAL_REQUIRES_APPROVAL` is exactly `0`. Without the
floor hash nothing is seeded and promotion and effects fail closed. `npm run probe:mongo` reports server version, topology
and transaction support without printing credentials. With `MONGODB_DOMAIN_EXECUTOR_URI` set it also reports a `boundary`
block for the worker principal (privileges that name the private database, whether a direct read of it is refused with
code 13, and `rbacEnforced`). On a local replica set without authentication that block says `rbacEnforced: false`; it
describes the server it ran against and is not evidence about an Atlas custom role.

## Campaign permits and read grants (MA-F1, F-8)
- `ProvenanceRepository.permitted` accepts a hash with NO eligibility row when a `campaign_artifact_permits` row exists for the scope
  and `assertCampaignScope` passes (evaluation env, no worker deployment pointer). Any eligibility row that is not `permitted` still
  blocks; ancestry blocking is unchanged.
- Grants added: grader FIND on `completion_receipts`, `effects`, `preview_plans` (it already reads `world_revisions`); projection reader
  FIND on `gate_reports`.

| Residual | Detail |
|---|---|
| GB-2: held-out per-pair rows reach `projection_reader` | the `gate_reports` row carries per-pair protected and validation rows. Accepted until rsi-evolution's F-10 reduces withheld splits to aggregates in the report; until then the projection layer must serve aggregates for withheld splits. |
| GB-3: the grader's FIND is cluster-wide | `completion_receipts`, `effects`, `preview_plans` are not campaign-scoped, and `preview_plans.bindings` hold subject identity values from every scope. Acceptable for the privileged evaluator; the gate should scope its reads by campaign scope in code. |
