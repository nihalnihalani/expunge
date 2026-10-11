import { z } from 'zod';
import type { EffectKind, Job, ResourceLimits, RunBinding } from './index.js';
import { nativeScalarSchema } from './source.js';

const id = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = count.refine((value) => value > 0, 'RevisionRequired');

/**
 * Native jobs pin the real source and the complete immutable execution profile. No world identifier or
 * model-supplied namespace/subject belongs in this binding. Parsing metadata does not grant authority.
 * The trusted job producer must compare every pin with its stored source, deployment and profile rows.
 */
export const nativeRunBindingSchema = z
  .object({
    dataPlane: z.literal('native_source_v2'),
    jobId: id,
    runId: id,
    sourceId: id,
    sourceRegistrationHash: digest,
    scopeRevision: revision,
    policyRevision: revision,
    authorizationRevision: revision,
    harnessHash: digest,
    authorityFloorHash: digest,
    workerProfileHash: digest,
    runtimeProfileDigest: digest,
    runtimeHash: digest,
  })
  .strict()
  .refine((binding) => binding.workerProfileHash === binding.runtimeProfileDigest, 'ProfilePinMismatch');

export type NativeRunBinding = z.infer<typeof nativeRunBindingSchema>;
export type ExecutableRunBinding = RunBinding | NativeRunBinding;
export type NativeCleanupJob = Omit<Job, 'kind' | 'binding'> & {
  kind: 'cleanup';
  binding: NativeRunBinding;
};
export type ExecutableJob = Job | NativeCleanupJob;
/** A trusted host loads the complete owner-approved spec; a bare floor hash is insufficient to enforce it. */
export type NativeExecutionFloor = {
  readonly hash: string;
  readonly allowedTools: readonly string[];
  readonly allowedEffects: readonly EffectKind[];
  readonly maxLimits: ResourceLimits;
};

export function isNativeRunBinding(value: unknown): value is NativeRunBinding {
  return nativeRunBindingSchema.safeParse(value).success;
}

export function isNativeCleanupJob(job: ExecutableJob): job is NativeCleanupJob {
  return job.kind === 'cleanup' && isNativeRunBinding(job.binding);
}

/** The owner request stores its literal only in the trusted source plane, never in a worker projection. */
export const nativeCleanupRequestInputSchema = z
  .object({ sourceId: id, subjectFieldId: id, subject: nativeScalarSchema })
  .strict()
  .refine((value) => value.subject.bsonType !== 'null', 'SubjectIdentityRequired');
export type NativeCleanupRequestInput = z.infer<typeof nativeCleanupRequestInputSchema>;

/** The host resolves deployment/profile pins; an HTTP caller cannot select its own executable authority. */
export const nativeSubmitInputSchema = z
  .object({ requestKey: id, sourceId: id, cleanupRequestId: id })
  .strict();
export type NativeSubmitInput = z.infer<typeof nativeSubmitInputSchema>;

/** Exact preview decision only. Expiry, targets, actor, scope and grants come from trusted stored state. */
export const nativePreviewDecisionInputSchema = z
  .object({
    decisionKey: id,
    jobId: id,
    previewId: id,
    decision: z.enum(['approve', 'reject']),
  })
  .strict();
export type NativePreviewDecisionInput = z.infer<typeof nativePreviewDecisionInputSchema>;

/**
 * A sanitized approval descriptor contains counts and commitments, never source documents, literal
 * identities, mutation predicates or private expected outcomes. A stored descriptor is not a grant.
 */
export const nativePreviewDescriptorSchema = z
  .object({
    contractVersion: z.literal(2),
    dataPlane: z.literal('native_source_v2'),
    jobId: id,
    previewId: id,
    sourceId: id,
    sourceKind: z.enum(['original', 'isolated_replay']),
    sourceRegistrationHash: digest,
    scopeRevision: revision,
    policyRevision: revision,
    authorizationRevision: revision,
    harnessHash: digest,
    authorityFloorHash: digest,
    runtimeProfileDigest: digest,
    previewHash: digest,
    targetsDigest: digest,
    snapshotDigest: digest,
    observedAt: z.string().datetime({ offset: true }),
    expiresAt: z.string().datetime({ offset: true }),
    targetCount: count.max(1000),
    batchCount: count.max(1000),
    namespaceIds: z.array(id).max(64),
    effects: z.array(z.enum(['delete', 'redact', 'restrict', 'tombstone'])).max(4),
    limitations: z.array(z.string().min(1).max(256)).max(32),
    verificationBoundary: z.literal('registered_source_snapshot'),
    externalWritesAfterSnapshotPossible: z.literal(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Date.parse(value.expiresAt) <= Date.parse(value.observedAt))
      ctx.addIssue({ code: 'custom', message: 'PreviewExpiryInvalid', path: ['expiresAt'] });
    if (new Set(value.namespaceIds).size !== value.namespaceIds.length)
      ctx.addIssue({ code: 'custom', message: 'DuplicateNamespace', path: ['namespaceIds'] });
    if (new Set(value.effects).size !== value.effects.length)
      ctx.addIssue({ code: 'custom', message: 'DuplicateEffect', path: ['effects'] });
    if ((value.targetCount === 0) !== (value.batchCount === 0))
      ctx.addIssue({ code: 'custom', message: 'PreviewBatchCountInvalid', path: ['batchCount'] });
    if (value.batchCount > value.targetCount)
      ctx.addIssue({ code: 'custom', message: 'PreviewBatchCountInvalid', path: ['batchCount'] });
    if (value.targetCount > 0 && (value.namespaceIds.length === 0 || value.effects.length === 0))
      ctx.addIssue({ code: 'custom', message: 'PreviewCoverageMissing' });
  });
export type NativePreviewDescriptor = z.infer<typeof nativePreviewDescriptorSchema>;

/** Tools exchange opaque, stored metadata handles. They cannot supply the trusted cleanup subject or targets. */
export const nativeToolInputSchemas = {
  inspect_scope: z.object({}).strict(),
  resolve_subject: z.object({}).strict(),
  discover_references: z
    .object({
      resolutionId: id,
      fieldIds: z.array(id).max(1024),
      referenceIds: z.array(id).max(256),
      outgoingDepth: count.max(16),
      incomingDepth: count.max(16),
    })
    .strict(),
  preview_cleanup: z.object({ discoveryId: id }).strict(),
  apply_cleanup_batch: z.object({ previewId: id, batchOrdinal: count.max(999) }).strict(),
  verify_registered_scope: z.object({ previewId: id }).strict(),
  complete_cleanup: z.object({ previewId: id, verificationId: id }).strict(),
  inspect_harness: z.object({}).strict(),
  report_diagnostic: z
    .object({
      code: z.enum([
        'discovery_incomplete',
        'policy_denied',
        'approval_required',
        'source_changed',
        'verification_incomplete',
        'resource_bound',
        'tool_failure',
      ]),
    })
    .strict(),
} as const;
export type NativeToolId = keyof typeof nativeToolInputSchemas;
export type NativeToolInputById = {
  [K in NativeToolId]: z.infer<(typeof nativeToolInputSchemas)[K]>;
};
