# Brief E1: failure recovery, races and containment review

Owner: **verifier** (harness and findings) with code fixes routed to the original owners. Owned paths: `tests/reliability/`, fault-injection drivers, reliability findings in VERIFICATION.md. Depends on: B2 worker (leases, wake dedupe, crash-recovery polling, graceful release), B1 gateway (decision ledger before action, receipts), C3 (approvals, promotion CAS), infra/opendots candidate sandbox (netguard, proxy token), local replica set and RBAC set.

Status: drafted 2026-10-11 11:55 UTC, not dispatched (start the harness skeleton now under V-3; full matrix after B1 and C3 land).

## Objective

ACCEPTANCE "E1": bounded effects, no stale-owner commit, durable checkpoint replay, no duplicate logical effects, recoverable projection and honest waiting states, demonstrated by killing and racing the real processes against the local replica set. Record every actual check and every limitation.

## Scope (each as a driver under tests/reliability/ with a machine-readable result row)

- Kill and restart the worker at pre-effect, post-commit and pre-projection points (SIGKILL on a marker; resume by a second worker instance); assert the effect count, receipt and projection sequence afterwards.
- Force lease expiry and takeover; the stale owner's late commit must be rejected by the lease fence (B2/A2-R).
- Interrupt a batch write mid-transaction and interrupt remote telemetry (outbox) mid-send; assert idempotent replay and no duplicate logical effect or duplicate outbox delivery.
- Expire the projection resume token (`afterSequence` beyond retention) and verify the client re-syncs from a snapshot with an honest "reconnecting" state (B3).
- Race two approvals for one grant and two promotions for one parent (real concurrency on the replica set); exactly one wins; the loser's grant stays unconsumed or is rejected by code.
- Revoke scope mid-run; the run cancels or finishes under the authority revision it started with, as the design specifies, and the decision ledger shows the fence check.
- Attempt a cross-world query and oracle (grader truth) access from a worker principal and from the candidate sandbox; both denied by RBAC or network policy; attempt DNS and direct egress from the candidate container (reuse `docs/review/repro/cand-dns.repro.sh` and `infra/opendots/verify-candidate.mjs`).

## Evidence to report

A table: driver, injection point, expected invariant, observed outcome, exit code, log excerpt path; limitations listed explicitly (for example, kill timing granularity). Any failure goes to the owner as a finding with the reproduction command; the fixed version is re-run by the verifier before the row turns green.
