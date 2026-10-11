import { describe, expect, it } from 'vitest';
import {
  nativeCleanupRequestInputSchema,
  nativePreviewDescriptorSchema,
  nativePreviewDecisionInputSchema,
  nativeRunBindingSchema,
  nativeSubmitInputSchema,
  nativeToolInputSchemas,
} from '../src/native-run.js';

// Metadata grammar only: no business records, service responses, runtime attestation or asserted grants.
const digest = 'a'.repeat(64);
const binding = {
  dataPlane: 'native_source_v2',
  jobId: 'job-reference',
  runId: 'run-reference',
  sourceId: 'source-reference',
  sourceRegistrationHash: digest,
  scopeRevision: 1,
  policyRevision: 1,
  authorizationRevision: 1,
  harnessHash: digest,
  authorityFloorHash: digest,
  workerProfileHash: digest,
  runtimeProfileDigest: digest,
  runtimeHash: digest,
};

describe('native job and tool metadata boundary', () => {
  it('pins the full profile and refuses a generated-world binding', () => {
    expect(nativeRunBindingSchema.safeParse(binding).success).toBe(true);
    expect(nativeRunBindingSchema.safeParse({ ...binding, worldId: 'world-reference' }).success).toBe(false);
    expect(nativeRunBindingSchema.safeParse({ ...binding, dataPlane: 'generated_world' }).success).toBe(
      false,
    );
    expect(
      nativeRunBindingSchema.safeParse({ ...binding, runtimeProfileDigest: 'b'.repeat(64) }).success,
    ).toBe(false);
  });
  it.each([0, -1, Number.MAX_SAFE_INTEGER + 1, Infinity])('refuses invalid pinned revision %s', (value) => {
    expect(nativeRunBindingSchema.safeParse({ ...binding, authorizationRevision: value }).success).toBe(
      false,
    );
  });
  it('refuses executable authority and raw targets on an untrusted submission or decision', () => {
    const submit = {
      requestKey: 'request-key',
      sourceId: 'source-reference',
      cleanupRequestId: 'request-reference',
    };
    const decision = {
      decisionKey: 'decision-key',
      jobId: 'job-reference',
      previewId: 'preview-reference',
      decision: 'approve',
    };
    for (const key of [
      'harnessHash',
      'workerProfileHash',
      'subject',
      'targets',
      'actor',
      'scope',
      'worldId',
    ]) {
      expect(nativeSubmitInputSchema.safeParse({ ...submit, [key]: 'untrusted' }).success).toBe(false);
      expect(nativePreviewDecisionInputSchema.safeParse({ ...decision, [key]: 'untrusted' }).success).toBe(
        false,
      );
    }
    expect(nativeSubmitInputSchema.safeParse(submit).success).toBe(true);
    expect(nativePreviewDecisionInputSchema.safeParse(decision).success).toBe(true);
  });
  it('keeps stored subjects, target identities and raw diagnostic text outside model tool inputs', () => {
    expect(nativeToolInputSchemas.resolve_subject.safeParse({}).success).toBe(true);
    expect(nativeToolInputSchemas.resolve_subject.safeParse({ subject: 'untrusted' }).success).toBe(false);
    expect(
      nativeToolInputSchemas.apply_cleanup_batch.safeParse({
        previewId: 'preview-reference',
        batchOrdinal: 0,
        targets: [],
      }).success,
    ).toBe(false);
    expect(
      nativeToolInputSchemas.report_diagnostic.safeParse({ code: 'tool_failure', text: 'untrusted' }).success,
    ).toBe(false);
  });
  it('refuses an absent identity and an out-of-range batch handle before storage or source access', () => {
    expect(
      nativeCleanupRequestInputSchema.safeParse({
        sourceId: 'source-reference',
        subjectFieldId: 'field-reference',
        subject: { bsonType: 'null', value: null },
      }).success,
    ).toBe(false);
    expect(
      nativeToolInputSchemas.apply_cleanup_batch.safeParse({
        previewId: 'preview-reference',
        batchOrdinal: 1000,
      }).success,
    ).toBe(false);
  });
  it('bounds descriptor grammar and refuses private data or an eradication claim', () => {
    const descriptor = {
      contractVersion: 2,
      dataPlane: binding.dataPlane,
      jobId: binding.jobId,
      previewId: 'preview-reference',
      sourceId: binding.sourceId,
      sourceKind: 'isolated_replay',
      sourceRegistrationHash: digest,
      scopeRevision: 1,
      policyRevision: 1,
      authorizationRevision: 1,
      harnessHash: digest,
      authorityFloorHash: digest,
      runtimeProfileDigest: digest,
      previewHash: digest,
      targetsDigest: digest,
      snapshotDigest: digest,
      observedAt: '2026-10-12T00:00:00Z',
      expiresAt: '2026-10-12T01:00:00Z',
      targetCount: 0,
      batchCount: 0,
      namespaceIds: [],
      effects: [],
      limitations: [],
      verificationBoundary: 'registered_source_snapshot',
      externalWritesAfterSnapshotPossible: true,
    };
    expect(nativePreviewDescriptorSchema.safeParse(descriptor).success).toBe(true);
    for (const changed of [
      { targets: [] },
      { subject: null },
      { expectedEffects: [] },
      { worldId: 'untrusted' },
      { externalWritesAfterSnapshotPossible: false },
      { targetCount: 1 },
      { batchCount: 1 },
      { targetCount: 1001 },
      { expiresAt: descriptor.observedAt },
      { namespaceIds: ['namespace-reference', 'namespace-reference'] },
    ])
      expect(nativePreviewDescriptorSchema.safeParse({ ...descriptor, ...changed }).success).toBe(false);
  });
});
