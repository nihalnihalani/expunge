import type { EvidenceBundle, EvidenceReference, JsonValue } from '@expunge/contracts';
import { bundlesDisjoint, selectWrongIncident } from '@expunge/contracts';
import { privateIdHash } from '@expunge/observability';
import { describe, expect, it } from 'vitest';
import {
  BundleError,
  assembleEvidenceBundle,
  assertNoLeak,
  bundleBudget,
  observeEvent,
  scoreOnlyControl,
  wrongIncidentControl,
  type BundleInput,
} from '../src/index.js';
import { GUARD, LITERAL, SCOPE } from './helpers.js';

const cost = {
  modelCalls: 2,
  toolCalls: 3,
  inputTokens: 100,
  outputTokens: 20,
  costMicrousd: 40,
  unpricedCalls: 0,
  mongoOperations: 5,
  wallTimeMs: 900,
};
const decision = { result: 'allow' as const, ruleIds: ['r1'], authorizationRevision: 2 };
const source = (over: Partial<EvidenceReference> = {}): EvidenceReference => ({
  provider: 'raindrop',
  externalEventId: 'evt-1',
  externalSignalIds: [],
  localSourceIds: ['ledger-1'],
  origin: 'verifier_feedback',
  redactionPolicy: 'v1',
  retrievedAt: '2026-06-02T00:00:00.000Z',
  contentHash: 'a'.repeat(64),
  permittedUse: 'training',
  ...over,
});
const observation = (runId = 'run-1') =>
  observeEvent(
    'proj-1',
    {
      id: `evt-${runId}`,
      event_name: 'expunge.worker',
      timestamp: '2026-06-02T00:00:00.000Z',
      properties: { role: 'worker', run_id: runId },
      feature_flags: {},
    } as never,
    { guard: GUARD },
  );

/** Two incidents that share nothing: distinct job, world and every source id. */
function input(over: Partial<BundleInput> = {}, n = 1): BundleInput {
  const runId = `run-${n}`;
  return {
    evidenceId: `ev-${runId}`,
    actor: SCOPE,
    binding: {
      jobId: `job-${n}`,
      runId,
      worldId: `world-${n}`,
      harnessHash: 'h'.repeat(64),
      scopeRevision: 1,
      workerProfileHash: 'p'.repeat(64),
    },
    split: 'train',
    observation: observation(runId),
    tools: [
      { toolId: 'inspect_scope', input: { table: 'orders' }, output: { rows: 3 }, decision },
      { toolId: 'delete_rows', input: { ids: ['a'] }, output: { deleted: 1 }, decision },
    ],
    diagnostics: [],
    failureWitnesses: [{ kind: 'residual', table: 'audit_log', count: 4 }],
    modelOutputSha256: 'b'.repeat(64),
    cost,
    confidence: 0.8,
    sources: [
      source({ externalEventId: `evt-${n}`, localSourceIds: [`ledger-${n}`] }),
      source({
        origin: 'agent_self_report',
        contentHash: 'c'.repeat(64),
        externalEventId: `evt-${n}b`,
        localSourceIds: [`self-${n}`],
      }),
    ],
    guard: GUARD,
    ...over,
  };
}

describe('assembleEvidenceBundle', () => {
  it('keeps origin labels exactly as given and records split and cost', () => {
    const bundle = assembleEvidenceBundle(input());
    expect(bundle.sources.map((s) => s.origin)).toEqual(['verifier_feedback', 'agent_self_report']);
    expect(bundle.split).toBe('train');
    expect(bundle.cost).toEqual(cost);
    expect(bundle.tools).toHaveLength(2);
    expect(bundle.failureWitnesses).toHaveLength(1);
    expect(bundle.withheld).toEqual({ freeText: false, values: false });
  });

  it('stores only a hash placeholder for the model narrative', () => {
    const bundle = assembleEvidenceBundle(input());
    expect(bundle.modelOutput).toBe(`untrusted-model-output:sha256:${'b'.repeat(64)}`);
    expect(assembleEvidenceBundle(input({ modelOutputSha256: undefined })).modelOutput).toBe('');
  });

  it.each(['protected', 'validation', 'final'] as const)(
    'withholds raw witnesses and tool values for the %s split, and says so',
    (split) => {
      const bundle = assembleEvidenceBundle(input({ split }));
      expect(bundle.failureWitnesses).toEqual([]);
      for (const tool of bundle.tools) {
        expect(tool.input).toEqual({ withheld: true, split });
        expect(tool.output).toEqual({ withheld: true, split });
      }
      expect(JSON.stringify(bundle)).not.toContain('audit_log');
      expect(JSON.stringify(bundle)).not.toContain('orders');
      expect(bundle.tools.map((t) => t.toolId)).toEqual(['inspect_scope', 'delete_rows']);
      expect(bundle.withheld).toMatchObject({ values: true });
    },
  );

  it('refuses revoked evidence and unlabeled or unsupported classifier sources', () => {
    expect(() => assembleEvidenceBundle(input({ sources: [source({ permittedUse: 'revoked' })] }))).toThrow(
      /RevokedEvidence/,
    );
    expect(() =>
      assembleEvidenceBundle(input({ sources: [source({ origin: 'raindrop_classifier' })] })),
    ).toThrow(/signal id/);
    expect(() =>
      assembleEvidenceBundle(input({ sources: [source({ origin: 'made_up' as never })] })),
    ).toThrow(/InvalidSource/);
    expect(
      assembleEvidenceBundle(
        input({ sources: [source({ origin: 'raindrop_classifier', externalSignalIds: ['sig-1'] })] }),
      ).sources[0]!.origin,
    ).toBe('raindrop_classifier');
  });

  it('refuses empty sources and out-of-range confidence', () => {
    expect(() => assembleEvidenceBundle(input({ sources: [] }))).toThrow(/EmptySources/);
    expect(() => assembleEvidenceBundle(input({ confidence: 1.5 }))).toThrow(/InvalidConfidence/);
    expect(() => assembleEvidenceBundle(input({ confidence: Number.NaN }))).toThrow(/InvalidConfidence/);
  });

  it('refuses a quarantined observation outright', () => {
    const quarantined = observeEvent(
      'proj-1',
      {
        id: 'evt-q',
        event_name: 'x',
        timestamp: 't',
        properties: { expectedState: 1 },
        feature_flags: {},
      } as never,
      { guard: GUARD },
    );
    expect(quarantined.quarantined).toBe('HeldOutLeak');
    expect(() => assembleEvidenceBundle(input({ observation: quarantined }))).toThrow(
      /QuarantinedObservation/,
    );
  });
});

describe('O1: the held-out and subject guard cannot be bypassed by renaming, encoding or omission', () => {
  const refused = (over: Partial<BundleInput>, code: string) => {
    try {
      assembleEvidenceBundle(input(over));
    } catch (error) {
      expect(error).toBeInstanceOf(BundleError);
      expect((error as BundleError).code).toBe(code);
      return;
    }
    throw new Error(`expected ${code}`);
  };

  it('O1: expectedState, expected_poststate and manifestHash in a diagnostic are HeldOutLeak', () => {
    for (const key of [
      'expectedState',
      'expected_poststate',
      'manifestHash',
      'seeds',
      'held_out',
      'oracle_targets',
      'groundTruthIds',
    ])
      refused({ diagnostics: [{ [key]: ['x'] }], sources: input().sources }, 'HeldOutLeak');
  });

  it('O1: a subject literal used as an object KEY in a failure witness is SubjectLiteral', () => {
    refused({ failureWitnesses: [{ [LITERAL]: true }] }, 'SubjectLiteral');
  });

  it('O1: base64, hex, URL-encoded and split forms of the literal are SubjectLiteral', () => {
    const forms: JsonValue[] = [
      Buffer.from(LITERAL).toString('base64'),
      Buffer.from(LITERAL).toString('hex'),
      encodeURIComponent(LITERAL),
      ['syn_subj', 'ect_maria_rossi'],
    ];
    for (const form of forms) refused({ failureWitnesses: [{ note: form }] }, 'SubjectLiteral');
  });

  it('O1: a bundle built without forbiddenLiterals is MissingForbiddenLiterals', () => {
    refused({ guard: undefined as never }, 'MissingForbiddenLiterals');
    refused({ guard: { forbiddenLiterals: [] } }, 'MissingForbiddenLiterals');
  });

  it('O1: a private id from the grader salted-hash set is PrivateIdLeak whatever key it sits under', () => {
    const privateIds = { salt: 'world-salt', hashes: [privateIdHash('world-salt', 'cust-0042')] };
    refused(
      { guard: { ...GUARD, privateIds }, failureWitnesses: [{ anything: 'record cust-0042 removed' }] },
      'PrivateIdLeak',
    );
    expect(() =>
      assembleEvidenceBundle(
        input({ guard: { ...GUARD, privateIds }, failureWitnesses: [{ anything: 'record cust-9999' }] }),
      ),
    ).not.toThrow();
  });

  it('O1: assertNoLeak itself needs a guard', () => {
    expect(() => assertNoLeak({ a: 1 }, undefined as never)).toThrowError(/MissingForbiddenLiterals/);
    expect(() => assertNoLeak({ a: { seedCommitment: 'x' } }, GUARD)).toThrowError(
      /HeldOutLeak:\$\.a\.seedCommitment/,
    );
    expect(() => assertNoLeak({ a: { harmless: 1 } }, GUARD)).not.toThrow();
  });
});

describe('O7: diagnostics are model narrative', () => {
  const diagnostic = (detail: string): JsonValue => ({ category: 'missing_context', detail });

  it('O7: reach a bundle only on the train split, and only beside an agent_self_report source', () => {
    const train = assembleEvidenceBundle(input({ diagnostics: [diagnostic('registry has no archive')] }));
    expect(train.diagnostics).toHaveLength(1);
    for (const split of ['protected', 'validation', 'final'] as const) {
      const other = assembleEvidenceBundle(
        input({ split, diagnostics: [diagnostic('registry has no archive')] }),
      );
      expect(other.diagnostics).toEqual([]);
      expect(other.withheld?.freeText).toBe(true); // absence is flagged, not silent
    }
    expect(() =>
      assembleEvidenceBundle(
        input({ diagnostics: [diagnostic('x')], sources: [source({ origin: 'verifier_feedback' })] }),
      ),
    ).toThrow(/agent_self_report/);
  });

  it('O7: with the literal list, text carrying none of them stays readable and the bundle says nothing was withheld', () => {
    const bundle = assembleEvidenceBundle(
      input({ diagnostics: [diagnostic('registry has no archive collection')] }),
    );
    expect(JSON.stringify(bundle.diagnostics)).toContain('registry has no archive collection');
    expect(bundle.withheld?.freeText).toBe(false);
  });

  it('O7: with only a private-id set (no literals) every free-text value is reduced to a hash and flagged as withheld', () => {
    const privateIds = { salt: 's', hashes: [privateIdHash('s', 'cust-1')] };
    const bundle = assembleEvidenceBundle(
      input({
        guard: { forbiddenLiterals: [], privateIds },
        diagnostics: [diagnostic('registry has no archive collection')],
      }),
    );
    expect(JSON.stringify(bundle.diagnostics)).not.toContain('registry has no archive');
    expect(JSON.stringify(bundle.diagnostics)).toMatch(/\[redacted:[a-f0-9]{16}\]/);
    expect(bundle.withheld?.freeText).toBe(true);
  });

  it('O7: a diagnostic that carries a subject literal is reduced to a hash, never kept readable, and flagged as withheld', () => {
    const bundle = assembleEvidenceBundle(input({ diagnostics: [diagnostic(`about ${LITERAL}`)] }));
    expect(JSON.stringify(bundle)).not.toContain(LITERAL);
    expect(JSON.stringify(bundle.diagnostics)).toMatch(/\[redacted:[a-f0-9]{16}\]/);
    expect(bundle.withheld?.freeText).toBe(true);
  });
});

describe('O4: delivery-proof labels travel with the evidence reference', () => {
  it('O4: sources[i].delivery survives assembly with the labels the dispatcher wrote', () => {
    const delivery = {
      sdkEnqueued: 'worker_attested' as const,
      ingestAccepted: 'inferred' as const,
      queryVisible: 'observed' as const,
      evidenceReady: 'observed' as const,
    };
    const bundle = assembleEvidenceBundle(input({ sources: [source({ delivery })] }));
    expect(bundle.sources[0]!.delivery).toEqual(delivery);
  });
});

describe('controls', () => {
  const real = () => assembleEvidenceBundle(input());
  const other = (over: Partial<BundleInput> = {}) => assembleEvidenceBundle(input(over, 2));

  it('score-only control keeps identity and score sources but no trace-derived content', () => {
    const bundle = real();
    const control = scoreOnlyControl(bundle);
    expect(control.binding).toEqual(bundle.binding);
    expect(control.split).toBe(bundle.split);
    expect(control.cost).toEqual(bundle.cost);
    expect(control.tools).toEqual([]);
    expect(control.diagnostics).toEqual([]);
    expect(control.failureWitnesses).toEqual([]);
    expect(control.modelOutput).toBe('');
    expect(
      control.sources.every((s) => s.origin === 'verifier_feedback' || s.origin === 'admission_service'),
    ).toBe(true);
    expect(bundleBudget(control)).toBeLessThanOrEqual(bundleBudget(bundle));
  });

  it('score-only control refuses when no score source exists', () => {
    const bundle = assembleEvidenceBundle(
      input({ sources: [source({ origin: 'agent_self_report' })], diagnostics: [] }),
    );
    expect(() => scoreOnlyControl(bundle)).toThrow(/EmptySources/);
  });

  it('wrong-incident control carries another incident under this identity and never exceeds the budget', () => {
    const bundle = real();
    const control = wrongIncidentControl(bundle, other());
    expect(control.binding).toEqual(bundle.binding);
    expect(control.tools.map((t) => t.toolId)).not.toContain('inspect_scope_other');
    expect(bundleBudget(control)).toBeLessThanOrEqual(bundleBudget(bundle));
    expect(control.evidenceId).toBe(`${bundle.evidenceId}:wrong_incident`);
  });

  it('O5: a control built from an incident with ten sources and a long output still fits the treatment budget (sources and model output are trimmed)', () => {
    const small = assembleEvidenceBundle(input({ tools: [], failureWitnesses: [], sources: [source()] }));
    const bigSources = Array.from({ length: 10 }, (_, i) =>
      source({
        externalEventId: `big-${i}`,
        localSourceIds: [`big-ledger-${i}`],
        contentHash: String(i).repeat(64).slice(0, 64),
      }),
    );
    const big = assembleEvidenceBundle(
      input(
        {
          sources: bigSources,
          tools: [{ toolId: 'one', input: { a: 1 }, output: { b: 2 }, decision }],
          modelOutputSha256: 'd'.repeat(64),
        },
        2,
      ),
    );
    const control = wrongIncidentControl(small, big);
    expect(bundleBudget(control)).toBeLessThanOrEqual(bundleBudget(small));
    expect(control.sources.length).toBeLessThan(bigSources.length);
  });

  it('O5: throws ControlOverBudget when even a single source cannot fit', () => {
    const tiny = assembleEvidenceBundle(
      input({
        tools: [],
        failureWitnesses: [],
        modelOutputSha256: undefined,
        sources: [source({ localSourceIds: [] })],
      }),
    );
    const huge = assembleEvidenceBundle(
      input(
        {
          tools: [],
          failureWitnesses: [],
          sources: [
            source({
              externalEventId: 'huge-evt',
              localSourceIds: Array.from({ length: 200 }, (_, i) => `l${i}-xxxxxxxxxxxx`),
            }),
          ],
        },
        2,
      ),
    );
    expect(() => wrongIncidentControl(tiny, huge)).toThrow(/ControlOverBudget/);
  });

  it('O5: another run of the SAME job, the same world, or any overlapping source id is not an unrelated incident', () => {
    const bundle = real();
    const sameJob = other({ binding: { ...input(undefined, 2).binding, jobId: bundle.binding.jobId } });
    const sameWorld = other({ binding: { ...input(undefined, 2).binding, worldId: bundle.binding.worldId } });
    const sharedEvent = other({ sources: [source({ externalEventId: 'evt-1', localSourceIds: ['x'] })] });
    const sharedSignal = assembleEvidenceBundle(
      input(
        {
          sources: [
            source({
              origin: 'raindrop_classifier',
              externalSignalIds: ['sig-shared'],
              externalEventId: 'e9',
            }),
          ],
        },
        2,
      ),
    );
    const mine = assembleEvidenceBundle(
      input({ sources: [source({ origin: 'raindrop_classifier', externalSignalIds: ['sig-shared'] })] }),
    );
    for (const candidate of [sameJob, sameWorld, sharedEvent]) {
      expect(bundlesDisjoint(bundle, candidate)).toBe(false);
      expect(() => wrongIncidentControl(bundle, candidate)).toThrow(/InvalidSource/);
    }
    expect(bundlesDisjoint(mine, sharedSignal)).toBe(false);
  });

  it('O5: one shared selector (contracts) picks the first disjoint pool bundle by evidenceId, or null', () => {
    const target = real();
    const poolA = other();
    const poolB = assembleEvidenceBundle(input({}, 3));
    const sameJob: EvidenceBundle = {
      ...poolB,
      evidenceId: 'ev-aaa',
      binding: { ...poolB.binding, jobId: target.binding.jobId },
    };
    expect(selectWrongIncident([target], [poolB, sameJob, poolA])?.evidenceId).toBe(poolA.evidenceId);
    expect(selectWrongIncident([target], [sameJob])).toBeNull();
    expect(selectWrongIncident([target, poolA], [poolA, poolB])?.evidenceId).toBe(poolB.evidenceId); // disjoint from EVERY target
    expect(selectWrongIncident([target], [])).toBeNull();
  });

  it('does not hand protected-split witnesses to a wrong-incident control', () => {
    const protectedBundle = assembleEvidenceBundle(input({ split: 'protected' }));
    const control = wrongIncidentControl(protectedBundle, other());
    expect(control.failureWitnesses).toEqual([]);
  });
});
