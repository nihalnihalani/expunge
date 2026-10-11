import { describe, expect, it } from 'vitest';
import {
  DEFAULT_OWNER_POLICY,
  RetractionRunner,
  enforceScan,
  registerRawSource,
  scanItem,
  scanRetained,
} from '../src/index.js';
import {
  FakeEligibility,
  FakeProvenance,
  FakeRawStore,
  FakePurger,
  FakeRegeneration,
  FakeRuns,
  POLICY,
  SCOPE,
  StaticCatalog,
} from './fakes.js';

const LITERAL = 'maria.rossi';
const guard = { forbiddenLiterals: [LITERAL] };

describe('subject-literal scan of retained artifacts', () => {
  it('catches a planted literal in a lesson: plain, as a key, folded, and encoded', () => {
    const plant = (value: unknown) =>
      scanItem({ artifactId: 'lesson-1', kind: 'lesson', value: value as never }, guard);
    for (const value of [
      { ref: LITERAL },
      { [LITERAL]: 1 },
      { ref: 'MARIA . Rossi' },
      { ref: Buffer.from(LITERAL).toString('base64') },
      { ref: encodeURIComponent(LITERAL) },
      { parts: ['maria', '.ro', 'ssi'] },
    ]) {
      const hits = plant(value).filter((v) => v.type === 'leak');
      expect(hits, JSON.stringify(value)).toHaveLength(1);
      expect(hits[0]).toMatchObject({ code: 'SubjectLiteral' });
    }
  });

  it('passes a hash-only evidence bundle and a structural lesson', () => {
    const bundle = {
      evidenceId: 'ev-1',
      sources: [{ provider: 'raindrop', contentHash: 'a'.repeat(64), origin: 'verifier_feedback' }],
      tools: [{ toolId: 'inspect_scope', count: 3 }],
    };
    const report = scanRetained(
      [
        { artifactId: 'ev-1', kind: 'evidence_bundle', value: bundle },
        {
          artifactId: 'lesson-1',
          kind: 'lesson',
          value: { family: 'orphan_reference', counts: { sources: 2 } },
        },
      ],
      guard,
    );
    expect(report).toMatchObject({ scanned: 2, structural: 2, raw: 0, violations: [] });
  });

  it('distinguishes structural learning from raw retention: free text in a lesson is a violation, in the raw store it is not', () => {
    const text = { note: 'the full transcript of the conversation with the customer' };
    expect(scanItem({ artifactId: 'lesson-2', kind: 'lesson', value: text }, guard)).toEqual([
      { artifactId: 'lesson-2', kind: 'lesson', type: 'raw_retention' },
    ]);
    expect(scanItem({ artifactId: 'src-1', kind: 'raw_source', value: text }, guard)).toEqual([]);
  });

  it('refuses to scan without anything to look for', () => {
    expect(() => scanRetained([], { forbiddenLiterals: [] })).toThrow(/MissingForbiddenLiterals/);
  });

  it('never repeats the matched text in a violation', () => {
    const report = scanRetained(
      [{ artifactId: 'l', kind: 'lesson', value: { ref: `see ${LITERAL}` } }],
      guard,
    );
    expect(JSON.stringify(report)).not.toContain(LITERAL);
  });
});

describe('enforcement: immutability and content addressing are not an exemption', () => {
  it('retracts an ACTIVE artifact with a hit (and what derives from it) and only reports an already inactive one', async () => {
    const eligibility = new FakeEligibility();
    const provenance = new FakeProvenance(eligibility);
    const raw = new FakeRawStore();
    await registerRawSource({ raw, eligibility, policyHash: POLICY }, SCOPE, {
      sourceId: 'src-1',
      kind: 'transcript',
      content: 'x',
      retention: 'hash_only',
    });
    for (const id of ['lesson-bad', 'lesson-old', 'candidate-1'])
      await eligibility.permit(SCOPE, id, POLICY, 'registered');
    await provenance.append(SCOPE, 'lesson-bad', 'candidate-1', 'derived_from');
    eligibility.revoke(SCOPE, 'lesson-old', 'src-0', POLICY, 'earlier');
    const regeneration = new FakeRegeneration();
    const purger = new FakePurger();
    const runner = new RetractionRunner({
      provenance,
      eligibility,
      catalog: new StaticCatalog({ 'lesson-bad': 'lesson', 'candidate-1': 'candidate' }),
      raw,
      purger,
      runs: new FakeRuns(),
      regeneration,
      policy: DEFAULT_OWNER_POLICY(POLICY),
    });
    const report = scanRetained(
      [
        { artifactId: 'lesson-bad', kind: 'lesson', value: { ref: LITERAL } },
        { artifactId: 'lesson-old', kind: 'lesson', value: { ref: LITERAL } },
        { artifactId: 'lesson-fine', kind: 'lesson', value: { ref: 'ok_id' } },
      ],
      guard,
    );
    const actions = await enforceScan({ eligibility, retraction: runner, purger }, SCOPE, report);
    expect(actions.map((a) => [a.artifactId, a.action])).toEqual([
      ['lesson-bad', 'retracted'],
      ['lesson-old', 'bytes_purged'], // P34-2: revoked is not removed
    ]);
    // Both artifacts' bytes were removed, whatever their eligibility state, for the scan reason.
    expect(purger.purged.map((p) => p.id).sort()).toEqual(['candidate-1', 'lesson-bad', 'lesson-old']);
    expect(purger.purged.every((p) => p.reason.startsWith('scan_'))).toBe(true);
    expect(eligibility.rows.get('lesson-bad')?.state).not.toBe('permitted');
    expect(eligibility.rows.get('candidate-1')?.state).not.toBe('permitted'); // the derived candidate lost eligibility too
    expect(eligibility.rows.get('lesson-bad')?.reasonCode).toBe('scan_SubjectLiteral');
    const retracted = actions[0]!;
    expect(retracted.action === 'retracted' && retracted.state.phase).toBe('complete');
  });
});
