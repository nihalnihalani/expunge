import { describe, expect, it } from 'vitest';
import {
  PRIVATE_ID_DOMAIN,
  bundlesDisjoint,
  privateIdHash,
  selectWrongIncident,
  validateProjectionPayload,
  type EvidenceBundle,
} from '../src/index.js';
import { PROJECTION_SAMPLES } from './projection-samples.js';

const bundle = (n: number, over: Partial<EvidenceBundle> = {}): EvidenceBundle => ({
  evidenceId: `ev-${n}`,
  actor: { tenantId: 't', env: 'evaluation', scopeId: 's' },
  binding: {
    jobId: `job-${n}`,
    runId: `run-${n}`,
    worldId: `world-${n}`,
    harnessHash: 'h'.repeat(64),
    scopeRevision: 1,
    workerProfileHash: 'p'.repeat(64),
  },
  tools: [],
  failureWitnesses: [],
  diagnostics: [],
  modelOutput: '',
  sources: [
    {
      provider: 'raindrop',
      externalEventId: `evt-${n}`,
      externalSignalIds: [`sig-${n}`],
      localSourceIds: [`local-${n}`],
      origin: 'verifier_feedback',
      redactionPolicy: 'v1',
      retrievedAt: '2026-06-02T00:00:00.000Z',
      contentHash: 'a'.repeat(64),
      permittedUse: 'training',
    },
  ],
  cost: {
    modelCalls: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    costMicrousd: 0,
    unpricedCalls: 0,
    mongoOperations: 0,
    wallTimeMs: 0,
  },
  confidence: 0.5,
  split: 'train',
  ...over,
});

describe('privateIdHash (shared by the grader export and the observer check)', () => {
  it('has the agreed domain and test vector: hex(sha256(domain NUL salt NUL NFKC(id)))', () => {
    expect(PRIVATE_ID_DOMAIN).toBe('expunge-private-id:v1');
    expect(privateIdHash('salt-world-1', 'cust-0042')).toBe(
      'a30814d6ac27eae743f8e779f8f159c9da44845082a774d374153952ef671db7',
    );
    expect(privateIdHash('salt-world-1', 'ｃust-0042')).toBe(privateIdHash('salt-world-1', 'cust-0042'));
    expect(privateIdHash('salt-world-2', 'cust-0042')).not.toBe(privateIdHash('salt-world-1', 'cust-0042'));
  });
});

describe('selectWrongIncident', () => {
  it('returns the first pool bundle by evidenceId that is disjoint from EVERY incident bundle, else null', () => {
    const a = bundle(1);
    const b = bundle(2);
    const c = bundle(3);
    expect(selectWrongIncident([a], [c, b])?.evidenceId).toBe('ev-2');
    expect(selectWrongIncident([a, b], [b, c])?.evidenceId).toBe('ev-3');
    expect(selectWrongIncident([a], [])).toBeNull();
    expect(selectWrongIncident([a], [a])).toBeNull();
  });

  it('excludes bundles that share a job, a world or any source identifier', () => {
    const a = bundle(1);
    const sameJob = bundle(2, { binding: { ...bundle(2).binding, jobId: a.binding.jobId } });
    const sameWorld = bundle(3, { binding: { ...bundle(3).binding, worldId: a.binding.worldId } });
    const sameSignal = bundle(4, { sources: [{ ...bundle(4).sources[0]!, externalSignalIds: ['sig-1'] }] });
    const sameLocal = bundle(5, { sources: [{ ...bundle(5).sources[0]!, localSourceIds: ['local-1'] }] });
    for (const other of [sameJob, sameWorld, sameSignal, sameLocal])
      expect(bundlesDisjoint(a, other)).toBe(false);
    expect(selectWrongIncident([a], [sameJob, sameWorld, sameSignal, sameLocal])).toBeNull();
    expect(bundlesDisjoint(a, bundle(6))).toBe(true);
  });
});

describe('evidence_ready projection payload: optional delivery labels', () => {
  const base = PROJECTION_SAMPLES.evidence_ready;
  it('accepts the payload with and without delivery, and rejects unknown labels', () => {
    expect(() => validateProjectionPayload('evidence_ready', base)).not.toThrow();
    const delivery = {
      sdkEnqueued: 'worker_attested',
      ingestAccepted: 'inferred',
      queryVisible: 'observed',
      evidenceReady: 'observed',
    };
    expect(() => validateProjectionPayload('evidence_ready', { ...base, delivery })).not.toThrow();
    expect(() =>
      validateProjectionPayload('evidence_ready', {
        ...base,
        delivery: { ...delivery, ingestAccepted: 'guessed' },
      }),
    ).toThrow();
    expect(() =>
      validateProjectionPayload('evidence_ready', { ...base, delivery: { ...delivery, extra: 'x' } }),
    ).toThrow();
    expect(() =>
      validateProjectionPayload('evidence_ready', {
        ...base,
        delivery: { ...delivery, queryVisible: 'inferred' },
      }),
    ).toThrow();
  });
});
