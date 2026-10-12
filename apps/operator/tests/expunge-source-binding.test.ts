import { expect, it } from 'vitest';
import { previewStale } from '../src/client/expunge/lib/preview.js';
import { describeSourceReadiness } from '../src/server/expunge/readiness.js';
import { sourceBindingSchema } from '../src/server/expunge/schemas.js';
import {
  cleanupReadinessPassed,
  SOURCE_ENVIRONMENTS,
  sourceBindingMatchesReadiness,
  sourceBindingsEqual,
  sourceEnvironmentAllowed,
  sourceScopeReady,
  type Environment,
  type ReadinessCheck,
  type SourceBindingView,
  type SourceReadinessView,
} from '../src/shared/expunge.js';

// Operational binding DTOs only: no subject, records, effect counts, receipt or provider response.
const source: SourceBindingView = {
  sourceId: 'metadata-source',
  sourceKind: 'original',
  registrationHash: 'a'.repeat(64),
  registrationRevision: 1,
  policyRevision: 2,
  authorizationRevision: 3,
};
const status: SourceReadinessView = {
  ...source,
  sourceRegistrationHash: source.registrationHash,
  registration: 'active',
  permission: 'authorized',
};

it('compares every source identity, hash and revision and never matches absent bindings', () => {
  expect(sourceBindingsEqual(source, { ...source })).toBe(true);
  for (const patch of [
    { sourceId: 'another-source' },
    { sourceKind: 'isolated_replay' as const },
    { registrationHash: 'b'.repeat(64) },
    { registrationRevision: 2 },
    { policyRevision: 3 },
    { authorizationRevision: 4 },
  ]) {
    expect(sourceBindingsEqual(source, { ...source, ...patch })).toBe(false);
    const next = { ...source, ...patch };
    expect(sourceBindingMatchesReadiness(next, status)).toBe(false);
  }
  expect(sourceBindingsEqual(undefined, undefined)).toBe(false);
  expect(sourceBindingMatchesReadiness(source, undefined)).toBe(false);
  expect(
    sourceBindingMatchesReadiness(source, {
      ...status,
      registration: 'revoked',
    }),
  ).toBe(false);
});

it('rejects unsafe source-binding DTO revisions and strips unexpected metadata', () => {
  expect(
    sourceBindingSchema.parse({ ...source, privateTruth: 'not-for-browser' }),
  ).toEqual(source);
  expect(
    sourceBindingSchema.safeParse({
      ...source,
      authorizationRevision: Number.MAX_SAFE_INTEGER + 1,
    }).success,
  ).toBe(false);
  expect(
    sourceBindingSchema.safeParse({ ...source, registrationHash: 'unbound' })
      .success,
  ).toBe(false);
});

it('invalidates previews at expiry, on scope substitution and on changed source authority', () => {
  const expiresAt = '2026-10-11T20:00:00.000Z';
  const expiry = Date.parse(expiresAt);
  const preview = {
    worldId: 'scope-one',
    expiresAt,
    worldRevision: 1,
    scopeRevision: 1,
    source,
  };
  const world = {
    worldId: 'scope-one',
    maintenanceMode: false,
    worldRevision: 1,
    scopeRevision: 1,
    source,
  };
  expect(previewStale(preview, world, expiry - 1)).toBe(null);
  expect(previewStale(preview, world, expiry)).toMatch(/expired/);
  expect(
    previewStale(preview, { ...world, worldId: 'scope-two' }, expiry - 1),
  ).toMatch(/different source scope/);
  expect(
    previewStale(
      preview,
      { ...world, source: { ...source, policyRevision: 3 } },
      expiry - 1,
    ),
  ).toMatch(/current registered source/);
  expect(
    previewStale(
      { ...preview, source: undefined },
      { ...world, source: undefined },
      expiry - 1,
    ),
  ).toMatch(/current registered source/);
});

// The New cleanup gate (server transport gate and view share sourceScopeReady + cleanupReadinessPassed).
const replay: SourceBindingView = {
  ...source,
  sourceId: 'replay:world_0123456789abcdef01234567',
  sourceKind: 'isolated_replay',
};
const replayStatus: SourceReadinessView = {
  ...replay,
  sourceRegistrationHash: replay.registrationHash,
  registration: 'active',
  permission: 'authorized',
};
const observedAt = '2026-10-11T19:30:00.000Z';
const pass: ReadinessCheck = {
  status: 'pass',
  reason: null,
  missing: [],
  detail: '',
  observedAt,
};
const cleanupReady = (
  world: { env: Environment; source?: SourceBindingView },
  reported: SourceReadinessView | null,
) =>
  cleanupReadinessPassed({
    backend: { kind: 'live', version: null },
    configured: pass,
    reachable: pass,
    authorized: pass,
    ...describeSourceReadiness(reported, observedAt),
  }) && sourceScopeReady(world, reported);

it('allows an isolated replay copy bound to the reported registration in the demo environment', () => {
  expect(cleanupReady({ env: 'demo', source: replay }, replayStatus)).toBe(
    true,
  );
  expect(sourceEnvironmentAllowed('demo', replay)).toBe(true);
  for (const env of SOURCE_ENVIRONMENTS)
    expect(cleanupReady({ env, source: replay }, replayStatus)).toBe(true);
});

it('keeps an original source blocked outside staging and production', () => {
  for (const env of ['demo', 'dev', 'evaluation'] as const) {
    expect(sourceEnvironmentAllowed(env, source)).toBe(false);
    expect(cleanupReady({ env, source }, status)).toBe(false);
  }
  for (const env of SOURCE_ENVIRONMENTS)
    expect(cleanupReady({ env, source }, status)).toBe(true);
  // A replay binding cannot stand in for the original's registration, nor the other way round.
  expect(cleanupReady({ env: 'demo', source: replay }, status)).toBe(false);
  expect(cleanupReady({ env: 'demo', source }, replayStatus)).toBe(false);
});

it('keeps isolated replay blocked outside its environments and without a current registration', () => {
  for (const env of ['dev', 'evaluation'] as const)
    expect(cleanupReady({ env, source: replay }, replayStatus)).toBe(false);
  expect(sourceEnvironmentAllowed('demo', undefined)).toBe(false);
  expect(cleanupReady({ env: 'demo' }, replayStatus)).toBe(false);
  expect(cleanupReady({ env: 'demo', source: replay }, null)).toBe(false);
  for (const registration of ['missing', 'revoked', 'unsupported'] as const)
    expect(
      cleanupReady(
        { env: 'demo', source: replay },
        { ...replayStatus, registration, permission: 'not_checked' },
      ),
    ).toBe(false);
  for (const permission of ['not_checked', 'denied', 'revoked'] as const)
    expect(
      cleanupReady(
        { env: 'demo', source: replay },
        { ...replayStatus, permission },
      ),
    ).toBe(false);
  expect(
    cleanupReady(
      { env: 'demo', source: { ...replay, authorizationRevision: 4 } },
      replayStatus,
    ),
  ).toBe(false);
});
