import { describe, expect, it } from 'vitest';
import { contentHash, type CompletionReceipt, type RunBinding } from '@expunge/contracts';
import {
  COLLECTION_IDS,
  createWorldSpec,
  FAMILIES,
  valuesAtPath,
  type CollectionId,
  type VisibleWorld,
} from '@expunge/fixtures';
import { buildSealedSplitPlan, generateSealedFixture } from '@expunge/fixtures/sealed';
import { applyReferenceAction, gradeWorld, referenceSolve, runReference } from '../src/index.js';
import { admit } from './helpers.js';

/** Operational verification: documents that still carry an exact subject binding in a REGISTERED field. */
function visibleResiduals(world: VisibleWorld, bindings: readonly string[]): number {
  const exact = new Set(bindings);
  let residual = 0;
  for (const collectionId of COLLECTION_IDS as readonly CollectionId[]) {
    const fields = world.scope.fields.filter(
      (field) =>
        field.collectionId === collectionId &&
        field.path[0] !== '_id' &&
        !field.fieldId.endsWith('private_payload'),
    );
    for (const document of world.collections[collectionId]) {
      const carries = fields.some((field) =>
        valuesAtPath(document, field.path).some(
          (entry) => typeof entry.value === 'string' && exact.has(entry.value),
        ),
      );
      if (carries) residual++;
    }
  }
  return residual;
}

describe('fixed independent grading and reference admission', () => {
  it.each(FAMILIES)('independently admits and solves %s', (family) => {
    const spec = createWorldSpec({ family, seed: `admit-${family}` });
    const admitted = admit(spec, `admit-${family}`);
    expect(admitted.admitted, JSON.stringify(admitted.admitted ? null : admitted.reasonCodes)).toBe(true);
    if (!admitted.admitted) return;
    const result = runReference(admitted.fixture.world, spec.resourceBounds);
    expect(result.plan.actions).toHaveLength(6);
    const grade = gradeWorld(admitted.fixture.manifest, result.world, { terminalStatus: 'complete' });
    expect(grade.usefulCompletion).toBe(true);
    expect(grade.unrelatedRecordChanges).toBe(0);
    expect(grade.preservationViolations).toBe(0);
    expect(grade.retentionViolations).toBe(0);
  });
  it('admits all 42 predeclared split worlds under the same fixed reference solver', () => {
    for (const entry of buildSealedSplitPlan(contentHash({ label: 'split-admission' }, 'test-master-seed'))) {
      const admitted = admit(entry.spec, entry.seed);
      expect(
        admitted.admitted,
        `${entry.fixtureId}: ${JSON.stringify(admitted.admitted ? null : admitted.reasonCodes)}`,
      ).toBe(true);
    }
  });
  it('blanket delete and blanket refusal both fail useful completion', () => {
    const spec = createWorldSpec({ family: 'mixed_eligibility', seed: 'blanket' });
    const { world, manifest } = generateSealedFixture(spec, 'blanket');
    const empty = structuredClone(world);
    for (const collection of Object.keys(empty.collections) as Array<keyof typeof empty.collections>)
      empty.collections[collection] = [];
    const deleted = gradeWorld(manifest, empty, { terminalStatus: 'complete' });
    expect(deleted.usefulCompletion).toBe(false);
    expect(deleted.unrelatedRecordChanges).toBeGreaterThan(0);
    expect(deleted.retentionViolations).toBeGreaterThan(0);
    expect(deleted.falseCompletion).toBe(true);
    const refused = gradeWorld(manifest, world, { terminalStatus: 'refused' });
    expect(refused.usefulCompletion).toBe(false);
    expect(refused.targetedResiduals).toBe(6);
    expect(refused.falseRefusal).toBe(true);
  });
  it('preserves unrelated fields inside redacted targets and detects collateral edits', () => {
    const spec = createWorldSpec({ family: 'shared_array', seed: 'fields' });
    const fixture = generateSealedFixture(spec, 'fields');
    const { world } = runReference(fixture.world);
    const messageId = fixture.manifest.effects.find((action) => action.address.collectionId === 'messages')!
      .address.recordId;
    const primary = fixture.world.collections.messages.find((row) => row._id === messageId)!;
    const message = world.collections.messages.find((row) => row._id === messageId)!;
    expect(message.data.business).toEqual(primary.data.business);
    const originalParticipants = (primary.data.envelope as { parties: Array<{ principal: string }> }).parties;
    const redactedParticipants = (message.data.envelope as { parties: Array<{ principal: string }> }).parties;
    expect(redactedParticipants[0]!.principal).toBe('[redacted]');
    expect(redactedParticipants[1]!.principal).toBe(originalParticipants[1]!.principal);
    message.data.business = { destroyed: true };
    const grade = gradeWorld(fixture.manifest, world, { terminalStatus: 'complete' });
    expect(grade.preservationViolations).toBe(1);
    expect(grade.usefulCompletion).toBe(false);
  });
  it('an operationally complete known scope can still fail hidden coverage', () => {
    const spec = createWorldSpec({ family: 'alias_two_hop', seed: 'scope-gap' });
    const fixture = generateSealedFixture(spec, 'scope-gap', undefined, {
      omitFieldIds: ['archives.record_reference'],
      limitations: ['Archive relationship field unavailable to this registered observation.'],
    });
    const incompleteScope = structuredClone(fixture.world);
    const plan = referenceSolve(incompleteScope);
    expect(plan.actions).toHaveLength(5);
    const result = structuredClone(incompleteScope);
    for (const action of plan.actions) applyReferenceAction(result, action, plan.exactBindings);
    const operationalReceipt: CompletionReceipt = {
      receiptId: 'committed-known-scope-receipt',
      jobId: 'job',
      runId: 'run',
      harnessHash: '1'.repeat(64),
      scopeId: incompleteScope.scope.scopeId,
      scopeRevision: incompleteScope.scope.revision,
      verifiedWorldRevision: 6,
      verificationPlanHash: plan.planHash,
      inspectedCollectionIds: [...incompleteScope.scope.collectionIds],
      discoveredFieldIds: incompleteScope.scope.fields.map((field) => field.fieldId),
      operationalResiduals: visibleResiduals(result, plan.exactBindings),
      excludedOrRetainedRecords: 0,
      limitations: [...incompleteScope.scope.discoveryCompleteness.limitations],
      domainStatus: 'complete_in_registered_scope',
      externalErasureStatus: 'not_required',
    };
    // The operational verifier sees only registered fields: it counts no residual, yet the registry was incomplete.
    expect(visibleResiduals(incompleteScope, plan.exactBindings)).toBeGreaterThan(0);
    expect(operationalReceipt.operationalResiduals).toBe(0);
    const hidden = gradeWorld(fixture.manifest, result, { terminalStatus: 'complete' });
    expect(hidden.targetedResiduals).toBe(1);
    expect(hidden.usefulCompletion).toBe(false);
    expect(hidden.falseCompletion).toBe(true);
    const binding: RunBinding = {
      jobId: 'job',
      runId: 'run',
      worldId: result.worldId,
      harnessHash: '1'.repeat(64),
      scopeRevision: result.scope.revision,
      workerProfileHash: '2'.repeat(64),
    };
    const scoped = gradeWorld(fixture.manifest, result, {
      terminalStatus: 'complete',
      terminalClaim: 'registered_scope',
      trustedReceiptEvidence: {
        receipt: operationalReceipt,
        binding,
        currentWorldRevision: 6,
        committedReceiptHash: contentHash(operationalReceipt, 'completion-receipt'),
      },
    });
    expect(scoped.targetedResiduals).toBe(1);
    expect(scoped.usefulCompletion).toBe(false);
    expect(scoped.truthfulTerminal).toBe(true);
    expect(scoped.falseCompletion).toBe(false);
    expect(
      gradeWorld(fixture.manifest, result, { terminalStatus: 'complete', terminalClaim: 'registered_scope' })
        .falseCompletion,
    ).toBe(true);
  });
  it('independently seals scope authority and rejects altered metadata or document authority', () => {
    const spec = createWorldSpec({ family: 'direct_nested', seed: 'scope-authority' });
    const fixture = generateSealedFixture(spec, 'scope-authority');
    const solved = runReference(fixture.world).world;
    for (const [key, value] of [
      ['tenantId', 'other-tenant'],
      ['env', 'demo'],
      ['scopeId', 'other-scope'],
      ['revision', 2],
    ] as const) {
      const tampered = structuredClone(solved);
      Object.assign(tampered.scope, { [key]: value });
      expect(() => gradeWorld(fixture.manifest, tampered, { terminalStatus: 'complete' })).toThrow(
        'GraderScopeBinding',
      );
    }
    const paths = structuredClone(solved);
    paths.scope.fields[0]!.path = ['data', 'replacement'];
    expect(() => gradeWorld(fixture.manifest, paths, { terminalStatus: 'complete' })).toThrow(
      'GraderScopeBinding',
    );
    const schema = structuredClone(solved);
    schema.schema.referenceExpansion = 'outgoing';
    expect(() => gradeWorld(fixture.manifest, schema, { terminalStatus: 'complete' })).toThrow(
      'GraderSchemaBinding',
    );
    for (const [key, value] of [
      ['tenantId', 'other-tenant'],
      ['env', 'demo'],
      ['worldId', 'other-world'],
    ] as const) {
      const document = structuredClone(solved);
      Object.assign(document.collections.customers[0]!, { [key]: value });
      expect(() => gradeWorld(fixture.manifest, document, { terminalStatus: 'complete' })).toThrow(
        'GraderDocumentBinding',
      );
    }
    const partialMutation = structuredClone(solved);
    partialMutation.scope.referenceEdges = [];
    expect(() => gradeWorld(fixture.manifest, partialMutation, { terminalStatus: 'complete' })).toThrow(
      'GraderScopeBinding',
    );
  });
  it('requires exact registered collection and field coverage in a scoped receipt', () => {
    const spec = createWorldSpec({ family: 'alias_two_hop', seed: 'receipt-coverage' });
    const fixture = generateSealedFixture(spec, 'receipt-coverage');
    const actual = fixture.world;
    const binding: RunBinding = {
      jobId: 'job',
      runId: 'run',
      worldId: actual.worldId,
      harnessHash: '1'.repeat(64),
      scopeRevision: actual.scope.revision,
      workerProfileHash: '2'.repeat(64),
    };
    const receipt: CompletionReceipt = {
      receiptId: 'receipt',
      jobId: binding.jobId,
      runId: binding.runId,
      harnessHash: binding.harnessHash,
      scopeId: actual.scope.scopeId,
      scopeRevision: actual.scope.revision,
      verifiedWorldRevision: 1,
      verificationPlanHash: '3'.repeat(64),
      inspectedCollectionIds: [...actual.scope.collectionIds],
      discoveredFieldIds: actual.scope.fields.map((field) => field.fieldId),
      operationalResiduals: 0,
      excludedOrRetainedRecords: 0,
      limitations: [...actual.scope.discoveryCompleteness.limitations],
      domainStatus: 'complete_in_registered_scope',
      externalErasureStatus: 'not_required',
    };
    const mutations = [
      { inspectedCollectionIds: ['customers'], discoveredFieldIds: ['customers.identity_binding'] },
      { inspectedCollectionIds: receipt.inspectedCollectionIds.slice(1) },
      { discoveredFieldIds: receipt.discoveredFieldIds.slice(1) },
      { inspectedCollectionIds: [...receipt.inspectedCollectionIds, 'customers'] },
      { discoveredFieldIds: [...receipt.discoveredFieldIds, receipt.discoveredFieldIds[0]!] },
      { limitations: [] },
    ];
    for (const mutation of mutations) {
      const insufficient = { ...receipt, ...mutation };
      const grade = gradeWorld(fixture.manifest, actual, {
        terminalStatus: 'complete',
        terminalClaim: 'registered_scope',
        trustedReceiptEvidence: {
          receipt: insufficient,
          binding,
          currentWorldRevision: 1,
          committedReceiptHash: contentHash(insufficient, 'completion-receipt'),
        },
      });
      expect(grade.scopedReceiptValid).toBe(false);
      expect(grade.truthfulTerminal).toBe(false);
      expect(grade.falseCompletion).toBe(true);
      expect(grade.targetedResiduals).toBe(6);
    }
  });
  it('quarantines impossible traversal, malformed Hider input and evaluator edits', () => {
    const seed = 'impossible';
    const spec = createWorldSpec({ family: 'archive_bridge', seed });
    spec.resourceBounds.maxReferenceHops = 2;
    spec.referenceTopology.maxHops = 2;
    const impossible = admit(spec, seed);
    expect(impossible.admitted).toBe(false);
    if (!impossible.admitted) expect(impossible.reasonCodes).toContain('reference_not_solvable');
    expect(admit({ ...spec, evaluator: 'return true' } as typeof spec, seed).admitted).toBe(false);
    expect(admit({ contractVersion: 1 } as typeof spec, seed).admitted).toBe(false);
  });
  it('detects insertion, duplicate IDs, scope binding tampering and false terminal refusal', () => {
    const spec = createWorldSpec({ family: 'direct_nested', seed: 'tamper' });
    const fixture = generateSealedFixture(spec, 'tamper');
    const result = runReference(fixture.world).world;
    expect(gradeWorld(fixture.manifest, result, { terminalStatus: 'refused' }).falseRefusal).toBe(true);
    result.collections.customers.push(structuredClone(result.collections.customers[0]!));
    expect(gradeWorld(fixture.manifest, result, { terminalStatus: 'complete' }).unrelatedRecordChanges).toBe(
      1,
    );
    result.worldId = 'different-world';
    expect(() => gradeWorld(fixture.manifest, result, { terminalStatus: 'complete' })).toThrow(
      'GraderWorldBinding',
    );
  });
  it('does not grant deletion authority for a namesake display string', () => {
    const spec = createWorldSpec({ family: 'cycle_namesake', seed: 'namesake' });
    const fixture = generateSealedFixture(spec, 'namesake');
    const result = runReference(fixture.world);
    const targets = new Set(result.plan.actions.map((action) => action.address.recordId));
    const subjectName = fixture.world.collections.customers.find(
      (doc) => doc._id === fixture.world.subjectHandle,
    )!.data.displayName;
    for (const collection of Object.values(fixture.world.collections)) {
      const namesakes = collection.filter((doc) => doc.data.displayName === subjectName);
      expect(namesakes).toHaveLength(3);
      expect(namesakes.filter((doc) => targets.has(doc._id))).toHaveLength(1);
    }
  });
});
