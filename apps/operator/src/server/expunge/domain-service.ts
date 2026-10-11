import { z } from 'zod';
import type {
  ApprovalDecisionResult,
  ApprovalDescriptorView,
  ArtifactEnvelope,
  CleanupPreview,
  DeploymentView,
  ExpungeJobList,
  ExpungeJobSnapshotV2,
  JobStatus,
  TargetKind,
  WorldSummary,
} from '../../shared/expunge.js';
import {
  APPROVAL_TOKEN,
  JOB_WRITE_TOKEN,
  MIN_TOKEN_LENGTH,
  READ_TOKEN,
} from './config.js';
import {
  approvalDescriptorSchema,
  deploymentSchema,
  domainReadinessSchema,
  jobListSchema,
  parseArtifact,
  parseEventsPage,
  parseWith,
  previewSchema,
  snapshotSchema,
  worldsSchema,
  type DomainReadiness,
  type EventsPage,
} from './schemas.js';

export type DomainErrorCode =
  | 'unreachable'
  | 'timeout'
  | 'tls_error'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'unsupported'
  | 'invalid_request'
  | 'bad_response'
  | 'upstream_error'
  | 'write_principal_missing';

/** Carries a closed code and fixed message only. Upstream bodies and credentials are never reflected. */
export class ExpungeDomainError extends Error {
  constructor(
    readonly code: DomainErrorCode,
    readonly upstreamStatus?: number,
    readonly missing: string[] = [],
  ) {
    super(`Expunge domain request failed: ${code}.`);
    this.name = 'ExpungeDomainError';
  }
}

export type ReadinessProbe =
  | { kind: 'ok'; body: DomainReadiness }
  | { kind: 'error'; code: DomainErrorCode; upstreamStatus?: number };

export interface JobListQuery {
  cursor?: string;
  limit?: number;
  kind?: string;
  status?: string;
}

/** Dependencies are bound by trusted startup code, never by model or client state. */
export interface ExpungeDomainService {
  probeReadiness(signal?: AbortSignal): Promise<ReadinessProbe>;
  listWorlds(signal?: AbortSignal): Promise<WorldSummary[]>;
  previewCleanup(
    input: { worldId: string; subject: { idType: string; value: string } },
    signal?: AbortSignal,
  ): Promise<CleanupPreview>;
  listJobs(query: JobListQuery, signal?: AbortSignal): Promise<ExpungeJobList>;
  submitCleanup(
    input: {
      requestKey: string;
      worldId: string;
      previewId: string;
      subject: { idType: string; value: string };
    },
    signal?: AbortSignal,
  ): Promise<{ jobId: string; status: JobStatus }>;
  readJob(
    jobId: string,
    signal?: AbortSignal,
  ): Promise<ExpungeJobSnapshotV2 | null>;
  readCommittedEvents(
    jobId: string,
    afterSequence: number,
    signal?: AbortSignal,
    limit?: number,
  ): Promise<EventsPage>;
  cancelJob(
    jobId: string,
    input: { reason?: string },
    signal?: AbortSignal,
  ): Promise<{ accepted: boolean; sequence: number | null }>;
  readArtifact(
    artifactId: string,
    query?: { cursor?: string },
    signal?: AbortSignal,
  ): Promise<ArtifactEnvelope | null>;
  readApproval(
    proposalId: string,
    signal?: AbortSignal,
  ): Promise<ApprovalDescriptorView | null>;
  decideApproval(
    proposalId: string,
    input: {
      decision: 'approve' | 'decline';
      descriptorDigest: string;
      toolCallId?: string;
    },
    signal?: AbortSignal,
  ): Promise<ApprovalDecisionResult>;
  readDeployment(
    target: TargetKind,
    signal?: AbortSignal,
  ): Promise<DeploymentView | null>;
  readJobByThread(
    threadId: string,
    signal?: AbortSignal,
  ): Promise<{ jobId: string } | null>;
}

const idParam = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);
const submitResult = z.object({
  jobId: idParam,
  status: z.enum([
    'queued',
    'running',
    'waiting_evidence',
    'waiting_approval',
    'waiting_external',
    'succeeded',
    'failed',
    'cancelled',
  ]),
});
const cancelResult = z.object({
  accepted: z.boolean(),
  sequence: z.number().int().nonnegative().nullable(),
});
const decisionResult = z.object({
  accepted: z.boolean(),
  state: z.enum([
    'pending',
    'approved',
    'declined',
    'expired',
    'consumed',
    'stale',
  ]),
  committedEventSequence: z.number().int().nonnegative().nullable(),
  /** Minted by the database when an approval is committed; absent for a decline. */
  grantId: idParam.nullish(),
});
const threadBinding = z.object({ jobId: idParam });

export interface DomainCredentials {
  /** Read projection principal (EXPUNGE_INTERNAL_TOKEN). */
  readToken: string;
  /** Submit, cancel and operator previews (EXPUNGE_JOB_WRITE_TOKEN). */
  jobWriteToken?: string;
  /** Review decision to the approval issuer (EXPUNGE_APPROVAL_TOKEN). */
  approvalToken?: string;
}

const TIMEOUT_MS = 5000;
const MAX_BYTES = 1_000_000;
const TLS_CODES =
  /^(ERR_TLS_|CERT_|DEPTH_ZERO|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_SSL_)/;

function classifyTransportFailure(error: unknown): DomainErrorCode {
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  const code = typeof cause?.code === 'string' ? cause.code : '';
  if (TLS_CODES.test(code)) return 'tls_error';
  return 'unreachable';
}

function classifyStatus(status: number): DomainErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 501) return 'unsupported';
  if (status === 400 || status === 422) return 'invalid_request';
  return 'upstream_error';
}

/** The backend must authenticate each principal and bind it to a fixed owner and scope. */
export class HttpExpungeDomainService implements ExpungeDomainService {
  constructor(
    private readonly origin: string,
    private readonly credentials: DomainCredentials,
    private readonly ownerId: string,
    private readonly transport: typeof fetch = fetch,
  ) {
    const url = new URL(origin);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      throw new Error('EXPUNGE_DOMAIN_URL must be an HTTP(S) origin.');
    if (credentials.readToken.length < MIN_TOKEN_LENGTH || !ownerId.trim())
      throw new Error(
        'Expunge domain transport requires a service token and owner binding.',
      );
  }

  private writeToken(kind: 'job' | 'approval') {
    const token =
      kind === 'job'
        ? this.credentials.jobWriteToken
        : this.credentials.approvalToken;
    if (!token || token.length < MIN_TOKEN_LENGTH)
      throw new ExpungeDomainError('write_principal_missing', undefined, [
        kind === 'job' ? JOB_WRITE_TOKEN : APPROVAL_TOKEN,
      ]);
    return token;
  }

  /** Returns parsed JSON, or null for 404. Throws ExpungeDomainError otherwise. */
  private async call(
    method: 'GET' | 'POST',
    path: string,
    token: string,
    signal?: AbortSignal,
    body?: unknown,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await this.transport(new URL(path, this.origin), {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'x-expunge-owner-id': this.ownerId,
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)])
          : AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new ExpungeDomainError(classifyTransportFailure(error));
    }
    if (response.status === 404) return null;
    if (!response.ok)
      throw new ExpungeDomainError(
        classifyStatus(response.status),
        response.status,
      );
    // Do not reflect upstream response bodies or credentials in operator errors.
    const reader = response.body?.getReader();
    if (!reader) throw new ExpungeDomainError('bad_response', response.status);
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > MAX_BYTES) {
        await reader.cancel();
        throw new ExpungeDomainError('bad_response', response.status);
      }
      chunks.push(value);
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch {
      throw new ExpungeDomainError('bad_response', response.status);
    }
  }

  private read(path: string, signal?: AbortSignal) {
    return this.call('GET', path, this.credentials.readToken, signal);
  }

  async probeReadiness(signal?: AbortSignal): Promise<ReadinessProbe> {
    try {
      const value = await this.read('/internal/projection/readiness', signal);
      if (value === null) return { kind: 'error', code: 'not_found' };
      return { kind: 'ok', body: parseWith(domainReadinessSchema, value) };
    } catch (error) {
      if (error instanceof ExpungeDomainError)
        return {
          kind: 'error',
          code: error.code,
          upstreamStatus: error.upstreamStatus,
        };
      return { kind: 'error', code: 'bad_response' };
    }
  }

  async listWorlds(signal?: AbortSignal) {
    const value = await this.read('/internal/projection/worlds', signal);
    if (value === null) throw new ExpungeDomainError('not_found', 404);
    return parseWith(worldsSchema, value).worlds;
  }

  async previewCleanup(
    input: { worldId: string; subject: { idType: string; value: string } },
    signal?: AbortSignal,
  ) {
    const value = await this.call(
      'POST',
      '/internal/projection/previews',
      this.writeToken('job'),
      signal,
      input,
    );
    if (value === null) throw new ExpungeDomainError('not_found', 404);
    return parseWith(previewSchema, value);
  }

  async listJobs(query: JobListQuery, signal?: AbortSignal) {
    const params = new URLSearchParams();
    if (query.cursor) params.set('cursor', query.cursor.slice(0, 256));
    if (query.limit)
      params.set('limit', String(Math.min(200, Math.max(1, query.limit))));
    if (query.kind) params.set('kind', query.kind);
    if (query.status) params.set('status', query.status);
    const suffix = params.size ? `?${params}` : '';
    const value = await this.read(`/internal/projection/jobs${suffix}`, signal);
    if (value === null) throw new ExpungeDomainError('not_found', 404);
    return parseWith(jobListSchema, value);
  }

  async submitCleanup(
    input: {
      requestKey: string;
      worldId: string;
      previewId: string;
      subject: { idType: string; value: string };
    },
    signal?: AbortSignal,
  ) {
    const value = await this.call(
      'POST',
      '/internal/projection/jobs',
      this.writeToken('job'),
      signal,
      input,
    );
    if (value === null) throw new ExpungeDomainError('not_found', 404);
    return parseWith(submitResult, value);
  }

  async readJob(jobId: string, signal?: AbortSignal) {
    idParam.parse(jobId);
    const value = await this.read(`/internal/projection/jobs/${jobId}`, signal);
    if (value === null) return null;
    const result = parseWith(snapshotSchema, value);
    if (result.jobId !== jobId)
      throw new ExpungeDomainError('bad_response', 200);
    return result;
  }

  async readCommittedEvents(
    jobId: string,
    afterSequence: number,
    signal?: AbortSignal,
    limit?: number,
  ) {
    idParam.parse(jobId);
    z.number().int().nonnegative().parse(afterSequence);
    const extra = limit ? `&limit=${Math.min(500, Math.max(1, limit))}` : '';
    const value = await this.read(
      `/internal/projection/jobs/${jobId}/events?afterSequence=${afterSequence}${extra}`,
      signal,
    );
    if (value === null) throw new ExpungeDomainError('not_found', 404);
    return parseEventsPage(value, jobId, afterSequence);
  }

  async cancelJob(
    jobId: string,
    input: { reason?: string },
    signal?: AbortSignal,
  ) {
    idParam.parse(jobId);
    const value = await this.call(
      'POST',
      `/internal/projection/jobs/${jobId}/cancel`,
      this.writeToken('job'),
      signal,
      input,
    );
    if (value === null) throw new ExpungeDomainError('not_found', 404);
    return parseWith(cancelResult, value);
  }

  async readArtifact(
    artifactId: string,
    query?: { cursor?: string },
    signal?: AbortSignal,
  ) {
    idParam.parse(artifactId);
    const suffix = query?.cursor
      ? `?cursor=${encodeURIComponent(query.cursor.slice(0, 256))}`
      : '';
    const value = await this.read(
      `/internal/projection/artifacts/${artifactId}${suffix}`,
      signal,
    );
    if (value === null) return null;
    const artifact = parseArtifact(value);
    if (artifact.artifactId !== artifactId)
      throw new ExpungeDomainError('bad_response', 200);
    return artifact;
  }

  async readApproval(proposalId: string, signal?: AbortSignal) {
    idParam.parse(proposalId);
    const value = await this.read(
      `/internal/projection/proposals/${proposalId}`,
      signal,
    );
    if (value === null) return null;
    // A pending descriptor has no grant yet (grants are minted on approval): a missing key is the
    // same as null, so the stored descriptor is identified by proposalId and descriptorDigest.
    return parseWith(approvalDescriptorSchema, {
      grantId: null,
      ...(value as Record<string, unknown>),
    });
  }

  async decideApproval(
    proposalId: string,
    input: {
      decision: 'approve' | 'decline';
      descriptorDigest: string;
      toolCallId?: string;
    },
    signal?: AbortSignal,
  ) {
    idParam.parse(proposalId);
    // Fails first, before any network call, when this operator has no approval credential.
    const token = this.writeToken('approval');
    // The approver comes from the server, never the browser, and the stored descriptor names the
    // digest the decision must match. A pending descriptor has no grant (the database mints it on
    // approval), so the decision is identified by proposalId and descriptorDigest only.
    const descriptor = await this.readApproval(proposalId, signal);
    if (!descriptor) throw new ExpungeDomainError('not_found', 404);
    if (descriptor.state !== 'pending')
      throw new ExpungeDomainError('conflict', 409);
    if (descriptor.descriptorDigest !== input.descriptorDigest)
      throw new ExpungeDomainError('conflict', 409);
    const value = await this.call(
      'POST',
      `/internal/projection/proposals/${proposalId}/decision`,
      token,
      signal,
      { ...input, approverId: this.ownerId },
    );
    if (value === null) throw new ExpungeDomainError('not_found', 404);
    return parseWith(decisionResult, value);
  }

  async readDeployment(target: TargetKind, signal?: AbortSignal) {
    z.enum(['worker', 'improver', 'hider']).parse(target);
    const value = await this.read(
      `/internal/projection/deployments/${target}`,
      signal,
    );
    if (value === null) return null;
    return parseWith(deploymentSchema, value);
  }

  async readJobByThread(threadId: string, signal?: AbortSignal) {
    idParam.parse(threadId);
    const value = await this.read(
      `/internal/projection/threads/${threadId}`,
      signal,
    );
    if (value === null) return null;
    return parseWith(threadBinding, value);
  }
}

export function expungeDomainFromEnv(env: Record<string, string | undefined>) {
  if (!env.EXPUNGE_DOMAIN_URL?.trim()) return undefined;
  return new HttpExpungeDomainService(
    env.EXPUNGE_DOMAIN_URL.trim(),
    {
      readToken: env[READ_TOKEN]?.trim() ?? '',
      jobWriteToken: env[JOB_WRITE_TOKEN]?.trim() || undefined,
      approvalToken: env[APPROVAL_TOKEN]?.trim() || undefined,
    },
    env.OWNER_ID?.trim() || 'opendots-owner',
  );
}
