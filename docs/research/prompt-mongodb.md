# MongoDB requirements for the Expunge Claude Code goal

Fact gathering only, 11 October 2026. No product implementation, service startup, test execution, installation or commit was performed in this pass. The existing source is a partial foundation; test-file presence is not proof that its integration assertions passed.

## Verified primary-source constraints

- Use one `MongoClient` and its `ClientSession` for every operation in a transaction. Sequentially await each database operation. Do not use `Promise.all` inside the transaction or pass a session to another credentialed client. `withTransaction` may rerun a callback; model calls, vendor HTTP calls and other external effects must stay outside it. [Node driver transactions](https://www.mongodb.com/docs/drivers/node/current/crud/transactions/), freshly scraped to `.firecrawl/prompt-mongodb-official-transactions.md`, session ownership at line 823 and sequential operations at 859–899.
- A snapshot read can be stale. Effect and promotion protocols must acquire conditional writes on their authority/fence rows, then check the result. A read-only lease or authorization check does not establish a fence. [Transaction production considerations](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/), cached `.firecrawl/blueprint-mongo-txn-production.md`, section “In-progress Transactions and Stale Reads.”
- Atlas roles are provisioned through Atlas CLI, UI, Administration API or supported integrations. Direct role edits are rolled back. Privileges are additive; assigning a broad role alongside a narrow role does not deny the broader actions. Provisioning requires the relevant Atlas account role; Free/Flex propagation can take up to 30 seconds. [Atlas custom roles](https://www.mongodb.com/docs/atlas/security-add-mongodb-roles/), freshly scraped `.firecrawl/prompt-mongodb-official-roles.md`, lines 692–710 and “Required Access.”
- Resource privileges operate on databases/collections. Expunge tenant/environment/world binding remains a trusted application boundary; do not describe Atlas collection RBAC as document-level RLS. Test both raw-driver collection denials and application scope denials. [MongoDB privileges](https://www.mongodb.com/docs/manual/core/authorization/), [Atlas custom role actions](https://www.mongodb.com/docs/atlas/reference/custom-role-actions/).
- `$graphLookup` searches a same-database target collection. `maxDepth` bounds recursive depth; its restriction is ordinary query syntax, not an aggregation-expression context. Results have no guaranteed order. Use a normalized visible-data edge projection with scope and source revisions. [Graph lookup](https://www.mongodb.com/docs/manual/reference/operator/aggregation/graphLookup/), cached `.firecrawl/blueprint-mongo-graphlookup.md`, syntax/field table near lines 83–108. Sharded target restrictions and tier memory/resource limits must be checked against the actual deployment.
- Change-stream resume requires the same pipeline/options and enough oplog history. `resumeAfter` cannot resume after invalidation; `startAfter` is the distinct mechanism. Persist backend BSON tokens after durable processing. Use a committed event sequence and snapshot/backfill when stream history is unavailable. [Change streams](https://www.mongodb.com/docs/manual/changeStreams/), cached `.firecrawl/tech-mongodb-change-streams.md`, resume sections around 252–308.
- MongoDB Search has eventual consistency and no stronger consistency guarantee. Indexed permission flags alone cannot enforce immediate revocation. Search returns candidate lesson IDs; re-read current scope, eligibility, source revision and actual content from authoritative MongoDB reads before context assembly. Absence from search is not cleanup completion proof. [Search index performance](https://www.mongodb.com/docs/search/performance/index-performance/), freshly discovered and fully scraped in `.firecrawl/prompt-mongodb-search-consistency-discovery.json`, section “Eventual Consistency and Indexing Latency.” The attempted former URL `/docs/atlas/atlas-search/query-consistency/` returned a page-not-found document and is not evidence.
- Vector Search filter fields must be in the index. Explicitly choose manual or automated embeddings and use that variant's verified request shape; do not combine `queryVector` examples with automated `query.text` fields accidentally. Pin embedding model/dimensions and test index readiness, relevance and revoked-source exclusion. [Vector Search stage](https://www.mongodb.com/docs/vector-search/query/aggregation-stages/vector-search-stage/), cached `.firecrawl/tech-mongodb-vector-stage.md`.
- TTL is eventual housekeeping, not immediate erasure, lease expiry authorization or a way to remove inconvenient audit records. Strict BSON validators must include MongoDB's `_id` in a root `additionalProperties:false` envelope. Runtime roles must lack `bypassDocumentValidation`, `collMod`, drop and role-admin privileges. [TTL](https://www.mongodb.com/docs/manual/core/index-ttl/), [validation bypass](https://www.mongodb.com/docs/manual/core/schema-validation/bypass-document-validation/), [JSON schema](https://www.mongodb.com/docs/manual/core/schema-validation/specify-json-schema/).

## Concrete API shapes to preserve

The existing repository pins the MongoDB driver around the 7.7 API. Verify installed declarations when resolving dependencies. Existing API audit is in `docs/research/blueprint-mongodb.md` sections 1–2.

```ts
client.withSession(async session =>
  session.withTransaction(async () => {
    // Sequential database operations using this session only.
  }, {
    readPreference: 'primary',
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
    maxCommitTimeMS: 10_000,
  })
);

collection.findOneAndUpdate(filter, update, {
  session,
  returnDocument: 'after',
  includeResultMetadata: false,
}); // document | null; do not assume .value

collection.watch(pipeline, { resumeAfter: backendBsonToken });
```

Approved application protocols are not vendor APIs: `claim`, `fence`, `commitEffect`, `promote` and `complete` are Expunge code that must be tested.

## Deep integration architecture to require

Keep three databases on one invited Atlas deployment: `expunge_world` for controlled company documents and source-derived edges; `expunge_control` for durable jobs, immutable bundles, scoped eligibility, evidence/provenance, lessons, receipts, outboxes, approvals and CAS pointers; `expunge_private` for grader-only truth. Each principal gets its own client, without fallback to setup credentials. Transactions may span the permitted databases using one principal/client; cleanup and promotion remain separate transactions.

For every genuinely new cleanup effect: authenticate actor/job access; resolve the stored plan and trusted scope; first return an already committed receipt for the stable logical effect key and matching digest; otherwise enter the transaction, recheck that ledger, conditionally write live job fence and world revision, recheck eligibility/targets/preimages, apply a bounded batch, insert effect/receipt/outbox, and commit. Lost acknowledgement must return the saved receipt even if the job is now terminal or the world revision advanced. Logical keys exclude a new lease fence or model tool-call ID.

Promotion: finish evidence retrieval and evaluation beforehand; independently derive authority classification from stored data; pin artifact/report/compiler/runtime/evaluator versions; consume the exact bound unexpired grant when required; CAS the scoped active pointer against parent hash/revision; append transition receipt and outbox in one transaction. A stale parent or injected failure rolls back grant consumption. Revocations remain live despite a run's pinned bundle.

Use ordinary indexed exact queries for destructive authorization and completion. Use Search/Vector to improve structural lesson recall, with scope prefilters and authoritative postchecks. Record explain plans for real query factories, search readiness/lag, graph truncation and operations scanned/changed. Context retrieval combines structural relevance with current permission and source provenance.

## Confirmed partial-code gaps to put into the build goal

1. **Array path integration is currently broken.** `packages/fixtures/src/generator.ts:108` emits `['data','aliases','*']`; many fixture recipes also contain wildcards. `packages/mongo/src/scope.ts:13` rejects `*`. Define an explicit typed path AST or a verified declared wildcard grammar. Compile read discovery and targeted array modifications separately; never blindly strip `*` for writes. Test fixture→registry→discovery→mixed-array cleanup end to end with preservation checks.
2. **Privacy traversal silently loses completeness.** `packages/mongo/src/provenance.ts:8` defaults to depth 8 and applies a root `$limit:500`. It returns only IDs, so a caller cannot tell whether closure was incomplete. A root limit does not bound the descendant array of each graph lookup. Replace this with a bounded traversal protocol that returns completeness/frontier state, continues the closure durably or blocks the affected context scope until complete. Test more than 500 source edges, depth beyond eight, cycles, concurrent new derivations and revoked context already pinned by an active job.
3. **RBAC execution is unverified in this pass.** `packages/mongo/test/rbac.integration.test.ts:7–8` skips without `MONGODB_RBAC_TEST_URI`; its `createRole/createUser` setup is explicitly for a local authenticated replica set. This is useful local testing, not Atlas provisioning evidence. Require separate actual Atlas identities and raw-driver denials, record executed/skipped counts, and fail the production acceptance lane on unexpected skips. There is no standalone recorded RBAC pass report discovered in the inspected files.
4. **Scope identity is already tenant/environment scoped.** `packages/contracts/src/index.ts:88–90` hashes exact `{tenantId,env,scopeId}` and additionally `target` for deployment. It performs no identifier normalization. Preserve exact opaque server-issued IDs or explicitly define validation/canonicalization at the authentication boundary; do not silently lowercase/trim IDs differently across routes, hashing, grants, event streams and query filters. Test same scopeId under different tenants/environments and delimiter/Unicode/whitespace edge cases.
5. **Scaffold callbacks are not complete authority.** `EffectRepository.commitEffect` accepts trusted `apply` and optional `validate`; `DeploymentRepository.promote` accepts caller-provided `requiresApproval` and a validation callback. The final authenticated gateway/promoter service must derive those decisions from stored policy and require the checks. Do not expose these internals as direct model/HTTP authority. Artifact reads in promotion currently occur without its session; review atomic permission/revocation checks and require a written authorization revision fence where needed.
6. **Source retraction coverage needs broader run tracking.** Current provenance revoke cancels jobs by descendant `binding.harnessHash`. The complete loader must also track evidence/lesson/context inputs and cancel runs holding revoked context even when their harness hash itself is unaffected. Add a revocation epoch or equivalent authority revision to close retrieval-to-action races.

## Production acceptance evidence

- Real invited Atlas cluster capability probe and per-principal credential check; disclose topology, version/tier, role provisioning constraints and Search/Vector readiness. Never print connection strings.
- Real replica-set/Atlas tests: stale worker takeover; cancellation race; concurrent world write during completion; unknown commit/lost acknowledgement; digest conflicts; injected post-fence failure; duplicate unique-key race; same-parent promotion race; expired/changed grant; rollback; live revocation.
- Raw-driver negative tests: worker/proposer cannot read private truth, mutate admitted artifacts, mint approval or promote; executor cannot remove separately protected retained collection; runtime cannot bypass schema or alter validators. Application tests separately enforce tenant/world binding.
- Array fixture integration and BSON identity tests for string/ObjectId/int64 distinction; exact plan target/preimage binding; only target values altered in mixed arrays; unrelated preserved bytes/hashes.
- Reconnect tests with duplicate events, expired token, changed pipeline, invalidation, bounded backlog and restart; no replayed logical effect or UI-derived authority.
- Search recall and authoritative eligibility tests after deletion/revocation while the index is stale; closure tests beyond depth/branch bounds; verify retained lesson/artifact bytes contain no withdrawn subject literal.
- Setup/migrations are idempotent; validators/indexes are created before workloads; backup/restore and reconciliation are exercised on synthetic data; secrets stay server-only; health/readiness distinguish configured, reachable, authorized and evidence-ready states.
- CI reports every check and unexpected skip. A production claim requires actual command/result and run IDs in `WHAT_IS_REAL.md`, not mocks, fixture tests or configuration inspection alone.
