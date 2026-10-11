import type { Job, ScopeKey } from '@expunge/contracts';
import { contentHash } from '@expunge/contracts';
import { AttestationRepository, type MongoService, type StoredAttestation } from '@expunge/mongo';
import type { EpisodeOutcome, WorkerProfile } from './types.js';

/**
 * What the gate learns about an arm from the stored job row itself, with its own grader principal, never from the
 * port (DA-11 F-1). A port can say anything; the job row is what the worker committed: which harness it was pinned to,
 * which world, how it ended, the runtime hash the worker build attested and the model the worker resolved.
 */
export type ModelStamp = {
  fence: number;
  source: string;
  provider: string;
  modelId: string;
  spec?: string;
  endpoint?: string;
  endpointHostHash?: string;
  runtimeHash?: string;
};
export type ArmFacts = {
  /** Every check below held and the model is the frozen provider model. Anything less is not real evidence. */
  verified: boolean;
  /** The runtime hash the lease holder attested in its insert-only attestation row for the final fence; null when absent. */
  runtimeHash: string | null;
  reasons: string[];
};

/**
 * What is stored about one arm: the job row, and the per-fence attestation rows (model and runtime). The stamps come
 * from the insert-only attestation collection and nowhere else.
 */
export type ArmRecord = {
  job: Job | null;
  stamps: unknown;
  /** Integrity defects the reader found in the stored rows themselves; any one makes the arm fake evidence. */
  defects?: string[];
};
export interface JobEvidenceReader {
  read(scope: ScopeKey, jobId: string): Promise<ArmRecord>;
}

/** The job row, read at majority as the grader. Internal: the stamps are never taken from the row's checkpoint. */
async function readJob(service: MongoService, scope: ScopeKey, jobId: string): Promise<Job | null> {
  return service.control.collection<Job & { _id: string }>('jobs').findOne(
    {
      _id: jobId,
      'actor.tenantId': scope.tenantId,
      'actor.env': scope.env,
      'actor.scopeId': scope.scopeId,
    },
    { readConcern: { level: 'majority' } },
  );
}

/**
 * The source: the job row from `jobs` and the stamps from the insert-only `run_attestations` collection (one
 * row per scope, job and fence), which principals with UPDATE on `jobs` cannot rewrite. Same interface as
 * the stamps come ONLY from `run_attestations`; the job's checkpoint copy is never read.
 */
export class AttestedJobEvidence implements JobEvidenceReader {
  private readonly service: MongoService;
  private readonly listRows: (scope: ScopeKey, jobId: string) => Promise<StoredAttestation[]>;
  constructor(
    service: MongoService,
    /** Replaceable for tests; defaults to the repository's list. */
    list?: (scope: ScopeKey, jobId: string) => Promise<StoredAttestation[]>,
  ) {
    this.service = service;
    const repository = new AttestationRepository(service);
    this.listRows = list ?? ((scope, jobId) => repository.list(scope, jobId));
  }
  async read(scope: ScopeKey, jobId: string): Promise<ArmRecord> {
    const job = await readJob(this.service, scope, jobId);
    const rows = await this.listRows(scope, jobId);
    const defects: string[] = [];
    for (const row of rows) {
      // INSERT on the collection is collection-wide, so a row is not trusted for what it claims: its id must be the
      // one the repository derives from (scope, job, fence), and it must belong to this job and this run.
      const expectedId = contentHash(
        { tenantId: scope.tenantId, env: scope.env, scopeId: scope.scopeId, jobId, fence: row.fence },
        'run-attestation-row',
      );
      if (row._id !== expectedId) defects.push('attestation_id_mismatch');
      if (row.jobId !== jobId) defects.push('attestation_job_mismatch');
      if (row.tenantId !== scope.tenantId || row.env !== scope.env || row.scopeId !== scope.scopeId)
        defects.push('attestation_scope_mismatch');
      if (!job || row.runId !== job.binding.runId) defects.push('attestation_run_mismatch');
    }
    return {
      job,
      defects: [...new Set(defects)],
      stamps: rows.map((row) => ({
        fence: row.fence,
        source: row.source,
        provider: row.provider,
        modelId: row.modelId,
        spec: row.spec,
        runtimeHash: row.runtimeHash,
        ...(row.endpoint === undefined ? {} : { endpoint: row.endpoint }),
        ...(row.endpointHostHash === undefined ? {} : { endpointHostHash: row.endpointHostHash }),
      })),
    };
  }
}

const HEX64 = /^[a-f0-9]{64}$/;
/** The port outcomes a stored job status can stand behind. */
const OUTCOMES_FOR_STATUS: Record<string, readonly EpisodeOutcome[]> = {
  succeeded: ['completed'],
  failed: ['failed', 'incomplete', 'refused', 'timed_out'],
  cancelled: ['cancelled'],
  queued: ['failed', 'timed_out', 'cancelled'],
  running: ['failed', 'timed_out', 'cancelled'],
  waiting_evidence: ['failed', 'timed_out', 'cancelled'],
  waiting_approval: ['failed', 'timed_out', 'cancelled'],
  waiting_external: ['failed', 'timed_out', 'cancelled'],
};
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The worker's model stamps, one per claiming session, each bound to the lease fence it was written under. An entry that is malformed, or has no numeric fence, is no stamp.
 */
export function modelStampsOf(stamps: unknown): ModelStamp[] {
  if (!Array.isArray(stamps)) return [];
  return stamps.flatMap((item) =>
    isRecord(item) &&
    typeof item.fence === 'number' &&
    Number.isSafeInteger(item.fence) &&
    typeof item.source === 'string' &&
    typeof item.provider === 'string' &&
    typeof item.modelId === 'string'
      ? [
          {
            fence: item.fence,
            source: item.source,
            provider: item.provider,
            modelId: item.modelId,
            ...(typeof item.spec === 'string' ? { spec: item.spec } : {}),
            ...(typeof item.endpoint === 'string' ? { endpoint: item.endpoint } : {}),
            ...(typeof item.endpointHostHash === 'string' ? { endpointHostHash: item.endpointHostHash } : {}),
            ...(typeof item.runtimeHash === 'string' ? { runtimeHash: item.runtimeHash } : {}),
          },
        ]
      : [],
  );
}

/**
 * Verifies one arm against its stored job. Fails closed: a missing job, a job pinned to another harness, world or run,
 * a missing runtime attestation, a missing stamp, an unknown source, anything but `provider`, stamps that disagree with
 * each other, or a provider or model that is not the frozen profile's, each make the arm fake evidence.
 */
export function verifyArm(
  record: ArmRecord,
  expected: { runId: string; worldId: string; bundleHash: string; outcome: EpisodeOutcome },
  profile: WorkerProfile & { provider?: string },
): ArmFacts {
  const reasons: string[] = [];
  const { job } = record;
  reasons.push(...(record.defects ?? []));
  if (!job) return { verified: false, runtimeHash: null, reasons: ['job_missing'] };
  if (job.kind !== 'cleanup') reasons.push('job_kind');
  if (job.binding.runId !== expected.runId) reasons.push('run_mismatch');
  if (job.binding.worldId !== expected.worldId) reasons.push('world_mismatch');
  if (job.binding.harnessHash !== expected.bundleHash) reasons.push('harness_mismatch');
  // The arm's outcome is what the stored job says, not what the port reports. Any disagreement is a mismatch.
  if (!(OUTCOMES_FOR_STATUS[job.status] ?? []).includes(expected.outcome)) reasons.push('status_mismatch');
  // A succeeded job whose own terminal decision is a failure is inconsistent too.
  const decision = (job.checkpoint as { terminal?: { decision?: { status?: unknown } } } | null)?.terminal
    ?.decision;
  if (
    job.status === 'succeeded' &&
    decision &&
    decision.status !== undefined &&
    decision.status !== 'succeeded'
  )
    reasons.push('status_mismatch');
  const raw = record.stamps;
  const stamps = modelStampsOf(raw);
  // The runtime the lease holder ran under is in the same insert-only row as its model: the final fence's row decides,
  // and every row of the job must name a well-formed hash. Nothing is read from the job's rewritable checkpoint.
  const finalStamp = stamps.find((stamp) => stamp.fence === job.lease.fence);
  const runtimeHash =
    finalStamp?.runtimeHash !== undefined && HEX64.test(finalStamp.runtimeHash)
      ? finalStamp.runtimeHash
      : null;
  if (
    !runtimeHash ||
    stamps.some((stamp) => stamp.runtimeHash === undefined || !HEX64.test(stamp.runtimeHash))
  )
    reasons.push('runtime_unattested');
  else if (stamps.some((stamp) => stamp.runtimeHash !== runtimeHash)) reasons.push('runtime_stamps_disagree');
  if (!stamps.length) reasons.push('model_unstamped');
  else {
    const first = stamps[0]!;
    // A malformed entry beside good ones is not ignored: the stamps must all be well formed.
    if (Array.isArray(raw) && raw.length !== stamps.length) reasons.push('model_stamp_malformed');
    if (new Set(stamps.map((stamp) => stamp.fence)).size !== stamps.length)
      reasons.push('model_stamp_duplicate_fence');
    // A later session always stamps before it can call the model, so the job's final fence must have its own entry.
    if (!stamps.some((stamp) => stamp.fence === job.lease.fence))
      reasons.push('model_stamp_missing_final_fence');
    if (stamps.some((stamp) => stamp.source !== 'provider')) reasons.push('model_not_provider');
    // A redirected endpoint is only evidence when its host is on the frozen allowlist (none is frozen today).
    if (stamps.some((stamp) => stamp.endpoint !== 'default')) reasons.push('endpoint_not_default');
    if (stamps.some((stamp) => stamp.provider !== first.provider || stamp.modelId !== first.modelId))
      reasons.push('model_stamps_disagree');
    if (profile.modelKind !== 'provider') reasons.push('profile_not_provider');
    if (!profile.provider || first.provider !== profile.provider || first.modelId !== profile.modelId)
      reasons.push('model_not_frozen_profile');
  }
  return { verified: reasons.length === 0, runtimeHash, reasons };
}
