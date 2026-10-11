import { expect, it } from 'vitest';
import { describeSourceReadiness } from '../src/server/expunge/readiness.js';
import { sourceReadinessSchema } from '../src/server/expunge/schemas.js';
import {
  cleanupReadinessPassed,
  type ReadinessCheck,
  type SourceReadinessView,
} from '../src/shared/expunge.js';

// Pure state DTO/counterexample checks. These are not source, service or live readiness evidence.
const observedAt = '2026-10-11T19:30:00.000Z';
const binding: SourceReadinessView = {
  registration: 'active',
  permission: 'authorized',
  sourceId: 'metadata-source',
  sourceKind: 'original',
  sourceRegistrationHash: 'a'.repeat(64),
  registrationRevision: 1,
  policyRevision: 2,
  authorizationRevision: 3,
};
const pass: ReadinessCheck = {
  status: 'pass',
  reason: null,
  missing: [],
  detail: '',
  observedAt,
};

it('blocks when the producer has not reported source registration', () => {
  for (const value of [undefined, null]) {
    const checks = describeSourceReadiness(value, observedAt);
    expect(checks.sourceRegistered).toMatchObject({
      status: 'fail',
      reason: 'source_registration_unreported',
    });
    expect(checks.cleanupAuthorized.status).toBe('unknown');
  }
});

it('preserves missing, revoked and unsupported registration states', () => {
  for (const registration of ['missing', 'revoked', 'unsupported'] as const) {
    const checks = describeSourceReadiness(
      { ...binding, registration, permission: 'not_checked' },
      observedAt,
    );
    expect(checks.sourceRegistered).toMatchObject({
      status: 'fail',
      reason: `source_${registration}`,
    });
    expect(checks.cleanupAuthorized.status).toBe('unknown');
  }
});

it('does not turn an active registration into cleanup permission', () => {
  for (const permission of ['not_checked', 'denied', 'revoked'] as const) {
    const checks = describeSourceReadiness(
      { ...binding, permission },
      observedAt,
    );
    expect(checks.sourceRegistered.status).toBe('pass');
    expect(checks.cleanupAuthorized).toMatchObject({
      status: 'fail',
      reason: `cleanup_permission_${permission}`,
    });
  }
});

it('cannot turn legacy fixture status into real-source readiness', () => {
  const checks = describeSourceReadiness(binding, observedAt, 'fixture');
  expect(checks.sourceRegistered.reason).toBe('legacy_backend');
  expect(checks.cleanupAuthorized.status).toBe('fail');
});

it('requires all cleanup prerequisite checks and a live backend', () => {
  const checks = {
    backend: { kind: 'live' as const, version: null },
    configured: pass,
    reachable: pass,
    authorized: pass,
    ...describeSourceReadiness(binding, observedAt),
  };
  expect(cleanupReadinessPassed(checks)).toBe(true);
  for (const key of [
    'configured',
    'reachable',
    'authorized',
    'sourceRegistered',
    'cleanupAuthorized',
  ] as const)
    expect(
      cleanupReadinessPassed({
        ...checks,
        [key]: { ...pass, status: 'unknown' },
      }),
    ).toBe(false);
  expect(
    cleanupReadinessPassed({ ...checks, sourceRegistered: undefined }),
  ).toBe(false);
  expect(
    cleanupReadinessPassed({
      ...checks,
      backend: { kind: 'fixture', version: null },
    }),
  ).toBe(false);
  expect(cleanupReadinessPassed(undefined)).toBe(false);
});

it('refuses incomplete or contradictory registration DTOs and unsafe revisions', () => {
  expect(sourceReadinessSchema.safeParse(binding).success).toBe(true);
  for (const key of [
    'sourceId',
    'sourceKind',
    'sourceRegistrationHash',
    'registrationRevision',
    'policyRevision',
    'authorizationRevision',
  ])
    expect(
      sourceReadinessSchema.safeParse({ ...binding, [key]: null }).success,
    ).toBe(false);
  expect(
    sourceReadinessSchema.safeParse({ ...binding, registration: 'revoked' })
      .success,
  ).toBe(false);
  for (const value of [0, -1, 0.5, Number.MAX_SAFE_INTEGER + 1])
    expect(
      sourceReadinessSchema.safeParse({ ...binding, policyRevision: value })
        .success,
    ).toBe(false);
});

it('strips unknown metadata before the DTO is forwarded', () => {
  const dto = sourceReadinessSchema.parse({
    ...binding,
    privateExpectedManifest: 'must-not-forward',
  });
  expect(dto).not.toHaveProperty('privateExpectedManifest');
});
