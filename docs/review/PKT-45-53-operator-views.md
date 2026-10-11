# Operator views PKT-45, 46, 49, 52 and 53: authority and honesty review

Reviewer: devils-advocate (claude-opus-5-5), 2026-10-11, about 16:20Z.

**Pin.** Every hashed entry in `docs/ui/PKT-{45,46,49,52,53}-MANIFEST.txt` matches the tree: 5, 17, 16, 17 and 15 entries, 0 mismatches.

**Checks.** `cd apps/operator && npx vitest run tests/expunge-review-tool.test.tsx tests/expunge-evaluation.test.tsx tests/expunge-lineage.test.tsx tests/expunge-privacy.test.tsx tests/expunge-campaign.test.tsx` exits 0: 5 files and 34 tests passed (node 24.13.1). Static read of the view sources, the review tool and `server/expunge/projection-agent.ts`.

## Cross-cutting answers

- **Raw HTML.** There is no `dangerouslySetInnerHTML`, `innerHTML`, `insertAdjacentHTML`, `eval` or `new Function` anywhere in `src/client/expunge`. Model, plugin and provider text is rendered as React text.
- **Write paths.** None of the five packets' files call `fetch` or POST. The client's only writes are the pre-existing cancel, preview and submit routes (S3) and the approval decision (ApprovalDialog). The server has four POST routes.
- **Committed state the backend did not commit.** I found no such path.
  - Verdicts come from the stored gate report.
  - Erasure "completed" requires the provider's `completedAt`.
  - Promotions and rollbacks come from stored receipts.
  - Meta results are shown as recorded, and the view states that it computes no gain.

## Per packet

| Packet | Disposition | Basis and notes |
|---|---|---|
| PKT-45 HITL review | ACCEPT | The projection agent emits `review_expunge_proposal` itself, from committed state only: the snapshot's pending approval `proposalId`, and only when the frontend offered the tool (`ADMITTED`, projection-agent.ts:104-131). The model never calls it. The card parses a strict `{proposalId}` (shared/expunge.ts:987-989), loads the stored descriptor by id, and opens the dialog. The `respond` payload is marked `informational: true`, "not authority". The client hook and the backend allowlist share one name constant. |
| PKT-46 Evaluation | ACCEPT-WITH-NOTE | The verdict, reason codes and authority flips come from the stored report. Missing pairs are shown (`planned - recorded`). *Note (LOW):* `summarizePairs` recounts improvements and successes in the browser from the stored pair rows (EvaluationView.tsx:56-90). These are descriptive, but they can differ from the gate's stored `decision.summary` (for example `triggerGain`, which counts training pairs only). Show the stored summary where it exists, and label the browser counts "counted from recorded rows". |
| PKT-49 Lineage | ACCEPT | Versions, tested-against parents, grants and rollback receipts come from stored rows. `refusedRollbacks === undefined` says "does not report … not a statement that none happened" (LineageView.tsx:336-342). That is the right wording. |
| PKT-52 Privacy | ACCEPT | It covers all nine statuses, including `submitting` and `submission_ambiguous` (the lead's "eight" plus `unsubmitted`). An unknown status is not treated as known. `completed` without `completedAt` renders "Not shown as complete" (PrivacyView.tsx:62-120). Closure progress says "not a complete list" until it is complete. |
| PKT-53 Hider/meta | ACCEPT-WITH-NOTE | It shows no gain figure and states "It states no gain and no conclusion". Equal budgets and the W0 reset are claimed only when every row's hash matches the campaign's. *Note (LOW):* with 0 recorded rows and a recorded budget hash, it prints "Equal budgets: all 0 rows carry the campaign's budget hash", and does the same for the reset proof (CampaignView.tsx:181-193). That is literally true but reads as a claim. Show "no rows recorded yet" instead. |

**Overall:** no authority or honesty blocker. Two LOW wording notes (PKT-46, PKT-53).
