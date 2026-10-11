# DA-6: observability and observer evidence review (devils-advocate)

Reviewer: devils-advocate, effective model `claude-opus-5-5`. Date 2026-10-11. This is a reading-based review of
`packages/observability` and `packages/observer` (working tree, frozen as packet C1a). I wrote negative-test
specifications only: no exploit scripts and no product edits. Findings go to the coordinator only.

Base: HEAD f17fd61 at the time of reading.

Read-only command run:
`env -u MONGODB_TEST_URI -u RAINDROP_API_KEY -u RAINDROP_QUERY_API_KEY -u RAINDROP_PROJECT_ID npx vitest run packages/observability packages/observer`
-> exit 0 (9 files passed, 2 skipped; 82 tests passed, 14 skipped: the replica-set and live-Raindrop lanes).

## 1. Files reviewed (sha256 prefix)

```
a6ac708dc8eb0318 observability/package.json      f7577346c87b0b98 observability/src/carrier.ts
dd53019c3c234985 observability/src/config.ts     ce29b7399076a4b3 observability/src/diagnostics.ts
dde15829be2f950e observability/src/episode.ts    abd000c5eef46052 observability/src/index.ts
d41d3dfecab280e0 observability/src/ingest.ts     d793aa62d99811a8 observability/src/outbox.ts
8981fb1cc1dcd51c observability/src/sanitize.ts   4f1b88ccdf40acc0 observability/src/tools.ts
d3b52f93add35de3 observability/src/tracing.ts    0979614a2e595522 observability/test/fake-raindrop.ts
70ad6bafca8f4c47 observer/package.json           61b3cec553ad036e observer/src/bundle.ts
6c88db31aeac4f18 observer/src/evidence.ts        981f4c9c97198a1e observer/src/index.ts
98388a1dc06a8e96 observer/src/mcp.ts             59da1edf4bbe222c observer/src/outbox-dispatcher.ts
7522ad5e882c63cc observer/src/query-client.ts    d62b28fc5d0b4acd observer/src/scan.ts
68ad9949e52dd4c0 observer/test/raindrop-live.test.ts   720f73a18ebaa0d9 observer/test/outbox-dispatcher.test.ts
e7de37594afd0563 observer/test/bundle.test.ts    be520e90d7fa5a24 observer/test/scan.test.ts
```

I also read `apps/worker/src/telemetry.ts` and `apps/worker/src/dispatch.ts` (`finalize`, `recordEpisode`) for the
episode path.

## 2. Findings, ranked (each with the negative test the owner should add)

### HIGH

**O1. The held-out and subject guard can be bypassed by renaming a key or putting the literal in a key.** Owner:
observer (`bundle.ts`).
- `assertNoLeak` (`bundle.ts:93-101`) refuses a key only if its lower-cased form is *exactly* one of
  `HELD_OUT_KEYS`. So `expectedState`, `expected_poststate`, `manifestHash`, `seeds`, `held_out`, `oracle_targets`
  and `groundTruthIds` all pass.
- It checks forbidden literals only in string *values*, by substring. A subject literal used as an object **key**
  (`{ "syn_subject_…": true }`) passes. So do base64, hex or URL-encoded forms, a literal split across two array
  elements, and Unicode look-alikes or zero-width characters.
- `forbiddenLiterals` is optional and defaults to `[]` (`BundleInput`, `assembleEvidenceBundle`). A caller that
  omits it gets no subject check at all.

Negative tests (`packages/observer/test/bundle.test.ts`). Each must throw `BundleError`:
1. Diagnostics `{ expectedState: [...] }`, `{ expected_poststate: ... }` and `{ manifestHash: 'x' }` ->
   `HeldOutLeak`.
2. Failure witness `{ [subjectLiteral]: true }` -> `SubjectLiteral`.
3. Diagnostics containing `base64(subjectLiteral)`, `hex(subjectLiteral)`, `encodeURIComponent(literal)`, and
   `['syn_subj', 'ect_…']` -> `SubjectLiteral`.
4. `assembleEvidenceBundle` without `forbiddenLiterals` for a worker bundle -> `MissingForbiddenLiterals`.

Minimal semantic check that closes the common cases:
1. Normalise every key: NFKC, lower-case, strip `[^a-z0-9]`. Refuse it when it contains a held-out stem (`expect`,
   `manifest`, `seed`, `heldout`, `holdout`, `oracle`, `answer`, `groundtruth`, `poststate`, `preservation`).
2. Apply the forbidden-literal test to keys as well as values, after the same normalisation.
3. Before matching, also test each string's decodings when they decode to printable text (base64, hex,
   percent-encoding).
4. Have the grader supply a salted-hash set of the world's private target IDs and identity tokens. Refuse a bundle
   if the salted hash of any string, or of any identifier-shaped token inside it, is in the set. This catches
   values whatever key they sit under and never puts the secret itself into the observer.

**O2. Remote event properties are stored raw, so the proposer can read them outside any bundle check.** Owner:
observer (`evidence.ts`) and mongodb-authority (roles).
- `observeEvent` keeps `event.properties` (minus `$context`), `featureFlags`, `userId`, `convoId`, signal names,
  tool-call names and span names as received (`evidence.ts:86-115`).
- `MongoEvidenceStore.put` inserts them with no sanitizer or literal check (`evidence.ts:210-227`).
  `assertNoLeak(observation.event.properties)` runs only later, at bundle time (`bundle.ts:141`), and its result is
  not stored.
- The role manifest gives the proposer FIND on `evidence` (DA-1 roles), so a subject literal in any remote property
  reaches a proposer-readable row. That includes properties written by any holder of the write key, or added by
  the vendor.

Negative test (`packages/observer/test/mongo.integration.test.ts`): `put` an observation whose properties contain a
forbidden literal, or a held-out key. Expect `put` to refuse with `SubjectLiteral`/`HeldOutLeak`, or to store
`properties` only in sanitized form (`sanitizeValue` under the episode policy). The proposer must have no read path
to unsanitized rows.

### MEDIUM

**O3. A crash between send and `ingest_accepted` re-sends a signal with no idempotency key.** Owner: observer
(`outbox-dispatcher.ts`).
- `runOnce` advances `sdk_enqueued`, sends, then advances `ingest_accepted` (`:131-140`).
- If the process crashes, or the lease expires, after the 2xx but before that advance, the next claim sends the
  same signal again. `IngestSignal` carries no dedupe ID, and `specificGaps` checks only that a signal of that name
  is present, not how many there are.
- A vendor-side count (Issues, signal rates) can therefore double count. The local evidence will not show it.

Negative test (`outbox-dispatcher.test.ts`, fake server): inject a crash after the transport resolves 204 and before
`advance('ingest_accepted')`, then run `runOnce` again. Expect either one `signals/track` request (the dispatcher
first reads back by event and signal name and skips the send if the signal is visible), or an idempotency property
(`dedupe_key = operationId`) that consumers count distinct by.

**O4. Delivery-provenance labels stop at the outbox row.** Owner: observer, with B3 for the UI.
- The `sdk_event` states are honestly labelled `worker-attested-not-observed` and `inferred-from-query-visible`
  (`outbox-dispatcher.ts:151-161`). Those strings appear nowhere else in `packages/` or `apps/` (grep).
- `EvidenceObservation`, `EvidenceReference` and `EvidenceBundle` carry no delivery state. A bundle, or a UI
  projection built from it, cannot tell an observed ingest from an attested one.

Negative test: a bundle assembled from an `sdk_event` observation must carry
`sources[i].delivery = { sdkEnqueued: 'worker_attested', ingestAccepted: 'inferred' }`, or a separate
`deliveryProvenance` field. A projection event for evidence readiness must include the same labels.

**O5. The wrong-incident control can exceed the budget and need not be disjoint.** Owner: observer (`bundle.ts`),
cross-check with evolution.
- `wrongIncidentControl` trims only `tools`, `diagnostics` and `failureWitnesses` (`bundle.ts:197-204`).
  `sources` and `modelOutput` from the other incident are never trimmed. A control built from an incident with more
  sources or a longer output hash text ends **over** the trace-informed budget, and the loop stops because the
  trimmable lists are empty.
- Disjointness is checked only as `other.binding.runId !== bundle.binding.runId`. Another run of the same job, or
  another attempt of the same incident, passes, and overlapping source IDs are not checked.
- The evolution package's own wrong-incident arm (`evidence.ts` `buildEvidencePacket`) selects by `evidenceId`
  only. That is a second, different selection rule for the same control.

Negative tests:
1. A control built from an `other` with ten sources and one tool must have `bundleBudget(control) <=
   bundleBudget(bundle)`, or throw `ControlOverBudget`.
2. An `other` with the same `jobId` (different run), or any overlapping `externalEventId`/`externalSignalIds`,
   throws `InvalidSource`.
3. One shared selection function serves both packages.

### LOW

**O6. Unsanitized paths into telemetry exist by contract comment, not by check.**
- `Episode.begin` sends `context.input` raw as the interaction input and `telemetryUserId` raw (`episode.ts:76-86`).
  "Already-sanitized" and "never a subject handle" are comments, not checks.
- `dispatchSubagent` forwards `options.input` unsanitized (`carrier.ts:26-30`).
- `telemetryPayloadSchema` admits `event.output` and `event.input` up to 8192 characters, and string properties up
  to 256, without sanitization (`outbox.ts:37-49`). Only the two signal builders sanitize.

Negative tests: `Episode.begin` with an `input` containing a forbidden literal, `dispatchSubagent` with such an
`input`, and an `event` intent with such an `output` must each be redacted or refused before any SDK or HTTP call.
The fake server's recorded bodies must not contain the literal.

**O7. Diagnostic free text is model narrative.** `sanitizeFreeText` passes up to 200 characters of model text
unless a caller-supplied literal matches (`sanitize.ts:146-149`, `diagnostics.ts:42`). With the default policy
(`forbiddenLiterals: []`) nothing is removed, and that text can enter `EvidenceBundle.diagnostics`. This is
legitimate as an `agent_self_report`. Two tests should hold:
1. The worker's `Episode` refuses to start with an empty forbidden list.
2. Diagnostics reach a bundle only on the train split, tagged `origin: agent_self_report`.

**O8. "Committed facts" read with the default read concern.** Episode status comes from the finalize result or the
re-read stored job (`dispatch.ts` `finalizeState`, `recordEpisode`). A `succeeded` read at read concern `local`
during a failover can later be rolled back. Ambiguous commits already map to `aborted` (under-claiming, which is
safe). Negative test, or a code change: read the stored terminal status and the receipt with read concern
`majority` before reporting `succeeded`.

**O9. Vendor semantics are tested only against a self-written fake.** Pagination, the 1000-span trace cap, the
signal catalog, `204` semantics and signal duplication are encoded from documentation, and exercised only against
`fake-raindrop.ts`, which shares the author's assumptions. The docs are honest: WHAT_IS_REAL says nothing has
reached Raindrop, VERIFICATION marks it BLOCKED, and the live suite fails by name under
`EXPUNGE_REQUIRE_LIVE_TESTS=1`. Required before any live claim: a contract probe that records actual responses for
each assumption, signal duplication included.

## 3. Answers to the coordinator's questions

- **Can narrative or a subject literal reach the evidence store or a bundle?**
  - Store: yes, via raw remote properties (O2).
  - Bundle: model narrative reaches `diagnostics` as free text checked only by caller literals (O7). Subject
    literals pass under a key, encoded, split, or when no literal list is given (O1).
  - Span attributes: tools set sanitized input and output with `traceContent: false` (`tools.ts`), and the model
    spans have content capture off (`episode.ts:108-120`).
  - MCP capture stores only the vendor's tool schemas (`mcp.ts`), no data.
- **Is the held-out guard bypassable by encoding or rename?** Yes (O1). The minimal semantic check is given there.
- **Do outbox states claim more than was observed?** Within the outbox, no. Each state is advanced only on its own
  evidence, incomplete visibility is HELD and then dead-lettered, and `evidence_ready` is written in the same
  transaction as the evidence row. The labels are not carried into the bundle or UI (O4).
- **Can two observers or a crashed dispatcher double count?**
  - Locally, no: the outbox claim is fenced, the scan cursor is a revision CAS, and evidence revisions are deduped
    by content hash.
  - At the vendor, yes: a crash after send re-sends the signal (O3).
  - The evidence `_id` omits the scope (`raindrop:project:event:revision`), so the same remote event observed under
    two scopes would collide and stall. That is low likelihood, since event IDs are per job.
- **Can an uncommitted or rolled-back effect be reported as committed?** The outbox intent commits with the domain
  outcome (`enqueueTelemetry` with the same session). The terminal episode event is sent after finalize, and only
  committed results map to `succeeded`; `unfinalized` maps to `aborted`. Residual: the read concern (O8).
- **Are the controls at equal or lower budget and disjoint?** Score-only, yes (a subset of the trace bundle).
  Wrong-incident, no on both counts (O5).
- **Is anything claimed live that was tested only against the fake?** Not in the status documents, which are
  honest. The code's vendor assumptions are unverified live (O9).
