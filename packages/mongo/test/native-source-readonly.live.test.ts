import { describe, expect, it } from 'vitest';
import { sourceEnvironmentSchema, type ActorContext } from '@expunge/contracts';
import { createDomainExecutor, mongoConfigForPrincipal } from '../src/client.js';
import { NativeSourceRepository } from '../src/native-source-registry.js';
import { AuthorityRepository } from '../src/authority.js';
import {
  assertNativeRegisteredShape,
  encodeNativeScalar,
  fieldValues,
  nativeScalarKey,
  nativeTenantPredicate,
  NATIVE_BSON_OPTIONS,
} from '../src/native-source-bson.js';

const enabled =
  process.env.EXPUNGE_REQUIRE_LIVE_TESTS === '1' || process.env.EXPUNGE_NATIVE_LIVE_READS === '1';
const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`NativeReadOnlyProofBlocked:${name}`);
  return value;
};
describe.runIf(enabled)('approved original native-source read-only proof', () => {
  it('reads actual registered namespaces with exact owner/tenant/BSON boundaries', async () => {
    const service = createDomainExecutor(mongoConfigForPrincipal(process.env, 'domain_executor'));
    try {
      const scope = {
        tenantId: required('EXPUNGE_TENANT_ID'),
        env: sourceEnvironmentSchema.parse(required('EXPUNGE_ENV')),
        scopeId: required('EXPUNGE_SCOPE_ID'),
      };
      const authority = await new AuthorityRepository(service).read(scope);
      const actor: ActorContext = {
        ...scope,
        actorId: required('OWNER_ID'),
        authorizationRevision: authority.authorizationRevision,
      };
      const source = await new NativeSourceRepository(service).readCurrent(
        actor,
        required('EXPUNGE_SOURCE_ID'),
      );
      expect(source.sourceKind).toBe('original');
      for (const namespace of source.namespaces) {
        const documents = await service.client
          .db(namespace.database)
          .collection(namespace.collection, NATIVE_BSON_OPTIONS)
          .find(nativeTenantPredicate(source, namespace.namespaceId), {
            limit: 1,
            maxTimeMS: 5000,
            readPreference: 'primary',
            readConcern: { level: 'majority' },
          })
          .toArray();
        // Empty namespaces are valid owner data. This lane asserts reads and isolation, never an erasure outcome.
        for (const document of documents) {
          assertNativeRegisteredShape(source, namespace.namespaceId, document);
          const boundary = source.tenantBoundaries.find(
            (value) => value.namespaceId === namespace.namespaceId,
          )!;
          const field = source.fields.find((value) => value.fieldId === boundary.fieldId)!;
          const values = fieldValues(document, field);
          expect(values.length).toBe(1);
          expect(nativeScalarKey(encodeNativeScalar(values[0].value))).toBe(nativeScalarKey(boundary.equals));
        }
      }
    } finally {
      await service.close();
    }
  }, 30000);
});
