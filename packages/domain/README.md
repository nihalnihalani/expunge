# @expunge/domain

The trusted domain gateway. A worker run reaches the owner's world only through nine typed tools. Each call goes
through one pipeline, in OpenBot's order: resolve the job and its world from stored rows, decide under the owner floor,
the bundle's grants, tool prerequisites and compiled guardrails, write the decision to the ledger, act, record the
outcome. The model sends a tool name and a small strict argument object. It never sends a connection string, a
collection name, a field path outside the registry, a world id or an effect kind.

This package is local, replica-set-verified code. Nothing here is evidence about Atlas privileges (see `docs/MONGO.md`).

## Layout

| Path | What it is |
|---|---|
| `src/gateway.ts` | `JobGateway`: argument validation, `prepare`, `decide`, ledger write, action, outcome, refusal mapping. `TOOL_SPECS` lists the nine tools. |
| `src/provider.ts` | `createDomainToolProvider(env)`: a `ToolProvider` for `@expunge/runtime`. |
| `src/env.ts` | `createDomainEnv(service, { floors })`: every repository the gateway touches, built from one `domain_executor` client (or `setup` for local scripts). Any other principal is refused. |
| `src/context.ts` | `RunContext`: the run as read from the stored job; the world capability and the lease-fenced step store. |
| `src/controls.ts`, `workflow.ts`, `budget.ts` | Durable per-job workflow position and budgets (gateway-controls; DA-5 DG3, DG4, DG6). |
| `src/store.ts` | Insert-only step log (`job_subjects`, `domain_steps`, `preview_plans`, `verification_sweeps`, `diagnostics`). |
| `src/tools/*` | One file per tool. |
| `src/closure.ts`, `sweep.ts`, `edge-*.ts` | The subject's reach under the owner's widest policy, the registered-scope sweep, derived identity edges. |
| `src/service/*` | The operator-facing HTTP service (previews, submit, cancel, worlds). |

## The nine tools

`inspect_scope`, `resolve_subject`, `discover_references`, `preview_cleanup`, `apply_cleanup_batch`,
`verify_registered_scope`, `complete_cleanup`, `inspect_harness`, `report_diagnostic` (ids frozen in
`@expunge/baselines`, `WORKER_TOOL_IDS`).

Properties the tests pin:

- **Authority comes from stored rows.** The world capability is minted from the stored job (`JobRepository.worldKey`).
  The pinned bundle must hash to the stored `binding.harnessHash` (`BundleBindingMismatch`). The floor is the one the
  bundle names among the floors the process knows; there is no default (`AuthorityFloorUnknown`).
- **Every call is decided and recorded before it acts.** A deny becomes `ToolRefusal('PolicyDenied')` after the ledger
  row and the `tool_decided` projection event. An ask records the decision and stops the run with a wait. Success is
  never fabricated.
- **Live revocation.** The authorization revision is re-read on every call. Effects re-check it, and the owner floor,
  inside the effect transaction. A deleted or bumped authority row refuses with `AuthorityRevoked` and cancels the job.
- **One logical effect once.** The effect key is `hash(jobId, planHash, step, batchOrdinal)`. The args digest binds the
  target set, the effect kind and the record versions the plan saw. Same key, same digest: the saved receipt. Same key,
  different digest: `IdempotencyConflict`.
- **Lease-fenced control writes (DG5).** Every step, plan, sweep and diagnostic is inserted in one transaction with a
  check of the live lease, so a session that lost the job cannot add rows the new holder would consume.
- **Workflow and budgets are enforced (DG3, DG4).** A call must follow an admitted edge of the bundle's workflow graph
  from where the last advancing call left the run, and total calls, scanned documents and changed documents are
  counted per job across sessions and plans.
- **Overlapping calls are serialised.** Overlapping tool calls of one lease holder (for example a tool abandoned at
  the runtime phase bound that keeps running) are judged from the same settled workflow position, so a node can repeat
  without a self edge for that outcome. The repeat is bounded by the visit each call reserves when it begins, by
  `limits.toolCalls`, and by the tool's own guards (one commit per effect key, batches in order). Controls serialise
  their reads and rows in one fenced transaction (`DomainStore.appendStepAfter`).
- **Completion is built from a verification (`complete_cleanup`).** The receipt comes from a valid sweep of every
  registered collection at a stable world revision, measured against the subject's identity and the owner-policy
  reach recorded at resolution. A truncated reach refuses completion (`ClosureIncomplete`). Model text never enters a
  receipt, an effect or a decision.
- **Identity is exact (DG1, DG2, DG7).** Only fields the owner policy names as identity seed bindings. Discovery
  follows ownership direction, so a record shared with another subject is never carried into the erase set. Typed
  references (ObjectId, int, long) are unlinked and counted like string references.
- **What the sweep calls kept is only what the policy keeps (DG10).** A record due for deletion that was merely
  restricted, or that has no eligibility metadata, is a residual, not a retained record.
- **The model sees no more structure than its context policy gives it (DG13).** `verify_registered_scope` names a field
  only when the run could see it; `inspect_scope` reports no registered totals to `selected_fields` runs.
- **Diagnostics are the run's own claim (DG12).** `report_diagnostic` stores a sanitized row labelled
  `agent_self_report`: control characters stripped, then every identity value and e-mail local part removed
  case-insensitively after Unicode compatibility folding. It reserves the operation id for the remote report but does
  not enqueue it: the Raindrop dispatch and the outbox belong to the observer lane (C1), which applies its own
  subject-literal guard before anything leaves the machine.

## Using it from the worker

```ts
import { createPrincipalService, mongoConfigFromEnv } from '@expunge/mongo';
import { DEFAULT_AUTHORITY_FLOOR } from '@expunge/governance';
import { createDomainEnv, createDomainToolProvider } from '@expunge/domain';

const service = createPrincipalService(mongoConfigFromEnv(), 'domain_executor');
const env = createDomainEnv(service, { floors: [DEFAULT_AUTHORITY_FLOOR] });
const tools = createDomainToolProvider(env); // pass as `tools` to the runtime
```

## The operator-facing service

`createDomainService({ env, config })` answers the three inbound principals configured by `serviceConfigFromEnv`
(`EXPUNGE_INTERNAL_TOKEN` read, `EXPUNGE_JOB_WRITE_TOKEN` previews/submit/cancel, `EXPUNGE_APPROVAL_TOKEN` decisions),
each bound by configuration to one owner (`OWNER_ID`) and one scope (`EXPUNGE_TENANT_ID`, `EXPUNGE_ENV`,
`EXPUNGE_SCOPE_ID`). A token works only on its own route family. Routes whose state this package does not serve yet
(job snapshots, event pages, artifacts, approvals, deployments, threads) answer 501, never a fixture. The wake token
(`EXPUNGE_WAKE_TOKEN`) is outbound only. `POST /previews` is a model-free count by collection (basis
`expert_static_discovery`) and cannot be applied. `POST /jobs` recomputes the preview, refuses a changed world (409),
and pins the job to the scope's active worker harness and the configured `EXPUNGE_WORKER_PROFILE_HASH`.

## Tests

Deterministic unit tests run anywhere. The live suites need a replica set and skip without one:

```sh
MONGODB_TEST_URI='mongodb://127.0.0.1:27018/?directConnection=true' npx vitest run packages/domain packages/governance
```

`EXPUNGE_REQUIRE_LIVE_TESTS=1` turns a missing variable into a failure instead of a skip. The scripted driver in
`test/rig.ts` is a labelled stand-in for the model that follows a bundle's workflow; its runs are not model evidence.
The service suite uses a recorded stand-in for the wake transport, labelled in its `describe`.

## Not claimed

- **Cleanup is supported ONLY on generator-built worlds until PKT-16b lands.** The reach, ownership and identity rules
  are tested on worlds built by `@expunge/fixtures` (plus a few hand-built test worlds), where no parent record is
  shared between subjects in a way the generator did not declare. Any path that would register a non-generated scope
  (a demo seed, customer-shaped data, a Hider world with a shared parent) stays blocked on PKT-16b
  (`ReferenceDeclaration.owner`, ownership-directed discovery): until then a shared parent is planned with the first
  subject and the other subject's reference becomes a residual (see the open gaps below).

- No Atlas privilege, Atlas Search or deployed-database result. Local RBAC (`MONGODB_RBAC_TEST_URI`) shows the manifest
  is enforceable by MongoDB, not that an Atlas custom role matches it.
- No external erasure: `externalErasureStatus` is `not_required` for the synthetic worlds and is not derived from a
  provider.
- Approval grants (G7) are not served here yet: a decision of `ask` waits and cannot resolve.
- **Open, recorded gaps.** (P2-1) The WorldSpec fault plan (transient failures, interrupts) is NOT injected on the
  domain path; the `partial_retry` walk is fault-free, so `retryable_error` is not driven by any domain test. It is
  scheduled after the collections packet, with the fault parameters in a stored, grader-written campaign row. (P2-2 /
  DG1) Reference edges carry no ownership direction yet, so a parent shared by two subjects is planned with the first
  one and the other subject's reference then shows up as a residual (pinned by a KNOWN GAP test); PKT-16b adds
  `ReferenceDeclaration.owner`. (Overlap) When two `apply_cleanup_batch` calls for one batch overlap, the loser returns
  the saved receipt with the right `receiptId` and exactly one effect, but reports `replayed: false`.

## Dependencies worth knowing

- **zod 4 inside this package only.** `packages/domain` declares `zod` 4.6.5 because `@expunge/vendor-openmuse`'s
  `defineTool` and `@expunge/runtime` take zod 4 schemas. It uses zod for its own tool arguments and service request bodies.
  `@expunge/contracts` is on zod 3 and no contracts schema object or `ZodError` crosses the boundary: domain imports only
  types and pure functions from contracts.
- **Discovery never turns around.** An outgoing chain and an incoming chain are walked separately, over the edges the
  subject owns in that direction (`ReferenceDeclaration.owner`: `'to'` is walked incoming from the owner, `'from'` outgoing,
  `'none'` never). A record behind an edge the subject does not own is not a target and not a binding; it is listed as
  retained with reason `not_subject_owned`. Until the generator emits owners, an undeclared owner keeps the legacy
  behaviour (see the open gaps above).
- **`Job.eventSeq`** counts the fenced projection appends for a job; the worker's fenced append increments it as a
  write-conflict guard. It is not a stream sequence: those are per job in `projection_sequences`.
