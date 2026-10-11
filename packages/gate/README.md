# @expunge/gate

Fresh paired admission (spec section 10, brief C3). Privileged evaluation service: no worker, proposer or runtime
image may import it (enforced by `test/import-boundary.test.ts`).

- `runGate` runs the exact tested parent and child on separately reset campaign worlds (instance-scoped record ids from
  a per-campaign HMAC key), under equal profile, budget and fault plan, through an `EpisodePort`.
- Everything frozen is read from the stored `campaign_freezes` row (written by the fixture builder); everything observed
  comes from the executing modules and the worker's own per-run runtime attestation. Nothing is a parameter of the call.
- One gate run per (parent, executable child projection): the claim is inserted before the first episode; attempts per
  parent are capped by an atomic conditional upsert. A hold (fake evidence, unattested runtime, harness defect, INVALID-INFRA,
  cancelled campaign, unpriced cost) decides nothing: its executed trials are kept in `gate_held_runs` and the pair may be
  taken over by a later campaign. Only admit and reject are stored in `gate_reports`, whose `_id` is derived from
  (parent, child projection) so a second report cannot exist.
- Failed, cancelled and timed-out arms are rows with no success and stay in the denominator.
- The report's `computedClass` is derived from the two stored bundles and is the only classification promotion trusts.
- `@expunge/gate/testing` holds the SCRIPTED/FAKE port. It is a stand-in for protocol tests, never evidence about the
  worker or a model. Real model-backed admission is BLOCKED until a provider key and a measured cost ceiling exist.
