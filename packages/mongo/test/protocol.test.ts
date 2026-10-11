import { describe, it, expect } from 'vitest';
import { MongoClient, ObjectId, Long } from 'mongodb';
import {
  atlasRoleManifests,
  bsonPreimageHash,
  addressId,
  nodeKey,
  worldFilter,
  assertSupportedMongoSchema,
  CONTROL_VALIDATORS,
  createPrincipalService,
  queryIdentityDigest,
} from '../src/index.js';
import { contentHash, type ActorContext } from '@expunge/contracts';
const actor: ActorContext = {
  actorId: 'owner',
  tenantId: 'a',
  env: 'demo',
  scopeId: 'same',
  authorizationRevision: 1,
};
describe('offline protocol boundary checks (no database simulation)', () => {
  it('always conjuncts actor/world with generated filter', () => {
    expect(worldFilter(actor, 'world-a', { $or: [{ tenantId: 'evil' }, { worldId: 'world-b' }] })).toEqual({
      $and: [
        { tenantId: 'a', env: 'demo', worldId: 'world-a' },
        { $or: [{ tenantId: 'evil' }, { worldId: 'world-b' }] },
      ],
    });
  });
  it('preserves ObjectId/string/Long distinction in hashes and addresses', () => {
    const id = new ObjectId('507f1f77bcf86cd799439011');
    expect(bsonPreimageHash({ _id: id })).not.toBe(bsonPreimageHash({ _id: id.toHexString() }));
    expect(bsonPreimageHash({ _id: Long.fromString('9007199254740993') })).not.toBe(
      bsonPreimageHash({ _id: '9007199254740993' }),
    );
    expect(
      addressId({ collectionId: 'customers', recordId: id.toHexString(), recordIdBsonType: 'objectId' }),
    ).toEqual(id);
    expect(() =>
      addressId({ collectionId: 'customers', recordId: 'bad', recordIdBsonType: 'objectId' }),
    ).toThrow();
    expect(
      nodeKey({ collectionId: 'customers', recordId: id.toHexString(), recordIdBsonType: 'string' }),
    ).not.toBe(
      nodeKey({ collectionId: 'customers', recordId: id.toHexString(), recordIdBsonType: 'objectId' }),
    );
  });
  it('rejects unsupported Mongo schema keywords and permits envelope _id', () => {
    expect(() => assertSupportedMongoSchema(CONTROL_VALIDATORS)).not.toThrow();
    expect(() => assertSupportedMongoSchema({ format: 'date-time' })).toThrow(
      'UnsupportedMongoSchemaKeyword',
    );
    expect(CONTROL_VALIDATORS.artifacts.$jsonSchema.properties).toHaveProperty('_id');
    expect(CONTROL_VALIDATORS.artifacts.$jsonSchema.additionalProperties).toBe(false);
    expect(CONTROL_VALIDATORS.artifacts.$jsonSchema.properties.payload.additionalProperties).toBe(false);
  });
  it('declares actual collection-role gaps without broad runtime grants', () => {
    const roles = atlasRoleManifests();
    expect(
      roles.proposer?.actions.some((a) =>
        ['UPDATE', 'REMOVE', 'BYPASS_DOCUMENT_VALIDATION'].includes(a.action),
      ),
    ).toBe(false);
    expect(
      roles.domain_executor?.actions
        .find((a) => a.action === 'REMOVE')
        ?.resources.some((r) => r.collection === 'retained_invoices'),
    ).toBe(false);
    expect(
      roles.promoter?.actions
        .find((a) => a.action === 'INSERT')
        ?.resources.some((r) => r.collection === 'approvals'),
    ).toBe(false);
  });
  it('refuses admin fallback and hides private handles from executor', async () => {
    expect(() =>
      createPrincipalService({ uris: { setup: 'mongodb://127.0.0.1' } }, 'domain_executor'),
    ).toThrow('MissingConfiguration:MONGODB_DOMAIN_EXECUTOR_URI');
    const service = createPrincipalService(
      { uris: { domain_executor: 'mongodb://127.0.0.1' } },
      'domain_executor',
    );
    expect(service.privateDb).toBeUndefined();
    await service.close();
  });
  it('pins identical observer filter/window/pagination identity', () => {
    const filter = { signals: ['failure'] };
    const query = {
      projectId: 'p',
      observerVersion: 'v1',
      filterSnapshot: filter,
      filterHash: contentHash(filter, 'observer-filter'),
      windowStart: '2026-10-11T00:00:00Z',
      windowEnd: '2026-10-11T01:00:00Z',
      overlapMs: 1000,
      backfillPolicy: 'pending_ids_and_overlap' as const,
    };
    expect(queryIdentityDigest(query)).not.toBe(
      queryIdentityDigest({ ...query, windowEnd: '2026-10-11T02:00:00Z' }),
    );
    expect(() => queryIdentityDigest({ ...query, filterSnapshot: { signals: ['other'] } })).toThrow(
      'ObserverFilterMismatch',
    );
  });
});
