/**
 * Local protocol fixtures for native owner-source tests: a contract `NativeSourceRegistration` over made-up collections.
 * Not authentic owner data.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- the fixture builds loose JSON */
import { Long, ObjectId, UUID } from 'mongodb';
import type { NativeSourceRegistration } from '../src/index.js';

export const SCOPE = { tenantId: 'acme-tenant', env: 'staging' as const, scopeId: 'scope-acme-crm' };
export const HASH = 'a'.repeat(64);

type FieldSpec = [string, string, string[], string[], { identity?: boolean; protected?: boolean }?];
export function registrationFor(
  dbA: string,
  dbB: string,
  options: { consistency?: 'conditional_preimage' | 'native_revision'; revision?: number } = {},
): NativeSourceRegistration {
  const namespaces = [
    ['people', dbA, 'crm_people'],
    ['billing', dbA, 'billing_accounts'],
    ['orgs', dbA, 'orgs'],
    ['deals', dbB, 'deals'],
    ['addresses', dbA, 'addresses'],
    ['shipments', dbA, 'shipments'],
  ] as const;
  const keyTypes: Record<string, string[]> = {
    people: ['string', 'objectId'],
    billing: ['int', 'long'],
    orgs: ['int'],
    deals: ['binData'],
    addresses: ['string'],
    shipments: ['string'],
  };
  const fieldSpecs: FieldSpec[] = [];
  for (const [ns] of namespaces) {
    fieldSpecs.push([`${ns}._id`, ns, ['_id'], keyTypes[ns]!, { protected: true }]);
    fieldSpecs.push([`${ns}.tenant`, ns, ['tenant'], ['string'], { protected: true }]);
    fieldSpecs.push([`${ns}.rev`, ns, ['rev'], ['int'], { protected: true }]);
  }
  fieldSpecs.push(
    ['people.email', 'people', ['contact', 'email'], ['string', 'null'], { identity: true }],
    ['people.aliases', 'people', ['aliases', '*'], ['string', 'null'], { identity: true }],
    ['people.notes', 'people', ['notesText'], ['string', 'null']],
    ['people.access', 'people', ['access'], ['string']],
    ['billing.customerRef', 'billing', ['customerRef'], ['string']],
    ['billing.orgRef', 'billing', ['orgRef'], ['int']],
    ['billing.ownerEmail', 'billing', ['ownerEmail'], ['string'], { identity: true }],
    ['billing.invoiceTotal', 'billing', ['invoiceTotal'], ['double']],
    ['billing.legalHold', 'billing', ['legalHold'], ['bool'], { protected: true }],
    ['deals.principal', 'deals', ['parties', '*', 'principal'], ['string'], { identity: true }],
    ['deals.personRef', 'deals', ['personRef'], ['string']],
    ['deals.addressRef', 'deals', ['addressRef'], ['string']],
    ['addresses.holder', 'addresses', ['holder'], ['string'], { identity: true }],
    ['shipments.personHex', 'shipments', ['personHex'], ['string']],
  );
  const owned = (ns: string) => ({ fieldId: `${ns}.tenant`, equals: { bsonType: 'string', value: 'acme' } });
  const ref = (
    referenceId: string,
    fromFieldId: string,
    toFieldId: string,
    owner: string,
    identityRule = 'same_bson_type',
  ) => ({ referenceId, fromFieldId, toFieldId, owner, identityRule });
  const redacted = { bsonType: 'string', value: '[redacted]' };
  const rule = (
    ruleId: string,
    namespaceId: string,
    effect: string,
    fieldIds: string[],
    extra: any = {},
  ) => ({
    ruleId,
    namespaceId,
    all: extra.all ?? [owned(namespaceId)],
    effect,
    fieldIds,
    ...(effect === 'delete' ? {} : { replacement: extra.replacement ?? redacted }),
  });
  const registration = {
    contractVersion: 2,
    sourceId: 'acme-crm',
    deploymentId: 'dep-acme-crm',
    scope: SCOPE,
    revision: options.revision ?? 1,
    policyRevision: 1,
    authorizationRevision: 1,
    sourceKind: 'original',
    namespaces: namespaces.map(([namespaceId, database, collection]) => ({
      namespaceId,
      database,
      collection,
    })),
    fields: fieldSpecs.map(([fieldId, namespaceId, path, bsonTypes, flags]) => ({
      fieldId,
      namespaceId,
      path,
      bsonTypes,
      identity: flags?.identity ?? false,
      protected: flags?.protected ?? false,
    })),
    tenantBoundaries: namespaces.map(([ns]) => ({
      namespaceId: ns,
      fieldId: `${ns}.tenant`,
      equals: { bsonType: 'string', value: 'acme' },
    })),
    subjectIdentityFieldIds: ['people.email', 'people.aliases'],
    references: [
      ref('billing_customer', 'billing.customerRef', 'people._id', 'to'),
      ref('billing_org', 'billing.orgRef', 'orgs._id', 'none'),
      ref('deal_person', 'deals.personRef', 'people._id', 'to'),
      ref('deal_address', 'deals.addressRef', 'addresses._id', 'from'),
      ref('shipment_person', 'shipments.personHex', 'people._id', 'to', 'string_to_objectId'),
    ],
    rules: [
      rule('people-delete', 'people', 'delete', []),
      rule('people-redact', 'people', 'redact', ['people.email', 'people.aliases', 'people.notes']),
      rule('people-tombstone', 'people', 'tombstone', ['people.email', 'people.aliases', 'people.notes'], {
        replacement: { bsonType: 'null', value: null },
      }),
      rule('people-restrict', 'people', 'restrict', ['people.access'], {
        replacement: { bsonType: 'string', value: 'restricted' },
      }),
      // Billing keeps its tax record: no delete rule, `invoiceTotal` retained, and a legal hold is a rule condition.
      rule('billing-redact', 'billing', 'redact', ['billing.customerRef', 'billing.ownerEmail'], {
        all: [owned('billing'), { fieldId: 'billing.legalHold', equals: { bsonType: 'bool', value: false } }],
      }),
      rule('deals-delete', 'deals', 'delete', []),
      rule('deals-redact', 'deals', 'redact', ['deals.principal', 'deals.personRef', 'deals.addressRef']),
      rule('addresses-delete', 'addresses', 'delete', []),
      rule('addresses-redact', 'addresses', 'redact', ['addresses.holder']),
      rule('shipments-delete', 'shipments', 'delete', []),
    ],
    retainedFieldIds: ['billing.invoiceTotal'],
    consistency:
      (options.consistency ?? 'conditional_preimage') === 'native_revision'
        ? {
            kind: 'native_revision',
            changeStreamRequired: true,
            bindings: namespaces.map(([ns]) => ({ namespaceId: ns, revisionFieldId: `${ns}.rev` })),
          }
        : { kind: 'conditional_preimage', changeStreamRequired: true },
    limits: {
      maxScanned: 1000,
      maxChanged: 100,
      maxBatch: 10,
      maxHops: 4,
      maxTotalScanned: 5000,
      maxTotalChanged: 500,
      maxOperations: 1000,
    },
    ownerReview: {
      reviewId: 'review-1',
      actorId: 'owner-actor',
      reviewedAt: '2026-10-11T12:00:00.000Z',
      provenanceDigest: HASH,
      writeScopeDigest: HASH,
    },
  };
  return registration as unknown as NativeSourceRegistration;
}

export const DEAL_1 = new UUID('abcdef01-1111-4111-8111-fedcba109876');
export const PERSON_OID = new ObjectId('507f1f77bcf86cd799439011');
export const BIG = Long.fromString('5000000000');
