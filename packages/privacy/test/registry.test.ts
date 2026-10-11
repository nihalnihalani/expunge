import { describe, expect, it } from 'vitest';
import { privateIdHash } from '@expunge/contracts';
import {
  PrivacyError,
  classifyRetention,
  guardFor,
  recordDerivation,
  registerLesson,
  registerRawSource,
  registerSubjectTokens,
  retrieveRawSource,
} from '../src/index.js';
import {
  FakeEligibility,
  FakeLessons,
  FakeProvenance,
  FakeRawStore,
  FakeSubjectTokens,
  POLICY,
  SCOPE,
} from './fakes.js';

const TOKEN_A = 'u_00000000000000000000000000000a01';
const TOKEN_B = 'u_00000000000000000000000000000b02';

function rig() {
  const eligibility = new FakeEligibility();
  const raw = new FakeRawStore();
  const tokens = new FakeSubjectTokens();
  const lessons = new FakeLessons();
  const provenance = new FakeProvenance(eligibility);
  return { eligibility, raw, tokens, lessons, provenance };
}

describe('raw source registration', () => {
  it('stores bytes only for raw retention and registers eligibility; hash-only keeps nothing readable', async () => {
    const { raw, eligibility } = rig();
    const deps = { raw, eligibility, policyHash: POLICY };
    const kept = await registerRawSource(deps, SCOPE, {
      sourceId: 'src-1',
      kind: 'transcript',
      content: 'hello subject',
      retention: 'raw',
    });
    const hashed = await registerRawSource(deps, SCOPE, {
      sourceId: 'src-2',
      kind: 'trace',
      content: 'hello subject',
      retention: 'hash_only',
    });
    expect(raw.rows.get('src-1')?.content).toBe('hello subject');
    expect(raw.rows.get('src-2')?.content).toBeNull();
    expect(kept.contentSha256).toBe(hashed.contentSha256);
    expect(kept.sizeBytes).toBe(13);
    expect(eligibility.rows.get('src-1')?.state).toBe('permitted');
  });

  it('is idempotent for the same content, a conflict for different content, and never re-registers a deleted id', async () => {
    const { raw, eligibility } = rig();
    const deps = { raw, eligibility, policyHash: POLICY };
    const input = { sourceId: 'src-1', kind: 'transcript' as const, content: 'a', retention: 'raw' as const };
    await registerRawSource(deps, SCOPE, input);
    await expect(registerRawSource(deps, SCOPE, input)).resolves.toMatchObject({ sourceId: 'src-1' });
    await expect(registerRawSource(deps, SCOPE, { ...input, content: 'b' })).rejects.toMatchObject({
      code: 'SourceIdConflict',
    });
    await raw.tombstone(SCOPE, {
      sourceId: 'src-9',
      kind: 'trace',
      deletedAt: new Date(),
      reasonCode: 'x',
      policyHash: POLICY,
      closureId: null,
    });
    await expect(registerRawSource(deps, SCOPE, { ...input, sourceId: 'src-9' })).rejects.toMatchObject({
      code: 'SourceIdConflict',
    });
    await expect(registerRawSource(deps, SCOPE, { ...input, sourceId: 'bad id!' })).rejects.toMatchObject({
      code: 'InvalidSource',
    });
    await expect(
      registerRawSource(deps, SCOPE, { ...input, sourceId: 'src-3', kind: 'nope' as never }),
    ).rejects.toBeInstanceOf(PrivacyError);
  });
});

describe('subject token registration', () => {
  it('stores only opaque provider identities for raindrop, sorted, idempotently', async () => {
    const { tokens } = rig();
    const entry = await registerSubjectTokens({ tokens }, SCOPE, {
      subjectHandle: 'maria.rossi',
      provider: 'raindrop',
      tokenGeneration: 1,
      tokens: [TOKEN_B, TOKEN_A],
    });
    expect(entry.tokens).toEqual([TOKEN_A, TOKEN_B]);
    await registerSubjectTokens({ tokens }, SCOPE, {
      subjectHandle: 'maria.rossi',
      provider: 'raindrop',
      tokenGeneration: 1,
      tokens: [TOKEN_A, TOKEN_B],
    });
    expect(tokens.entries).toHaveLength(1);
    expect(await tokens.tokensFor(SCOPE, 'maria.rossi', 'raindrop')).toEqual([TOKEN_A, TOKEN_B]);
  });

  it('refuses ids derived from a name, duplicates, empty lists and bad generations', async () => {
    const { tokens } = rig();
    const base = {
      subjectHandle: 'maria.rossi',
      provider: 'raindrop',
      tokenGeneration: 1,
      tokens: [TOKEN_A],
    };
    for (const bad of [
      { ...base, tokens: ['maria_rossi'] },
      { ...base, tokens: [TOKEN_A, TOKEN_A] },
      { ...base, tokens: [] },
      { ...base, tokenGeneration: 0 },
      { ...base, subjectHandle: '   ' },
    ])
      await expect(registerSubjectTokens({ tokens }, SCOPE, bad)).rejects.toMatchObject({
        code: 'InvalidSubjectToken',
      });
  });
});

describe('leak guard for a scope', () => {
  it('uses every registered handle as a forbidden literal and refuses to exist without any', async () => {
    const { tokens } = rig();
    await expect(guardFor({ tokens }, SCOPE)).rejects.toMatchObject({ code: 'MissingForbiddenLiterals' });
    await registerSubjectTokens({ tokens }, SCOPE, {
      subjectHandle: 'maria.rossi',
      provider: 'raindrop',
      tokenGeneration: 1,
      tokens: [TOKEN_A],
    });
    const guard = await guardFor({ tokens }, SCOPE, { literals: ['alias-x'] });
    expect(guard.forbiddenLiterals).toEqual(['maria.rossi', 'alias-x']);
  });

  it('accepts a grader private-id set instead of literals', async () => {
    const { tokens } = rig();
    const privateIds = { salt: 's', hashes: [privateIdHash('s', 'cust-1')] };
    await expect(guardFor({ tokens }, SCOPE, { privateIds })).resolves.toMatchObject({ privateIds });
  });
});

describe('structural lessons', () => {
  const guard = { forbiddenLiterals: ['maria.rossi'] };
  const structure = {
    family: 'orphan_reference',
    counts: { sources: 3, residuals: 0 },
    evidence: ['a'.repeat(64)],
  };

  it('classifies identifiers, counts and digests as structural and free text as raw', () => {
    expect(classifyRetention(structure)).toBe('structural');
    expect(classifyRetention({ note: 'the archive of someone is gone' })).toBe('raw');
    expect(classifyRetention(['ok_id', { n: 1, flag: true, none: null }])).toBe('structural');
  });

  it('records the derivation edges BEFORE the lesson becomes permitted, and is idempotent', async () => {
    const { lessons, eligibility, provenance } = rig();
    const deps = { lessons, eligibility, provenance, policyHash: POLICY };
    const order: string[] = [];
    const originalAppend = provenance.append.bind(provenance);
    provenance.append = async (...args) => (
      order.push(`edge:${args[1]}->${args[2].slice(0, 6)}`),
      originalAppend(...args)
    );
    const originalPermit = eligibility.permit.bind(eligibility);
    eligibility.permit = async (...args) => (order.push('permit'), originalPermit(...args));
    const lesson = await registerLesson(
      deps,
      SCOPE,
      { moduleId: 'm1', family: 'f1', structure, sourceIds: ['src-2', 'src-1', 'src-1'] },
      guard,
    );
    expect(lesson.sourceIds).toEqual(['src-1', 'src-2']);
    expect(order.slice(0, 2).every((entry) => entry.startsWith('edge:'))).toBe(true);
    expect(order.at(-1)).toBe('permit');
    expect(provenance.edges.filter((e) => e.toId === lesson.lessonId).map((e) => e.fromId)).toEqual([
      'src-1',
      'src-2',
    ]);
    const again = await registerLesson(
      deps,
      SCOPE,
      { moduleId: 'm1', family: 'f1', structure, sourceIds: ['src-1', 'src-2'] },
      guard,
    );
    expect(again.lessonId).toBe(lesson.lessonId);
    expect(lessons.rows.size).toBe(1);
  });

  it('refuses raw text and any subject literal (plain, as a key, or encoded) and registers nothing', async () => {
    const { lessons, eligibility, provenance } = rig();
    const deps = { lessons, eligibility, provenance, policyHash: POLICY };
    const attempt = (value: unknown) =>
      registerLesson(
        deps,
        SCOPE,
        { moduleId: 'm1', family: 'f1', structure: value as never, sourceIds: ['src-1'] },
        guard,
      );
    await expect(attempt({ note: 'the archive of someone is gone' })).rejects.toMatchObject({
      code: 'LessonNotStructural',
    });
    await expect(attempt({ 'maria.rossi': 1 })).rejects.toMatchObject({ code: 'LessonRejected' });
    await expect(attempt({ ref: 'maria.rossi' })).rejects.toMatchObject({ code: 'LessonRejected' });
    await expect(attempt({ ref: Buffer.from('maria.rossi').toString('hex') })).rejects.toMatchObject({
      code: 'LessonRejected',
    });
    await expect(attempt({ expectedState: 1 })).rejects.toMatchObject({ code: 'LessonRejected' });
    expect(lessons.rows.size).toBe(0);
    expect(provenance.edges).toHaveLength(0);
    expect(eligibility.rows.size).toBe(0);
  });

  it('records plain derivations', async () => {
    const { provenance } = rig();
    await recordDerivation({ provenance }, SCOPE, 'a', 'b');
    expect(provenance.edges).toEqual([{ fromId: 'a', toId: 'b', kind: 'derived_from' }]);
  });
});

describe('raw retrieval gate', () => {
  it('serves a permitted source, and denies a revoked, incompletely-resolved or deleted one', async () => {
    const { raw, eligibility, provenance } = rig();
    await registerRawSource({ raw, eligibility, policyHash: POLICY }, SCOPE, {
      sourceId: 'src-1',
      kind: 'transcript',
      content: 'hello',
      retention: 'raw',
    });
    expect(await retrieveRawSource({ raw, provenance }, SCOPE, 'src-1')).toMatchObject({
      status: 'ok',
      content: 'hello',
    });
    await provenance.revoke(SCOPE, 'src-1', POLICY, 'retracted');
    expect(await retrieveRawSource({ raw, provenance }, SCOPE, 'src-1')).toEqual({
      status: 'denied',
      reason: 'not_permitted',
    });
    await raw.tombstone(SCOPE, {
      sourceId: 'src-1',
      kind: 'transcript',
      deletedAt: new Date(),
      reasonCode: 'retracted',
      policyHash: POLICY,
      closureId: null,
    });
    expect(await retrieveRawSource({ raw, provenance }, SCOPE, 'src-1')).toEqual({
      status: 'denied',
      reason: 'deleted',
    });
    expect(await retrieveRawSource({ raw, provenance }, SCOPE, 'never-registered')).toMatchObject({
      status: 'denied',
    });
  });
});
