/* eslint-disable @typescript-eslint/no-explicit-any -- registration fixtures are mutated as loose JSON */
/**
 * Invariants of native owner-source registration on the contract model. No database: deterministic configuration checks.
 */
import { describe, expect, it } from 'vitest';
import {
  atlasRoleManifests,
  compileOwnerSource,
  connectOwnerSource,
  sourceConnectionVariable,
} from '../src/index.js';
import { registrationFor } from './native-fixtures.js';

describe('owner-source registration on the contract model (no database)', () => {
  const base = () => JSON.parse(JSON.stringify(registrationFor('acme_x', 'acme_y'))) as Record<string, any>;
  it('accepts the native shape: any names, top-level paths, native id types, two databases', () => {
    const compiled = compileOwnerSource(registrationFor('acme_x', 'acme_y'));
    expect([...compiled.namespaces.values()].map((n) => n.collection)).toContain('crm_people');
    expect(compiled.namespaces.get('deals')!.idTypes).toEqual(['uuid']);
    expect(compiled.namespaces.get('people')!.idTypes).toEqual(['string', 'objectId']);
    expect(compiled.namespaces.get('billing')!.revisionPath).toBeNull();
    expect(
      compileOwnerSource(registrationFor('a', 'b', { consistency: 'native_revision' })).namespaces.get(
        'billing',
      )!.revisionPath,
    ).toEqual(['rev']);
  });
  it('refuses unknown keys, a missing owner, a missing tenant boundary, a missing key field, and the data-envelope prefix as a key', () => {
    const cases: Array<(r: Record<string, any>) => void> = [
      (r) => (r.extra = 1),
      (r) => delete r.references[0].owner,
      (r) => r.tenantBoundaries.pop(),
      (r) => (r.fields = r.fields.filter((f: any) => f.fieldId !== 'orgs._id')),
      (r) => (r.fields.find((f: any) => f.fieldId === 'orgs._id').protected = false),
      (r) => (r.fields.find((f: any) => f.fieldId === 'orgs._id').bsonTypes = ['double']),
      (r) => (r.rules[1].fieldIds = ['people.email', 'billing.invoiceTotal']),
      (r) => (r.rules[1].fieldIds = ['people.rev']),
      (r) =>
        r.rules.push({
          ...r.rules[0],
          ruleId: 'billing-delete',
          namespaceId: 'billing',
          all: [r.rules[4].all[0]],
        }),
    ];
    for (const mutate of cases) {
      const r = base();
      mutate(r);
      expect(() => compileOwnerSource(r)).toThrow('InvalidOwnerSource');
    }
  });
  it('NA-4: refuses system databases and every configured EXPUNGE_*_DB name, at registration and at connect', () => {
    for (const database of ['admin', 'local', 'config', 'Admin', 'expunge_world']) {
      const r = base();
      r.namespaces[0].database = database;
      expect(() => compileOwnerSource(r), database).toThrow('InvalidOwnerSource');
    }
    const r = base();
    r.namespaces.forEach((n: any) => (n.database = 'tenant_prod_control'));
    const env = { EXPUNGE_CONTROL_DB: 'Tenant_Prod_Control' } as NodeJS.ProcessEnv;
    expect(() => compileOwnerSource(r, {})).not.toThrow();
    expect(() => compileOwnerSource(r, env)).toThrow('InvalidOwnerSource');
    const variable = sourceConnectionVariable('dep-acme-crm');
    expect(variable).toBe('EXPUNGE_SOURCE_DEP_ACME_CRM_URI');
    expect(() => connectOwnerSource(r, { ...env, [variable]: 'mongodb://127.0.0.1:1' })).toThrow(
      'InvalidOwnerSource',
    );
    expect(() => connectOwnerSource(base(), {})).toThrow(`MissingConfiguration:${variable}`);
  });
  it('the role manifests give the worker no write on registrations and the builder no update on them', () => {
    const roles = atlasRoleManifests();
    const can = (principal: 'domain_executor' | 'fixture_builder', verb: string, collection: string) =>
      roles[principal]!.actions.some(
        (a) => a.action === verb && a.resources.some((r) => r.collection === collection),
      );
    expect(can('domain_executor', 'FIND', 'owner_sources')).toBe(true);
    for (const verb of ['INSERT', 'UPDATE', 'REMOVE'])
      expect(can('domain_executor', verb, 'owner_sources')).toBe(false);
    expect(can('fixture_builder', 'INSERT', 'owner_sources')).toBe(true);
    expect(can('fixture_builder', 'UPDATE', 'owner_sources')).toBe(false);
    expect(can('domain_executor', 'UPDATE', 'owner_source_state')).toBe(true);
    expect(can('domain_executor', 'INSERT', 'owner_source_state')).toBe(true);
  });
});
