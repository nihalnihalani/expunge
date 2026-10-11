import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Document } from 'mongodb';
import { projectionStreamId } from '../src/events.js';
import {
  CampaignArtifactRepository,
  type CampaignSummaryInput,
  ErasureSuppressionRepository,
  LessonRepository,
  META_DRAW_MIN_GAP_MS,
  MetaDrawCommitmentRepository,
  RawArtifactRepository,
  SubjectTokenRepository,
  WorldSplitRepository,
  type MongoService,
  type Principal,
} from '../src/index.js';
import {
  HASH,
  actor,
  createJob,
  deployWorker,
  describeLive,
  openEnvironment,
  type LiveEnvironment,
} from './support.js';

const scope = { tenantId: actor.tenantId, env: actor.env, scopeId: actor.scopeId };
const ROW = {
  rowId: 'row-1',
  kind: 'meta',
  manifestHash: HASH,
  result: 'measured',
  payload: { value: 1 },
} as const;
const B = 'b'.repeat(64);

describeLive('campaign results, privacy stores and world splits (real replica set)', () => {
  let env: LiveEnvironment;
  const as = (principal: Principal): Promise<MongoService> => env.as(principal);

  beforeAll(async () => {
    env = await openEnvironment('packet62');
  }, 60000);
  beforeEach(() => env.reset());
  afterAll(async () => {
    if (env) await env.dispose();
  }, 60000);

  const control = (name: string) => env.service.control.collection(name);

  describe('campaign artifacts: immutable rows and a summary that stands on them', () => {
    const repo = async (principal: Principal = 'grader') =>
      new CampaignArtifactRepository(await as(principal));

    it('commits a row once, announces it once, and treats the same bytes again as a no-op', async () => {
      const grader = await repo();
      expect(await grader.commitRow(scope, 'c1', ROW)).toEqual({ committed: true });
      expect(await grader.commitRow(scope, 'c1', ROW)).toEqual({ committed: false });
      const stored = await control('campaign_artifact_rows').find({}).toArray();
      expect(stored).toHaveLength(1);
      expect(stored[0]).toMatchObject({ _id: 'c1:row-1', campaignId: 'c1', result: 'measured' });
      const events = await control('projection_events').find({ jobId: 'campaign:c1' }).toArray();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        eventId: 'campaign-row:c1:row-1',
        kind: 'campaign_row_committed',
        payload: { campaignId: 'c1', rowId: 'row-1', result: 'measured', kind: 'meta', manifestHash: HASH },
      });
      expect(JSON.stringify(events[0]!.payload)).not.toContain('value');
      expect(
        await control('projection_sequences').countDocuments({
          _id: projectionStreamId(scope, 'campaign:c1') as never,
        }),
      ).toBe(1);
    });

    it('refuses different bytes under the same row, and never overwrites', async () => {
      const grader = await repo();
      await grader.commitRow(scope, 'c1', ROW);
      await expect(grader.commitRow(scope, 'c1', { ...ROW, payload: { value: 2 } })).rejects.toThrow(
        'CampaignRowConflict',
      );
      await expect(grader.commitRow(scope, 'c1', { ...ROW, result: 'invalid' })).rejects.toThrow(
        'CampaignRowConflict',
      );
      expect((await control('campaign_artifact_rows').findOne({}))!.payload).toEqual({ value: 1 });
      expect(await control('projection_events').countDocuments({ jobId: 'campaign:c1' })).toBe(1);
    });

    it('commits the summary only over committed rows, with the server clock, and only once', async () => {
      const grader = await repo();
      const summary: CampaignSummaryInput = {
        kind: 'meta',
        manifestHash: HASH,
        rowIds: ['row-1', 'row-2'],
        payload: { verdict: 'null' },
      };
      await grader.commitRow(scope, 'c1', ROW);
      await expect(grader.commitSummary(scope, 'c1', summary)).rejects.toThrow('CampaignRowsMissing');
      await grader.commitRow(scope, 'c1', { ...ROW, rowId: 'row-2' });
      const first = await grader.commitSummary(scope, 'c1', summary);
      expect(first).toMatchObject({ artifactId: 'campaign:c1', created: true });
      expect(Math.abs(first.committedAt.getTime() - Date.now())).toBeLessThan(60_000);
      expect(
        await grader.commitSummary(scope, 'c1', { ...summary, rowIds: ['row-2', 'row-1'] }),
      ).toMatchObject({ created: false });
      await expect(
        grader.commitSummary(scope, 'c1', { ...summary, payload: { verdict: 'other' } }),
      ).rejects.toThrow('CampaignSummaryConflict');
      const read = await (await repo('projection_reader')).readSummary(scope, 'c1');
      expect(read).toMatchObject({ artifactId: 'campaign:c1', kind: 'meta', rowIds: ['row-1', 'row-2'] });
      expect((await (await repo('projection_reader')).listRows(scope, 'c1')).map((r) => r.rowId)).toEqual([
        'row-1',
        'row-2',
      ]);
      expect(
        (await (await repo('projection_reader')).listRows(scope, 'c1', { afterRowId: 'row-1' })).map(
          (r) => r.rowId,
        ),
      ).toEqual(['row-2']);
    });

    it('refuses rows another campaign owns, malformed ids and hashes, and any scope that is not a campaign scope', async () => {
      const grader = await repo();
      await grader.commitRow(scope, 'c1', ROW);
      await expect(
        grader.commitSummary(scope, 'c2', {
          kind: 'hider',
          manifestHash: HASH,
          rowIds: ['row-1'],
          payload: {},
        }),
      ).rejects.toThrow('CampaignRowsMissing');
      await expect(grader.commitRow(scope, 'bad id', ROW)).rejects.toThrow('InvalidCampaignId');
      await expect(
        grader.commitRow(scope, 'c1', { ...ROW, rowId: 'r2', manifestHash: 'nope' }),
      ).rejects.toThrow('InvalidCampaignRow');
      await expect(
        grader.commitRow({ ...scope, env: 'demo' }, 'c1', { ...ROW, rowId: 'r3' }),
      ).rejects.toThrow('NotCampaignWorld');
      await deployWorker(env.service);
      await expect(grader.commitRow(scope, 'c1', { ...ROW, rowId: 'r4' })).rejects.toThrow(
        'NotCampaignWorld',
      );
      await expect(
        grader.commitSummary(scope, 'c1', {
          kind: 'meta',
          manifestHash: HASH,
          rowIds: ['row-1'],
          payload: {},
        }),
      ).rejects.toThrow('NotCampaignWorld');
    });

    it("is the grader's to write; others can only read what they are granted", async () => {
      for (const principal of [
        'domain_executor',
        'fixture_builder',
        'observer',
        'proposer',
        'promoter',
      ] as const)
        await expect((await repo(principal)).commitRow(scope, 'c1', ROW), principal).rejects.toThrow(
          'PrincipalBoundary',
        );
      await expect((await repo('observer')).readSummary(scope, 'c1')).rejects.toThrow('PrincipalBoundary');
    });
  });

  describe('the meta draw record: three insert-only rows, stamped by the server', () => {
    const commitment = { seedCommitment: HASH, incidentPoolHash: B, worldPoolHash: 'c'.repeat(64) };
    const repo = async (principal: Principal = 'fixture_builder') =>
      new MetaDrawCommitmentRepository(await as(principal));
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    it('writes commitment, I1 and freeze in order, each strictly later by the server clock, and refuses a repeat, a skip or haste', async () => {
      const writer = await repo();
      await expect(writer.recordI1('m1', { i1Hash: B })).rejects.toThrow('MetaDrawOutOfOrder');
      const first = await writer.commit('m1', { commitment, i0Hash: B });
      expect(Math.abs(first.committedAt.getTime() - Date.now())).toBeLessThan(60_000);
      expect((await control('meta_draw_commitments').findOne({}))!._id.constructor.name).toBe('ObjectId');
      await expect(writer.markFreeze('m1', {})).rejects.toThrow('MetaDrawOutOfOrder');
      await expect(writer.commit('m1', { commitment, i0Hash: 'd'.repeat(64) })).rejects.toThrow(
        'MetaDrawAlreadyCommitted',
      );
      // Too soon: the server clock is not yet more than a second past the commitment.
      await expect(writer.recordI1('m1', { i1Hash: B })).rejects.toThrow('MetaDrawTooSoon');
      await pause(META_DRAW_MIN_GAP_MS + 300);
      const i1 = await writer.recordI1('m1', { i1Hash: B });
      expect(i1.committedAt.getTime()).toBeGreaterThan(first.committedAt.getTime() + 1000);
      await expect(writer.markFreeze('m1', { freezeHash: HASH })).rejects.toThrow('MetaDrawTooSoon');
      await pause(META_DRAW_MIN_GAP_MS + 300);
      const freeze = await writer.markFreeze('m1', { freezeHash: HASH });
      expect(freeze.committedAt.getTime()).toBeGreaterThan(i1.committedAt.getTime() + 1000);
      await expect(writer.recordDraw('m1', { setHash: B })).rejects.toThrow('MetaDrawTooSoon');
      await pause(META_DRAW_MIN_GAP_MS + 300);
      const draw = await writer.recordDraw('m1', { setHash: B });
      expect(draw.committedAt.getTime()).toBeGreaterThan(freeze.committedAt.getTime() + 1000);
      await expect(writer.recordDraw('m1', { setHash: B })).rejects.toThrow('MetaDrawAlreadyCommitted');
      const all = await (await repo('grader')).read('m1');
      expect(all.commitment).toMatchObject({ i0Hash: B, commitment });
      expect(all.i1).toMatchObject({ i1Hash: B });
      expect(all.freeze).toMatchObject({ freezeHash: HASH });
      expect(all.draw).toMatchObject({ setHash: B });
      expect(await (await repo('grader')).read('m2')).toEqual({});
      expect(await control('meta_draw_commitments').countDocuments()).toBe(4);
      await expect(writer.markFreeze('m1', {})).rejects.toThrow('MetaDrawAlreadyCommitted');
    }, 45000);

    it("is fixture_builder's to write; the proposer and the worker are refused, and a malformed hash is", async () => {
      for (const principal of ['proposer', 'domain_executor', 'observer', 'grader'] as const)
        await expect(
          (await repo(principal)).commit('m1', { commitment, i0Hash: B }),
          principal,
        ).rejects.toThrow('PrincipalBoundary');
      await expect(
        (await repo()).commit('m1', { commitment: { ...commitment, worldPoolHash: 'x' }, i0Hash: B }),
      ).rejects.toThrow('InvalidMetaCommitment');
      await expect((await repo('proposer')).read('m1')).rejects.toThrow('PrincipalBoundary');
    });
  });

  describe('world splits: one committed assignment per world', () => {
    it("assigns once, and a job's split is its world's", async () => {
      const builder = new WorldSplitRepository(await as('fixture_builder'));
      const jobId = await createJob(env.service, { id: 'job-a' });
      await builder.assign(scope, 'world-job-a', 'final', HASH);
      await expect(builder.assign(scope, 'world-job-a', 'train', HASH)).rejects.toThrow(
        'WorldSplitAlreadyAssigned',
      );
      await expect(builder.assign(scope, 'world-x', 'train', 'nope')).rejects.toThrow('InvalidWorldSplit');
      const observer = new WorldSplitRepository(await as('observer'));
      expect(await observer.splitOfJob(scope, jobId)).toEqual({ split: 'final', planCommitment: HASH });
      const other = await createJob(env.service, { id: 'job-b' });
      expect(await observer.splitOfJob(scope, other)).toBeNull();
      await expect(observer.splitOfJob(scope, 'job-missing')).rejects.toThrow('JobNotFound');
      await expect(observer.splitOfJob({ ...scope, scopeId: 'elsewhere' }, jobId)).rejects.toThrow(
        'JobNotFound',
      );
      await expect(new WorldSplitRepository(await as('proposer')).splitOfJob(scope, jobId)).rejects.toThrow(
        'PrincipalBoundary',
      );
      await expect(
        new WorldSplitRepository(await as('domain_executor')).assign(scope, 'w', 'train', HASH),
      ).rejects.toThrow('PrincipalBoundary');
    });
  });

  describe('privacy stores', () => {
    const privacy = async () => as('privacy_controller');
    const source = (sourceId: string) => ({
      sourceId,
      kind: 'trace' as const,
      contentSha256: HASH,
      sizeBytes: 5,
      retention: 'raw' as const,
      registeredAt: new Date(),
    });
    it('keeps raw evidence until it is purged, then only a tombstone without content, hash or size', async () => {
      const raw = new RawArtifactRepository(await privacy());
      expect(await raw.put(scope, source('s1'), 'hello')).toBe('created');
      expect(await raw.put(scope, source('s1'), 'other')).toBe('exists');
      expect((await raw.get(scope, 's1'))!.content).toBe('hello');
      await expect(raw.put(scope, { ...source('s2'), retention: 'raw' }, null)).rejects.toThrow(
        'InvalidRawSource',
      );
      expect(await raw.put(scope, { ...source('s3'), retention: 'hash_only' }, null)).toBe('created');
      expect(
        await raw.purge(scope, 's1', 'trace', 'subject_erasure_request', { policyHash: B, closureId: null }),
      ).toBe('purged');
      expect(await raw.get(scope, 's1')).toBeNull();
      const tomb = (await raw.getTombstone(scope, 's1'))!;
      expect(tomb).toMatchObject({ sourceId: 's1', reasonCode: 'subject_erasure_request', closureId: null });
      expect(Object.keys(tomb).sort()).toEqual([
        'closureId',
        'deletedAt',
        'kind',
        'policyHash',
        'reasonCode',
        'sourceId',
      ]);
      expect(JSON.stringify(await control('raw_artifacts').find({}).toArray())).not.toContain('hello');
      expect(
        await raw.purge(scope, 's1', 'trace', 'source_retracted', { policyHash: B, closureId: null }),
      ).toBe('tombstoned');
      expect(await raw.put(scope, source('s1'), 'again')).toBe('exists');
      expect(
        await raw.purge(scope, 'missing', 'trace', 'source_retracted', { policyHash: B, closureId: null }),
      ).toBe('not_found');
    });

    it('maps subject handles to provider identities by generation, and purges lessons to a tombstone', async () => {
      const tokens = new SubjectTokenRepository(await privacy());
      const entry = {
        subjectHandle: 'handle-1',
        provider: 'raindrop',
        tokenGeneration: 1,
        tokens: ['u1'],
        registeredAt: new Date(),
      };
      expect(await tokens.put(scope, entry)).toBe('created');
      expect(await tokens.put(scope, entry)).toBe('exists');
      expect(await tokens.put(scope, { ...entry, tokenGeneration: 2, tokens: ['u2', 'u3'] })).toBe('created');
      expect(await tokens.tokensFor(scope, 'handle-1', 'raindrop')).toEqual(['u2', 'u3']);
      expect(await tokens.tokensFor(scope, 'nobody', 'raindrop')).toEqual([]);
      expect(await tokens.list(scope)).toHaveLength(2);

      const lessons = new LessonRepository(await privacy());
      const lesson = {
        lessonId: 'l1',
        moduleId: 'm',
        family: 'f',
        structure: { counts: [1, 2] },
        retention: 'structural' as const,
        sourceIds: ['s1'],
        policyHash: B,
        registeredAt: new Date(),
      };
      expect(await lessons.put(scope, lesson)).toBe('created');
      expect(await lessons.put(scope, lesson)).toBe('exists');
      expect((await lessons.list(scope)).map((l) => l.lessonId)).toEqual(['l1']);
      expect(
        await lessons.purge(scope, 'l1', 'source_retracted', { policyHash: B, closureId: 'closure-1' }),
      ).toBe('purged');
      expect(await lessons.get(scope, 'l1')).toBeNull();
      expect(await lessons.list(scope)).toEqual([]);
      expect(await lessons.purge(scope, 'l1', 'source_retracted', { policyHash: B, closureId: null })).toBe(
        'tombstoned',
      );
      const stored = (await control('lessons').findOne({}))!;
      expect(stored).not.toHaveProperty('structure');
      expect(stored).not.toHaveProperty('sourceIds');
    });

    it('serves export suppression by organization and user across tenants and jobs, one row per job', async () => {
      const service = await privacy();
      const writer = new ErasureSuppressionRepository(service);
      const a = {
        tenantId: 't1',
        env: 'demo' as const,
        providerOrganizationId: 'org-1',
        userKey: 'user-a',
        jobId: 'job-A',
      };
      await writer.setActive(a, true);
      await writer.setActive({ ...a, tenantId: 't2', userKey: 'user-b', jobId: 'job-C' }, true);
      await writer.setActive({ ...a, providerOrganizationId: 'org-2', userKey: 'user-c' }, true);
      for (const principal of ['observer', 'domain_executor', 'privacy_controller'] as const)
        expect(
          await new ErasureSuppressionRepository(await as(principal)).activeUserKeys('org-1'),
          principal,
        ).toEqual(['user-a', 'user-b']);
      // Two jobs cover user-a: clearing one leaves the user suppressed, clearing the other lifts it.
      await writer.setActive({ ...a, jobId: 'job-B' }, true);
      expect(await writer.activeJobsFor('org-1', 'user-a')).toEqual(['job-A', 'job-B']);
      await writer.setActive(a, false);
      const observer = new ErasureSuppressionRepository(await as('observer'));
      expect(await observer.activeUserKeys('org-1')).toEqual(['user-a', 'user-b']);
      expect(await writer.activeJobsFor('org-1', 'user-a')).toEqual(['job-B']);
      await writer.setActive({ ...a, jobId: 'job-B' }, false);
      expect(await observer.activeUserKeys('org-1')).toEqual(['user-b']);
      // One row per (organization, user, job): flipping again updates, never duplicates.
      expect(
        await control('erasure_suppressions').countDocuments({
          providerOrganizationId: 'org-1',
          userKey: 'user-a',
        }),
      ).toBe(2);
      expect(await writer.activeForJob('job-C')).toEqual([
        { providerOrganizationId: 'org-1', userKey: 'user-b' },
      ]);
      // The write inside a caller's transaction rolls back with it.
      await expect(
        service.transaction(async (session) => {
          await writer.setActive({ ...a, userKey: 'user-z', jobId: 'job-Z' }, true, session);
          throw new Error('abort');
        }),
      ).rejects.toThrow('abort');
      expect(await control('erasure_suppressions').countDocuments({ userKey: 'user-z' })).toBe(0);
      await expect(observer.setActive(a, true)).rejects.toThrow('PrincipalBoundary');
      await expect(observer.activeForJob('job-C')).rejects.toThrow('PrincipalBoundary');
    });

    it("never lets ':' in an organization or a key alias another pair", async () => {
      const writer = new ErasureSuppressionRepository(await privacy());
      const base = { tenantId: 't1', env: 'demo' as const, jobId: 'job-1' };
      await writer.setActive({ ...base, providerOrganizationId: 'a:b', userKey: 'c' }, true);
      await writer.setActive({ ...base, providerOrganizationId: 'a', userKey: 'b:c' }, true);
      expect(await control('erasure_suppressions').countDocuments()).toBe(2);
      // Releasing one organization's user does not lift the other's.
      await writer.setActive({ ...base, providerOrganizationId: 'a:b', userKey: 'c' }, false);
      const observer = new ErasureSuppressionRepository(await as('observer'));
      expect(await observer.activeUserKeys('a:b')).toEqual([]);
      expect(await observer.activeUserKeys('a')).toEqual(['b:c']);
    });

    it('fails closed when more users are suppressed than a reader may take', async () => {
      const writer = new ErasureSuppressionRepository(await privacy());
      for (const n of [1, 2, 3])
        await writer.setActive(
          { tenantId: 't1', env: 'demo', providerOrganizationId: 'big', userKey: `u${n}`, jobId: 'j' },
          true,
        );
      const observer = new ErasureSuppressionRepository(await as('observer'));
      expect(await observer.activeUserKeys('big', 3)).toEqual(['u1', 'u2', 'u3']);
      await expect(observer.activeUserKeys('big', 2)).rejects.toThrow('SuppressionListTooLarge');
    });

    it('keeps subject tokens apart whatever characters a handle holds (rows are hashed from a structured key)', async () => {
      const tokens = new SubjectTokenRepository(await privacy());
      const entry = {
        subjectHandle: 'h\u0000x',
        provider: 'p',
        tokenGeneration: 1,
        tokens: ['t1'],
        registeredAt: new Date(),
      };
      expect(await tokens.put(scope, entry)).toBe('created');
      expect(await tokens.put(scope, { ...entry, subjectHandle: 'h', provider: 'x' })).toBe('created');
      expect(await tokens.put(scope, { ...entry, subjectHandle: 'h\u0000x', provider: 'p' })).toBe('exists');
      expect(await control('subject_tokens').countDocuments()).toBe(2);
    });

    it('the privacy collections validate strictly', async () => {
      const bad: Array<[string, Document]> = [
        [
          'raw_artifacts',
          { _id: 'x', ...scope, sourceId: 's', kind: 'trace', contentSha256: HASH, content: 'c' },
        ],
        [
          'raw_artifacts',
          {
            _id: 'y',
            ...scope,
            sourceId: 's',
            kind: 'trace',
            deletedAt: new Date(),
            reasonCode: 'whim',
            policyHash: B,
            closureId: null,
          },
        ],
        [
          'erasure_suppressions',
          {
            _id: 'z',
            tenantId: 't',
            env: 'demo',
            providerOrganizationId: 'o',
            userKey: 'u',
            active: true,
            updatedAt: new Date(),
            extra: 1,
          },
        ],
        [
          'lessons',
          {
            _id: 'l',
            ...scope,
            lessonId: 'l',
            moduleId: 'm',
            family: 'f',
            structure: {},
            retention: 'raw',
            sourceIds: [],
            policyHash: B,
            registeredAt: new Date(),
          },
        ],
      ];
      for (const [name, doc] of bad)
        await expect(
          control(name).insertOne(doc as never),
          `${name} ${String(doc._id)}`,
        ).rejects.toMatchObject({ code: 121 });
    });
  });
});
