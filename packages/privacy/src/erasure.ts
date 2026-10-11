import { contentHash, type ExternalErasureJob, type ScopeKey } from '@expunge/contracts';
import type { DeletionJob } from '@expunge/observer';
import { PrivacyError } from './errors.js';
import type { ErasureStore, ProjectionSink, RetentionBoundary, RetentionBoundaryStore } from './ports.js';

/**
 * External erasure lifecycle for Raindrop user deletion (organization-wide). The states are kept distinct and honest:
 *  - `unsubmitted`: recorded locally, nothing sent. Local export suppression is already active.
 *  - `pending`: the provider ACKNOWLEDGED the request (2xx) and gave a due date. Acknowledgement is not erasure.
 *  - `in_progress`: the provider reports it is working on it.
 *  - `completed`: ONLY when the provider's own status says so. Nothing else flips this.
 *  - `submitting`: a local claim taken (compare-and-swap) BEFORE the provider is called, so two submits cannot both send.
 *  - `submission_ambiguous`: the provider call may or may not have been accepted (a lost response, a crash, a failed
 *    store write). It is NEVER re-sent automatically; it is reconciled only by reading a stored remote id, or by a
 *    named human decision that nothing was sent.
 *  - `rejected`: the provider refused.
 *  - `cancelled`: every subject was removed from the PENDING job with the cancel endpoint; their data is KEPT.
 * `DELETE /v1/deletions/users/{id}/{user_id}` is a cancellation, never an erasure command; the method that calls it says so.
 */

/** The slice of RaindropQueryClient the lifecycle uses; the real client satisfies it structurally. */
export interface DeletionProvider {
  /**
   * The provider organization the credential belongs to, from trusted configuration that binds key and organization
   * together (the Query API documents no endpoint that reports it). `null` means unverified: submit refuses.
   */
  organizationId(): string | null;
  requestUserDeletion(input: {
    userIds: string[];
    requester: string;
    regulation: 'gdpr' | 'ccpa' | 'other';
  }): Promise<DeletionJob>;
  getDeletion(jobId: string): Promise<DeletionJob>;
  cancelPendingUserDeletion(
    jobId: string,
    userId: string,
  ): Promise<{ jobId: string; userId: string; revokedAt: string }>;
}

/**
 * Binds a provider client to the organization its credential belongs to. The binding comes from trusted configuration
 * (the Query API has no endpoint that reports it); a caller that cannot name the organization passes `null` and every
 * submit refuses with `OrganizationUnverified`.
 */
export function bindOrganization(
  client: Omit<DeletionProvider, 'organizationId'>,
  organizationId: string | null,
): DeletionProvider {
  return {
    organizationId: () => organizationId,
    requestUserDeletion: (input) => client.requestUserDeletion(input),
    getDeletion: (jobId) => client.getDeletion(jobId),
    cancelPendingUserDeletion: (jobId, userId) => client.cancelPendingUserDeletion(jobId, userId),
  };
}

export type ErasureRequest = {
  requestKey: string;
  providerOrganizationId: string;
  requester: string;
  regulation: 'gdpr' | 'ccpa' | 'other';
  /** Opaque telemetry user ids, 1 to 100 (the provider's own limit). */
  namespacedUserIds: string[];
};

/** Local states the contract union does not list yet; they are stored in `providerStatus` as plain strings. */
type ErasureStatus = ExternalErasureJob['providerStatus'] | 'submitting' | 'submission_ambiguous';
type Patch = Omit<Partial<ExternalErasureJob>, 'providerStatus'> & {
  providerStatus?: ErasureStatus;
  snapshot?: string;
};
/** A claim older than this is no longer "in progress": it is treated as ambiguous. */
const SUBMIT_STALE_MS = 60_000;

const snapshotHash = (snapshot: unknown) => contentHash(snapshot as never, 'raindrop-deletion-snapshot');

export function mapProviderStatus(status: DeletionJob['status']): ExternalErasureJob['providerStatus'] {
  return status; // pending | in_progress | completed | rejected are the provider's own words
}

/** Past its due date and still not completed or rejected: reported honestly, never hidden. */
export function isOverdue(job: ExternalErasureJob, now: Date): boolean {
  return (
    job.dueBy !== null &&
    job.dueBy.getTime() < now.getTime() &&
    (job.providerStatus === 'pending' || job.providerStatus === 'in_progress')
  );
}

type Clock = { now?: () => Date };

export class ErasureService {
  constructor(
    private readonly deps: {
      store: ErasureStore;
      provider: DeletionProvider;
      projection?: ProjectionSink;
    } & Clock,
  ) {}

  private now(): Date {
    return (this.deps.now ?? (() => new Date()))();
  }

  /** Records the request locally and starts suppressing export for these ids. Nothing is sent to the provider. */
  async create(scope: ScopeKey, request: ErasureRequest): Promise<ExternalErasureJob> {
    const ids = [...new Set(request.namespacedUserIds)];
    if (
      !request.requestKey ||
      ids.length < 1 ||
      ids.length > 100 ||
      ids.some((id) => id.length < 1 || id.length > 512) ||
      request.requester.length < 1 ||
      request.requester.length > 320 ||
      !['gdpr', 'ccpa', 'other'].includes(request.regulation)
    )
      throw new PrivacyError('InvalidErasureRequest');
    const job: ExternalErasureJob = {
      ...scope,
      requestKey: request.requestKey,
      providerOrganizationId: request.providerOrganizationId,
      requester: request.requester,
      regulation: request.regulation,
      namespacedUserIds: ids.sort(),
      localExportSuppression: 'active',
      remoteJobId: null,
      receivedAt: this.now(),
      dueBy: null,
      completedAt: null,
      providerStatus: 'unsubmitted',
      subjectEntries: [],
      providerSnapshot: null,
      history: [
        {
          at: this.now(),
          status: 'unsubmitted',
          snapshotHash: snapshotHash({ requestKey: request.requestKey }),
        },
      ],
    };
    if ((await this.deps.store.insert(job)) === 'exists') return this.require(scope, request.requestKey);
    return job;
  }

  /**
   * Sends the request, at most once per stored request. Order: (1) refuse unless the credential's organization is known
   * and equals the recorded one; (2) CLAIM `submitting` by compare-and-swap (a second concurrent submit loses the swap
   * and sends nothing); (3) call the provider; (4) a 2xx is ACKNOWLEDGED (`pending` with the due date), not erasure.
   * Any failure after the claim (lost response, crash, a store write that failed after the provider accepted) leaves the
   * job `submission_ambiguous`: never re-sent automatically, reconciled with `reconcileSubmission`.
   */
  async submit(scope: ScopeKey, requestKey: string): Promise<ExternalErasureJob> {
    const job = await this.require(scope, requestKey);
    if (job.remoteJobId) return job; // already submitted: never file a second org-wide job for the same request
    const status = job.providerStatus as ErasureStatus;
    if (status === 'submission_ambiguous') throw new PrivacyError('SubmissionAmbiguous');
    if (status === 'submitting') {
      const claimedAt = job.history.at(-1)?.at ?? job.receivedAt;
      if (this.now().getTime() - claimedAt.getTime() < SUBMIT_STALE_MS)
        throw new PrivacyError('SubmissionInProgress');
      // An old claim: a crash may have happened after the provider accepted. Say so; never resend.
      await this.transition(job, { providerStatus: 'submission_ambiguous' });
      throw new PrivacyError('SubmissionAmbiguous');
    }
    const credentialOrganization = this.deps.provider.organizationId();
    if (!credentialOrganization)
      throw new PrivacyError(
        'OrganizationUnverified',
        'no configured organization for this credential; not provider-verified',
      );
    if (credentialOrganization !== job.providerOrganizationId)
      throw new PrivacyError(
        'OrganizationMismatch',
        'configured organization differs from the request; the binding is configured, not provider-verified',
      );
    const claimed = await this.transition(job, { providerStatus: 'submitting' }); // CAS: a concurrent loser throws ErasureStale
    let remote: DeletionJob;
    try {
      remote = await this.deps.provider.requestUserDeletion({
        userIds: claimed.namespacedUserIds,
        requester: claimed.requester,
        regulation: claimed.regulation,
      });
    } catch {
      await this.markAmbiguous(scope, requestKey);
      throw new PrivacyError('SubmissionAmbiguous');
    }
    // The provider accepted. Recording it can lose a race with a poller; retry the write before giving up.
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await this.apply(await this.require(scope, requestKey), remote);
      } catch (error) {
        if (!(error instanceof PrivacyError && error.code === 'ErasureStale')) break;
      }
    }
    await this.markAmbiguous(scope, requestKey);
    throw new PrivacyError('SubmissionAmbiguous');
  }

  private async markAmbiguous(scope: ScopeKey, requestKey: string): Promise<void> {
    try {
      const current = await this.require(scope, requestKey);
      if (current.providerStatus === ('submitting' as ErasureStatus))
        await this.transition(current, { providerStatus: 'submission_ambiguous' });
    } catch {
      /* the stale-claim rule in submit() turns a leftover `submitting` into ambiguous */
    }
  }

  /**
   * Resolves an ambiguous submission. With a stored remote id the provider's own status is read (GET) and applied; the
   * request is never re-sent. Without one, the only way out is a NAMED human decision that nothing was sent, which puts
   * the job back to `unsubmitted` and records who decided.
   */
  async reconcileSubmission(
    scope: ScopeKey,
    requestKey: string,
    resolution: { remoteJobId: string } | { notSentDecidedBy: string },
  ): Promise<ExternalErasureJob> {
    const job = await this.require(scope, requestKey);
    if ((job.providerStatus as ErasureStatus) !== 'submission_ambiguous')
      throw new PrivacyError('ErasureNotCancellable');
    if ('remoteJobId' in resolution)
      return this.apply(job, await this.deps.provider.getDeletion(resolution.remoteJobId));
    if (!resolution.notSentDecidedBy.trim()) throw new PrivacyError('InvalidErasureRequest');
    return this.transition(job, {
      providerStatus: 'unsubmitted',
      snapshot: snapshotHash({ notSentDecidedBy: resolution.notSentDecidedBy }),
    });
  }

  /** Reads the provider's current job state. History grows only when the provider's snapshot actually changed. */
  async poll(scope: ScopeKey, requestKey: string): Promise<ExternalErasureJob> {
    const job = await this.require(scope, requestKey);
    if (!job.remoteJobId) throw new PrivacyError('ErasureNotSubmitted');
    return this.apply(job, await this.deps.provider.getDeletion(job.remoteJobId));
  }

  /**
   * CANCELS one subject's PENDING deletion at the provider (their data is KEPT; this is not an erasure). Allowed only
   * while the job is `pending`. When every subject has been cancelled the job becomes `cancelled`.
   */
  async cancelPendingSubject(
    scope: ScopeKey,
    requestKey: string,
    userId: string,
  ): Promise<ExternalErasureJob> {
    const job = await this.require(scope, requestKey);
    if (!job.remoteJobId || job.providerStatus !== 'pending' || !job.namespacedUserIds.includes(userId))
      throw new PrivacyError('ErasureNotCancellable');
    await this.deps.provider.cancelPendingUserDeletion(job.remoteJobId, userId);
    const refreshed = await this.apply(job, await this.deps.provider.getDeletion(job.remoteJobId));
    const allRevoked =
      refreshed.subjectEntries.length > 0 &&
      refreshed.subjectEntries.every((entry) => entry.revoked_at !== null);
    if (allRevoked && refreshed.providerStatus === 'pending')
      return this.transition(refreshed, { providerStatus: 'cancelled' });
    return refreshed;
  }

  /** Ends local export suppression. An explicit decision, never a side effect of a status. */
  async releaseExportSuppression(scope: ScopeKey, requestKey: string): Promise<ExternalErasureJob> {
    const job = await this.require(scope, requestKey);
    return this.transition(job, { localExportSuppression: 'released' });
  }

  /**
   * Ids whose telemetry must not be exported to this provider ORGANIZATION: every id of any job under active suppression
   * (any scope), unless that subject was cancelled at the provider. Satisfies the observer's `ExportSuppression`.
   */
  async suppressedUserIds(providerOrganizationId: string): Promise<Set<string>> {
    const suppressed = new Set<string>();
    for (const job of await this.deps.store.listSuppressing(providerOrganizationId)) {
      if (job.localExportSuppression !== 'active') continue;
      for (const id of job.namespacedUserIds) {
        const entry = job.subjectEntries.find((e) => e.user_id === id);
        if (!entry || entry.revoked_at === null) suppressed.add(id);
      }
    }
    return suppressed;
  }

  private async require(scope: ScopeKey, requestKey: string): Promise<ExternalErasureJob> {
    const job = await this.deps.store.get(scope, requestKey);
    if (!job) throw new PrivacyError('ErasureNotFound');
    return job;
  }

  private async apply(job: ExternalErasureJob, remote: DeletionJob): Promise<ExternalErasureJob> {
    // A provider job is accepted for this request only if it names exactly this request's user ids. Anything else (a
    // reconcile or a poll that reached another request's deletion) changes nothing.
    const remoteIds = new Set(remote.user_ids.map((entry) => entry.user_id));
    if (
      remoteIds.size !== remote.user_ids.length ||
      remoteIds.size !== job.namespacedUserIds.length ||
      !job.namespacedUserIds.every((id) => remoteIds.has(id))
    )
      throw new PrivacyError('RemoteJobMismatch');
    if (remote.status === 'completed' && !remote.completed_at)
      throw new PrivacyError('ProviderResponseInvalid', 'completed without completed_at');
    const status = mapProviderStatus(remote.status);
    return this.transition(job, {
      remoteJobId: remote.id,
      providerStatus: job.providerStatus === 'cancelled' && status === 'pending' ? 'cancelled' : status,
      dueBy: new Date(remote.due_by),
      completedAt: remote.completed_at ? new Date(remote.completed_at) : null,
      subjectEntries: remote.user_ids.map((u) => ({
        user_id: u.user_id,
        requested_on: u.requested_on,
        revoked_at: u.revoked_at,
      })),
      providerSnapshot: remote as never,
      snapshot: snapshotHash(remote),
    });
  }

  private async transition(job: ExternalErasureJob, patch: Patch): Promise<ExternalErasureJob> {
    const { snapshot, ...fields } = patch;
    const next = { ...job, ...fields } as ExternalErasureJob;
    const hash =
      snapshot ?? snapshotHash({ status: next.providerStatus, suppression: next.localExportSuppression });
    const last = job.history.at(-1);
    const changed = !last || last.snapshotHash !== hash || last.status !== next.providerStatus;
    if (changed)
      next.history = [...job.history, { at: this.now(), status: next.providerStatus, snapshotHash: hash }];
    if (JSON.stringify(stripHistory(next)) === JSON.stringify(stripHistory(job)) && !changed) return job;
    if (!(await this.deps.store.replace(next, job.history.length))) throw new PrivacyError('ErasureStale');
    // The two local-only states are not in the projection contract's status vocabulary yet; the UI reads them from the job.
    const localOnly = (value: string) => value === 'submitting' || value === 'submission_ambiguous';
    if (changed && next.providerStatus !== job.providerStatus && !localOnly(next.providerStatus))
      await this.announce(next, hash);
    return next;
  }

  private async announce(job: ExternalErasureJob, hash: string): Promise<void> {
    if (!this.deps.projection) return;
    try {
      await this.deps.projection.append(job, {
        eventId: `${job.requestKey}:erasure:${job.history.length}`,
        jobId: job.requestKey,
        runId: job.requestKey,
        artifactIds: [],
        kind: 'external_erasure_updated',
        payload: {
          requestKey: job.requestKey,
          providerStatus: job.providerStatus,
          dueBy: job.dueBy ? job.dueBy.toISOString() : null,
          completedAt: job.completedAt ? job.completedAt.toISOString() : null,
          subjectCount: job.namespacedUserIds.length,
          snapshotHash: hash,
        },
      });
    } catch {
      /* the UI recovers from the stored job */
    }
  }
}

const stripHistory = (job: ExternalErasureJob) => ({ ...job, history: undefined });

/**
 * CopilotKit Intelligence conversation retention: no purge API exists, so none is invented. The only honest state is
 * that a retention boundary was REGISTERED; it is never `deleted`.
 */
export async function registerRetentionBoundary(
  store: RetentionBoundaryStore,
  scope: ScopeKey,
  input: { provider: string; note: string },
  now: () => Date = () => new Date(),
): Promise<RetentionBoundary> {
  const boundary: RetentionBoundary = {
    ...scope,
    provider: input.provider,
    state: 'retention_boundary_registered',
    note: input.note.slice(0, 500),
    registeredAt: now(),
  };
  await store.put(boundary);
  return boundary;
}

/**
 * What a UI or projection may say about a finished job and its external erasure TOGETHER. The domain cleanup can be
 * `succeeded` while the provider's erasure is still `pending`; `fullyErased` is true only when the provider itself
 * reports `completed` for every job tied to the request.
 */
export function completionView(
  domainStatus: 'succeeded' | 'failed' | 'cancelled' | 'running' | 'queued',
  erasure: ExternalErasureJob | null,
): { domain: string; external: string; fullyErased: boolean } {
  return {
    domain: domainStatus,
    external: erasure ? erasure.providerStatus : 'not_requested',
    fullyErased: domainStatus === 'succeeded' && erasure !== null && erasure.providerStatus === 'completed',
  };
}
