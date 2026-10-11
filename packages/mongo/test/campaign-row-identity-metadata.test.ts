import { describe, expect, it } from 'vitest';
import { contentHash, type ScopeKey } from '@expunge/contracts';
import { campaignRowIdentity, assertCampaignRowReplay } from '../src/campaign-artifacts.js';
import { decodeStoredProjectionEvent } from '../src/events.js';
import { CAMPAIGN_RESULT_INDEXES, CAMPAIGN_RESULT_VALIDATORS } from '../src/validators-campaign.js';
import { CONTROL_INDEXES } from '../src/setup.js';

// Identity/schema metadata only: no business records, service doubles or live acceptance evidence.
const scope: ScopeKey = { tenantId: 'tenant', env: 'evaluation', scopeId: 'scope' };
const digest = 'a'.repeat(64);
const identity = () => campaignRowIdentity(scope, 'campaign', 'row');
const storedIdentity = () => ({ ...identity().logical, _id: identity().storageId, payloadDigest: digest });

describe('campaign row tuple identity and legacy compatibility', () => {
  it('uses distinct deterministic hash domains for bounded storage and projection identities', () => {
    const value = identity();
    expect(value).toEqual(identity());
    expect(value.storageId).toBe(contentHash(value.logical, 'campaign-row-identity-v2'));
    expect(value.eventId).toBe(contentHash(value.logical, 'campaign-row-projection-v2'));
    expect(value.storageId).toMatch(/^[a-f0-9]{64}$/);
    expect(value.eventId).toMatch(/^[a-f0-9]{64}$/);
    expect(value.storageId).not.toBe(value.eventId);
  });
  it('does not conflate separator-bearing campaign and row tuple components', () => {
    const left = campaignRowIdentity(scope, 'a:b', 'c');
    const right = campaignRowIdentity(scope, 'a', 'b:c');
    expect(`${left.logical.campaignId}:${left.logical.rowId}`).toBe(
      `${right.logical.campaignId}:${right.logical.rowId}`,
    );
    expect(left.storageId).not.toBe(right.storageId);
    expect(left.eventId).not.toBe(right.eventId);
  });
  it.each([{ tenantId: 'other-tenant' }, { env: 'dev' as const }, { scopeId: 'other-scope' }])(
    'binds each scope component %#',
    (change) => {
      const alternate = campaignRowIdentity({ ...scope, ...change }, 'campaign', 'row');
      expect(alternate.storageId).not.toBe(identity().storageId);
      expect(alternate.eventId).not.toBe(identity().eventId);
    },
  );
  it.each([
    ['other-campaign', 'row'],
    ['campaign', 'other-row'],
  ])('binds the full campaign/row tuple (%s, %s)', (campaignId, rowId) => {
    const alternate = campaignRowIdentity(scope, campaignId, rowId);
    expect(alternate.storageId).not.toBe(identity().storageId);
    expect(alternate.eventId).not.toBe(identity().eventId);
  });
  it('captures the logical scope so later caller mutation cannot alter the hashed tuple', () => {
    const mutable = { ...scope };
    const value = campaignRowIdentity(mutable, 'campaign', 'row');
    mutable.scopeId = 'other-scope';
    expect(value.logical).toEqual({ ...scope, campaignId: 'campaign', rowId: 'row' });
    expect(value.storageId).toBe(identity().storageId);
  });
  it('fits the unchanged Mongo and full-envelope decoder limits for both maximum legal identifiers', () => {
    const campaignId = 'c'.repeat(128);
    const rowId = 'r'.repeat(128);
    const value = campaignRowIdentity(scope, campaignId, rowId);
    expect(`${campaignId}:${rowId}`).toHaveLength(257);
    expect(`campaign-row:${campaignId}:${rowId}`).toHaveLength(270);
    const schema = CAMPAIGN_RESULT_VALIDATORS.campaign_artifact_rows.$jsonSchema;
    expect(schema.properties._id.maxLength).toBe(256);
    expect(value.storageId.length).toBeLessThanOrEqual(schema.properties._id.maxLength);
    const event = decodeStoredProjectionEvent({
      ...scope,
      _id: value.eventId,
      eventId: value.eventId,
      jobId: `campaign:${campaignId}`,
      runId: 'campaign',
      artifactIds: [],
      kind: 'campaign_row_committed',
      payload: { campaignId, rowId, manifestHash: digest, kind: 'meta', result: 'measured' },
      sequence: 1,
      createdAt: new Date('2026-10-11T00:00:00.000Z'),
    });
    expect(event.eventId).toBe(value.eventId);
  });
  it.each([
    ['', 'row'],
    ['campaign', ''],
    ['c'.repeat(129), 'row'],
    ['campaign', 'r'.repeat(129)],
    ['campaign', 'row space'],
  ])('refuses illegal identifier tuple %#', (campaignId, rowId) => {
    expect(() => campaignRowIdentity(scope, campaignId, rowId)).toThrow('InvalidCampaignId');
  });
  it.each([null, 1, undefined])('does not coerce a nonstring row identifier %#', (rowId) => {
    expect(() => campaignRowIdentity(scope, 'campaign', rowId as unknown as string)).toThrow(
      'InvalidCampaignId',
    );
  });
  it('accepts exact metadata replay under both new and historical storage IDs without changing payloadDigest', () => {
    for (const _id of [identity().storageId, 'campaign:row']) {
      const metadata = { ...storedIdentity(), _id };
      expect(() => assertCampaignRowReplay(identity(), metadata, digest)).not.toThrow();
      expect(metadata.payloadDigest).toBe(digest);
    }
  });
  it('never decodes a historical ID into a different logical tuple', () => {
    const left = campaignRowIdentity(scope, 'a:b', 'c');
    const wrongTuple = {
      ...campaignRowIdentity(scope, 'a', 'b:c').logical,
      _id: 'a:b:c',
      payloadDigest: digest,
    };
    expect(() => assertCampaignRowReplay(left, wrongTuple, digest)).toThrow('CampaignRowIntegrity');
  });
  it.each([
    { scopeId: 'other-scope' },
    { tenantId: 'other-tenant' },
    { env: 'dev' as const },
    { campaignId: 'other-campaign' },
    { rowId: 'other-row' },
    { _id: 'unknown-id' },
    { payloadDigest: 'invalid' },
  ])('refuses corrupt or adjacent stored identity metadata %#', (change) => {
    expect(() => assertCampaignRowReplay(identity(), { ...storedIdentity(), ...change }, digest)).toThrow(
      'CampaignRowIntegrity',
    );
  });
  it('refuses a different immutable digest instead of treating it as idempotent', () => {
    expect(() => assertCampaignRowReplay(identity(), storedIdentity(), 'b'.repeat(64))).toThrow(
      'CampaignRowConflict',
    );
  });
  it('retains the declared scoped logical unique index through the actual setup manifest', () => {
    const expected = {
      collection: 'campaign_artifact_rows',
      key: { tenantId: 1, env: 1, scopeId: 1, campaignId: 1, rowId: 1 },
      options: { unique: true },
    };
    expect(CAMPAIGN_RESULT_INDEXES).toContainEqual(expected);
    expect(CONTROL_INDEXES).toContainEqual(expected);
  });
});
