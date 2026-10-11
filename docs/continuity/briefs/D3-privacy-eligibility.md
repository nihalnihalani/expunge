# Brief D3: provenance, erasure approvals and context eligibility

Owner: **runtime-raindrop** (privacy package and provider erasure adapters) with **mongodb-authority** owning the `provenance_edges`, `artifact_eligibility`, `raw_artifacts`, `subject_tokens` collections and the `privacy_controller` principal (already in `packages/mongo/src/provenance.ts` and roles). Owned paths: `packages/privacy/`. Depends on: A2-R provenance closure (`packages/mongo/src/provenance.ts`: bounded `$graphLookup`, frontier persistence, fail-closed `permitted`), B1 gateway (context inputs recorded per run), C1 observer (evidence bundles store hashes and structure only), C3 approval descriptors. Frozen interfaces: `ProvenanceEdge`, `ArtifactEligibility`, `ExternalErasureJob`, `ApprovalGrant`, `EvidenceBundle`.

Status: drafted 2026-10-11 11:55 UTC, not dispatched (dispatch after C1a lands).

## Objective

Spec section 12 and ACCEPTANCE "Source retraction" and "External erasure": register raw sources, protected telemetry mappings, structural lessons, derivation edges and scoped artifact eligibility; record every context input a run used; retraction disables future use, traverses the full affected closure, revokes or regenerates inappropriate descendants and cancels or restarts runs holding revoked content; a current source/authorization revision fence closes read-to-action races; retained bytes are scanned for subject literals; provider erasure states stay distinct and honest.

## Scope

- `packages/privacy/src/registry.ts`: register raw evidence (`raw_artifacts`), subject token mappings (`subject_tokens`, private database), structural lessons and `derived_from` edges at creation time through the owning repositories; every run records its context inputs (artifact hashes, lesson ids, source ids) in its `RunBinding`-linked record so a closure can find it.
- `packages/privacy/src/retract.ts`: retraction protocol: mark the source ineligible; run the bounded closure from `provenance.ts` (fanout, deep chains, cycles, concurrent new derivations; frontier persisted; completeness flag); until complete, `permitted` fails closed for affected retrieval and authority; revoke `artifact_eligibility` for descendants per owner policy (policyHash recorded); queue redaction/deletion or regeneration; cancel or restart active runs holding revoked content via the worker's wake/cancel path (B2); write `source_deleted` edges and permitted nonpersonal tombstones only.
- `packages/privacy/src/scan.ts`: subject-literal scan of retained artifact and lesson bytes against the subject token map (exact and normalized forms); a positive hit on an active artifact revokes it; immutability and content addressing are never an exemption; distinguish generalized structural learning (allowed, policy-recorded) from raw source retention (not allowed).
- `packages/privacy/src/erasure.ts`: `ExternalErasureJob` lifecycle for Raindrop user deletion (organization-wide scope, exact request schema from research notes, status polling, pending deadline, completion, rejection, cancellation as separate states; cancel-user DELETE is never an erasure command) and a separate boundary record for CopilotKit Intelligence conversation retention (no purge API is invented; state is "retention boundary registered", not "deleted"). Live calls BLOCKED without credentials; adapters tested against a labeled FAKE provider.
- Approval binding: an erasure that revokes a deployed artifact or expands authority consumes an `ApprovalGrant` rendered from stored rows exactly once (C3 gate primitives).

## Tests required

Retract a source used by a lesson: new runs cannot retrieve the raw content (gateway filter test); the active artifact containing forbidden material is revoked and a tombstone without personal content remains; closure over a fanout, a deep chain, a cycle and a concurrent new derivation terminates with completeness recorded and no silent truncation; an incomplete closure fails closed; a run holding revoked content is cancelled and restarted with permitted context (worker integration on the local replica set); a domain job can be `completed` while external erasure is accurately `pending` (UI/projection state); provider acknowledgment never flips to completed without the provider's completed status; the subject-literal scan catches a planted literal in a lesson and a hash-only evidence bundle passes.

## Evidence to report

Commands and exit codes; the closure traces for the four graph shapes; the revoked artifact and its tombstone; the erasure job state history against the FAKE provider; the BLOCKED line for live Raindrop deletion.

## Guards

Immutable archive is not a privacy exemption; log deletion may remove learning evidence, so provenance policy is gated before a lesson is retained; no promise of instant vendor deletion or unverified Intelligence purge.
