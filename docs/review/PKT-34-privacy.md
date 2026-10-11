# PKT-34 privacy disposition (D3 privacy and observer export suppression)

Reviewer: devils-advocate (claude-opus-5-5), 2026-10-11, 13:29Z to 13:45Z. This review is read-only.

**Pin.** The sha256 list is `pkt34-pin.txt` in the reviewer scratchpad: packages/privacy/**, `observer/src/outbox-dispatcher.ts` and `observer/test/suppression.test.ts`. Two test files changed during the review (`privacy/test/erasure.live.test.ts`, `privacy/test/mongo.integration.test.ts`); every `src` file was unchanged.

**Checks.** `npx vitest run packages/privacy packages/observer/test/suppression.test.ts` (node 24.13.1) exits 0: 6 files passed and 2 skipped; 42 tests passed and 13 skipped (the live and replica-set suites; no `MONGODB_TEST_URI` in the reviewer shell).

**Disposition: NOT ACCEPTED until P34-1 and P34-2 are fixed.** Both are small. P34-3 to P34-6 are required notes or follow-ups.

## Integration status (read this first)

`OutboxDispatcher`, `ErasureService` and `RetractionRunner` are constructed only in tests (grep across `apps` and `packages`). Nothing in the worker, operator or any service wires them. The README describes the adapters honestly as REAL or PORTS ONLY, but it never says that the suppression gate, the erasure service and the retraction runner are unwired. Add a row stating that, or the packet reads as an integrated privacy path.

## DEMONSTRATED (static)

**P34-1 (MEDIUM): `submit` can file a second organization-wide deletion.**
- `submit` refuses only when `remoteJobId` is already stored (erasure.ts:113). The provider call runs before anything is persisted (lines 114-119).
- A crash, a lost response, or `ErasureStale` from the CAS in `transition` (line 208) after the provider accepted therefore leaves `remoteJobId` null. A retry then files another org-wide job.
- Two concurrent `submit` calls do the same.
- The comment "never file a second org-wide job for the same request" holds only on the happy path. The spec says not to assume vendor deduplication.
- *Fix:* CAS a `submitting` claim, with an attempt id, onto the stored job BEFORE the provider call. On an ambiguous outcome, move to a distinct `submission_ambiguous` state that needs reconciliation and is never re-sent automatically. Do not invent an idempotency header that the provider does not document.
- *NT-1:* the provider accepts, then the store's `replace` throws once. A second `submit` makes zero further provider calls and reports ambiguous or pending, never a second job.

**P34-2 (MEDIUM): retained personal content survives a hit on an artifact that is already revoked.**
- `enforceScan` only reports a subject-literal or raw-retention hit on an artifact whose eligibility is not `permitted` (scan.ts:79-87, `already_inactive`). A revoked artifact keeps its bytes.
- In the same way, the retraction's `keep_revoked` disposition keeps the bytes for any kind the owner policy does not delete (harness and unknown kinds; retract.ts:35-43,276-279), even when the reason is `scan_SubjectLiteral`.
- Spec line 321: hashes and immutability do not justify keeping prohibited personal content. Revoked is not removed.
- *Fix:* a leak hit (SubjectLiteral, PrivateIdLeak, HeldOutLeak) forces removal of the bytes, or replacement by a non-personal tombstone, whatever the eligibility state and the owner disposition. `keep_revoked` stays valid only for non-leak reasons.
- *NT-2:* an artifact already `revoked` that contains a subject literal is purged or tombstoned by `enforceScan`, and its bytes are no longer readable by any principal.

## LIKELY

**P34-3 (MEDIUM): the suppression gate is optional and scoped narrower than the erasure.**
- `deps.suppression` is optional (outbox-dispatcher.ts:133). A dispatcher built without it sends everything.
- `suppressedUserIds(scope)` only sees erasure jobs of the dispatcher row's own ScopeKey. The provider erasure is organization-wide. If the same namespaced telemetry user id can appear in another scope's outbox, that export is not held.
- *Fix:* make `suppression` required in the production constructor, and key suppression by provider organization plus user id, not by ScopeKey. Or prove that namespaced ids cannot cross scopes.

**P34-4 (MEDIUM): the provider organization is recorded but never bound.**
- `providerOrganizationId` is stored (erasure.ts:86) but never compared with the organization of the credential that `DeletionProvider` uses. The record can say org A while the request runs against org B.
- Spec line 265 requires binding the exact provider organization.
- *Fix:* the provider adapter reports the organization its key belongs to, if the API exposes it, and `submit` refuses on a mismatch. Otherwise record `organization_unverified`.

**P34-5 (LOW-MEDIUM): progress event ids repeat after a resume.**
- `run()` always restarts from `initialState`, with step 0 (retract.ts:220). Event ids are `${retractionId}:${step}` (line 309).
- A resumed retraction therefore re-emits ids 0, 1, … with different payloads. Under the DA-7 R2 rule (a known sequence or id with different content is a conflict) that is a gap or a dropped update.
- *Fix:* persist the retraction state or the step, or include a run attempt id in the event id.

## SPECULATIVE

- **P34-6:**
  - `classifyRetention` accepts any identifier-shaped string (`[A-Za-z][A-Za-z0-9_.:/-]{0,63}`). A single-token name or a `syn_<hex>` record id is "structural", so the leak guard is the only control for those. That is acceptable if the guard holds the literals of every erased subject.
  - After a subject's domain data is erased, the guard must still be able to check retained artifacts against that subject. Confirm that `guardFor` keeps salted subject handles past erasure.

## Checked, no finding

- Retraction closure and fail-closed: the phase moves to `disposing` only on `result.complete` (retract.ts:138), and `failClosed` is true in every phase but `complete`. Denial of the reached set and of descendants whose ancestry is incomplete is in the repository's `permitted` (not re-read here).
- Erasure lifecycle:
  - `completed` requires the provider's status plus `completed_at`, else `ProviderResponseInvalid` (erasure.ts:177-178).
  - `DELETE` is used only through `cancelPendingSubject`, only while `pending`, and the data is kept.
  - `completionView.fullyErased` needs a succeeded domain job and a provider `completed`.
  - The Intelligence retention is registered only, never "deleted".
- Suppression: an unreadable list fails closed (no send, row retried), and a suppressed id is held, not dead-lettered.

## Rework re-read (2026-10-11, about 14:05Z)

Pinned on the same hash list, with the same test run (exit 0, 100 passed, 13 skipped).

| Item | Disposition | Basis |
|---|---|---|
| P34-1 | CLOSED, with gap P34-7 | There is a CAS `submitting` claim before the POST. A provider error, or failing to record the response, moves the job to `submission_ambiguous`, which is never re-sent. A claim older than 60 s becomes ambiguous (erasure.ts:152-200). |
| P34-2 | CLOSED (port level) | A leak hit purges the bytes on any eligibility state (scan.ts:86-101). Disposition purges before deciding, and `keep_revoked` becomes `delete` for leak reasons (retract.ts:281-286). The README says `ContentPurger` has no Mongo adapter yet. That is honest; it is the same blocker as the raw, subject and lesson stores. |
| P34-3 | CLOSED in the code, with blocker P34-8 | `suppression` and `providerOrganizationId` are required, and the constructor throws `SuppressionRequired` (outbox-dispatcher.ts:142). The list is keyed by provider organization across scopes (erasure.ts:263-273, mongo.ts:106-109). |
| P34-4 | CLOSED, as a configured binding | `organizationId()` comes from trusted configuration, because no documented endpoint reports it. `null` refuses (`OrganizationUnverified`), and a mismatch refuses (erasure.ts:165-167). Label it "configured, not provider-verified" wherever it is reported. |
| P34-5 | CLOSED | Event ids are `${retractionId}:${runId}:${step}` (retract.ts:333). |

**NEW, P34-7 (MEDIUM, DEMONSTRATED static): reconciling against a remote id that belongs to another deletion.**
- `reconcileSubmission(…, { remoteJobId })` applies whatever provider job the caller names (erasure.ts:215-216).
- `apply` never checks that the remote job's `user_ids` equal this request's `namespacedUserIds`. So an ambiguous request can be bound to another request's deletion job, possibly an already `completed` one, and then report `completed` for subjects that were never submitted.
- *Fix:* in `apply` (which covers `poll` too), refuse a remote job whose set of user ids differs from the request's, with `RemoteJobMismatch`. Record who supplied the id.
- *NT-7:* reconcile with the id of a completed job for other users. Expect `RemoteJobMismatch`, the status stays `submission_ambiguous`, and `completedAt` stays null.

**NEW, P34-8 (MEDIUM, DEMONSTRATED static, blocking for wiring): under RBAC, suppression holds every event.**
- Only `privacy_controller` has FIND on `external_deletions` (roles.ts:203-228).
- The outbox dispatcher runs as the observer or worker principal. Its suppression read is therefore Unauthorized under real RBAC, and by the fail-closed rule (outbox-dispatcher.ts:192-194) every `event` intent is held forever.
- That is safe, but it silently stops the Raindrop evidence path.
- *Fix:* serve the suppression list through a narrow, privacy_controller-owned read (a view or collection of `{providerOrganizationId, userId}` only) that the dispatcher's principal may FIND, or wire the dispatcher with a privacy_controller-backed `ExportSuppression`.
- *Test:* on the RBAC replica set, the dispatcher's principal reads the list, and one unsuppressed event is sent.
