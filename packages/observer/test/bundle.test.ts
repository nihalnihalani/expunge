import type { EvidenceReference, JsonValue } from '@expunge/contracts';
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
import { SCOPE } from './helpers.js';

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
  observeEvent('proj-1', {
    id: 'evt-1',
    event_name: 'expunge.worker',
    timestamp: '2026-06-02T00:00:00.000Z',
    properties: { role: 'worker', run_id: runId },
    feature_flags: {},
  } as never);

function input(over: Partial<BundleInput> = {}, runId = 'run-1'): BundleInput {
  return {
    evidenceId: `ev-${runId}`,
    actor: SCOPE,
    binding: {
      jobId: `job-${runId}`,
      runId,
      worldId: 'w1',
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
    diagnostics: [{ category: 'tool_error', detail: 'timeout' }],
    failureWitnesses: [{ kind: 'residual', table: 'audit_log', count: 4 }],
    modelOutputSha256: 'b'.repeat(64),
    cost,
    confidence: 0.8,
    sources: [source(), source({ origin: 'agent_self_report', contentHash: 'c'.repeat(64) })],
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
  });

  it('stores only a hash placeholder for the model narrative', () => {
    const bundle = assembleEvidenceBundle(input());
    expect(bundle.modelOutput).toBe(`untrusted-model-output:sha256:${'b'.repeat(64)}`);
    expect(assembleEvidenceBundle(input({ modelOutputSha256: undefined })).modelOutput).toBe('');
  });

  it.each(['protected', 'validation', 'final'] as const)(
    'withholds raw witnesses and tool values for the %s split',
    (split) => {
      const bundle = assembleEvidenceBundle(input({ split }));
      expect(bundle.failureWitnesses).toEqual([]);
      for (const tool of bundle.tools) {
        expect(tool.input).toEqual({ withheld: true, split });
        expect(tool.output).toEqual({ withheld: true, split });
      }
      expect(JSON.stringify(bundle)).not.toContain('audit_log');
      expect(JSON.stringify(bundle)).not.toContain('orders');
      // Structure (which tool, which decision) stays so the proposer sees shape without values.
      expect(bundle.tools.map((t) => t.toolId)).toEqual(['inspect_scope', 'delete_rows']);
    },
  );

  it('refuses any bundle that names held-out truth, at any depth', () => {
    const leaky: JsonValue = { nested: [{ expectedPostState: { rows: 0 } }] };
    expect(() => assembleEvidenceBundle(input({ diagnostics: [leaky] }))).toThrowError(BundleError);
    expect(() => assembleEvidenceBundle(input({ failureWitnesses: [{ privateManifest: 'x' }] }))).toThrow(
      /HeldOutLeak/,
    );
    expect(() => assertNoLeak({ a: { seedCommitment: 'x' } })).toThrow(/HeldOutLeak:\$\.a\.seedCommitment/);
    expect(() => assertNoLeak({ a: { harmless: 1 } })).not.toThrow();
  });

  it('refuses a forbidden subject literal anywhere, case-insensitively', () => {
    expect(() =>
      assembleEvidenceBundle(
        input({ diagnostics: [{ detail: 'user Maria Rossi asked' }], forbiddenLiterals: ['maria rossi'] }),
      ),
    ).toThrow(/SubjectLiteral/);
  });

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
});

describe('controls', () => {
  const real = () => assembleEvidenceBundle(input());
  const other = () =>
    assembleEvidenceBundle(
      input(
        {
          tools: [{ toolId: 'other_tool', input: { x: 1 }, output: { y: 2 }, decision }],
          failureWitnesses: [{ kind: 'different-incident' }],
          diagnostics: [{ category: 'other' }],
        },
        'run-2',
      ),
    );

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
    const bundle = assembleEvidenceBundle(input({ sources: [source({ origin: 'agent_self_report' })] }));
    expect(() => scoreOnlyControl(bundle)).toThrow(/EmptySources/);
  });

  it('wrong-incident control carries another incident under this identity and never exceeds the budget', () => {
    const bundle = real();
    const control = wrongIncidentControl(bundle, other());
    expect(control.binding).toEqual(bundle.binding);
    expect(control.tools.map((t) => t.toolId)).not.toContain('inspect_scope');
    expect(bundleBudget(control)).toBeLessThanOrEqual(bundleBudget(bundle));
    expect(control.evidenceId).toBe(`${bundle.evidenceId}:wrong_incident`);
  });

  it('wrong-incident control is trimmed to a smaller budget and rejects the same run', () => {
    const small = assembleEvidenceBundle(input({ tools: [], diagnostics: [], failureWitnesses: [] }));
    const control = wrongIncidentControl(small, other());
    expect(bundleBudget(control)).toBeLessThanOrEqual(bundleBudget(small));
    expect(() => wrongIncidentControl(real(), real())).toThrow(/different run/);
  });

  it('does not hand protected-split witnesses to a wrong-incident control', () => {
    const protectedBundle = assembleEvidenceBundle(input({ split: 'protected' }));
    const control = wrongIncidentControl(protectedBundle, other());
    expect(control.failureWitnesses).toEqual([]);
  });
});
