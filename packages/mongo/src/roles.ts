import { WORLD_COLLECTIONS, PRIVATE_COLLECTIONS } from './setup.js';
import type { Principal } from './client.js';
export type AtlasAction = { action: string; resources: Array<{ db: string; collection: string }> };
export type AtlasRoleManifest = { roleName: string; actions: AtlasAction[]; inheritedRoles: never[] };
const DOMAIN_STEP_COLLECTIONS = [
  'job_subjects',
  'domain_steps',
  'preview_plans',
  'verification_sweeps',
  'diagnostics',
] as const;
const JOB_BINDING_WORLD_ROWS = ['world_revisions', 'world_scope_bindings'] as const;
const EXECUTOR_WORLD_WRITES = [
  'customers',
  'accounts',
  'messages',
  'events',
  'notes',
  'archives',
  'world_revisions',
  'identity_edges',
] as const;
/** Atlas Administration API custom-role bodies; apply through Atlas, never createRole on Atlas. */
export function atlasRoleManifests(
  names = { world: 'expunge_world', control: 'expunge_control', private: 'expunge_private' },
): Partial<Record<Principal, AtlasRoleManifest>> {
  const action = (verb: string, db: string, collections: readonly string[]): AtlasAction => ({
    action: verb,
    resources: collections.map((collection) => ({ db, collection })),
  });
  const worldRead = action('FIND', names.world, WORLD_COLLECTIONS);
  const control = (verb: string, collections: string[]) => action(verb, names.control, collections);
  const role = (roleName: string, actions: AtlasAction[]): AtlasRoleManifest => ({
    roleName,
    actions,
    inheritedRoles: [],
  });
  return {
    domain_executor: role('expunge_domain_executor', [
      worldRead,
      // Domain records, the revision fence and derived edges only. The registry (schema_registry) and retained
      // data (retained_invoices) are never writable by the worker principal.
      action('UPDATE', names.world, EXECUTOR_WORLD_WRITES),
      action('INSERT', names.world, ['identity_edges']),
      action('REMOVE', names.world, ['customers', 'accounts', 'messages', 'events', 'notes', 'archives']),
      control('FIND', [
        'jobs',
        'runs',
        'action_intents',
        'effects',
        'action_receipts',
        'completion_receipts',
        'artifacts',
        'artifact_eligibility',
        // recordContextInputs asks `permitted`, which reads provenance ancestry.
        'provenance_edges',
        'deployments',
        'approvals',
        // Effects read the stored authority and decision ledger inside their transaction.
        'authority_revisions',
        'authority_touches',
        'decisions',
        'wake_commands',
        // The operator-facing service runs as this principal and serves committed projections: events, the per-job
        // sequence counters and the deployment history (promotions) are read-only here.
        'projection_events',
        'projection_sequences',
        'promotions',
        // The campaign fault plan and campaign artifact permits are read only for a campaign world's run.
        'world_faults',
        'campaign_artifact_permits',
        ...DOMAIN_STEP_COLLECTIONS,
      ]),
      control('INSERT', [
        'jobs',
        'runs',
        'action_intents',
        'effects',
        'action_receipts',
        'completion_receipts',
        'telemetry_outbox',
        'projection_events',
        'projection_sequences',
        // The gateway's decision ledger. Rows are insert-only; nothing may edit a recorded decision.
        'decisions',
        // Wake-command deduplication ids, insert-only.
        'wake_commands',
        // The gateway's insert-only step log: subject, resolution, discovery, plans, sweeps, diagnostics.
        ...DOMAIN_STEP_COLLECTIONS,
      ]),
      // authority_touches: the fence counter only. The authoritative authority_revisions row is not writable here.
      control('UPDATE', ['jobs', 'runs', 'projection_sequences', 'authority_touches']),
    ]),
    observer: role('expunge_observer', [
      // JobRepository.create binds a job to a world through these two rows; no domain collection is readable.
      action('FIND', names.world, JOB_BINDING_WORLD_ROWS),
      control('FIND', [
        'jobs',
        'runs',
        // recordContextInputs asks `permitted` for the observe/propose jobs this principal works.
        'artifact_eligibility',
        'provenance_edges',
        'telemetry_outbox',
        'telemetry_receipts',
        'evidence',
        'observer_cursors',
        'projection_events',
        'stream_offsets',
      ]),
      control('INSERT', [
        'jobs',
        'evidence',
        'telemetry_outbox',
        'telemetry_receipts',
        'observer_cursors',
        'projection_events',
        'projection_sequences',
        'stream_offsets',
        'provenance_edges',
      ]),
      control('UPDATE', [
        'jobs',
        'telemetry_outbox',
        'telemetry_receipts',
        'observer_cursors',
        'projection_sequences',
        'stream_offsets',
      ]),
      control('REMOVE', ['stream_offsets']),
      control('CHANGE_STREAM', ['projection_events']),
    ]),
    proposer: role('expunge_proposer', [
      control('FIND', [
        'artifacts',
        'artifact_eligibility',
        'evidence',
        'lessons',
        'provenance_edges',
        'candidates',
      ]),
      control('INSERT', ['artifacts', 'candidates', 'provenance_edges']),
    ]),
    grader: role('expunge_grader', [
      worldRead,
      action('FIND', names.private, PRIVATE_COLLECTIONS),
      action('INSERT', names.private, ['grader_results']),
      // campaign_freezes and gate_claims: read by `JobRepository.createCampaignJob` to admit an evaluation job.
      control('FIND', [
        'jobs',
        'artifacts',
        'artifact_eligibility',
        'provenance_edges',
        'campaign_freezes',
        'gate_claims',
        'gate_attempts',
        'gate_held_runs',
        'world_faults',
        'campaign_artifact_permits',
        // Read-only: the campaign port reads the fault-plan attestation row (kind 'fault') the gateway wrote.
        'domain_steps',
      ]),
      // gate_claims: INSERT, then UPDATE of `state` only through the gate's compare-and-set (a collection grant cannot
      // narrow it). gate_attempts: the atomic per-parent counter (upsert = INSERT + UPDATE). campaign_artifact_permits:
      // where a campaign's artifact is permitted for its own scope; the grader has NO write on artifact_eligibility.
      control('INSERT', [
        'gate_claims',
        'gate_attempts',
        'gate_held_runs',
        'campaign_artifact_permits',
        'public_trial_rows',
        'gate_reports',
        'projection_events',
        'projection_sequences',
        'provenance_edges',
        'jobs',
      ]),
      control('UPDATE', ['jobs', 'projection_sequences', 'gate_claims', 'gate_attempts']),
    ]),
    approval_issuer: role('expunge_approval_issuer', [
      control('FIND', ['candidates', 'gate_reports', 'deployments', 'artifacts', 'authority_revisions']),
      control('INSERT', ['approvals']),
      // Bumping the authorization revision rewrites the authority row and its touch row together.
      control('UPDATE', ['authority_revisions', 'authority_touches']),
    ]),
    promoter: role('expunge_promoter', [
      worldRead,
      control('FIND', [
        'candidates',
        'gate_reports',
        'deployments',
        'artifacts',
        'artifact_eligibility',
        'approvals',
        // The approval requirement is derived from this stored policy, never from the caller.
        'authority_policies',
        'grant_consumptions',
        'provenance_edges',
        'authority_revisions',
        'authority_touches',
        'jobs',
      ]),
      // candidates: the promoted state transition. approvals: grant consumption.
      // No UPDATE on approvals: a grant is consumed by inserting a unique grant_consumptions row.
      control('UPDATE', ['deployments', 'candidates', 'jobs', 'projection_sequences', 'authority_touches']),
      control('INSERT', [
        'deployments',
        'promotions',
        'grant_consumptions',
        'deployment_outbox',
        // Every refused rollback, insert-only.
        'rollback_refusals',
        'projection_events',
        'projection_sequences',
        'provenance_edges',
        'jobs',
      ]),
    ]),
    projection_reader: role('expunge_projection_reader', [
      control('FIND', [
        'projection_events',
        'jobs',
        'completion_receipts',
        'action_receipts',
        'deployments',
        'promotions',
        'public_trial_rows',
        'rollback_refusals',
        'stream_offsets',
      ]),
      control('CHANGE_STREAM', ['projection_events']),
      control('INSERT', ['stream_offsets']),
      control('UPDATE', ['stream_offsets']),
      control('REMOVE', ['stream_offsets']),
    ]),
    privacy_controller: role('expunge_privacy_controller', [
      action('FIND', names.world, JOB_BINDING_WORLD_ROWS),
      control('FIND', [
        'subject_tokens',
        'raw_artifacts',
        'artifact_eligibility',
        'provenance_edges',
        'provenance_closures',
        'external_deletions',
        'jobs',
        'evidence',
        'telemetry_outbox',
      ]),
      control('UPDATE', [
        'artifact_eligibility',
        'provenance_closures',
        'external_deletions',
        'evidence',
        'jobs',
        'telemetry_outbox',
        'projection_sequences',
      ]),
      control('INSERT', [
        'artifact_eligibility',
        'provenance_closures',
        'external_deletions',
        'provenance_edges',
        'telemetry_outbox',
        'projection_events',
        'projection_sequences',
        'jobs',
      ]),
      control('REMOVE', ['raw_artifacts', 'subject_tokens']),
    ]),
    fixture_builder: role('expunge_fixture_builder', [
      worldRead,
      action('INSERT', names.world, WORLD_COLLECTIONS),
      action('UPDATE', names.world, WORLD_COLLECTIONS),
      action('REMOVE', names.world, [
        'customers',
        'accounts',
        'messages',
        'events',
        'notes',
        'archives',
        'identity_edges',
      ]),
      action('FIND', names.private, PRIVATE_COLLECTIONS),
      action('INSERT', names.private, PRIVATE_COLLECTIONS),
      control('FIND', ['jobs', 'artifacts', 'artifact_eligibility', 'campaign_freezes']),
      control('INSERT', [
        'jobs',
        'artifacts',
        // Written once before a campaign runs; the fault plan of a campaign world.
        'campaign_freezes',
        'world_faults',
        'projection_events',
        'projection_sequences',
        'provenance_edges',
      ]),
      control('UPDATE', ['jobs', 'projection_sequences']),
    ]),
  };
}
export const ROLE_BOUNDARY_NOTES = {
  tenantIsolation:
    'Application gateway predicates; MongoDB roles are collection-level, not row-level tenant RLS.',
  immutableArtifacts:
    'Proposer/grader insert-only artifacts; no update/remove/bypassDocumentValidation/collMod runtime action.',
  retention:
    'retained_invoices physically separates removal authority. Mixed retention in other collections remains trusted-policy enforced.',
  approvalPolicy:
    'authority_policies is written only by the setup principal (no runtime role can insert or update it); the promoter has FIND only.',
  setup:
    'DDL requires a setup principal; Atlas administration rights required separately to provision these roles.',
  deployment:
    'All principal URIs must point to one replica-set deployment. Separate sessions never mix differently credentialed clients.',
};
