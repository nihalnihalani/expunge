# Expunge database discovery: implementation facts for the blueprint

Fact-gathering report, 11 October 2026. The orchestrator owns the implementation plan. No application implementation, installation or benchmark was performed here. **Verified** below means primary documentation read; **Design** means a proposed protocol built with those APIs; **Gap** means a required runtime/account test remains.

## 1. Sources consulted and sections actually read

The files below are saved source artifacts, not app modules. URLs are the authoritative sources; local line numbers are useful copy locations.

| Source | Read in this pass / reused from earlier fresh pass | Copy-ready source locations |
|---|---|---|
| [Node driver 7.7 Collection API](https://mongodb.github.io/node-mongodb-native/7.7/classes/Collection.html) | aggregate, bulkWrite, createIndex, insertOne, findOneAndUpdate overloads, updateOne, watch | `.firecrawl/blueprint-mongo-driver-collection.md`: aggregate 162; bulkWrite 191; createIndex 320; findOneAndUpdate 997; insertOne 1288; updateOne 1527; watch 1595 |
| [Node driver 7.7 Db API](https://mongodb.github.io/node-mongodb-native/7.7/classes/Db.html) | command, createCollection, listCollections overloads | `.firecrawl/blueprint-mongo-driver-db.md`: command 276; createCollection 333; listCollections 508 |
| [Node transaction guide](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/) | Convenient API, session ownership, concerns and retry behavior | `.firecrawl/tech-mongodb-node-transactions.md`: runnable-pattern excerpt 238–260; no parallel operations 267; options 269; errors 300 |
| [Production transaction considerations](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/) | runtime, locks, write conflicts, snapshot stale reads and modifying a lock document | `.firecrawl/blueprint-mongo-txn-production.md`: runtime 79; locks 133; conflicts 188; stale reads 203; modifying lockId example 246 |
| [Atomicity](https://www.mongodb.com/docs/manual/core/write-operations-atomicity/) | expected-value filter, multi-document limitation | `.firecrawl/tech-mongodb-atomicity.md`: expected-value guidance 47–49; multi-document operations 147–157 |
| [Update aggregation pipelines](https://www.mongodb.com/docs/manual/tutorial/update-documents-with-aggregation-pipeline/) | allowed update stages, literal strings, NOW example | `.firecrawl/blueprint-mongo-update-pipeline.md`: allowed stages 64; literal example 90–94; NOW example 208–213 |
| [$dateAdd](https://www.mongodb.com/docs/manual/reference/operator/aggregation/dateAdd/) | syntax, millisecond/second units, return type, server version | `.firecrawl/blueprint-mongo-dateadd.md`: syntax and required fields 57–87 |
| [$jsonSchema](https://www.mongodb.com/docs/manual/reference/operator/query/jsonSchema/) | supported keywords and omissions | `.firecrawl/blueprint-mongo-jsonschema.md`: keywords 107–144; omissions 151–174 |
| [Specify JSON Schema](https://www.mongodb.com/docs/manual/core/schema-validation/specify-json-schema/) | BSON-aware validator example, combining with query predicates | `.firecrawl/tech-mongodb-validator.md`: example 94–128; combined validation 187–218 |
| [Bypass document validation](https://www.mongodb.com/docs/manual/core/schema-validation/bypass-document-validation/) | required bypass privilege and built-in roles | `.firecrawl/tech-mongodb-validation-bypass.md`: prerequisite 83–85 |
| [Atlas custom roles](https://www.mongodb.com/docs/atlas/security-add-mongodb-roles/) | additive permissions, required admin rights, collection scope, propagation | `.firecrawl/tech-mongodb-atlas-roles.md`: 60; 70; 90–99; 150–154 |
| [$graphLookup](https://www.mongodb.com/docs/manual/reference/operator/aggregation/graphLookup/) | traversal schema, static restrictions, memory, sharded transaction prohibition | `.firecrawl/blueprint-mongo-graphlookup.md`: syntax 83–108; sharding 118–122; memory/order 128–142 |
| [$lookup](https://www.mongodb.com/docs/manual/reference/operator/aggregation/lookup/) | equality joins, missing/null behavior, let/$expr, indexing, sharded transactions | `.firecrawl/blueprint-mongo-lookup.md`: syntax/fields 85–110; sharded transaction support 351 |
| [Change streams](https://www.mongodb.com/docs/manual/changeStreams/) | majority commitment, privileges, token preservation, resume/invalidate, fullDocument behavior | `.firecrawl/tech-mongodb-change-streams.md`: resume 252–308; privileges 443–471; majority 488; images 502 onward |
| [TTL indexes](https://www.mongodb.com/docs/manual/core/index-ttl/) | date fields, timing, cleanup delays, single-field restriction | `.firecrawl/blueprint-mongo-ttl.md`: creation 67–76; timing 229–238; restrictions 291–295 |
| [Free cluster limits](https://www.mongodb.com/docs/atlas/reference/free-shared-limitations/) | operation/memory/stage/connection limits | `.firecrawl/tech-mongodb-free-limits.md`: aggregation 91; roles 110; storage/throughput/sort 148–156 |
| [Aggregation limits](https://www.mongodb.com/docs/manual/core/aggregation-pipeline-limits/) | document size, stage and memory limits | `.firecrawl/tech-mongodb-aggregation-limits.md`: 55–120 |
| [RFC 8785: canonical JSON](https://www.rfc-editor.org/rfc/rfc8785.html) | I-JSON prerequisites, number validity, recursive sorting and UTF-8 | `.firecrawl/blueprint-mongo-canonical-json.md`: prerequisites 181–205; invalid numbers 318; sorting/encoding sections |
| [Node crypto](https://nodejs.org/api/crypto.html#cryptocreatehashalgorithm-options) | createHash, update, digest example | `.firecrawl/blueprint-mongo-node-hash.md`: Hash section 2025; update/digest example 2097 onward |

Discovery used Firecrawl developer search (`blueprint-mongo-lease-discovery.json`) and an official docs map (`blueprint-mongo-transactions-map.json`). The developer index found Orion Pulse and a Mastra fencing PR describing transaction-based fences; these were leads, not vendor guarantees or copied application code. The focused three-page crawl returned `Bad Request`; mapped exact-page scrapes supplied the evidence instead. Several requests hit the shared rate limit; failed fetches are not evidence. Cached sources were reused instead of fetched again.

Existing design consulted: `research/rethink/T-idea-fusion.md` §§4–10 and `research/fresh-mongodb-raindrop-architecture.md`. These inform scope only. Simulated judge scores are not factual evidence.

## 2. Allowed APIs and exact verified shapes

Verified against the 7.7 driver API. Pin an actual package version and validate its types; do not assume older snippets return the same wrapper shape.

```ts
Collection.findOneAndUpdate(
  filter: Filter<TSchema>,
  update: UpdateFilter<TSchema> | Document[],
  options: FindOneAndUpdateOptions & { includeResultMetadata: false }
): Promise<WithId<TSchema> | null>

Collection.updateOne(
  filter: Filter<TSchema>,
  update: UpdateFilter<TSchema> | Document[],
  options?: UpdateOptions
): Promise<UpdateResult<TSchema>>

Collection.insertOne(
  doc: OptionalUnlessRequiredId<TSchema>, options?: InsertOneOptions
): Promise<InsertOneResult<TSchema>>

Collection.bulkWrite(
  operations: readonly AnyBulkWriteOperation<TSchema>[],
  options?: BulkWriteOptions
): Promise<BulkWriteResult>

Collection.createIndex(
  indexSpec: IndexSpecification, options?: CreateIndexesOptions
): Promise<string>

Collection.watch(
  pipeline?: Document[], options?: ChangeStreamOptions
): ChangeStream

Db.createCollection<TSchema>(
  name: string, options?: CreateCollectionOptions
): Promise<Collection<TSchema>>

Db.command(command: Document, options?): Promise<Document>
Db.listCollections(filter, options): ListCollectionsCursor
```

`findOneAndUpdate` with `includeResultMetadata: true` returns `ModifyResult<TSchema>` instead. Use `returnDocument: "after"` and `includeResultMetadata: false` explicitly, then check the returned document/null. Do not unconditionally read `.value`. `Db.command` does not inherit ordinary MongoClient options; pass a session/options explicitly where applicable. `collection.count()` is deprecated; use `countDocuments()` for a precise match count. `aggregate()` returns an AggregationCursor; materialization is explicit (`toArray`, iteration).

Driver transaction pattern is `client.withSession(async session => session.withTransaction(async () => { ... }, options))`. Every operation in one transaction uses that same client's session, sequentially. A session cannot be passed to another principal's MongoClient. Multi-database operations can be in one transaction if the **same authenticated client has all required privileges**. There is no documented `lease()`, `consumeApproval()`, `promoteHarness()` or automatic exactly-once side-effect API; those are application protocols.

## 3. Proposed collection/index map — Design

Preserve the full governor, human approvals, adversarial fixtures and meta-improver. Database boundaries below isolate different trust/retention classes; tenant/environment/world IDs partition records without requiring a new database per episode.

| Database / collections | Minimum important fields | Index recommendations |
|---|---|---|
| `expunge_world`: registered domain collections, including retained records in separate physical collections | `_id`, `worldId`, document `rev`, source fields; active catalog revision in world control | `{worldId:1,_id:1}`; declared identifier/ref indexes; separate invoice collection denies remove by role |
| `expunge_world.world_state` | `_id:worldId`, `rev`, `catalogRev`, write/freeze state | `_id` already unique; all permitted world writers conditionally update this revision in the same transaction |
| `expunge_world.relation_edges` | `worldId`, `catalogRev`, `fromNode`, `toNode`, `kind`, `sourceRef`, `sourceRev` | `{worldId:1,catalogRev:1,fromNode:1}` and reverse lookup if needed; unique edge identity includes source/field |
| `expunge_control.jobs` | `_id`, state, owner, fence, leaseUntil, commitSeq, pinned bundle/meta hash, retry attempt, nextAttemptAt | queue index over state/nextAttemptAt/priority; separate state/leaseUntil index; **no TTL deletion of live jobs** |
| `effects`, `operational_receipts`, `outbox` | stable request/effect keys, argsDigest, jobId, fence, outcome; outbox delivery attempts | effects unique `{jobId:1,opKey:1}`; receipts unique logical receipt ID; outbox unique `{kind:1,dedupeKey:1}` |
| `harness_versions`, `proposals`, `promotions`, `deployments`, `gate_receipts`, `precedents` | content hash, parent, vocabulary/compiler/evaluator versions, evidence refs, admission receipt, deployment rev | bundles `_id:hash`; deployments one `_id` per tenant/env; promotions unique `{deploymentId:1,rev:1}`; sparse-by-type unique approvalId index; proposals unique proposalId |
| `schema_registry`, `census_paths`, `runs`, `decisions`, `evidence_structural`, `artifact_registry` | scoped catalog IDs/revisions, shape witnesses, pinned hashes, provenance, sanitized summaries; no raw identifiers in structural lessons | indexes by world/catalog/pathId; runs by world/bundle/split; decisions unique `{runId:1,seq:1}`; evidence source/event ID unique |
| `improver_versions`, `meta_trials`, `evaluator_snapshots` | immutable meta-payload hash, fixed evaluator hash, evidence-cutoff, trial seed/split, result | meta versions `_id:hash`; meta trials unique `{metaHash:1,trialId:1}`; frozen evaluator `_id` |
| `stream_offsets` | consumerId, pipelineVersion, opaque resume token, committed projection revision | consumerId unique |
| `expunge_auth.approval_grants` | issuer identity ref, nonce, parentHash/rev, candidateHash, flipSetDigest, catalog/evaluator hashes, expiresAt, consumedAt/by | `_id:nonce`; separate single-field TTL `{expiresAt:1}` with expireAfterSeconds:0 |
| `expunge_vault.subject_tokens`, `subject_artifact_links`, optional resurrection tombstones | short-lived identifier map; artifact references; separately governed pseudonymous watch token | opaque subject token unique; artifact link query; explicit TTL only for transient copies |
| `expunge_transient.raw_artifacts` | bounded encrypted/raw fixture or operational payload, subject links, expiresAt | `{jobId:1}` plus explicit subject-link index; TTL backup cleanup, but erasure uses explicit deletion |
| `expunge_private.fixture_targets`, `validation_grades`, `heldout_targets`, `heldout_grades` | hidden expected target IDs, namesake/retained classifications, seed and fixed evaluator version | trial/world IDs; physically separate targets from any feedback shared with the improver |

Avoid time-series collections for receipts, jobs or admission records: these need transactions/validation/change-stream behavior. Time-series charts may be a separate extension. A partial unique index proves **at most one** matching record, not existence; one deployment pointer document is a simpler source of active-version truth.

Copy-ready index sketch, using verified createIndex API; fields are proposed design:

```ts
await effects.createIndex({ jobId: 1, opKey: 1 }, { unique: true });
await promotions.createIndex({ deploymentId: 1, rev: 1 }, { unique: true });
await promotions.createIndex({ approvalId: 1 }, {
  unique: true, partialFilterExpression: { approvalId: { $type: "string" } }
});
await grants.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
await decisions.createIndex({ runId: 1, seq: 1 }, { unique: true });
```

Setup creates collections, indexes and validators before workers start. DDL and live transactions contend for locks, and default transaction lock waits are short. Do not dynamically rebuild indexes during a stage demonstration.

## 4. Lease, heartbeat and fenced effects — Design, supported by verified primitives

Precreate jobs with a monotonically increasing BSON-safe fence, not an expiring TTL lock. Claim via one atomic `findOneAndUpdate`: queued jobs or expired running jobs qualify; increment the fence; set owner and server-time expiration. No upsert is necessary for a pre-existing job. The following is a copy-ready **application sketch**, not a vendor lease function; `jobId` and `workerId` are bound by the server. It uses the authoritative root contract's nested `lease` fields; collection variables are aliases, and the orchestrator's CONTRACTS/DATA-MODEL names supersede the earlier proposed collection map above:

```ts
const claim = await jobs.findOneAndUpdate(
  {
    _id: jobId,
    $or: [
      { status: "queued" },
      { status: "running", $expr: { $lte: ["$lease.until", "$$NOW"] } }
    ]
  },
  [{ $set: {
    status: { $literal: "running" },
    "lease.ownerId": { $literal: workerId },
    "lease.fence": { $add: ["$lease.fence", 1] },
    "lease.until": { $dateAdd: { startDate: "$$NOW", unit: "second", amount: 30 } },
    "lease.heartbeatAt": "$$NOW",
    updatedAt: "$$NOW"
  } }],
  { returnDocument: "after", includeResultMetadata: false }
);
if (!claim) throw new Error("NotClaimed");
```

Heartbeat uses `_id + owner + fence + running + unexpired` and an update pipeline setting a new server-time leaseUntil. Do not renew a stale or already-expired lease. Literal wrapping prevents a value beginning with `$` from being interpreted as an expression. Initialize/validate fence as BSON long or enforce a documented safe-integer ceiling; do not silently lose integer precision through JSON serialization. Probe `$$NOW` in the claim filter on the actual server before relying on this exact query.

**Critical fencing requirement:** each world-effect transaction must **modify** the job under the fence predicate, then mutate the world and write its effect/receipt. Reading a lease under snapshot isolation is insufficient. MongoDB's production docs explicitly show that modifying a lock document acquires a write lock; a subsequent takeover/write conflict then prevents stale commitment.

```ts
// Inside the effect transaction, before world writes:
const live = await jobs.findOneAndUpdate(
  {
    _id: jobId, "lease.ownerId": workerId,
    "lease.fence": claim.lease.fence, status: "running",
    cancellationRequested: false,
    $expr: { $gt: ["$lease.until", "$$NOW"] }
  },
  { $inc: { commitSeq: 1 } },
  { session, returnDocument: "after", includeResultMetadata: false }
);
if (!live) throw new Error("LostLease");
```

Use a modifying increment, not a no-op `$set` of the existing owner. Lease expiration is not a precise cancel timer. A short effect that acquired the lock can complete while another claimant waits; the invariant is that a **replaced fence** cannot commit new effects. Long model calls occur outside database transactions and need separate cancellation/heartbeat handling. Fencing does not erase an already-sent HTTP/LLM request.

## 5. Idempotency, action receipts and operational coverage — Design

An effect key is stable for the same logical operation, including job/world, tool, canonical target/argument digest and expected source revision. Validate reused keys against argsDigest: the same key with different arguments is a conflict. A replay returns the previously committed receipt rather than executing again.

Within one short transaction: conditionally modify the live job fence; check/claim the idempotency record; conditionally lock/advance world_state; apply exact target-ID/source-revision changes; insert the durable effect/receipt and outbox row. Generate stable IDs outside the callback. Duplicate-key races abort; after the abort, read the authoritative completed receipt and confirm arguments. Do not swallow every duplicate-key exception as a success.

The operational verifier traverses **visible registered/discovered paths and relations**, not hidden target manifests. Its receipt must state catalog revision, world revision, scope, actions, unresolved witnesses and limitations. Hidden fixture targets grade trials separately; they can disagree with an apparently clean operational receipt when catalog coverage is incomplete. This disagreement supplies discovery evidence, never permission for the product tool to query the answer key.

If a residual sweep occurs outside the commit transaction, the commit must conditionally **modify** world_state at the sweep's exact world/catalog revision. This only prevents phantom writes if **every permitted world writer** advances that same state document within its own transaction. Uncontrolled external writes defeat that protocol. The synthetic fixed-world experiment can enforce it; production claims must name the write barrier/coverage boundary. Search/vector indexes cannot serve as instantaneous absence proofs. Reconfirm registered candidates with normal queries in the commit path.

TTL does not authorize action or prove erasure. Expired records can persist beyond the 60-second monitor interval; grants need an explicit server-time expiresAt predicate and raw artifacts need explicit deletion on erasure. TTL is eventual housekeeping only. TTL indexes are single-field and cannot target `_id`.

## 6. Immutable hashes, CAS and atomic human grant consumption — Design

Hash a canonical **JSON-compatible structural payload**: parent, typed rules/context/topology, compiler/vocabulary/constitution/evaluator version IDs and authority limits. Keep timestamps, signatures, display names and mutable status outside the payload. Do not hash driver-mutated BSON documents after insertion. RFC 8785 preserves arrays, recursively sorts object properties, emits UTF-8, disallows duplicate keys/NaN/Infinity and has defined number/string serialization. It does not silently normalize Unicode.

Verified Node API: `createHash('sha256').update(canonicalBytes).digest('hex')`. Canonicalization itself needs a tested RFC-8785 implementation; plain JSON.stringify over arbitrary objects is not a substitute. SHA-256 content addressing does not by itself authenticate the author, enforce immutability or prove that a raw-data hash is anonymous.

The trusted gate can atomically consume a grant and move a parent-aware deployment pointer, but it therefore needs scoped **find/update** privileges on grants. The human approval service remains the sole **insert** principal. Saying grants are accessible only to p_human while also promising transactional gate consumption is inconsistent.

Copy-ready application shape (domain variables are bound by a trusted admission service; callback does not perform model/network/UI operations):

```ts
await client.withSession(async session => {
  await session.withTransaction(async () => {
    // For an authority-expanding candidate only:
    const grant = await grants.findOneAndUpdate(
      {
        _id: approvalId, parentHash, parentRev, candidateHash,
        flipSetDigest, catalogHash, evaluatorHash,
        consumedAt: { $exists: false },
        $expr: { $gt: ["$expiresAt", "$$NOW"] }
      },
      [{ $set: {
        consumedAt: "$$NOW", consumedBy: { $literal: promotionId }
      } }],
      { session, returnDocument: "after", includeResultMetadata: false }
    );
    if (!grant) throw new Error("ApprovalInvalidOrConsumed");

    const next = await deployments.findOneAndUpdate(
      { _id: deploymentId, activeHash: parentHash, rev: parentRev },
      { $set: { activeHash: candidateHash }, $inc: { rev: 1 } },
      { session, returnDocument: "after", includeResultMetadata: false }
    );
    if (!next) throw new Error("StaleParent");
    await promotions.insertOne({
      _id: promotionId, deploymentId, rev: next.rev,
      from: parentHash, to: candidateHash, approvalId, gateReceiptId
    }, { session });
    await outbox.insertOne({
      _id: outboxId, kind: "harness_promoted", dedupeKey: promotionId
    }, { session });
  }, {
    readPreference: "primary",
    readConcern: { level: "snapshot" },
    writeConcern: { w: "majority" }
  });
});
```

For tightening candidates, omit grant consumption and its field, but retain the pointer CAS and gate receipt. Recompute/validate the approved flip-set digest against a pinned history high-water/corpus revision. If corpus writers can advance concurrently, admission conditionally modifies the shared corpus revision document too; a mere snapshot read does not forbid unseen later inserts. A failed CAS must roll back grant consumption. Expired/replayed/wrong-parent grants are never “close enough.” Rollback uses a new audited pointer CAS rather than changing historical bundles.

Transaction callback retries mean: no email/telemetry/HTTP delete inside it; no regenerated candidate; no rerunning a stochastic evaluator; no Promise.all over session operations. The outbox consumer is at-least-once unless the remote receiver supports idempotency. A unique local outbox record does not guarantee exactly-once delivery after a crash between remote acceptance and local acknowledgement. Uncertain external status is recorded and reconciled.

## 7. Role requirements and validation boundaries

**Verified facts:** Atlas roles are additive, collection-scoped custom actions exist, role changes may take 30 seconds on Free/Flex, and provisioning requires Org Owner / Project Owner / Project Database Access Admin. Use Atlas UI/CLI/Admin API; direct role alterations are rolled back. MongoDB RBAC cannot filter documents by worldId/tenant. Validators can be bypassed by a principal with bypassDocumentValidation; dbAdmin and restore include that permission.

**Proposed grants (Design):**

| Principal | Needs | Must not have |
|---|---|---|
| setup | create collections/indexes/validators and Atlas role provisioning | Runtime presence on worker/improver hosts |
| gateway by authority tier | scoped world reads and specific update/remove actions; jobs/effects/receipts/world_state/outbox writes | Raw remove on retained collections, collMod, bypass validation, hidden targets, approval inserts |
| census/discovery | world reads; structural catalog/edge writes | hidden targets, arbitrary governance writes. If collMod is deliberately retained, confine it to two named mutation collections and a trusted fixed schema compiler |
| improver | sanitized train evidence, structural catalog/precedents, insert proposals | raw vault/artifacts, validation/heldout targets, deployment/grant writes, evaluator modification |
| gate | read candidates and fixed validation reports; insert admitted bundles/audit; update deployment/corpus; find+update existing grants | insert grants, raw hidden answer-key access, schema/role edits |
| grader | hidden targets and world reads; insert grades in private collections | deployment/governance mutations; exposed agent tool endpoint |
| human approval service | insert signed/bound approval grants; own authenticated UI | model-authored identity, admission pointer updates |
| observer | controlled Raindrop read-back; sanitized evidence insert | grant creation, raw database admin credentials |
| privacy service | remove transient/raw artifacts and vault links; append erasure/tombstone evidence | rewriting structural rules or grading truth |
| stream/auditor | find+changeStream on precise public collections; offsets/projection writes | hidden private DBs and raw artifact stream payloads |

Physically separate retained invoices from deletable records if the demo claims a real authorization error on invoice deletion. Same-collection mixed retention is enforced by application code, not roles. Update privilege still permits arbitrary updates at the database layer; the trusted gateway must expose only fixed redaction/restriction updates.

Mutation schemas use BSON-aware `$jsonSchema` draft-4 subset: oneOf, enum, required, maxItems/maxLength, pattern and additionalProperties:false are supported. Include `_id` in allowed properties because the driver inserts it if absent. Use bsonType int/long, not type integer. `$ref`, `$schema`, definitions, format and default are omitted. A BSON date can be validated as date; an ISO-string format cannot be assumed. Generic Zod/JSON-Schema output needs an explicit adapter and validation tests.

Closed vocabulary plus membership checks reduces raw-PII insertion channels but does not mathematically guarantee anonymity: arbitrary strings/hashes/IDs or numeric fields can encode data. Prefer registered opaque path/event IDs; gate verifies membership and ownership. Raw evidence values never enter structural bundles. A validator cannot check a parent bundle or external approval document by itself.

## 8. Operational relations and lineage traversal

**Verified:** graphLookup recurses over **one from collection in the same database**. It is not automatic traversal across arbitrary domain collections. maxDepth 0 is non-recursive; first hop depth is 0. Results are unsorted. restrictSearchWithMatch is a static query filter and cannot contain aggregation expressions such as field-dependent `$expr`. A sharded from collection is permitted since 5.1, but graphLookup targeting it is forbidden within a transaction. Memory may spill above 100 MB in general; Free/Flex do not permit disk spill.

**Design:** normalize registered relations into a bounded relation_edges projection, with explicit world/catalog revision and typed node keys. A string ID is not automatically equal to an ObjectId; convert deliberately under a declared identity rule, and reject invalid/ambiguous conversions. Edge collection construction and candidate-ID reads stay operational. The hidden fixture manifest is not an input.

Application traversal sketch, to adapt after inspecting the official examples:

```js
{
  $graphLookup: {
    from: "relation_edges",
    startWith: "$nodeKey",
    connectToField: "fromNode",
    connectFromField: "toNode",
    as: "reachableEdges", maxDepth: 8, depthField: "hop",
    // Literal values supplied by server, not "$worldId" expressions:
    restrictSearchWithMatch: { worldId: selectedWorldId, catalogRev: selectedCatalogRev }
  }
}
```

For collection-specific joins, lookup supports localField/foreignField or let + pipeline + `$match.$expr`. Both missing local and missing foreign fields can match as null; filter missing values before joining. Correlated expression index usage is limited and does not cover all multikey/partial/sparse cases. lookup targeting a sharded collection inside a transaction is supported **from MongoDB 8.0**, unlike graphLookup's prohibition. Probe actual version and topology.

Structural lineage uses the same graph primitive over same-DB immutable version documents. Do not include erased raw content merely to make a lineage graph complete; an opaque source-deleted marker can preserve structural provenance without retaining a trace payload.

## 9. Change-stream recovery and privacy retention

Use one public promotions/events stream with immutable insert payloads; world resurrection monitoring is a distinct bounded stream. Collection watch needs find+changeStream on that collection; database watch needs those privileges on all non-system collections. Preserve event `_id` tokens unchanged. Persist the BSON token with consumer/pipeline version after processing; restart with the same options/pipeline and resumeAfter. At-least-once projection updates need stable event dedupe keys or a transaction that writes projection+offset together. UI SSE delivery itself is not an exactly-once durable effect.

resumeAfter cannot resume after invalidate; startAfter can create a new stream after it. Both require oplog history. An expired history token needs a full reconciliation plus a new checkpoint, not silent continuation. updateLookup reads the document at processing time and can show a later version/null; immutable promotion inserts avoid conflating versions. Pre/post images require enabling/retention and can retain sensitive prior content; do not enable them on PII-bearing collections without an explicit retention/deletion design.

**Privacy classification — Design, not a MongoDB compliance feature:**

| Artifact | Proposed treatment |
|---|---|
| subject identifier map and raw tool/model artifacts | private transient storage, explicit erasure plus eventual TTL, deletion verified by ordinary queries |
| raw Raindrop traces | redact before emission where possible; track subject/artifact linkage; asynchronous vendor-deletion outbox with pending/due/confirmed states, never immediate-forgotten claim |
| structural harness/critic/meta lessons | PII-free typed vocabulary and validated refs; immutable content-addressed payloads can survive raw-source deletion |
| audit/provenance metadata | opaque refs and counts; source tombstones; ordinary runtime append-only access with a separately authorized privacy deletion path for accidentally captured raw data |
| resurrection watch tokens / retained record restrictions | purpose-bound pseudonymous control data with declared retention; a retained HMAC/token is not total absence of personal linkage |

An immutable archive containing raw PII conflicts with a promise to erase that content. Either do not store raw data there, or give the privacy service an explicit deletion/crypto-erasure design and describe what persists. Logical document deletion does not prove immediate physical removal from oplog, pre-images, backups or external vendors. The benchmark should measure the declared logical artifact boundary rather than imply an unimplemented storage purge.

## 10. Required verification evidence for the orchestrator

Keep all full-scope components, with contract tests at their boundaries:

1. Two concurrent job claims: one live owner; takeover increments fence; stale heartbeat and stale effect transaction refuse. Kill a worker after committed effect but before acknowledgement; replay returns one receipt and no second effect.
2. Two candidates against one parent: one admission; failed CAS leaves approval unconsumed. Wrong-parent, expired, already-consumed and wrong-digest grants fail; successful consumption and pointer/audit commit are atomic.
3. Inject a world write between residual sweep and erasure commit: shared revision CAS aborts. Show that bypassing the write barrier invalidates the completeness claim.
4. Operational receipt can say clean over registered scope while hidden grader reports a missed copy; discovery expands visible scope; no tool can read hidden targets.
5. Validator adversarial tests: unsupported schema keywords rejected during setup; extra fields/PII-like raw values/invalid refs rejected; insert-only principal cannot modify admitted bundles or bypass validators; retained physical collection refuses removal.
6. Graph fixtures: cycles, missing/null refs, ObjectId/string mismatches, nested arrays, bounded maxDepth, namesakes and retained entities. Catalog is built from visible data only. Verify graphLookup restrictions on actual cluster.
7. Stream restart/duplicate delivery/invalidate/history loss tests. Projections reconstruct correctly from immutable events; resume tokens preserve BSON and do not leak raw data.
8. Privacy tests sweep raw artifacts, transient vault and external pending status while structural bundles remain PII-free. Deleted-source lineage is honest rather than fabricated.
9. Meta-improver trial pins model/harness/evaluator/catalog/cutoff and uses disjoint future trials. Meta-candidate cannot change the evaluator, hidden fixtures, constitution or human-approval requirement; it goes through its own fixed admission receipt and CAS pointer.

## Confidence and remaining gaps

High confidence in the documented APIs and source restrictions. Lease/fencing, grant consumption, coverage receipts, role layout, content hashes, privacy classification and meta-gates are **proposed protocols**, not a tested implementation or database-native feature.

Load-bearing gaps: actual Atlas tier/version/topology; custom-role provisioning rights and allowed scoped actions; `$expr`+NOW claim query and performance; BSON-long round trip; grant/lease conflict tests; exact code error assertions; catalog revision/write-barrier coverage; JCS implementation chosen and validated; any sharded graph/lookup deployment; Raindrop deletion semantics/latency checked by the Raindrop researcher; backup/pre-image retention if production erasure is claimed. Fixed small test worlds can isolate the experiment, but they do not establish universal discovery or compliance.

## Root contract audit (read-only, initial files at 141 / 148 lines)

Read `docs/expunge/CONTRACTS.md` and `docs/expunge/DATA-MODEL.md` completely after this fact report was drafted. Their names are authoritative implementation contracts; the proposed map earlier in this report is discovery material, not a competing contract. No root-owned file was edited. The following findings were sent to the orchestrator:

- DATA-MODEL line 49: pointer uniqueness `{scopeId,target}` needs explicit tenant/environment binding unless scopeId is guaranteed globally unique across both. Registry keys are tenant-scoped, so the current text permits cross-tenant reuse. Bind canonical pointer identity, projection sequence namespace and approval descriptors consistently.
- DATA-MODEL lines 104–109: effectKey replay after a WorldRevision mutation is too late for lost-ack recovery. A previously committed effect advances the revision, and a terminal job may no longer satisfy the live lease filter. Add an authorized read-only committed-receipt replay path; inside a new effect transaction recheck effectKey/argsDigest before changing world revision or reapplying effects.
- CONTRACTS HarnessBundle: runtimeAdapterHash alone needs an explicit definition that binds compiler/vocabulary/constitution semantics, or separate hashes in the canonical payload. GateReport-only bindings do not prevent identical bundle IDs from changing meaning under a new compiler/catalog.
- DATA-MODEL privacy sections: raw_artifacts/subject_tokens/subject-artifact links and the privacy-service principal/permissions need concrete inventory entries. Otherwise an erasure policy exists without an actor allowed to remove raw or mistakenly personal immutable artifacts.
- Lease protocol: heartbeat/effect/checkpoint admission predicates should explicitly enforce unexpired lease and cancellationRequested:false. Owner/fence equality alone does not implement the intended expiry/cancellation semantics. The sketch above is aligned to the nested Lease fields.

The main invariants already align: conditional lease/world writes, immutable bundles, parent CAS, approval consumption, source-derived operational receipts, hidden grader isolation, outbox uncertainty and resume-token recovery.
