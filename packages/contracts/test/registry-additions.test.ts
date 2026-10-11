import { describe, expect, it } from 'vitest';
import {
  validateProjectionPayload,
  type EvidenceBundle,
  type FieldDescriptor,
  type ReferenceDeclaration,
} from '../src/index.js';
import { PROJECTION_SAMPLES } from './projection-samples.js';

describe('additive registry and erasure fields', () => {
  it('describes ownership per edge and identity per field, both optional', () => {
    const edge: ReferenceDeclaration = {
      edgeId: 'accounts.customer_ref.references.customers',
      fromCollectionId: 'accounts',
      fromFieldId: 'accounts.customer_ref',
      toCollectionId: 'customers',
      toFieldId: 'customers.record_id',
      identityRule: 'same_bson_type',
    };
    const owners: Array<ReferenceDeclaration['owner']> = [undefined, 'from', 'to', 'none'];
    expect(owners.map((owner) => ({ ...edge, ...(owner ? { owner } : {}) })).length).toBe(4);
    const field: FieldDescriptor = {
      fieldId: 'customers.email',
      collectionId: 'customers',
      path: ['data', 'email'],
      bsonTypes: ['string'],
      isArray: false,
      sanitized: true,
      identity: true,
    };
    expect(field.identity).toBe(true);
  });

  it('accepts the two submission states in the erasure projection event and still refuses an unknown one', () => {
    for (const providerStatus of ['submitting', 'submission_ambiguous', 'pending'])
      expect(() =>
        validateProjectionPayload('external_erasure_updated', {
          ...PROJECTION_SAMPLES.external_erasure_updated,
          providerStatus,
        } as never),
      ).not.toThrow();
    expect(() =>
      validateProjectionPayload('external_erasure_updated', {
        ...PROJECTION_SAMPLES.external_erasure_updated,
        providerStatus: 'half_submitted',
      } as never),
    ).toThrow();
  });

  it('marks a cut evidence bundle with an optional truncated flag', () => {
    const flag: Pick<EvidenceBundle, 'truncated'> = { truncated: true };
    expect(flag.truncated).toBe(true);
    const absent: Pick<EvidenceBundle, 'truncated'> = {};
    expect(absent.truncated).toBeUndefined();
  });
});
