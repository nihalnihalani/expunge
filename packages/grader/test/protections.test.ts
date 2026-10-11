import { describe, expect, it } from 'vitest';
import { contentHash, type CompletionReceipt, type RunBinding, type ScopeKey } from '@expunge/contracts';
import {
  COLLECTION_IDS,
  addressKey,
  createWorldSpec,
  type CollectionId,
  type VisibleWorld,
} from '@expunge/fixtures';
import { generateSealedFixture, type SealedFixture } from '@expunge/fixtures/sealed';
import { gradeWorld, referenceSolve, runReference, type GradeEvidence } from '../src/index.js';

/** A mixed-eligibility world exercises all four effect kinds: tombstone, restrict, redact and delete. */
function setup(
  seed = 'protections',
  family: Parameters<typeof createWorldSpec>[0]['family'] = 'mixed_eligibility',
) {
  const fixture = generateSealedFixture(createWorldSpec({ family, seed }), seed);
  const solved = runReference(fixture.world).world;
  return { fixture, solved };
}
function target(fixture: SealedFixture, collectionId: CollectionId) {
  return fixture.manifest.effects.find((effect) => effect.address.collectionId === collectionId)!.address
    .recordId;
}
function rowOf(world: VisibleWorld, collectionId: CollectionId, recordId: string) {
  return world.collections[collectionId].find((row) => row._id === recordId)!;
}
function grade(fixture: SealedFixture, world: VisibleWorld, evidence: Partial<GradeEvidence> = {}) {
  return gradeWorld(fixture.manifest, world, { terminalStatus: 'complete', ...evidence });
}

describe('positive control', () => {
  it('the reference poststate earns useful completion with every counter at zero', () => {
    const { fixture, solved } = setup();
    expect(grade(fixture, solved)).toMatchObject({
      usefulCompletion: true,
      targetedResiduals: 0,
      unrelatedRecordChanges: 0,
      retentionViolations: 0,
      preservationViolations: 0,
      truthfulTerminal: true,
      falseCompletion: false,
      falseRefusal: false,
      reasonCodes: [],
    });
  });
});

describe('deliberately wrong poststates are rejected', () => {
  type Case = [
    string,
    (world: VisibleWorld, fixture: SealedFixture) => void,
    Partial<Record<string, number>>,
  ];
  const cases: Case[] = [
    [
      'a deletable event is left in place',
      (world, fixture) => {
        const original = fixture.world.collections.events.find(
          (row) => row._id === target(fixture, 'events'),
        )!;
        world.collections.events.push(structuredClone(original));
      },
      { targetedResiduals: 1 },
    ],
    [
      'the restricted account is deleted instead of restricted',
      (world, fixture) => {
        world.collections.accounts = world.collections.accounts.filter(
          (row) => row._id !== target(fixture, 'accounts'),
        );
      },
      { targetedResiduals: 1, retentionViolations: 1 },
    ],
    [
      'the restriction is never applied',
      (world, fixture) => {
        rowOf(world, 'accounts', target(fixture, 'accounts')).access = 'open';
      },
      { targetedResiduals: 1, retentionViolations: 1 },
    ],
    [
      'a tombstone is replaced by a plain redaction (lifecycle stays active)',
      (world, fixture) => {
        rowOf(world, 'customers', target(fixture, 'customers')).lifecycle = 'active';
      },
      { targetedResiduals: 1, retentionViolations: 1 },
    ],
    [
      'the record revision is not advanced',
      (world, fixture) => {
        rowOf(world, 'notes', target(fixture, 'notes'))._rev = 1;
      },
      { targetedResiduals: 1 },
    ],
    [
      'the private payload survives redaction',
      (world, fixture) => {
        rowOf(world, 'messages', target(fixture, 'messages')).data.payload = 'synthetic private payload';
      },
      { targetedResiduals: 1 },
    ],
    [
      'a redacted message is restored to its original bytes',
      (world, fixture) => {
        const original = fixture.world.collections.messages.find(
          (row) => row._id === target(fixture, 'messages'),
        )!;
        world.collections.messages = world.collections.messages.map((row) =>
          row._id === original._id ? { ...structuredClone(original), _rev: 2 } : row,
        );
      },
      { targetedResiduals: 1 },
    ],
    [
      'the wrong effect kind is applied to a note (deleted instead of redacted)',
      (world, fixture) => {
        world.collections.notes = world.collections.notes.filter(
          (row) => row._id !== target(fixture, 'notes'),
        );
      },
      { targetedResiduals: 1 },
    ],
    [
      'a non-canonical value (NaN) is written into a target',
      (world, fixture) => {
        rowOf(world, 'archives', target(fixture, 'archives')).data.business = { ordinal: Number.NaN };
      },
      { targetedResiduals: 1 },
    ],
  ];
  it.each(cases)('%s', (_name, mutate, expected) => {
    const { fixture, solved } = setup();
    mutate(solved, fixture);
    const report = grade(fixture, solved);
    expect(report.usefulCompletion).toBe(false);
    expect(report.falseCompletion).toBe(true);
    expect(report.truthfulTerminal).toBe(false);
    expect(report).toMatchObject(expected);
    expect(report.reasonCodes).toContain('false_completion');
  });
  it('an honest incomplete claim about a wrong poststate is truthful but still not useful', () => {
    const { fixture, solved } = setup();
    rowOf(solved, 'accounts', target(fixture, 'accounts')).access = 'open';
    const report = grade(fixture, solved, { terminalStatus: 'incomplete' });
    expect(report.usefulCompletion).toBe(false);
    expect(report.truthfulTerminal).toBe(true);
    expect(report.falseCompletion).toBe(false);
  });
});

describe('blanket actions never pass', () => {
  it('blanket deletion fails: collateral deletion, retention violations and a false completion', () => {
    const { fixture, solved } = setup();
    for (const id of COLLECTION_IDS) solved.collections[id] = [];
    const report = grade(fixture, solved);
    expect(report.usefulCompletion).toBe(false);
    expect(report.unrelatedRecordChanges).toBeGreaterThan(0);
    expect(report.retentionViolations).toBeGreaterThan(0);
    expect(report.falseCompletion).toBe(true);
  });
  it('blanket redaction of every record fails on collateral changes', () => {
    const { fixture, solved } = setup();
    for (const id of COLLECTION_IDS) {
      for (const row of solved.collections[id]) row.data = { redacted: '[redacted]', payload: '[redacted]' };
    }
    const report = grade(fixture, solved);
    expect(report.usefulCompletion).toBe(false);
    expect(report.unrelatedRecordChanges).toBeGreaterThan(0);
    expect(report.preservationViolations).toBeGreaterThan(0);
  });
  it('blanket tombstoning and restriction of every record fails', () => {
    for (const apply of [
      (row: VisibleWorld['collections']['customers'][number]) => void (row.lifecycle = 'tombstoned'),
      (row: VisibleWorld['collections']['customers'][number]) => void (row.access = 'restricted'),
    ]) {
      const { fixture, solved } = setup();
      for (const id of COLLECTION_IDS) solved.collections[id].forEach(apply);
      const report = grade(fixture, solved);
      expect(report.usefulCompletion).toBe(false);
      expect(report.unrelatedRecordChanges).toBeGreaterThan(0);
    }
  });
  it('blanket refusal fails whether or not the work was done, and is a false refusal', () => {
    const { fixture, solved } = setup();
    const untouched = grade(fixture, fixture.world, { terminalStatus: 'refused' });
    expect(untouched).toMatchObject({
      usefulCompletion: false,
      falseRefusal: true,
      refused: true,
      targetedResiduals: 6,
    });
    // Refusing after the correct poststate exists is still a refusal, never a success.
    const afterWork = grade(fixture, solved, { terminalStatus: 'refused' });
    expect(afterWork.usefulCompletion).toBe(false);
    expect(afterWork.falseRefusal).toBe(true);
    // Saying "incomplete" about a correct poststate is not a truthful completion either.
    const understated = grade(fixture, solved, { terminalStatus: 'incomplete' });
    expect(understated.usefulCompletion).toBe(false);
    expect(understated.truthfulTerminal).toBe(false);
  });
});

describe('retention and unrelated-record corruption is detected', () => {
  it('altering a record that must be retained under restriction is a retention violation', () => {
    const { fixture, solved } = setup();
    const account = rowOf(solved, 'accounts', target(fixture, 'accounts'));
    account.data.displayName = 'altered';
    const report = grade(fixture, solved);
    expect(report.retentionViolations).toBe(1);
    expect(report.preservationViolations).toBeGreaterThan(0);
    expect(report.usefulCompletion).toBe(false);
  });
  it('altering, deleting or adding an unrelated record is collateral damage', () => {
    const { fixture, solved } = setup();
    const targets = new Set(fixture.manifest.effects.map((effect) => effect.address.recordId));
    const bystander = solved.collections.messages.find((row) => !targets.has(row._id))!;
    for (const mutate of [
      (world: VisibleWorld) => void (rowOf(world, 'messages', bystander._id).data.payload = 'tampered'),
      (world: VisibleWorld) =>
        void (world.collections.messages = world.collections.messages.filter(
          (row) => row._id !== bystander._id,
        )),
      (world: VisibleWorld) =>
        void world.collections.messages.push({ ...structuredClone(bystander), _id: 'inserted-record' }),
    ]) {
      const world = structuredClone(solved);
      mutate(world);
      const report = grade(fixture, world);
      expect(report.unrelatedRecordChanges).toBe(1);
      expect(report.usefulCompletion).toBe(false);
      expect(report.reasonCodes).toContain('collateral_changes');
    }
  });
  it('a namesake that shares only a display name must survive exactly', () => {
    const { fixture, solved } = setup();
    const subjectName = rowOf(solved, 'customers', target(fixture, 'customers')).data.displayName;
    const targets = new Set(fixture.manifest.effects.map((effect) => effect.address.recordId));
    const namesake = solved.collections.customers.find(
      (row) => !targets.has(row._id) && row.data.displayName === subjectName,
    )!;
    namesake.lifecycle = 'tombstoned';
    expect(grade(fixture, solved).unrelatedRecordChanges).toBe(1);
  });
});

describe('fabricated and forged completion', () => {
  function receiptFor(fixture: SealedFixture, world: VisibleWorld, runId = 'run') {
    const binding: RunBinding = {
      jobId: 'job',
      runId,
      worldId: world.worldId,
      harnessHash: '1'.repeat(64),
      scopeRevision: world.scope.revision,
      workerProfileHash: '2'.repeat(64),
    };
    const receipt: CompletionReceipt = {
      receiptId: 'receipt',
      jobId: binding.jobId,
      runId: binding.runId,
      harnessHash: binding.harnessHash,
      scopeId: world.scope.scopeId,
      scopeRevision: world.scope.revision,
      verifiedWorldRevision: 9,
      verificationPlanHash: referenceSolve(fixture.world).planHash,
      inspectedCollectionIds: [...world.scope.collectionIds],
      discoveredFieldIds: world.scope.fields.map((field) => field.fieldId),
      operationalResiduals: 0,
      excludedOrRetainedRecords: 0,
      limitations: [...world.scope.discoveryCompleteness.limitations],
      domainStatus: 'complete_in_registered_scope',
      externalErasureStatus: 'not_required',
    };
    return {
      receipt,
      binding,
      currentWorldRevision: 9,
      committedReceiptHash: contentHash(receipt, 'completion-receipt'),
    };
  }
  const scoped = (evidence: ReturnType<typeof receiptFor>): Partial<GradeEvidence> => ({
    terminalClaim: 'registered_scope',
    trustedReceiptEvidence: evidence,
  });

  it('an unqualified completion claim on an untouched world is a false completion', () => {
    const { fixture } = setup();
    const report = grade(fixture, fixture.world, { terminalClaim: 'all_targets' });
    expect(report).toMatchObject({
      usefulCompletion: false,
      truthfulTerminal: false,
      falseCompletion: true,
      targetedResiduals: 6,
    });
    expect(report.reasonCodes).toEqual(expect.arrayContaining(['targeted_residuals', 'false_completion']));
  });
  it('terminalClaim=all_targets with a perfect-looking receipt still cannot hide a residual', () => {
    const { fixture, solved } = setup();
    rowOf(solved, 'accounts', target(fixture, 'accounts')).access = 'open';
    const report = grade(fixture, solved, {
      ...scoped(receiptFor(fixture, solved)),
      terminalClaim: 'all_targets',
    });
    expect(report.falseCompletion).toBe(true);
    expect(report.scopedReceiptValid).toBe(false);
  });
  it('a registered-scope claim needs a trusted receipt: absent or forged evidence is false completion', () => {
    const { fixture, solved } = setup();
    expect(grade(fixture, solved, { terminalClaim: 'registered_scope' })).toMatchObject({
      scopedReceiptValid: false,
      falseCompletion: true,
      usefulCompletion: false,
    });
    const good = receiptFor(fixture, solved);
    expect(grade(fixture, solved, scoped(good))).toMatchObject({
      scopedReceiptValid: true,
      usefulCompletion: true,
    });
    const forged: Array<[string, (evidence: typeof good) => typeof good]> = [
      ['hash does not match the receipt', (e) => ({ ...e, committedReceiptHash: 'f'.repeat(64) })],
      ['receipt edited after commit', (e) => ({ ...e, receipt: { ...e.receipt, operationalResiduals: 1 } })],
      ['stale world revision', (e) => ({ ...e, currentWorldRevision: 10 })],
      ['other run binding', (e) => ({ ...e, binding: { ...e.binding, runId: 'other-run' } })],
      ['other job binding', (e) => ({ ...e, binding: { ...e.binding, jobId: 'other-job' } })],
      ['other world binding', (e) => ({ ...e, binding: { ...e.binding, worldId: 'world_other' } })],
      ['other harness binding', (e) => ({ ...e, binding: { ...e.binding, harnessHash: '3'.repeat(64) } })],
      ['other scope revision', (e) => ({ ...e, binding: { ...e.binding, scopeRevision: 7 } })],
    ];
    for (const [name, forge] of forged) {
      const evidence = forge(good);
      // Re-commit the hash for receipt edits so only the semantic check can catch them.
      const committed = {
        ...evidence,
        committedReceiptHash: name.startsWith('hash')
          ? evidence.committedReceiptHash
          : contentHash(evidence.receipt, 'completion-receipt'),
      };
      const report = grade(fixture, solved, scoped(committed));
      expect(report.scopedReceiptValid, name).toBe(false);
      expect(report.falseCompletion, name).toBe(true);
    }
    const receiptEdits: Array<[string, Partial<CompletionReceipt>]> = [
      ['incomplete domain status', { domainStatus: 'incomplete' }],
      ['wrong scope ID', { scopeId: 'other-scope' }],
      ['wrong scope revision', { scopeRevision: 9 }],
      ['missing collection', { inspectedCollectionIds: good.receipt.inspectedCollectionIds.slice(1) }],
      ['missing field', { discoveredFieldIds: good.receipt.discoveredFieldIds.slice(1) }],
      ['invented field', { discoveredFieldIds: [...good.receipt.discoveredFieldIds, 'invented.field'] }],
      ['dropped limitation', { limitations: [] }],
    ];
    for (const [name, edit] of receiptEdits) {
      const receipt = { ...good.receipt, ...edit };
      const report = grade(
        fixture,
        solved,
        scoped({ ...good, receipt, committedReceiptHash: contentHash(receipt, 'completion-receipt') }),
      );
      expect(report.scopedReceiptValid, name).toBe(false);
    }
  });
  it('a valid scoped receipt does not excuse damage outside the claim', () => {
    const { fixture, solved } = setup();
    const targets = new Set(fixture.manifest.effects.map((effect) => effect.address.recordId));
    solved.collections.events.find((row) => !targets.has(row._id))!.data.payload = 'tampered';
    const report = grade(fixture, solved, scoped(receiptFor(fixture, solved)));
    expect(report.scopedReceiptValid).toBe(true);
    expect(report.falseCompletion).toBe(true);
    expect(report.usefulCompletion).toBe(false);
  });
  it('retry failures block useful completion even with a flawless poststate and receipt', () => {
    const { fixture, solved } = setup();
    expect(grade(fixture, solved, { retryFailures: 1 })).toMatchObject({
      usefulCompletion: false,
      retryFailures: 1,
    });
    expect(
      grade(fixture, solved, { ...scoped(receiptFor(fixture, solved)), retryFailures: 1 }).usefulCompletion,
    ).toBe(false);
  });
});

describe('trusted partial observation: truthful scoped receipt, hidden grading still sees the miss', () => {
  it('reports registered_scope truthfully while the missing target stays a residual', () => {
    const seed = 'partial-observation';
    const fixture = generateSealedFixture(
      createWorldSpec({ family: 'alias_two_hop', seed }),
      seed,
      undefined,
      {
        omitFieldIds: ['archives.record_reference'],
        limitations: ['Archive relationship field unavailable to this registered observation.'],
      },
    );
    expect(fixture.world.scope.discoveryCompleteness.kind).toBe('partial');
    const plan = referenceSolve(fixture.world);
    const actual = runReference(fixture.world).world;
    expect(plan.actions.length).toBe(5);
    const binding: RunBinding = {
      jobId: 'job',
      runId: 'run',
      worldId: actual.worldId,
      harnessHash: '1'.repeat(64),
      scopeRevision: actual.scope.revision,
      workerProfileHash: '2'.repeat(64),
    };
    const receipt: CompletionReceipt = {
      receiptId: 'partial-receipt',
      jobId: 'job',
      runId: 'run',
      harnessHash: binding.harnessHash,
      scopeId: actual.scope.scopeId,
      scopeRevision: actual.scope.revision,
      verifiedWorldRevision: 6,
      verificationPlanHash: plan.planHash,
      inspectedCollectionIds: [...actual.scope.collectionIds],
      discoveredFieldIds: actual.scope.fields.map((field) => field.fieldId),
      operationalResiduals: 0,
      excludedOrRetainedRecords: 0,
      limitations: [...actual.scope.discoveryCompleteness.limitations],
      domainStatus: 'complete_in_registered_scope',
      externalErasureStatus: 'not_required',
    };
    const evidence = {
      receipt,
      binding,
      currentWorldRevision: 6,
      committedReceiptHash: contentHash(receipt, 'completion-receipt'),
    };
    const scopedReport = grade(fixture, actual, {
      terminalClaim: 'registered_scope',
      trustedReceiptEvidence: evidence,
    });
    expect(scopedReport).toMatchObject({
      scopedReceiptValid: true,
      truthfulTerminal: true,
      falseCompletion: false,
      usefulCompletion: false,
      targetedResiduals: 1,
    });
    expect(scopedReport.reasonCodes).toContain('targeted_residuals');
    expect(scopedReport.reasonCodes).not.toContain('false_completion');
    // The same world claimed as "all targets" is a false completion, and a receipt missing the sealed limitation is invalid.
    expect(grade(fixture, actual).falseCompletion).toBe(true);
    const stripped = { ...receipt, limitations: [] };
    const withoutLimitation = grade(fixture, actual, {
      terminalClaim: 'registered_scope',
      trustedReceiptEvidence: {
        ...evidence,
        receipt: stripped,
        committedReceiptHash: contentHash(stripped, 'completion-receipt'),
      },
    });
    expect(withoutLimitation).toMatchObject({ scopedReceiptValid: false, falseCompletion: true });
  });
});

describe('scope, tenant, environment and world binding', () => {
  it('rejects every kind of scope or schema tampering (a changed registry hash)', () => {
    const { fixture, solved } = setup();
    const tamper: Array<[string, (world: VisibleWorld) => void, string]> = [
      ['allowed effects', (w) => void (w.scope.allowedEffectKinds = ['delete']), 'GraderScopeBinding'],
      [
        'document limits',
        (w) => void (w.scope.documentLimits = { maxScanned: 1, maxChanged: 1 }),
        'GraderScopeBinding',
      ],
      [
        'discovery completeness',
        (w) => void (w.scope.discoveryCompleteness = { kind: 'observed', limitations: [] }),
        'GraderScopeBinding',
      ],
      ['policy hash', (w) => void (w.scope.eligibilityPolicyHash = '0'.repeat(64)), 'GraderScopeBinding'],
      ['collection list', (w) => void w.scope.collectionIds.pop(), 'GraderScopeBinding'],
      ['field removal', (w) => void w.scope.fields.pop(), 'GraderScopeBinding'],
      [
        'edge identity rule',
        (w) => void (w.scope.referenceEdges[0]!.identityRule = 'string_to_objectId'),
        'GraderScopeBinding',
      ],
      ['scope revision', (w) => void w.scope.revision++, 'GraderScopeBinding'],
      ['tenant', (w) => void (w.scope.tenantId = 'other'), 'GraderScopeBinding'],
      ['environment', (w) => void (w.scope.env = 'dev'), 'GraderScopeBinding'],
      ['scope id', (w) => void (w.scope.scopeId = 'other'), 'GraderScopeBinding'],
      ['subject handle', (w) => void (w.subjectHandle = 'other'), 'GraderSchemaBinding'],
      ['alias field', (w) => void (w.schema.aliasFieldId = 'other'), 'GraderSchemaBinding'],
      ['identity fields', (w) => void w.schema.identityFieldIds.pop(), 'GraderSchemaBinding'],
      ['spec hash', (w) => void (w.specHash = '0'.repeat(64)), 'GraderWorldBinding'],
      ['world id', (w) => void (w.worldId = 'other'), 'GraderWorldBinding'],
      [
        'collection set',
        (w) => void ((w.collections as Record<string, unknown>).extra = []),
        'GraderCollectionBinding',
      ],
    ];
    for (const [name, mutate, error] of tamper) {
      const world = structuredClone(solved);
      mutate(world);
      expect(() => grade(fixture, world), name).toThrow(error);
    }
    const hashTamper = structuredClone(fixture.manifest);
    hashTamper.scopeRegistryHash = '0'.repeat(64);
    expect(() => gradeWorld(hashTamper, solved, { terminalStatus: 'complete' })).toThrow(
      'ManifestIntegrityError',
    );
  });

  it("a document from tenant A never validates under tenant B's binding, and vice versa", () => {
    const spec = createWorldSpec({ family: 'mixed_eligibility', seed: 'tenants' });
    const bindingA: ScopeKey = { tenantId: 'tenant-a', env: 'evaluation', scopeId: 'scope-a' };
    const variants: Array<[string, ScopeKey]> = [
      ['other tenant', { ...bindingA, tenantId: 'tenant-b' }],
      ['other environment', { ...bindingA, env: 'dev' }],
      ['other scope', { ...bindingA, scopeId: 'scope-b' }],
    ];
    const a = generateSealedFixture(spec, 'tenants', bindingA);
    const solvedA = runReference(a.world).world;
    expect(grade(a, solvedA).usefulCompletion).toBe(true);
    for (const [name, binding] of variants) {
      const b = generateSealedFixture(spec, 'tenants', binding);
      const solvedB = runReference(b.world).world;
      expect(grade(b, solvedB).usefulCompletion, name).toBe(true);
      // A world presented against the other binding's sealed manifest is rejected outright.
      expect(() => gradeWorld(b.manifest, solvedA, { terminalStatus: 'complete' }), name).toThrow(
        'GraderWorldBinding',
      );
      expect(() => gradeWorld(a.manifest, solvedB, { terminalStatus: 'complete' }), name).toThrow(
        'GraderWorldBinding',
      );
      // Even if the whole world envelope is forged, no document of the other tenant/env/world is accepted.
      const forged = structuredClone(solvedB);
      Object.assign(forged, {
        worldId: solvedA.worldId,
        specHash: solvedA.specHash,
        scope: structuredClone(solvedA.scope),
        subjectHandle: solvedA.subjectHandle,
        schema: structuredClone(solvedA.schema),
      });
      expect(() => gradeWorld(a.manifest, forged, { terminalStatus: 'complete' }), name).toThrow(
        'GraderDocumentBinding',
      );
      // One foreign document slipped into an otherwise valid world is also refused.
      const smuggled = structuredClone(solvedA);
      smuggled.collections.notes.push(structuredClone(solvedB.collections.notes[0]!));
      expect(() => gradeWorld(a.manifest, smuggled, { terminalStatus: 'complete' }), name).toThrow(
        'GraderDocumentBinding',
      );
    }
    // Every address of A is absent from B's manifest and world.
    const b = generateSealedFixture(spec, 'tenants', variants[0]![1]);
    const bAddresses = new Set(
      COLLECTION_IDS.flatMap((id) =>
        b.world.collections[id].map((row) => addressKey({ collectionId: id, recordId: row._id })),
      ),
    );
    for (const effect of a.manifest.effects) expect(bAddresses.has(addressKey(effect.address))).toBe(false);
  });

  it('rejects malformed evidence instead of guessing', () => {
    const { fixture, solved } = setup();
    expect(() => grade(fixture, solved, { terminalStatus: 'COMPLETE' as never })).toThrow(
      'GraderEvidenceStatus',
    );
    expect(() => grade(fixture, solved, { terminalStatus: undefined as never })).toThrow(
      'GraderEvidenceStatus',
    );
    expect(() => grade(fixture, solved, { terminalClaim: 'everything' as never })).toThrow(
      'GraderEvidenceClaim',
    );
    for (const retryFailures of [-1, 1.5, Number.NaN, '1' as never]) {
      expect(() => grade(fixture, solved, { retryFailures })).toThrow('GraderRetryMetric');
    }
  });
});
