# DA-7: operator client (S1/S2, with S3 files in the working tree)

Reviewer: devils-advocate (claude-opus-5-5). This review is read-only. It contains negative-test specifications and no exploit scripts. Findings go to the coordinator only.

## Snapshot

HEAD is `e2e1db1`. The operator is being built actively; these are the files as of 17:43.

SHA-256 prefixes (first 12 hex characters), all paths under `apps/operator/`:

| file                                               | sha256       |
| -------------------------------------------------- | ------------ |
| src/client/expunge/projection/reducer.ts           | 82d4baddcde1 |
| src/client/expunge/projection/controller.ts        | e39f92a182e4 |
| src/client/expunge/components/CommittedSeal.tsx    | 59bdc8ad0b7b |
| src/client/expunge/views/JobsHomeView.tsx          | 68c343d3bb6c |
| src/client/expunge/views/ReadinessView.tsx         | 1dfc7a88105a |
| src/client/expunge/TelemetryNotice.tsx             | 256d1376b99f |
| src/client/expunge/api.ts / src/client/api.ts      | d324ce6144e1 / ba9f2a9e8fd0 |
| src/client/expunge/projection/graphLayout.ts       | edfa653376f9 |
| src/client/expunge/lib/subject.ts                  | 6674da854646 |
| src/server/app.ts / src/server/index.ts            | 8bb52a1a3928 / 14cf11f61860 |
| src/server/expunge/routes.ts                       | 9f932cff844d |
| src/server/expunge/readiness.ts                    | be3bc0b38286 |
| src/server/expunge/config.ts                       | 8521251560e3 |
| src/server/expunge/domain-service.ts               | 0fa9623cb396 |
| src/server/expunge/schemas.ts                      | 967bd5c05a47 |
| src/shared/expunge.ts                              | 3d26b688f33d |
| scripts/run-from-root.mjs / package.json           | be92af435ad5 / 5b82f9593244 |
| tests/expunge-browser.e2e.mjs                      | 01de3116c528 |
| tests/browser/common.mjs / s1 / s2 / s3            | 4f90314bf4c0 / 10c80b13dfc8 / dc72ffa57a02 / 1045d600d060 |

**Checks run:**
- `cd apps/operator && npx vitest run tests/expunge-projection.test.ts tests/expunge-telemetry.test.tsx` exits 0 (26 passed).
- I did not run the browser e2e. Its default ports belong to other agents (see E1).

## Findings

### DEMONSTRATED (static, fixed by reading)

**K1 (MEDIUM): owner authentication is optional on loopback, so a human approval is anything a local process posts.**
- *Code:*
  - `index.ts:22-29` requires `OWNER_TOKEN` only when binding off loopback.
  - `app.ts:71,79-91` checks the bearer only when a token is set.
  - The Origin, Host and `sec-fetch-site` checks (app.ts:71-78) stop browsers on other sites, but not a local client that sends no Origin.
- *Exposed routes:* submit (`routes.ts:215-223`), cancel (`routes.ts:273-288`) and the approval decision (`routes.ts:323-334`).
- *How the decision is forwarded:* with the server's `EXPUNGE_APPROVAL_TOKEN` and no approver identity (`domain-service.ts:441-460`; the schema at `schemas.ts:924-928` has only `decision`, `descriptorDigest` and `toolCallId`).
- *Spec:* line 158 separates the approval issuer, but the human binding here is an optional, shared bearer.
- *Fix:* require an owner token for every non-GET `/api/expunge` route even on loopback. Return `401 owner_auth_required` and show the approve and submit writes as blocked in readiness. Forward an authenticated approver id (owner id plus session) for the approval issuer to record.
- *NT-K1:* `HOST=127.0.0.1`, no `OWNER_TOKEN`, `EXPUNGE_APPROVAL_TOKEN` set. A POST to `/api/expunge/proposals/p1/decision` with body `{"decision":"approve","descriptorDigest":"<64 hex>"}`, no Origin and no Authorization, must get 401 `owner_auth_required` and make no domain call.

**S1 (MEDIUM-LOW): `CommittedSeal`, documented as the only authority badge, is never rendered.**
- *Code:*
  - `components/CommittedSeal.tsx` has no call sites (grep across `src/client`).
  - The jobs list renders "Complete in registered scope" as a `StatusChip` (`JobsHomeView.tsx:214-226`), with no receipt id, sequence or verified world revision.
  - `ExpungeJobListItem` (`shared/expunge.ts:354-364`) does not carry those fields. The snapshot carries `receipt: {receiptId, sequence}` (`shared/expunge.ts:333`), but no client code reads it.
- *Plan claims this breaks:* `docs/ui/B3-PLAN.md:206` (only committed fields reach `CommittedSeal`) and `:575` ("Complete" never shown without scope and revision).
- *Test consequence:* the e2e checks that no seal appears (`s1.mjs:79`, `s2.mjs:139,352`) cannot fail, and nothing checks that a seal does appear.
- *Fix:* render the receipt verdict only through `CommittedSeal` with `{kind:'receipt', id, sequence}` plus "as of world revision N". Add `receiptId`, `receiptSequence` and `verifiedWorldRevision` to the list item.
- *NT-S1a:* a list item with `receiptDomainStatus:'complete_in_registered_scope'` and no `receiptId` renders no "Complete" text.
- *NT-S1b:* a succeeded job with a receipt renders exactly one `.ex-seal` with `data-source-kind="receipt"` and the revision.
- *NT-S1c:* the e2e asserts that a seal is present on the succeeded fixture job.

**T1 (LOW-MEDIUM): "telemetry off by default" is a property of the launcher, not of the operator.**
- *Code:*
  - Only `scripts/run-from-root.mjs:18` sets `DO_NOT_TRACK=1`.
  - `apps/operator` `npm run dev` and `npm start` (`package.json:11,13`) start the server without it.
  - `telemetryState` (`config.ts:24-29`) and the sender (`setup-telemetry.ts:150-163`) then report and send telemetry to telemetry.copilotkit.ai.
- *Notice:* the notice itself is truthful; it shows the server's state.
- *Claims:* `WHAT_IS_REAL.md` row 20 and `docs/ENVIRONMENT.md:17` both say it is off by default.
- *Fix:* make the server default to off unless `EXPUNGE_ALLOW_TELEMETRY=1`, in `telemetryState` and in the sender.
- *NT-T1:* start with `node dist/server/server/index.js` and neither variable set. `/api/expunge/status` returns `telemetry:'disabled'`, and an intercepted fetch to telemetry.copilotkit.ai is never called.

**E1 (MEDIUM): the e2e can pass against a build other than the one under test.**
- *Code:*
  - `tests/browser/common.mjs:19-28` defaults to `127.0.0.1:4393` and fixture `:4320`. VERIFICATION.md:405 notes these are other agents' listeners.
  - Nothing checks that the server answering was built from the tree under test.
  - `results-*.json` records no build identity.
- *Fix:*
  - expose a build id (a hash of the built client and server bundle) at `/api/expunge/status`;
  - have the runner compute the same hash from its `dist`, exit 2 on a mismatch, and record it in the results;
  - remove the default ports.
- *NT-E1:* run against a server whose `dist` is older than the source tree. The runner exits 2 with `build_mismatch` before any check runs.

**RD3 (LOW): the status route asserts constants.**
- `/api/expunge/status` returns `operator:'ready'` and `authority:'mongodb'` unconditionally (`routes.ts:155-161`), including when no domain is configured.
- *NT-RD3:* with no domain configured, `authority` is `'unconfigured'`.

### LIKELY

**R1 (MEDIUM-LOW): an older snapshot can replace a newer one.**
- The reducer decides whether a snapshot moves backwards against `lastSequence`, the event cursor, not against the current snapshot's sequence (`reducer.ts:131-151`).
- Poll reads the snapshot and the events concurrently (`controller.ts:187-190`). So a lagging snapshot read with sequence at least `lastSequence` silently rolls the aggregate state back, for example succeeded to running. A snapshot read before a newer events page gives a false "reset".
- *NT-R1:* state with snapshot seq 12 (`succeeded`) and `lastSequence` 10. Apply snapshot seq 11 (`running`). Expected: the snapshot stays at seq 12 and there is no reset notice.

**R2 (MEDIUM): the stream has no epoch, so a restore that moves forward is invisible.**
- The snapshot has only `sequence` (`shared/expunge.ts:269-275`), and events are deduplicated by sequence alone (`reducer.ts:154-157`).
- If the backend is restored and then advances past the client's cursor, the new history's events are appended to the old window. An event with the same sequence but different content is dropped silently.
- Spec line 209 requires invalidation recovery.
- *Fix:* add `streamEpoch` to the snapshot and to every event page, plus an `eventId` per event. Reset when the epoch changes, and refuse a known sequence that arrives with a different `eventId`.
- *NT-R2:* the client is at seq 5 of epoch A; the backend is at epoch B, seq 7. After one poll, `notice === 'reset'` and the window holds only epoch B's events 1 to 7.

**RD1 (LOW-MEDIUM): readiness shares one client's abort signal.**
- `routes.ts:166` passes the request signal into the shared 5 s cache (`readiness.ts:196-206`), and an `AbortError` maps to `'timeout'` (`domain-service.ts:185`).
- So when one client navigates away, every viewer sees "did not answer within 3 seconds" for 5 s.
- *NT-RD1:* the fake domain answers in 50 ms. Call `get(false, A)`, abort A at 10 ms, then call `get(false, B)`. Expected: `reachable.status === 'pass'`.

**RD2 (LOW): a plain-http domain URL is accepted for remote hosts.**
- `validOrigin` (`config.ts:31-42`) accepts `http:` for any host, so write and approval tokens can travel in cleartext.
- *NT-RD2:* `EXPUNGE_DOMAIN_URL=http://domain.example` gives `configured.reason === 'env_malformed'`. Loopback http remains allowed.

**TN1 (LOW): the telemetry notice can stay "unknown" for the whole page.**
- `TelemetryNotice.tsx:15-26` caches the first result, including `unknown` after a 401 before the owner token is entered.
- *NT-TN1:* the first call returns 401, then a token is set. The notice then shows the server state.

### SPECULATIVE

- **RD4:** evidence freshness passes when `readBackProvenAt` is in the future (`readiness.ts:157-166`).
  - *NT:* a value of now + 1 day gives `evidence_stale`, or a clock-skew fail.
- **X1:** an ObjectId subject is accepted in either letter case (`lib/subject.ts:52`). The domain hashes the raw string (`domain/src/store.ts:124`), so `ABC…` and `abc…` give two identity hashes for one record.
  - *NT:* the second submit is normalized or refused with `SubjectConflict`.
- **E2:** `chips.slice(0, 4).every(...)` (`s1.mjs:72-76`) passes on an empty list. The `rows >= 4` check guards it only loosely.
- **G1:** the "Committed path" legend (`graphLayout.ts:190`) marks an edge committed when both of its endpoints were applied. That is not a committed fact about the edge itself; it is a wording risk only.

## Answers to the brief

- **HTML rendering.**
  - The Expunge client has no `dangerouslySetInnerHTML`, `innerHTML`, `eval` or `new Function`.
  - Server text is rendered as React text, and narrative appears only in a labelled `NarrativeBlock`.
  - Routes are built with `encodeURIComponent`, and the one external link has `rel="noreferrer"`.
  - CSP `script-src 'self'` is set (`index.ts:110-111`).
  - No finding.
- **Token handling.**
  - The owner bearer is kept in `sessionStorage` (`opendots-token`, `client/api.ts:1-6`) and sent on every Expunge call.
  - The role tokens stay on the server; readiness shows names only (`config.ts:47-107`).
  - Findings: K1 and RD2.
- **Reducer invariants.**
  - Working: gaps are never skipped, and the window is bounded.
  - Missing invariants: R1 (snapshot monotonicity) and R2 (epoch).
- **Committed-seal sources.**
  - The seal component is sound but unused (S1).
  - Graph "applied" states come from the server graph artifact (`useGraph.ts:18-36`), not from client actions.
- **Telemetry notice.** It is truthful about the server state (T1, TN1). The default depends on the launcher.
- **Setup-only path.**
  - It is correct as designed.
  - The banner requires configured `fail` and backend `none` (`ReadinessView.tsx:312-313`).
  - Every domain route answers `unconfigured` without a domain (`routes.ts:138`).
  - Write credentials are listed by name.
- **Readiness truthfulness.**
  - The four checks are independent and use fixed vocabulary.
  - A fixture backend gets an app-wide banner (`ExpungeApp.tsx:54,83`).
  - Exceptions: RD1, RD3 and RD4.
- **Accessibility claims vs code.**
  - The `Dialog`/`ApprovalDialog`, `useFocusReturn` and `useInert` primitives in B3-PLAN:77,211 do not exist yet; `review/` is empty and there is no approval UI.
  - FEATURE-MATRIX row 14 says NOT_STARTED, so no false claim was found.
  - The browser scans are self-described as inputs, not WCAG claims (`common.mjs:2-5`).
- **E2E that could pass a wrong build.** E1 is the main risk. S1 and E2 are vacuous assertions.

## Footer

```
EFFECTIVE_MODEL: claude-opus-5-5
OWNED_PATHS: docs/review/DA-7-operator-client.md
CHECKS: npx vitest run tests/expunge-projection.test.ts tests/expunge-telemetry.test.tsx (apps/operator) -> exit code 0 (26 passed)
FINDINGS: demonstrated=5 likely=6 speculative=4
BLOCKED: browser e2e not run by reviewer (default ports are other agents' listeners; see E1)
STATUS: COMPLETE
```
