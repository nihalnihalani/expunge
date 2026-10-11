# VoiceOver manual checklist (human-pending)

Status: NOT RUN. No automated tool here drives VoiceOver, so no screen-reader result is claimed. Chrome-based browser checks (docs/ui/screens, tests/browser/s*.mjs) cover names, roles, focus order, Escape and focus return only; they are inputs, not a screen-reader pass.

Environment to record: macOS version, Safari version, VoiceOver on, `Verbosity` default, fixture backend labeled "Fixture backend" (`node --import tsx tests/expunge-browser.e2e.mjs` starts one; or run the operator against `tests/fixtures/run-expunge-fixture.ts`). Record build id from `/api/expunge/status`.

Limit: other screen readers (NVDA, JAWS, TalkBack) are not covered.

## A. Approval dialog (priority)
1. Open `#/expunge/jobs/job-approval/candidate`. VO+U, Headings: confirm one h1, "Approval" h2, "Candidate harness" h2.
2. Move to "Review proposal" (VO+Right). Activate (VO+Space).
3. Expect: "Review harness proposal, dialog" announced; focus on the title; reading does not announce a stale page behind it (page is inert).
4. VO+Right through the content: target, parent and child hashes (hash chips read the full value, not a truncated form), authority class "computed by the gate, not claimed", flip set table (caption "Capabilities that change", column headers Capability and Change), consequences list.
5. Tab through controls: order must be Copy buttons (if any), Decline, Refresh, Close without deciding, Approve promotion. Tab from the last control wraps to the first, never leaves the dialog.
6. Press Escape: dialog closes, nothing is sent, focus returns to "Review proposal" and VO announces it.
7. Reopen, activate Decline: expect a status announcement that the decision was sent and that the database reports the state; the word "promoted" must not be spoken.
8. Open `#/expunge/jobs/job-approval-expired/candidate` and `.../job-approval-stale/candidate` (fixture): open the dialog; expect Approve and Decline absent, the reason spoken (expired or stale), Close available.

## B. Receipt
1. `#/expunge/jobs/job-complete/receipt`: headings Verdict, What was verified, Eligible effects applied, Residual, External erasure, Model account of the run.
2. The seal reads "Committed receipt <id> event N" once; the full id is available (not only the truncated form).
3. External erasure reads "pending" and "has not yet confirmed"; never "confirmed".
4. The model narrative block is announced with its label "Model narrative, not verified" before its text.
5. `#/expunge/jobs/job-incomplete/receipt`: the verdict reads Incomplete although the narrative says everything is clean.

## C. Live workbench
1. `#/expunge/jobs/job-live`: phase stepper reads each phase with a word for its state (Done, Active, Pending), not by color.
2. Advance the fixture (`POST /__fixture/advance/job-live`): at most one polite announcement per change (phase, terminal state, approval needed); no per-event chatter.
3. Reference table: reach it from the graph section, confirm row and column headers read, and the "Reference trace" and table alternatives expose the same nodes.

## D. Readiness and new cleanup
1. `#/expunge/setup`: the four checks (configured, reachable, authorized, evidence-ready) read as separate rows with status words.
2. `#/expunge/new`: form labels, the exact-identifier hint, validation errors announced on submit (role alert), preview region announced once.

## E. Jobs list at narrow width
1. Resize to 390 CSS px (or Safari Responsive Design Mode). The stacked job blocks still read as a table: "table, N rows", column header read with each cell value.

Record per item: pass, fail or not applicable, plus the exact phrasing heard for any failure. File findings against the owning component under apps/operator/src/client/expunge/.
