import { contentHash, type ActorContext, type ScopeKey } from '@expunge/contracts';
import { fail, requirePrincipal, scopeFilter, type MongoService } from './client.js';
import { JobRepository, type LeaseBinding } from './jobs.js';

export type RunAttestation = {
  fence: number;
  /** Where the model choice came from (configuration, harness pin, ...). */
  source: string;
  provider: string;
  modelId: string;
  spec: string;
  /** Hash of the runtime this holder ran under (64 hex). Required; part of the stamp, so a differing repeat conflicts. */
  runtimeHash: string;
  endpoint?: string;
  endpointHostHash?: string;
  at: Date;
};
export type StoredAttestation = ScopeKey &
  RunAttestation & { _id: string; jobId: string; runId: string; createdAt: Date };

const HASH = /^[a-f0-9]{64}$/;
const text = (value: unknown, max = 256): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max;
const stampOf = (a: RunAttestation) => ({
  fence: a.fence,
  source: a.source,
  provider: a.provider,
  modelId: a.modelId,
  spec: a.spec,
  runtimeHash: a.runtimeHash,
  endpoint: a.endpoint ?? null,
  endpointHostHash: a.endpointHostHash ?? null,
  at: a.at.getTime(),
});
const sameStamp = (a: RunAttestation, b: RunAttestation): boolean =>
  contentHash(stampOf(a), 'run-attestation') === contentHash(stampOf(b), 'run-attestation');

/**
 * Per-fence model attestations. A row is the lease holder's statement of the model it ran under; the gate reads it instead
 * of the `jobs.checkpoint` copy, which principals with UPDATE on `jobs` could rewrite. Insert-only: a second attestation for
 * the same (job, fence) is returned if identical and refused otherwise.
 */
export class AttestationRepository {
  readonly jobs: JobRepository;
  constructor(readonly service: MongoService) {
    this.jobs = new JobRepository(service);
  }
  private get rows() {
    return this.service.control.collection<StoredAttestation>('run_attestations');
  }

  /** Inserts the attestation for the caller's live lease. `attestation.fence` must be the lease's fence. */
  async record(
    actor: ActorContext,
    lease: LeaseBinding,
    attestation: RunAttestation,
  ): Promise<StoredAttestation> {
    requirePrincipal(this.service, ['domain_executor', 'setup']);
    if (
      attestation.fence !== lease.fence ||
      !Number.isSafeInteger(attestation.fence) ||
      attestation.fence < 0 ||
      !text(attestation.source) ||
      !text(attestation.provider) ||
      !text(attestation.modelId) ||
      !text(attestation.spec) ||
      !HASH.test(attestation.runtimeHash) ||
      !(attestation.at instanceof Date) ||
      Number.isNaN(attestation.at.getTime()) ||
      (attestation.endpoint !== undefined && !text(attestation.endpoint)) ||
      (attestation.endpointHostHash !== undefined && !HASH.test(attestation.endpointHostHash))
    )
      fail('InvalidAttestation');
    const _id = contentHash(
      { ...scopeFilter(actor), jobId: lease.jobId, fence: lease.fence },
      'run-attestation-row',
    );
    try {
      return await this.service.transaction(async (session) => {
        // The lease must be live now: a fenced-out holder cannot attest.
        const job = await this.jobs.fence(actor, lease, session);
        const existing = await this.rows.findOne({ _id }, { session });
        if (existing) {
          if (!sameStamp(existing, attestation)) fail('AttestationConflict');
          return existing;
        }
        const row: StoredAttestation = {
          _id,
          ...scopeFilter(actor),
          jobId: lease.jobId,
          runId: job.binding.runId,
          createdAt: new Date(),
          ...attestation,
        };
        await this.rows.insertOne(row as never, { session });
        return row;
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 11000) {
        const stored = await this.rows.findOne({ _id });
        if (stored && sameStamp(stored, attestation)) return stored;
        return fail('AttestationConflict');
      }
      throw error;
    }
  }

  /** The attestations of one job in fence order. Readable by the worker, the grader and the projection reader. */
  async list(actor: ScopeKey, jobId: string): Promise<StoredAttestation[]> {
    requirePrincipal(this.service, ['domain_executor', 'grader', 'projection_reader', 'setup']);
    return this.rows.find({ ...scopeFilter(actor), jobId }, { sort: { fence: 1 } }).toArray();
  }
}
