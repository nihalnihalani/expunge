import { expect, it } from 'vitest';
import { previewStale } from '../src/client/expunge/lib/preview.js';
import { sourceBindingSchema } from '../src/server/expunge/schemas.js';
import {
  sourceBindingMatchesReadiness,
  sourceBindingsEqual,
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
