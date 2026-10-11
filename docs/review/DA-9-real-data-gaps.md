# DA-9: what stands between HEAD 5b49dfe and a real-data production Expunge

Reviewer: devils-advocate (effective model `claude-opus-5-5`), 2026-10-11. Static reading of HEAD `5b49dfe` plus my own
fast-lane run. I did not edit product code, did not touch Git, and printed no secret. The detailed real-build
specification (`EXPUNGE-REAL-BUILD-SPEC.txt`) is ABSENT. This review uses only the goal summary in
`docs/continuity/briefs/REAL-BUILD-2026-10-11.md`. Anything only that file would define is marked BLOCKED (spec).

Working tree at review time (other lanes in flight, NOT counted as HEAD): modified `packages/fixtures/src/sealed.ts`,
`splits.ts`, `tests/reliability/e1-worker-faults.live.test.ts`, `docs/continuity/PROJECT-STATE.md`, `TASKS.json`;
untracked `infra/services/`, `packages/mongo/src/native-values.ts`.

## 0. Checks I ran

| Command | Exit | Result |
|---|---|---|
| `npm run typecheck` | 0 | clean (working tree) |
| `env -u MONGODB_TEST_URI -u MONGODB_RBAC_TEST_URI -u EXPUNGE_REQUIRE_LIVE_TESTS npx vitest run` | **1** | 116 files: 74 passed, 1 failed, 41 skipped. Tests: **1006 passed, 3 failed, 546 skipped**. All 3 failures are in `tests/reliability/netguard.live.test.ts` (`expected 'blocked' to be 'info'`, line 99). |

The lead's baseline (998 passed / 557 skipped, exit 0) no longer holds. The netguard suite turns itself on when a Docker
container with the default name is present (`netguard.live.test.ts:17-19`). It has no explicit opt-in flag, so the
fast lane depends on what another lane has running. See D16.

## 1. Facts the brief has wrong

- **The root `.env` now EXISTS.** It is ignored by Git, 3493 bytes, mtime Oct 11 12:12. I checked names and emptiness
  only and printed no values. `MONGODB_SETUP_URI` is SET, with the `mongodb+srv` scheme and an Atlas (`mongodb.net`)
  host. All nine least-privilege principal URIs are EMPTY. `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `EXPUNGE_MODEL_ID`,
  every `RAINDROP_*` and `CPK_INTELLIGENCE_API_KEY` are EMPTY. `EXPUNGE_MODEL_PROVIDER=openai`. Also SET:
  `EXPUNGE_TENANT_ID`, `EXPUNGE_ENV`, `EXPUNGE_SCOPE_ID`, `EXPUNGE_*_DB`, `EXPUNGE_AUTHORITY_FLOOR_HASH`,
  `EXPUNGE_DOMAIN_URL`, `APP_ORIGIN`, `EXPUNGE_ALLOWED_ORIGINS`, `OWNER_ID`. Consequence: the brief's line "Atlas:
  BLOCKED" is now only partly true. The setup-principal probe can run. Least-privilege Atlas RBAC is still BLOCKED.
  Nobody has confirmed that this cluster is the invited Hackathon Sandbox and not a personal cluster. Spec section 6
  forbids using an unauthorized personal cluster.
- **More than `gate` and `deployment` was lost.** `docs/continuity/OWNERSHIP.md:25` names `packages/plugin-sandbox`,
  `packages/campaign-host`, `packages/rehearsal` and `packages/meta-evolution`. None of them is at HEAD, and
  `git log --all` has no history for any of them. Hider (PKT-42) and meta (PKT-43) are not in `COMMIT-LEDGER.md`. No
  Hider or improver code exists anywhere under `packages/` or `apps/`.

## 2. Goal clause by goal clause

Legend. REAL: runs on a production code path, exercised against a real local service by the cited test. TEST-ONLY:
library code with no production caller (the goal does not count these). FAKE: a synthetic or scripted stand-in.
BLOCKED: needs an external input. UNIMPL: work that could proceed locally now.

### 2.1 Owner sources, adapters, identities, retention, original-source effects, external writers, config

| Item | State | Evidence |
|---|---|---|
| Registering an owner source | UNIMPL (and partly BLOCKED, spec + owner rights) | The only registry writer is `ScopeRepository.insert` (`packages/mongo/src/scope.ts:244`), restricted to `fixture_builder`/`setup`, with no production caller. `WorldRepository.create` (`worlds.ts:37`) has no production caller either. No source preview, approval or registration flow exists. |
| Adapters over the owner's own collections | UNIMPL: the data model forbids it | Every domain read and write is ANDed with `{tenantId, env, worldId}` at the document root (`client.ts:138-145`). Registered fields must live under `data.*` (`contracts/src/index.ts:807-826`, `REGISTRY_DATA_ROOT`). Collections resolve only inside one database, `expunge_world` (`client.ts:76`, `scope.ts:292-407`). A registry holds at most 16 collections (`scope.ts:250`). A real owner collection with its own schema, in its own database, cannot be registered. This is exactly the "`data.*` envelope/collection assumption" the goal says to replace. |
| Exact identities and reference ownership | PARTIAL, with a known destructive gap | Identity-role fields exist (`FieldDescriptor.identity`). **Reference ownership is not implemented.** DG1/PKT-16b is still TODO. The pinned KNOWN GAP test `packages/domain/test/identity.integration.test.ts:167-200` shows that cleaning subject C1 plans deletion of a parent O that it shares with C2, then plans C2 as well. On real data this deletes another person's records. |
| Conditional effects on the original source, with readback | UNIMPL | Effects run only against `expunge_world` copies (`scope.ts:395-458`). They rely on an Expunge-only `_rev` field (`scope.ts:160-161,408-411`). `restrict` and `tombstone` write invented `access` and `lifecycle` fields into the record (`scope.ts:416-430`), which an owner application has no reason to honour. |
| Consistency with external writers | UNIMPL | The pre-effect version check compares `_rev` only (`effects.ts:227-234`). A writer outside Expunge that does not increment `_rev` is invisible to it. The world counter advances only through controlled writers (`worlds.ts:16-24`). |
| Retention | PARTIAL | Owner policy and retained-record hashes exist in the domain plan (`domain/src/store.ts` `PlanRow.retained`). Retention is not modelled on owner sources. |
| Production/staging configuration and role-scoped secrets | PARTIAL | One `MONGODB_<PRINCIPAL>_URI` per principal, with no fallback (`worker/src/wiring.ts:187-189`, `observer/src/process.ts:63-67`). There is no staging/production profile and no secret store. TLS: none, since the worker wake server and the domain listener are plain `node:http`. |

### 2.2 Replace synthetic policies, generated worlds and fake providers

| Item | State | Evidence |
|---|---|---|
| World source | FAKE only | The only world producer is `packages/fixtures` (the generator). The domain service labels every world `Synthetic world ...` (`domain/src/service/worlds.ts:21`). |
| Worker model | REAL code, BLOCKED live | `EnvModelResolver` and the TanStack OpenAI/Anthropic adapters (`vendor-openmuse/src/provider.ts:5-80`) are wired by `startWorker` (`worker/src/index.ts:57-80`). Every Dispatcher test uses `FakeChatModel` (`apps/worker/test/domain.integration.test.ts:1-4`). The live smoke (`apps/worker/test/live-provider.test.ts`) is BLOCKED: `OPENAI_API_KEY` and `EXPUNGE_MODEL_ID` are empty. |
| Raindrop | REAL code, BLOCKED live; production process not wired (D5) | The evidence path end to end runs only against `fake-raindrop.ts` (`apps/worker/test/evidence-path.integration.test.ts:1-9`). |
| Evolver model | INTERFACE ONLY | No `StructuredClient` implementation exists. `createStructuredEvolverModel` (`evolution/src/model.ts:106`) is never called, not even by a test. The only model is `createLabeledFakeEvolverModel`. `@expunge/evolution` has no provider SDK dependency (`evolution/package.json`). |

### 2.3 Production entrypoints: which ones wire the real components

The production processes at HEAD are exactly these:

| Process | Entrypoint | Principals | What it actually runs |
|---|---|---|---|
| worker | `apps/worker/src/index.ts:44-117` (`npm start`) | `domain_executor` | Real Dispatcher, the nine real gateway tools (`domain-wiring.ts:16-45`), the env model resolver and optional Raindrop SDK episodes. Claims only jobs in its one configured scope (`dispatch.ts:404-411`). |
| evidence | `packages/observer/src/main.ts:15-30` | `observer` | **Always BLOCKED by construction**: `createEvidenceProcess(env, {}, ...)` passes no suppression and no leak-guard source, so `evidenceReadiness` always adds two blockers (`process.ts:79-89`). It stays BLOCKED with every key present. |
| operator | `apps/operator` (OpenDots server) | none (it calls the domain service over HTTP) | UI and proxy routes. |
| setup / probe | `scripts/setup-mongo.ts`, `scripts/probe-mongo.ts` | `setup` | DDL, validators and an authority seed. They do **not** create a registry, a world or an initial deployment. |

No production process exists for: the domain service (`createDomainService`/`listenDomainService` are called only from
`packages/domain/test/*`), evolver/proposer, gate/grader, approval issuer, promoter, privacy controller, fixture builder
or source registration, campaign host, Hider or meta. The `proposer`, `grader`, `approval_issuer`, `promoter`,
`projection_reader`, `privacy_controller` and `fixture_builder` principals are created only by unused factory helpers
(`mongo/src/client.ts:102-112`) and by tests.

`@expunge/evolution`, `@expunge/privacy` and `@expunge/grader` have **zero** non-test importers outside their own
package (grep over `packages`, `apps`, `scripts`, `infra`, `tests`). `@expunge/fixtures` is imported only by the grader.

### 2.4 The mandatory working loop, stage by stage

| Stage | At HEAD | Evidence |
|---|---|---|
| Source preview, approval, cleanup, receipt | Preview, submit, cancel and receipt routes are REAL in the library and tested over real HTTP on a replica set (`packages/domain/test/service.integration.test.ts`, `projection-http.integration.test.ts`, `artifacts-http.integration.test.ts`). **No process serves them.** Source approval does not exist. | handler.ts, §2.3 |
| Bootstrap needed before any cleanup | MISSING | `submitCleanup` needs a deployed harness (`HarnessNotDeployed`, PKT-44, `jobs.ts:124-126`). `DeploymentRepository.initialize` (`deployment.ts:223`) has no production caller. A fresh production install can never create a cleanup job without test helpers. |
| Real Raindrop ingest and Query readback | BLOCKED (keys) and D5 | The query client exists (`observer/src/query-client.ts:120`). The live test is skipped because the keys are empty. |
| Evidence-linked generated mutation | TEST-ONLY + FAKE | `proposeCandidate` and `runEvolutionRound` have only test callers. No real model, no process, and `CandidateRepository` is never constructed outside tests. |
| Independent fresh admission | **ABSENT (lost)** | `packages/gate` is gone. What remains is the storage half: gate collections, the campaign permit and `createCampaignJob` (`mongo/test/gate-collections.integration.test.ts`, `campaign-permit.integration.test.ts`), plus `WorkerEpisodeRunner`/`MongoEpisodeJobHost` with only test callers (`apps/worker/test/episode-port.test.ts`). |
| Exact grant and atomic promotion | TEST-ONLY | `ApprovalRepository.issue`, `DeploymentRepository.promote`/`rollback` (`deployment.ts:118,272,483`) have no production callers. Real on a replica set: `packages/mongo/test/promotion.integration.test.ts`, `authority.integration.test.ts`. |
| Operator HITL decision | UNREACHABLE | The client hook and allowlist exist (PKT-45). The operator route `POST /expunge/proposals/:id/decision` (`operator/src/server/expunge/routes.ts:358-369`) calls `/internal/projection/proposals/:id/decision`, and the domain service answers that with **501** (`domain/src/service/handler.ts:181-185`). `GET proposals` and `threads` are also 501. |
| Subsequent real run on the new harness | Mechanism REAL, no trigger | `assertHarnessDeployed` at claim (PKT-54). Nothing promotes, so nothing changes. |
| Rollback | TEST-ONLY | as above |
| Privacy proof | TEST-ONLY + BLOCKED | §2.7 |

**Conclusion: the loop has never closed at HEAD, not even with a simulated worker.** The claim that it closed rests
entirely on lost code (§3).

### 2.5 The four harness surfaces and source plugins

| Surface | Executes in the real worker? | Evidence |
|---|---|---|
| Workflow | YES | `domain/src/controls.ts:177` enforces `bundle.workflow`. Tested in `controls.integration.test.ts`. |
| Guardrails | YES | `governance/src/evaluator.ts:68` `decide(bundle.guardrails, ...)` on the gateway path. |
| Tool policy | YES | `runtime/src/session.ts:117` filters the offered tools; `evaluator.ts:77,91` checks grants and prerequisites. |
| Context | PARTIAL | `schemaMode`, `includeNestedArrays` and `referenceDepth` are consumed (`domain/src/fields.ts`, `tools/inspect-scope.ts:16`, `tools/discover-references.ts:44`). **`lessonRecall`, `maxContextTokens`, `evidenceFormat` and `sourceEligibilityPolicyHash` have no runtime consumer** (grep over domain, runtime, worker and governance). An evolved change to them alters only the hash. |
| Source plugins (discovery/context/critic) | **NO** | `bundle.pluginArtifacts` is read only to hash context inputs (`runtime/src/session.ts:272`). Nothing in domain, runtime or worker references the broker or `EXPUNGE_SANDBOX_BROKER_URL`. The runner package (`packages/plugin-sandbox`) is lost. At HEAD only the broker, proxy and netguard remain (`infra/opendots/`). |

### 2.6 Atlas, Search/Vector, change streams

- RBAC manifests exist (`mongo/src/roles.ts:25-40`). Local RBAC proof exists (`rbac.integration.test.ts` on the local
  auth set). There is no Atlas Admin API applier. BLOCKED: least-privilege URIs and Atlas admin rights.
- Search/Vector: no `$search`, `$vectorSearch` or `createSearchIndex` anywhere. `lessonRecall.mode: 'hybrid'` has no
  consumer. NOT_STARTED (the feature matrix says so honestly).
- Change streams: `ProjectionStreamConsumer` (`mongo/src/events.ts:220-250`) is constructed only in
  `packages/mongo/test/integration.test.ts`. The operator reads by polling event pages. The library is verified, but no
  production caller uses it.

### 2.7 Privacy purge and erasure runners

- `RetractionRunner` (`privacy/src/retract.ts:220`) and `ErasureService` (`erasure.ts:92`) are libraries with no process
  and no importer.
- Mongo implementations exist for `EligibilityStore`, `ErasureStore` and `RunObserver` (`privacy/src/mongo.ts`), plus
  the PKT-62 repositories (`RawArtifactRepository`, `SubjectTokenRepository`, `LessonRepository`,
  `ErasureSuppressionRepository` in `mongo/src/privacy-stores.ts`). There is no adapter for `ProvenancePort`,
  `ArtifactCatalog`, `ContentPurger`, `RegenerationQueue`, `RetentionBoundaryStore` or the privacy `ProjectionSink`
  (`privacy/src/ports.ts:16-188`).
- Live Raindrop deletion is BLOCKED: it needs keys and `EXPUNGE_ALLOW_LIVE_ERASURE=1` from the human
  (`privacy/test/erasure.live.test.ts`).

### 2.8 Production engineering

| Item | State |
|---|---|
| CI | No root `.github/`. The only workflow is upstream OpenDots `apps/operator/.github/workflows/ci.yml`, which GitHub does not run from a subdirectory. |
| Images | `apps/operator/Dockerfile` uses `node:24-bookworm-slim` by tag with no digest, and its build stage runs `npm ci` with scripts. It does run as `USER node`. There is no worker, observer or domain image at HEAD (`infra/services/` is untracked in-flight work and was not reviewed for acceptance). |
| TLS / auth / origins | The operator requires `OWNER_TOKEN` for Expunge routes (`operator/src/server/expunge/routes.ts:179`). Internal HTTP is plain. TLS is not configured. |
| Monitoring | Worker `/healthz` and `/readyz` (`worker/src/wake.ts:116-117`). Nothing else. |
| Backup/restore | Not implemented (no mongodump or restore drill). |
| Runbooks | None at HEAD. |

## 3. Claims that rest on lost code, and overclaims

| # | Document : row | Claim | Reality at HEAD |
|---|---|---|---|
| O1 | `docs/FEATURE-MATRIX.md` row 17 | "IMPLEMENTED; gate/deployment HELD" with DA-8 closures | No `packages/gate` or `packages/deployment`. Every DA-8 "CLOSED" disposition was made against lost bytes and does not carry over. State is NOT_STARTED (lost), with the storage half at TEST-ONLY. |
| O2 | FEATURE-MATRIX row 18 | Hider "LOCALLY_VERIFIED on the FAKE sim (PKT-42)" | No Hider code exists. |
| O3 | FEATURE-MATRIX row 19 and `PREREGISTRATION.md:80,95` | meta "IMPLEMENTED scaffold, LOCALLY_VERIFIED on FAKE (PKT-43)"; resource plan and `summarizeMeta`/`signTestP` implemented in `packages/meta-evolution/...` | The package does not exist. The preregistration cites files that cannot be run. |
| O4 | FEATURE-MATRIX row 12 | "sandboxed plugin compile/execute/typed output ... IMPLEMENTED, live-probed locally (PKT-48)" | `packages/plugin-sandbox` is lost. Only the broker (PKT-50) and proxy remain, and there is no gateway call site. |
| O5 | FEATURE-MATRIX row 14 | HITL "backend half at HEAD" | The decision route is 501 and no domain service process exists. |
| O6 | `WHAT_IS_REAL.md` row "A fixed model's harness evolves ..." | "Loop closes with a simulated worker", citing gate report `gate_d751...`, promotion `99c7ce6f -> a7eb07ed` and `packages/deployment/scripts/c3-evidence.ts` exit 0 | The script and its packages are gone. Nothing at HEAD reproduces it. The header still says "HEAD e2e1db1". |
| O7 | FEATURE-MATRIX row 21 | reliability LOCALLY_VERIFIED | Lead's live lane: 8 E1 failures (HarnessNotDeployed regression). My fast lane: 3 netguard failures. |
| O8 | FEATURE-MATRIX row 16 / WHAT_IS_REAL evolution row | "real-provider proposal awaits credentials" | It awaits **code** as well: no `StructuredClient` implementation and no proposer process. |
| O9 | FEATURE-MATRIX row 13 | "PKT-58 adds them. Until then no real job is shown" | PKT-58 has landed. No real job is shown anyway, because nothing launches the domain service. The stated condition is wrong. |
| O10 | FEATURE-MATRIX row 24 | continuity LOCALLY_VERIFIED | The real machine transfer lost six uncommitted packages. Checkpoint packs are in ignored `.expunge/` and did not travel. The section-20 "transferred workspace" case failed in practice. |
| O11 | FEATURE-MATRIX row 6 | change-stream projection LOCALLY_VERIFIED | True for the library, but it has no production consumer (§2.6). It should be labelled so. |
| O12 | `PRODUCTION-READINESS.md` (whole file) | "HEAD: UNBORN"; PASS rows from 10:xx | Entirely stale. Its own rule ("never states PASS without a VERIFICATION.md entry" on the current HEAD) is broken. |
| O13 | FEATURE-MATRIX header and WHAT_IS_REAL Atlas rows | "root `.env` is absent" | Stale: a `.env` with an Atlas setup URI now exists (§1). This understates what is available, but it is still wrong. |

`WHAT_IS_REAL.md`'s last row ("Hider, meta-improver, privacy lineage ... briefs only ... No") is stale in the other
direction for privacy (PKT-34 and PKT-62 landed as libraries). Its "No" for Hider and meta is now the correct state, and
it contradicts FEATURE-MATRIX rows 18 and 19.

## 4. Findings by confidence

### DEMONSTRATED (by reading at HEAD, or by a test or command)

- **D1** No production entrypoint for the domain service, so the projection, preview, submit, cancel, artifact and
  approval routes are reachable only from tests (§2.3).
- **D2** The approval decision, proposals and threads routes answer 501 (`handler.ts:181-185`). The operator HITL path
  ends there.
- **D3** The evolver, privacy and grader packages have zero production importers. `StructuredClient` has no
  implementation. `createStructuredEvolverModel` is never called.
- **D4** Promotion, rollback, grant issue, `DeploymentRepository.initialize`, `ScopeRepository.insert`,
  `WorldRepository.create` and every campaign, candidate and world-split repository have no production caller. A
  fresh install cannot create its first cleanup job.
- **D5** The evidence process entry is always BLOCKED (`observer/src/main.ts:16` passes `{}`), although
  `ErasureSuppressionRepository` exists. Even with every Raindrop key set, worker outbox intents would never be
  dispatched.
- **D6** Of ten Mongo principals, only `domain_executor`, `observer` (always blocked) and `setup` back a process.
- **D7** The data model hard-requires the Expunge envelope: top-level `tenantId`/`env`/`worldId`, `_rev`, fields under
  `data.*`, one `expunge_world` database and at most 16 collections (§2.1). Native owner adapters are impossible
  without changing the model.
- **D8** External-writer consistency rests on `_rev` alone (`effects.ts:227-234`).
- **D9** `restrict` and `tombstone` write the Expunge-invented `access` and `lifecycle` fields (`scope.ts:416-430`).
  On owner data these are semantically void unless the owner application reads them.
- **D10** DG1 shared-parent over-deletion, pinned by the KNOWN GAP test (`identity.integration.test.ts:167`). It
  blocks any real-data run.
- **D11** The committed `MongoEpisodeJobHost` creates jobs and writes `artifact_eligibility: permitted` as `setup`
  (`apps/worker/src/episode-host.ts:42-76`). This is the CH-1 pattern from PKT-47 review, surviving in committed code.
  It contradicts PROJECT-STATE decision 14 and bypasses `createCampaignJob`. A rebuilt campaign host must not reuse it
  as is.
- **D12** The plugin surface is hash-only (§2.5).
- **D13** Context-surface fields `lessonRecall`, `maxContextTokens`, `evidenceFormat` and `sourceEligibilityPolicyHash`
  have no runtime consumer. A mutation to them is a no-op on execution that the compiler's no-op check would not catch,
  because they are valid schema fields. LIKELY: worth a regression test.
- **D14** No Search/Vector code.
- **D15** No root CI. The operator image is pinned by tag only. No backend images, TLS, backup/restore or runbooks at
  HEAD.
- **D16** The fast lane is not hermetic: `netguard.live.test.ts` runs when a container of the default name exists, and
  fails 3 tests now (my run, exit 1).

### LIKELY

- **L1** The worker serves exactly one scope (`dispatch.ts:404-411`), while campaign instances use per-instance scopes
  (PKT-47 review). A rebuilt campaign host needs either a worker per instance scope or a campaign mode bound to the
  run. The production worker as configured cannot run campaign episodes.
- **L2** Fresh paired admission needs separately reset worlds (spec section 10). Destructive effects on authentic
  records cannot be reset. Real-data admission therefore needs owner-authorized snapshot copies of authentic cases in
  isolated worlds. How copies are made, held and retained is a real-data design decision that only the absent spec (or
  the human) can settle. BLOCKED (spec). Building "real data" admission on the live owner source would be destructive.
- **L3** Rebuilding gate and deployment from DA-8 prose and the C3 brief: those closures bound to bytes that no longer
  exist. The rebuild needs a fresh review, including D8-3, D8-4, D8-6, D8-16 and D8-18. "Already closed" must not be
  copied forward.
- **L4** The domain readiness response hard-codes `evidence: { configured: false, ... }` (`handler.ts:139`), so the
  operator's evidence readiness can never reflect a real evidence path.

### SPECULATIVE

- **S1** Worker Raindrop SDK episodes (`observability/src/episode.ts:117-120`) bypass the dispatcher's export
  suppression. Telemetry user ids are job-granular (`worker/src/telemetry.ts:103-115`), so exposure is limited to a job
  resumed after an erasure request for that job's user id.
- **S2** The Atlas cluster in `.env` may not be the invited Sandbox. Running `setup:mongo` against it before
  confirmation could create Expunge databases on an unauthorized cluster.

## 5. BLOCKED versus locally unblocked

**BLOCKED (exact missing input):**

| Missing | Blocks |
|---|---|
| `OPENAI_API_KEY` (provider already `openai`) and `EXPUNGE_MODEL_ID`, plus a spend budget | live worker episode, real evolver/Hider/improver calls, every campaign |
| `RAINDROP_API_KEY`, `RAINDROP_QUERY_API_KEY`, `RAINDROP_PROJECT_ID`, `RAINDROP_ORGANIZATION_ID` | ingest, Query readback, evidence-linked mutation from real evidence |
| `EXPUNGE_ALLOW_LIVE_ERASURE=1` (human), on top of the Raindrop keys | live provider deletion |
| Nine `MONGODB_<PRINCIPAL>_URI` values, after Atlas custom roles and users are created with Atlas admin rights | Atlas least-privilege RBAC proof and every principal-separated process on Atlas |
| Confirmation that the `.env` Atlas cluster is the invited Hackathon Sandbox; its Search/Vector availability | any Atlas write; hybrid retrieval |
| `CPK_INTELLIGENCE_API_KEY` | live operator chat turn and the HITL card in a real conversation |
| `EXPUNGE-REAL-BUILD-SPEC.txt`, `EXPUNGE-DOTS-PROVISIONING-TASK.txt` | real-data protocol amendment and freeze, source provisioning details, snapshot/copy policy (L2) |
| Authorized owner data and rights | source registration on real records, authentic Hider cases, the 360-episode real-data protocol |
| Deployment target and hostname authorization | production TLS and deployment |

**Unblocked now, ranked by value toward the loop** (evidence -> mutation -> fresh admission -> grant/promotion -> new
run -> receipt -> rollback/privacy). Each item can be built and verified on local replica sets, with labeled
deterministic fakes only for protocol tests, then switched to live once its BLOCKED input arrives.

1. **Fix DG1/PKT-16b (reference ownership).** Every loop iteration includes a cleanup, and on real data the current
   discovery deletes records of non-subjects (D10). Safety precondition for everything below.
2. **Domain service process plus bootstrap CLI.** A `main` that runs `listenDomainService` with
   `serviceConfigFromEnv`, plus an idempotent setup/fixture-builder command that installs a registry, binds a world and
   calls `DeploymentRepository.initialize` for W0 (D1, D4). Without it, production can create no job, show no job and
   reach no receipt.
3. **Rebuild `packages/gate`** on the committed storage (gate collections, campaign permit, `createCampaignJob`, world
   splits, campaign artifacts) and the real `WorkerEpisodeRunner`. Use the grader principal only; fix D11 and L1. Run
   protocol tests with a labeled FAKE model and fresh review per L3.
4. **Rebuild promotion and approval as processes.** Approval issuer plus promoter processes; implement `GET proposals`
   and `POST proposals/:id/decision` (currently 501) on `ApprovalRepository.issue` and `DeploymentRepository.promote`
   and `rollback`, so the operator HITL path reaches a committed grant (D2).
5. **Real evolver provider adapter plus proposer process.** A `StructuredClient` (OpenAI structured outputs, matching
   the worker's provider) and a proposer that reads stored `EvidenceBundle`s and persists through `CandidateRepository`
   (D3). Code and fake-transport tests now; live once keys exist.
6. **Unblock the evidence process wiring.** Feed `ErasureSuppressionRepository` and a privacy-controller leak guard into
   `observer/src/main.ts` (D5). Test against the labeled fake Raindrop. Otherwise keys alone deliver nothing.
7. **Fix the E1 regression and make netguard opt-in.** Restores green fast and live lanes (D16, O7) so the verifier's
   gates mean something.
8. **Owner-source data model.** Register external collections and databases without the `data.*`/`worldId` envelope.
   Map the owner's own identity and version fields. Replace `_rev`-only CAS with preimage-hash comparison (or an
   owner-declared version field) and a readback after the effect. Express `restrict`/`tombstone` as owner-declared
   effects (D7, D8, D9). The generic mechanism can proceed locally; exact requirements are BLOCKED (spec).
9. **Privacy controller process.** Wire `RetractionRunner` and `ErasureService` to Mongo adapters for the missing ports
   (`ProvenancePort`, `ArtifactCatalog`, `ContentPurger`, `RegenerationQueue`, `RetentionBoundaryStore`), with run
   cancellation through `MongoRunObserver`. Provide a purge process with a local proof (§2.7).
10. **Rebuild the campaign host** as a durable, resumable process (L1, D11), keeping held trials as rows.
11. **Plugin execution.** Rebuild the sandbox runner and add a gateway call site for the discovery, context and critic
    slots through the existing broker (D12). Until then the fifth surface is decorative.
12. **Context surface consumers.** Exact structural lesson retrieval for `lessonRecall` with an authoritative reread,
    plus `maxContextTokens` and `evidenceFormat`. Add a compiler or test guard so a mutation of an unconsumed field
    cannot pass as a change (D13).
13. **Production packaging at HEAD.** Root CI (lint, type, unit, protocol on a service container, operator build),
    digest-pinned non-root images for worker, observer and domain (review the in-flight `infra/services`), TLS and
    origin configuration, and a mongodump/restore-plus-reconciliation drill on a local replica set, with runbooks (D15).
14. **Truth pass on the delivery documents.** Fix O1 to O13: downgrade lost-code rows to NOT_STARTED (lost), strip
    meta-evolution references from PREREGISTRATION, regenerate PRODUCTION-READINESS from current evidence, and record
    the `.env` facts.
15. **Atlas setup probe (owner: mongodb-authority).** After the human confirms the cluster (S2), run the read-only
    `probe:mongo` with the setup principal and record topology, version, transactions and change-stream support. Atlas
    role provisioning for the nine principals remains a human step.

Outside the top 15, and BLOCKED for the protocol though not for code: Hider rebuilt as an authentic-case selector that
can only choose from registered, owner-authorized records and quarantines when there are too few; the meta-improver
with I0/I1, noise and no-data controls. Neither can produce a scientific row until the real-data protocol is amended
and frozen, cases are authorized and budget exists.
