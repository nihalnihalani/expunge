# Expunge MongoDB Data Model

This is the authoritative implementation design. Collection/index names below are new Expunge names. Driver methods and server constraints must follow the cited API audit in `docs/research/blueprint-mongodb.md`; no database setup has been executed yet.

## Database boundaries

Use three databases on the same Atlas replica-set deployment:

| Database | Purpose | Models may receive |
|---|---|---|
| `expunge_world` | Controlled domain documents, schema registry, derived identity relationships and world revisions. | Scoped results from typed tools and registry observations. |
| `expunge_control` | Jobs, traces, effects, receipts, artifacts, approvals, evaluations, telemetry outbox and deployment pointers. | Training evidence and bounded current run context. |
| `expunge_private` | Sealed manifests, reference solutions, held-out seeds/labels and preservation expectations. | Scalar/structured gate results chosen by trusted code; no expected IDs or answers. |

Every domain document carries trusted `tenantId`, `env`, `worldId` and `_rev`. The gateway combines these with the generated filter using a conjunction. It never lets an agent replace the tenant/environment/world predicate. Collections are predeclared; unknown collection names cannot become command targets. Test and demo worlds are isolated by worldId and authorization, even when they share collections. MongoDB collection roles are not document-level tenant RLS; this row-level binding is enforced by trusted application tools, and the deployment must describe that boundary accurately.

Native OpenDots SQLite and Intelligence may retain existing workspace/chat state. Expunge job authority, receipts, approvals and deployment state belong only in Atlas. Changes in an incidental SQL row cannot authorize a cleanup or promote a harness. Stock preference/skill injection is replaced or explicitly filtered through the provenance-aware context loader.

## World collections and indexes

| Collection | Key fields | Required indexes |
|---|---|---|
| customers | `_id`, tenantId, worldId, `_rev`, approved synthetic identity fields, eligibility metadata | `{tenantId:1,worldId:1,_id:1}`; approved identity lookup indexes as discovered/registered. |
| accounts | customer references, synthetic aliases, eligible effects | `{tenantId:1,worldId:1,customerRef:1}` plus world/address lookup. |
| messages | sender/recipient/nested subject arrays, unrelated content and retention markers | world/address lookup and registered reference-path indexes. |
| events | actor/account/nested references and lifecycle metadata | world/address lookup; registered actor/account reference indexes. |
| notes and archives | Full-scope indirect references and declared retention/tombstone behaviors | world/address lookup; scoped reference indexes. |
| schema_registry | scopeId, revision, collectionIds, field descriptors, reference observations, eligibility policy hash | unique `{tenantId:1,env:1,scopeId:1,revision:1}`; current-scope pointer lookup. |
| identity_edges | source and target typed addresses, relation/field ID, observation/source revision, tenant/world | unique edgeKey; `{tenantId:1,worldId:1,fromNode:1}`; `{tenantId:1,worldId:1,toNode:1}`. |
| world_revisions | worldId, tenantId, revision, scopeRevision, maintenanceMode | unique worldId; trusted actor world access lookup. |

A node key is a typed collection/address tuple. `identity_edges` is derived from visible schema/data facts, never the private target manifest. Use `$lookup` for explicit joins. Use `$graphLookup` on the bounded edge collection with `maxDepth`, tenant/world restrictions and resource caps. It traverses one same-database target collection; it is not automatic semantic identity resolution across arbitrary collections. Its restriction filter is ordinary query syntax, not an aggregation-expression context. Rebuild/version derived edges after source changes; stale edge versions cannot be used for completion proof.

Simple registry-based type/path discovery occurs in trusted TypeScript or documented operators, with explicit array handling. Generated queries use whitelisted factories. No `$where`, `$function`, arbitrary command JSON or model-generated JavaScript is sent to the database.

## Control collections

| Collection | Responsibility | Index or invariant |
|---|---|---|
| jobs | Durable state machine, checkpoints, run pinning, lease/fence and cancellation | unique jobId; `{kind:1,status:1,priority:-1,createdAt:1}`; lease-expiry scan. |
| runs | Immutable initial bindings and mutable execution summary | unique runId; scope/job lookup. |
| action_intents | Decision and resolved targets before effects | unique logical effectKey; run/step/time lookup. |
| effects | Exactly one committed MongoDB effect record per logical effect | unique effectKey. |
| action_receipts | Exact committed batch results and revisions | unique receiptId and unique effectKey. |
| completion_receipts | Registered-scope verification evidence | unique receiptId; job and verified revision indexes. |
| artifacts | Content-addressed envelope with `_id=hash`, payload bundle and metadata | unique `_id`; `payload.parentHash` index; `payload.target`/createdAt index. Author role insert-only. |
| candidates | Mutable candidate lifecycle; hashes point to immutable artifacts | unique candidateId; target/parent/state lookup. |
| gate_reports | Frozen admission report and trial-row digest | unique reportId; candidateId index. |
| deployments | One active pointer per tenant/environment/scope and target kind | unique `{tenantId:1,env:1,scopeId:1,target:1}` or equivalent canonical `_id`; revision CAS. |
| promotions | Append-only committed deployment transition | unique promotionId; unique tenant/env/scope/target/toRevision; scoped time index. |
| approvals | Bound human grant, expiry and once-only consumption | unique grantId; unique nonce; trusted tenant/env/scope/proposal binding; expiry scan. |
| public_trial_rows | Per-run metrics safe for display and gate summaries | unique `{campaignId:1,pairId:1,arm:1,repeat:1}`. |
| evidence | Sanitized provider read-back, hash and provenance | unique provider/project/externalEventId/evidenceRevision; permit/split indexes. |
| provenance_edges | Artifact/evidence/source derivation graph | unique edgeKey; fromId and toId indexes. |
| lessons | Structural, permitted-use lessons with provenance | unique lessonId; scope/module/family indexes; optional Search/Vector index. |
| raw_artifacts | Sensitive trace/tool payloads and attachments with explicit retention/retraction | unique rawArtifactId; tenant/env/source lookup; service-only access. |
| subject_tokens | Protected synthetic/customer-handle to telemetry/provider identifiers | unique tenant/env/subjectHandle/provider/tokenGeneration; owner privacy service only. |
| artifact_eligibility | Mutable scoped permission/revocation of content-addressed artifacts | unique tenant/env/scope/artifactHash; state/reason/source lookup. |
| telemetry_outbox | Publish/reconcile requests after domain commits | unique operationId; status/nextAttemptAt/lease scan. |
| telemetry_receipts | Enqueue, flush and actual remote read-back proof | unique operationId; external event lookup. |
| observer_cursors | Fixed query windows, cursor and enrichment retries | unique project/observerVersion; revision CAS. |
| projection_events | Sanitized, resumable UI event log | unique eventId; unique tenant/env/scope/sequence; scoped job lookup. |
| external_deletions | Org-bound local request, remote job status/dates and subject requested_on/revoked_at snapshots | unique scoped requestKey; remote request ID; state/dueBy. No invented independent per-user completion status. |
| meta_campaigns and adversary_campaigns | Experiment specifications, artifact/seed/budget pinning | unique campaignId; target/status lookup. |

Use TTL only for genuinely disposable leases/cache/projection history or evaluation worlds with disclosed retention. It is asynchronous cleanup, not authorization, immediate erasure or the method for expiring a lease. Do not expire approvals/evidence before their promotion/audit retention requirements are resolved. Do not set TTL on immutable admitted bundles just to hide historical mistakes.

## Private collections

`fixture_specs`, `oracle_manifests`, `expected_poststates`, `preservation_hashes`, `heldout_assignments` and private grader results hold the answer key. Their creator and grader have scoped access; runtime, proposer, UI and observer do not. The proposer may read public verdict counts and training witnesses issued by the grader. The evaluator does not reveal held-out raw answers in an error message, stack trace, telemetry event or generative UI state.

Commit the generator/evaluator hashes, split assignment commitment and seed hashes before evolution. Reveal demonstration seeds only where that does not change the held-out claim. Freeze evaluation families and reference-solver admission rules as code artifacts outside the editable harness.

## Principals

| Principal | Minimum responsibility | Deliberately absent |
|---|---|---|
| setup/admin | Install validators/indexes and Atlas role configuration | Present in any model-accessible container. |
| domain_executor | Authorized world reads/writes, job fence, intents, effects and operational receipts | Private manifests; artifact mutation; deployment/approval authority. |
| observer | Read domain run summaries, write sanitized evidence/outbox/cursors/projections | Destructive domain tools; private truth; promotion. |
| proposer | Read permitted training evidence/lessons and parent artifacts; insert candidate artifacts | Update/delete admitted artifacts; approvals; deployment pointers; private truth. |
| grader | Read private truth and test worlds; create fixed evaluation reports | Human approval issuer credentials; arbitrary deployment changes. |
| approval_issuer | Insert authenticated human approval grants | Consume/update grants or directly move deployments. |
| promoter | Read tested artifacts/reports/current scope; update deployments and consume grants; insert promotion receipts | Alter oracle/evaluator; forge human approval grants; unrestricted world writes. |
| projection_reader | Read sanitized event log/current summaries | Raw subject content, credentials, private labels and mutation authority. |
| privacy_controller | Read protected subject-token mappings; update source/artifact eligibility; erase/redact registered raw artifacts; queue/poll provider deletions and write nonpersonal revocations | Forge approval, promote an arbitrary candidate, alter oracle/evaluator or silently bypass owner policy. |
| fixture_builder | Trusted fixed generator writes isolated fixture worlds and private manifests after typed Hider-spec admission | Human grants, production world writes and deployment authority. Hider model receives no such credentials. |

Atlas privileges are additive. Do not assign broad dbAdmin/readWrite roles to a user and then claim a narrower custom role isolates it. Runtime identities need no `bypassDocumentValidation`, `collMod`, role/user administration or drop privileges. Role creation is an Atlas administration operation with account prerequisites. If sandbox rights are insufficient, record exactly which boundaries are application-enforced.

A session belongs to one MongoClient. A single transaction can operate across permitted databases on the same deployment using that client; it cannot mix sessions/operations from differently credentialed clients. Separate execution and promotion services/principals therefore have separate transactions, which is appropriate here.

## Database validation

Install strict/error validators for bundle types, gate reports, grants, effects and receipts. Use MongoDB's supported BSON-aware `$jsonSchema` subset. Semantic checks—parent-relative authority changes, cross-collection references, grant expiry, artifact hashes and receipt validity—are trusted application checks inside the relevant protocol. A schema cannot implement a foreign-key join.

Validate the stored artifact envelope separately from its canonical payload. Explicitly declare `_id` in a root schema that uses additionalProperties=false, plus payload/createdAt/sourceBlobIds; otherwise MongoDB's own `_id` makes valid inserts fail. Store database timestamps as BSON Dates outside the hashed JSON payload. Content hashes are verified by trusted code; parent/target indexes use their actual nested payload paths.

Representative bundles should require contractVersion, target, parentHash, typed policies, pluginArtifacts, budgets, evidence, runtimeAdapterHash, compilerHash, vocabularyHash, authorityFloorHash and eligibilityPolicyHash; reject additional top-level properties. Enum approved tool/op IDs; cap array lengths and numeric budgets. Registering a new vocabulary is an admin-signed schema/compiler version change, not something the proposer can perform with `collMod`. These semantic hashes and sandboxed plugin source/compiled bindings are inside the hashed payload, so a fixed artifact hash cannot silently acquire different operator or policy meaning.

Append-only is enforced by privileges plus a content hash and duplicate-key constraint. Validation alone does not prevent a privileged actor from changing an existing document or the validator.

## Transaction protocols

### Lease claim and renewal

Use `findOneAndUpdate` with an eligible-state/expired-lease predicate, deterministic queue ordering, an update that increments fence, and `returnDocument:"after"`. Prefer database-time expressions/update pipeline where verified by the driver audit. A claim is returned only when the update actually succeeds. Renewal/checkpoint/new-effect writes filter the exact job, owner and fence, a live lease.until against database time, and cancellationRequested=false. Cancellation is set by the trusted owner route independently and is acknowledged at the next bounded action boundary. Keep server and worker clock skew from becoming an unexamined authority assumption.

### Domain effect

1. Authenticate current receipt-read/job access and resolve the logical action from the stored approved plan. Before demanding an old lease/status/revision, look up the committed effect by effectKey and compare its argument/plan digest. If it exists, return its saved receipt; different arguments fail as IdempotencyConflict.
2. For a genuinely new effect, resolve pinned bundle/scope/targets and enter the transaction. Recheck effectKey/digest first; commit-ambiguity or a duplicate-key race must reconcile the committed record through the same authorized replay path.
3. Conditionally update the job under owner/fence/live-lease/running/not-cancelled predicates and increment commitSeq. Zero matched/modified result fails the attempt.
4. Conditionally write WorldRevision under the expected revision. All world writes use this fence protocol.
5. Recheck authorization floor, plan/target hash, eligibility, prerequisites and expected document versions.
6. Apply a bounded batch; insert effect, receipt and any transactional outbox record.
7. Commit. Project and publish after commit. Transaction callback retries must not call a model or vendor API.

Touching lease and revision rows acquires conflicting writes. Read-only snapshot checks can remain stale and are not adequate fences. Keep transactions comfortably below the deployment transaction lifetime; split large cleanup into checkpointed batches.

### Registered-scope verification and completion

Recompute source-derived relationships as needed. Read all registered/discovered paths under a stable world/scope revision. The verifier may use a snapshot transaction for a small controlled world, or a bounded external sweep followed by a conditional revision write. The latter is valid only because every permitted write advances the same revision. Record exactly which scope was verified. `complete_cleanup` rechecks and conditionally writes the relevant revision/job, then stores the immutable receipt/final status.

Uncontrolled inserts, stale search-index results and undeclared collections cannot be included in an exhaustive completion claim. Search is for context recall; authority checks use ordinary indexed database reads and admitted paths.

### Promotion

Evaluation/model/read-back calls finish before promotion. In one promoter-client transaction:

1. Verify immutable bundle/report hashes and expected tested parent.
2. Re-derive mutation authority classification and any human-approved descriptor from trusted rows.
3. Consume the exact unexpired/unconsumed grant using a conditional update when required.
4. Move the deployment pointer by expected activeHash and revision; a stale candidate aborts.
5. Insert promotion receipt and projection/outbox intent.

No cleanup mutations happen in this transaction. Rollback uses the same parent-aware pointer protocol and a new receipt. Existing runs retain their pinned bundle but all actions still check the live owner authority floor for revocation.

## Change streams and recovery

Watch immutable promotion/projection inserts on one chosen collection rather than one stream per client. Use change streams as a wake-up and committed-event feed; persist their opaque resume token after local consumption. The durable projection sequence supports client reconnect. If the oplog no longer retains a resume token, reload an authoritative snapshot and backfill the durable event log.

`fullDocument:"updateLookup"` may reflect a later state; do not use it as historical promotion proof. Immutable insert documents carry the required from/to hashes. A change stream does not itself establish exactly-once application processing.

## Privacy and learning lineage

Raw traces in raw_artifacts, protected provider/subject mappings in subject_tokens and fixture truth are separate from structural lessons. Store limited source references and a provenance graph. The privacy_controller owns raw-material erasure and artifact_eligibility/revocation writes, with owner policy authorization. A user/source retraction marks affected raw evidence ineligible, traverses its descendants, revokes retrieval grants and queues deletion/redaction or regeneration. Use `$graphLookup` on provenance_edges with bounded same-scope traversal when appropriate. Active runs referencing revoked material are cancelled/restarted with permitted context; a new retrieval filter cannot erase content already inside an active model invocation.

Content-addressed admitted bundles contain structural field/op references rather than subject literals. If a bundle contains personal content, immutability is not a reason to retain it: revoke its deployment/retrieval eligibility and apply the defined artifact erasure protocol. Keep a nonpersonal revocation/audit tombstone where allowed by the owner policy. A source's withdrawal does not automatically prove a general structural algorithm must be forgotten; explicitly record the owner-approved policy for retaining generalized artifacts and test the actual retained bytes.

Raindrop deletion is an external lifecycle with its own API scope and deadline. Intelligence conversations are another registered external source if they contain the subject. Expunge may report the domain complete while external purges remain pending, using separate fields. Never relabel a request acknowledgment as purge confirmation.

## Limits and probes

Record cluster tier/version, role rights, transaction support, change-stream support, pipeline limits, Search/Vector indexes and embedding quotas. Free/Flex/server limits differ. Keep ordinary exact queries available for every safety-critical lookup. Test graph/transaction behavior on the actual target topology; `$graphLookup` against a sharded target is prohibited inside a transaction. A Node hosting service does not provide the Docker supervisor/computer host automatically.
