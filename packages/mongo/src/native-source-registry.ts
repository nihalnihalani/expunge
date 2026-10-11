import { randomUUID } from 'node:crypto';
import type { ClientSession, Document } from 'mongodb';
import {
  contentHash,
  nativeRegistrationHash,
  nativeSourceRegistrationSchema,
  nativeScalarSchema,
  sameScope,
  scopeIdentity,
  type ActorContext,
  type NativeScalar,
  type NativeSourceRegistration,
  type ScopeKey,
} from '@expunge/contracts';
import { AuthorityRepository } from './authority.js';
import { fail, requirePrincipal, scopeFilter, type MongoService } from './client.js';
import { JobRepository, type LeaseBinding } from './jobs.js';
import { ProvenanceRepository } from './provenance.js';
import type { NativePreview } from './native-source-adapter.js';

export type NativeSourceHead = ScopeKey & {
  _id: string;
  sourceId: string;
  ownerActorId: string;
  registrationHash: string;
  revision: number;
  authorizationRevision: number;
  eligible: boolean;
  touches: number;
  updatedAt: Date;
};
export type NativeSourceGrant = ScopeKey & {
  _id: string;
  sourceId: string;
  ownerActorId: string;
  registrationHash: string;
  previousRevision: number;
  authorizationRevision: number;
  reviewId: string;
  expiresAt: Date;
  createdAt: Date;
};
export type NativeJobBinding = ScopeKey & {
  _id: string;
  jobId: string;
  sourceId: string;
  registrationHash: string;
  revision: number;
  authorizationRevision: number;
  ownerActorId: string;
  cleanupRequestId: string;
  subjectFieldId: string;
  subject: NativeScalar;
  createdAt: Date;
};
export type NativeCleanupRequest = ScopeKey & {
  _id: string;
  sourceId: string;
  registrationHash: string;
  ownerActorId: string;
  authorizationRevision: number;
  subjectFieldId: string;
  subject: NativeScalar;
  expiresAt: Date;
  createdAt: Date;
};
export type NativeSourceStatus = {
  registration: 'missing' | 'active' | 'revoked' | 'unsupported';
  permission: 'not_checked' | 'authorized' | 'denied' | 'revoked';
  sourceId: string | null;
  sourceKind: 'original' | 'isolated_replay' | null;
  registrationRevision: number | null;
  policyRevision: number | null;
  authorizationRevision: number | null;
  sourceRegistrationHash: string | null;
};
export type NativePreviewApproval = ScopeKey & {
  _id: string;
  jobId: string;
  sourceId: string;
  registrationHash: string;
  previewHash: string;
  targetsDigest: string;
  ownerActorId: string;
  authorizationRevision: number;
  expiresAt: Date;
  createdAt: Date;
};
type RegistrationRow = {
  _id: string;
  registrationHash: string;
  registration: NativeSourceRegistration;
  createdAt: Date;
};
export function nativeSourceHeadId(key: ScopeKey, sourceId: string): string {
  return contentHash({ scope: scopeIdentity(key), sourceId }, 'native-source-head-v2');
}

/** Trusted registry. Caller configuration is never an active capability without a stored owner grant. */
export class NativeSourceRepository {
  readonly authority: AuthorityRepository;
  readonly jobs: JobRepository;
  constructor(readonly service: MongoService) {
    this.authority = new AuthorityRepository(service);
    this.jobs = new JobRepository(service);
  }
  private headId(key: ScopeKey, sourceId: string): string {
    return nativeSourceHeadId(key, sourceId);
  }
  private get heads() {
    return this.service.control.collection<NativeSourceHead>('native_source_heads');
  }
  private get grants() {
    return this.service.control.collection<NativeSourceGrant>('native_source_owner_grants');
  }
  private get registrations() {
    return this.service.control.collection<RegistrationRow>('native_source_registrations');
  }
  private get bindings() {
    return this.service.control.collection<NativeJobBinding>('native_source_job_bindings');
  }

  /** Sanitized owner-scoped readiness, derived from current authority and eligibility; no records or namespaces. */
  async status(actor: ActorContext, sourceId: string): Promise<NativeSourceStatus> {
    const missing: NativeSourceStatus = {
      registration: 'missing',
      permission: 'not_checked',
      sourceId: null,
      sourceKind: null,
      registrationRevision: null,
      policyRevision: null,
      authorizationRevision: null,
      sourceRegistrationHash: null,
    };
    const head = await this.heads.findOne({
      _id: this.headId(actor, sourceId),
      ...scopeFilter(actor),
      ownerActorId: actor.actorId,
    });
    if (!head) return missing;
    const row = await this.registrations.findOne({ _id: head.registrationHash });
    const parsed = nativeSourceRegistrationSchema.safeParse(row?.registration);
    if (!parsed.success || nativeRegistrationHash(parsed.data) !== head.registrationHash)
      return { ...missing, sourceId, registration: 'unsupported', permission: 'denied' };
    const source = parsed.data;
    if (source.ownerReview.actorId !== actor.actorId || !sameScope(actor, source.scope)) return missing;
    const result: NativeSourceStatus = {
      registration: head.eligible ? 'active' : 'revoked',
      permission: head.eligible ? 'not_checked' : 'revoked',
      sourceId,
      sourceKind: source.sourceKind,
      registrationRevision: source.revision,
      policyRevision: source.policyRevision,
      authorizationRevision: source.authorizationRevision,
      sourceRegistrationHash: head.registrationHash,
    };
    if (!head.eligible) return result;
    if (
      await this.service.control
        .collection<Document & { _id: string }>('native_source_gap_barriers')
        .findOne({ _id: this.headId(actor, sourceId), blocked: true })
    )
      return { ...result, registration: 'unsupported', permission: 'denied' };
    const authority = await this.authority.read(actor);
    if (
      authority.authorizationRevision !== actor.authorizationRevision ||
      head.authorizationRevision !== actor.authorizationRevision
    )
      return { ...result, permission: 'denied' };
    if ((await new ProvenanceRepository(this.service).tainted(actor, [head.registrationHash])).size)
      return { ...result, registration: 'revoked', permission: 'revoked' };
    return { ...result, permission: 'authorized' };
  }

  async list(actor: ActorContext, limit = 25): Promise<NativeSourceStatus[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 64) fail('NativeSourceListBound');
    const heads = await this.heads
      .find(
        { ...scopeFilter(actor), ownerActorId: actor.actorId },
        { projection: { sourceId: 1 }, sort: { sourceId: 1 }, limit, maxTimeMS: 5000 },
      )
      .toArray();
    const results: NativeSourceStatus[] = [];
    for (const head of heads) {
      const state = await this.status(actor, head.sourceId);
      if (state.registration !== 'missing') results.push(state);
    }
    return results;
  }

  async approveCleanupRequest(
    actor: ActorContext,
    sourceId: string,
    subjectFieldId: string,
    subject: NativeScalar,
    expiresAt: Date,
  ): Promise<NativeCleanupRequest> {
    requirePrincipal(this.service, ['approval_issuer']);
    const value = nativeScalarSchema.parse(subject);
    if (
      value.bsonType === 'null' ||
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt <= new Date() ||
      expiresAt.getTime() - Date.now() > 24 * 60 * 60 * 1000
    )
      fail('NativeCleanupRequestInvalid');
    return this.service.transaction(async (session) => {
      const source = await this.readCurrent(actor, sourceId, session);
      await this.authority.fence(actor, actor.authorizationRevision, session);
      const field = source.fields.find((value) => value.fieldId === subjectFieldId);
      if (
        !field ||
        !source.subjectIdentityFieldIds.includes(subjectFieldId) ||
        !field.identity ||
        !field.bsonTypes.includes(value.bsonType)
      )
        fail('NativeSubjectFieldInvalid');
      const request: NativeCleanupRequest = {
        _id: randomUUID(),
        ...scopeFilter(actor),
        sourceId,
        registrationHash: nativeRegistrationHash(source),
        ownerActorId: actor.actorId,
        authorizationRevision: actor.authorizationRevision,
        subjectFieldId,
        subject: value,
        expiresAt,
        createdAt: new Date(),
      };
      await this.service.control
        .collection<NativeCleanupRequest>('native_source_cleanup_requests')
        .insertOne(request, { session });
      return request;
    });
  }

  /** Exact stored preview approval; caller/UI supplies only a handle, never targets or destructive authority. */
  async approvePreview(
    actor: ActorContext,
    jobId: string,
    previewId: string,
    expiresAt: Date,
  ): Promise<NativePreviewApproval> {
    requirePrincipal(this.service, ['approval_issuer']);
    if (
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt <= new Date() ||
      expiresAt.getTime() - Date.now() > 24 * 60 * 60 * 1000
    )
      fail('NativePreviewApprovalInvalid');
    return this.service.transaction(async (session) => {
      const source = await this.forJob(actor, jobId, session);
      const job = await this.jobs.readAuthorized(actor, jobId, session);
      if (job.cancellationRequested || job.status !== 'running') fail('NativePreviewJobNotRunning');
      await this.authority.fence(actor, actor.authorizationRevision, session);
      const preview = await this.service.control
        .collection<NativePreview>('native_source_previews')
        .findOne(
          { _id: previewId, ...scopeFilter(actor), jobId, registrationHash: nativeRegistrationHash(source) },
          { session },
        );
      if (!preview) fail('NativePreviewMissingOrStale');
      const approval: NativePreviewApproval = {
        _id: randomUUID(),
        ...scopeFilter(actor),
        jobId,
        sourceId: source.sourceId,
        registrationHash: nativeRegistrationHash(source),
        previewHash: preview.previewHash,
        targetsDigest: contentHash(preview.targets, 'native-preview-targets-v2'),
        ownerActorId: actor.actorId,
        authorizationRevision: actor.authorizationRevision,
        expiresAt,
        createdAt: new Date(),
      };
      await this.service.control
        .collection<NativePreviewApproval>('native_source_preview_approvals')
        .insertOne(approval, { session });
      return approval;
    });
  }

  async issueOwnerGrant(
    actor: ActorContext,
    input: NativeSourceRegistration,
    previousRevision: number,
    expiresAt: Date,
  ): Promise<NativeSourceGrant> {
    requirePrincipal(this.service, ['approval_issuer']);
    const registration = nativeSourceRegistrationSchema.parse(input);
    if (
      !sameScope(actor, registration.scope) ||
      actor.actorId !== registration.ownerReview.actorId ||
      actor.authorizationRevision !== registration.authorizationRevision ||
      !Number.isSafeInteger(previousRevision) ||
      previousRevision < 0 ||
      registration.revision !== previousRevision + 1 ||
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt <= new Date() ||
      expiresAt.getTime() - Date.now() > 24 * 60 * 60 * 1000
    )
      fail('NativeOwnerGrantBindingMismatch');
    return this.service.transaction(async (session) => {
      await this.authority.fence(actor, actor.authorizationRevision, session);
      const head = await this.heads.findOne({ _id: this.headId(actor, registration.sourceId) }, { session });
      if ((head?.revision ?? 0) !== previousRevision) fail('NativeSourceRevisionStale');
      const grant: NativeSourceGrant = {
        _id: randomUUID(),
        ...scopeFilter(actor),
        sourceId: registration.sourceId,
        ownerActorId: actor.actorId,
        registrationHash: nativeRegistrationHash(registration),
        previousRevision,
        authorizationRevision: actor.authorizationRevision,
        reviewId: registration.ownerReview.reviewId,
        expiresAt,
        createdAt: new Date(),
      };
      await this.grants.insertOne(grant, { session });
      return grant;
    });
  }

  async install(actor: ActorContext, input: NativeSourceRegistration, grantId: string): Promise<string> {
    requirePrincipal(this.service, ['setup']);
    const registration = nativeSourceRegistrationSchema.parse(input);
    const hash = nativeRegistrationHash(registration);
    if (
      registration.namespaces.some(
        (namespace) =>
          namespace.database === this.service.control.databaseName ||
          namespace.database === this.service.privateDb?.databaseName,
      ) ||
      (registration.effectJournal &&
        (registration.effectJournal.database === this.service.privateDb?.databaseName ||
          registration.effectJournal.database === this.service.control.databaseName))
    )
      fail('NativeSourceCollidesWithAuthorityStorage');
    if (
      !sameScope(actor, registration.scope) ||
      registration.ownerReview.actorId !== actor.actorId ||
      registration.authorizationRevision !== actor.authorizationRevision
    )
      fail('NativeOwnerGrantBindingMismatch');
    return this.service.transaction(async (session) => {
      await this.authority.fence(actor, registration.authorizationRevision, session);
      const grant = await this.grants.findOne(
        {
          _id: grantId,
          ...scopeFilter(actor),
          sourceId: registration.sourceId,
          ownerActorId: actor.actorId,
          registrationHash: hash,
          previousRevision: registration.revision - 1,
          authorizationRevision: registration.authorizationRevision,
          reviewId: registration.ownerReview.reviewId,
          $expr: { $gt: ['$expiresAt', '$$NOW'] },
        },
        { session },
      );
      if (!grant) fail('NativeOwnerGrantMissingOrExpired');
      await this.service.control
        .collection<Document & { _id: string }>('native_source_grant_consumptions')
        .insertOne(
          {
            _id: grantId,
            ...scopeFilter(actor),
            sourceId: registration.sourceId,
            registrationHash: hash,
            createdAt: new Date(),
          },
          { session },
        );
      await this.registrations.insertOne(
        { _id: hash, registrationHash: hash, registration, createdAt: new Date() },
        { session },
      );
      const _id = this.headId(actor, registration.sourceId);
      const gap = await this.service.control
        .collection<Document & { _id: string }>('native_source_gap_barriers')
        .findOne({ _id, blocked: true }, { session });
      if (gap && registration.revision <= gap.registrationRevision)
        fail('NativeSourceReviewedRebaselineRequired');
      if (registration.revision === 1)
        await this.heads.insertOne(
          {
            _id,
            ...scopeFilter(actor),
            sourceId: registration.sourceId,
            ownerActorId: actor.actorId,
            registrationHash: hash,
            revision: 1,
            authorizationRevision: registration.authorizationRevision,
            eligible: true,
            touches: 0,
            updatedAt: new Date(),
          },
          { session },
        );
      else {
        const updated = await this.heads.updateOne(
          { _id, ...scopeFilter(actor), ownerActorId: actor.actorId, revision: registration.revision - 1 },
          {
            $set: {
              registrationHash: hash,
              revision: registration.revision,
              authorizationRevision: registration.authorizationRevision,
              eligible: true,
            },
            $inc: { touches: 1 },
            $currentDate: { updatedAt: true },
          },
          { session },
        );
        if (updated.matchedCount !== 1) fail('NativeSourceRevisionStale');
      }
      if (gap) {
        const reset = await this.service.control
          .collection<Document & { _id: string }>('native_source_gap_barriers')
          .updateOne(
            { _id, blocked: true, registrationHash: gap.registrationHash },
            { $set: { blocked: false, rebaselineHash: hash }, $currentDate: { updatedAt: true } },
            { session },
          );
        if (reset.matchedCount !== 1) fail('NativeSourceReviewedRebaselineRequired');
        await this.service.control
          .collection<Document & { _id: string }>('native_source_consistency_events')
          .insertOne(
            {
              _id: randomUUID(),
              ...scopeFilter(actor),
              jobId: 'owner-reviewed-rebaseline',
              sourceId: registration.sourceId,
              registrationHash: hash,
              namespaceId: gap.namespaceId,
              kind: 'rebaseline',
              reason: 'owner_reviewed_next_registration',
              recovery: 'fresh_job_snapshot_required',
              createdAt: new Date(),
            },
            { session },
          );
      }
      return hash;
    });
  }

  async readCurrent(
    actor: ActorContext,
    sourceId: string,
    session?: ClientSession,
  ): Promise<NativeSourceRegistration> {
    const head = await this.heads.findOne(
      {
        _id: this.headId(actor, sourceId),
        ...scopeFilter(actor),
        ownerActorId: actor.actorId,
        eligible: true,
      },
      { session },
    );
    if (!head || head.authorizationRevision !== actor.authorizationRevision) fail('NativeSourceNotEligible');
    if (
      await this.service.control
        .collection<Document & { _id: string }>('native_source_gap_barriers')
        .findOne({ _id: this.headId(actor, sourceId), blocked: true }, { session })
    )
      fail('NativeSourceReviewedRebaselineRequired');
    const row = await this.registrations.findOne({ _id: head.registrationHash }, { session });
    if (!row) fail('NativeSourceRegistrationMissing');
    const registration = nativeSourceRegistrationSchema.parse(row.registration);
    if (registration.ownerReview.actorId !== actor.actorId) fail('NativeSourceOwnerMismatch');
    if (
      nativeRegistrationHash(registration) !== head.registrationHash ||
      !sameScope(actor, registration.scope) ||
      registration.revision !== head.revision ||
      registration.authorizationRevision !== head.authorizationRevision
    )
      fail('NativeSourceRegistrationCorrupt');
    const authority = await this.authority.read(actor, session);
    if (authority.authorizationRevision !== registration.authorizationRevision)
      fail('AuthorityRevisionStale');
    if ((await new ProvenanceRepository(this.service).tainted(actor, [head.registrationHash], session)).size)
      fail('NativeSourceRetracted');
    return registration;
  }

  async bindJob(
    actor: ActorContext,
    jobId: string,
    sourceId: string,
    cleanupRequestId: string,
  ): Promise<NativeJobBinding> {
    requirePrincipal(this.service, ['domain_executor', 'setup']);
    return this.service.transaction(async (session) => {
      const job = await this.jobs.readAuthorized(actor, jobId, session);
      if (job.kind !== 'cleanup') fail('NativeSourceRequiresCleanupJob');
      const source = await this.readCurrent(actor, sourceId, session);
      if (job.binding.scopeRevision !== source.revision) fail('NativeSourceJobRevisionMismatch');
      await this.authority.fence(actor, source.authorizationRevision, session);
      const request = await this.service.control
        .collection<NativeCleanupRequest>('native_source_cleanup_requests')
        .findOne(
          {
            _id: cleanupRequestId,
            ...scopeFilter(actor),
            sourceId,
            registrationHash: nativeRegistrationHash(source),
            ownerActorId: actor.actorId,
            authorizationRevision: actor.authorizationRevision,
            $expr: { $gt: ['$expiresAt', '$$NOW'] },
          },
          { session },
        );
      if (!request) fail('NativeCleanupRequestMissingOrExpired');
      const binding: NativeJobBinding = {
        _id: jobId,
        ...scopeFilter(actor),
        jobId,
        sourceId,
        registrationHash: nativeRegistrationHash(source),
        revision: source.revision,
        authorizationRevision: source.authorizationRevision,
        ownerActorId: actor.actorId,
        cleanupRequestId,
        subjectFieldId: request.subjectFieldId,
        subject: request.subject,
        createdAt: new Date(),
      };
      await this.bindings.insertOne(binding, { session });
      return binding;
    });
  }

  async jobBinding(actor: ActorContext, jobId: string, session?: ClientSession): Promise<NativeJobBinding> {
    await this.forJob(actor, jobId, session);
    const binding = await this.bindings.findOne(
      { _id: jobId, ...scopeFilter(actor), ownerActorId: actor.actorId },
      { session },
    );
    if (!binding) fail('NativeSourceJobBindingMissing');
    return binding;
  }

  async forJob(
    actor: ActorContext,
    jobId: string,
    session?: ClientSession,
  ): Promise<NativeSourceRegistration> {
    const job = await this.jobs.readAuthorized(actor, jobId, session);
    const binding = await this.bindings.findOne(
      { _id: jobId, ...scopeFilter(actor), ownerActorId: actor.actorId },
      { session },
    );
    if (!binding || job.kind !== 'cleanup') fail('NativeSourceJobBindingMissing');
    const source = await this.readCurrent(actor, binding.sourceId, session);
    if (
      binding.registrationHash !== nativeRegistrationHash(source) ||
      binding.revision !== source.revision ||
      binding.authorizationRevision !== actor.authorizationRevision ||
      job.binding.scopeRevision !== source.revision
    )
      fail('NativeSourceJobRevisionMismatch');
    const request = await this.service.control
      .collection<NativeCleanupRequest>('native_source_cleanup_requests')
      .findOne(
        {
          _id: binding.cleanupRequestId,
          ...scopeFilter(actor),
          ownerActorId: actor.actorId,
          sourceId: binding.sourceId,
          registrationHash: binding.registrationHash,
          authorizationRevision: actor.authorizationRevision,
          $expr: { $gt: ['$expiresAt', '$$NOW'] },
        },
        { session },
      );
    if (
      !request ||
      request.subjectFieldId !== binding.subjectFieldId ||
      contentHash(request.subject, 'native-request-subject-v2') !==
        contentHash(binding.subject, 'native-request-subject-v2')
    )
      fail('NativeCleanupRequestMissingOrExpired');
    return source;
  }

  async fence(
    actor: ActorContext,
    lease: LeaseBinding,
    hash: string,
    session: ClientSession,
  ): Promise<NativeSourceRegistration> {
    const job = await this.jobs.fence(actor, lease, session);
    await new ProvenanceRepository(this.service).fenceUse(
      actor,
      [job.binding.harnessHash, ...(job.contextInputs ?? [])],
      session,
    );
    await this.authority.fence(actor, actor.authorizationRevision, session);
    const source = await this.forJob(actor, lease.jobId, session);
    if (nativeRegistrationHash(source) !== hash) fail('NativeSourceRevisionStale');
    const touched = await this.heads.updateOne(
      {
        _id: this.headId(actor, source.sourceId),
        ...scopeFilter(actor),
        registrationHash: hash,
        eligible: true,
        ownerActorId: actor.actorId,
        authorizationRevision: actor.authorizationRevision,
      },
      { $inc: { touches: 1 } },
      { session },
    );
    if (touched.matchedCount !== 1) fail('NativeSourceRevisionStale');
    return source;
  }

  async revoke(actor: ActorContext, sourceId: string): Promise<void> {
    requirePrincipal(this.service, ['privacy_controller', 'approval_issuer', 'setup']);
    await this.service.transaction(async (session) => {
      const changed = await this.heads.updateOne(
        { _id: this.headId(actor, sourceId), ...scopeFilter(actor), ownerActorId: actor.actorId },
        { $set: { eligible: false }, $inc: { touches: 1 }, $currentDate: { updatedAt: true } },
        { session },
      );
      if (changed.matchedCount !== 1) fail('NativeSourceRegistrationMissing');
      await this.service.control.collection('jobs').updateMany(
        {
          'actor.tenantId': actor.tenantId,
          'actor.env': actor.env,
          'actor.scopeId': actor.scopeId,
          status: { $nin: ['succeeded', 'failed', 'cancelled'] },
        },
        { $set: { cancellationRequested: true }, $currentDate: { updatedAt: true } },
        { session },
      );
    });
  }
}
