/**
 * Post-restore erasure re-application against a real local replica set (privacy_controller principal; protocol evidence,
 * not Atlas). "Restore" is modelled as putting the three erasure collections back to their pre-erasure documents, which is
 * what a restore of an older dump does to them; the mongodump/mongorestore round trip itself is drilled separately.
 */
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Document } from 'mongodb';
import type { ExternalErasureJob } from '@expunge/contracts';
import { ErasureSuppressionRepository, RawArtifactRepository, type MongoService } from '@expunge/mongo';
import { createMongoExportSuppression } from '@expunge/observer';
import { describeLive, openEnvironment, type LiveEnvironment } from '../../mongo/test/support.js';
import {
  MongoErasureStore,
  exportErasureLedger,
  ledgerSha256,
  mongoReapplyPorts,
  newCursor,
  parseLedger,
  reapplyErasures,
  REQUIRED_ATTESTATIONS,
  writePrivateFile,
} from '../src/index.js';
import { main as cli } from '../src/reapply-cli.js';

const SCOPE = { tenantId: 'protocol-test', env: 'evaluation' as const, scopeId: 'scope' };
const COLLECTIONS = ['raw_artifacts', 'external_deletions', 'erasure_suppressions'] as const;
const USER = 'u_00000000000000000000000000000a01';
const SUBJECT_TEXT = 'subject-literal-for-erasure';

describeLive('post-restore erasure re-application (real replica set)', () => {
  let env: LiveEnvironment;
  let privacy: MongoService;
  let observer: MongoService;
  const dir = mkdtempSync(join(tmpdir(), 'reapply-'));
  beforeAll(async () => {
    env = await openEnvironment('reapply');
    privacy = await env.as('privacy_controller');
    observer = await env.as('observer');
  });
  afterAll(async () => {
    await env.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  const snapshot = async () => {
    const out: Record<string, Document[]> = {};
    for (const name of COLLECTIONS) out[name] = await env.service.control.collection(name).find({}).toArray();
    return out;
  };
  const restoreTo = async (state: Record<string, Document[]>) => {
    for (const name of COLLECTIONS) {
      await env.service.control.collection(name).deleteMany({});
      if (state[name]!.length > 0) await env.service.control.collection(name).insertMany(state[name]!);
    }
  };
  const erasureJob = (): ExternalErasureJob => ({
    ...SCOPE,
    requestKey: 'req-1',
    providerOrganizationId: 'org-1',
    requester: 'dpo',
    regulation: 'gdpr',
    namespacedUserIds: [USER],
    localExportSuppression: 'active',
    remoteJobId: null,
    receivedAt: new Date(),
    dueBy: null,
    completedAt: null,
    providerStatus: 'pending',
    subjectEntries: [{ user_id: USER, requested_on: '2026-10-11', revoked_at: null }],
    providerSnapshot: null,
    history: [{ at: new Date(), status: 'pending', snapshotHash: 'a'.repeat(64) }],
  });

  it('after restoring an older state, the erased source, the erasure job and the suppression are back in force; DONE only after attestations', async () => {
    const raw = new RawArtifactRepository(privacy);
    const store = new MongoErasureStore(privacy, new ErasureSuppressionRepository(privacy));
    await raw.put(
      SCOPE,
      {
        sourceId: 'src-1',
        kind: 'transcript' as never,
        contentSha256: 'b'.repeat(64),
        sizeBytes: 3,
        retention: 'raw',
        registeredAt: new Date(),
      },
      SUBJECT_TEXT,
    );

    const older = await snapshot(); // the "backup": the source still holds its content, no erasure exists

    // The erasure happens AFTER the backup.
    await raw.purge(SCOPE, 'src-1', 'transcript' as never, 'subject_erasure_request' as never, {
      policyHash: 'c'.repeat(64),
      closureId: null,
    });
    await store.insert(erasureJob());
    expect((await createMongoExportSuppression(observer).suppressedUserIds('org-1')).has(USER)).toBe(true);

    // Before the damaged database is wiped: export the ledger.
    const ledgerPath = join(dir, 'ledger.json');
    writePrivateFile(ledgerPath, JSON.stringify(await exportErasureLedger(privacy)));
    expect(statSync(ledgerPath).mode & 0o777).toBe(0o600);

    // The restore resurrects the older state.
    await restoreTo(older);
    expect((await raw.get(SCOPE, 'src-1'))?.content).toBe(SUBJECT_TEXT); // erased content is BACK
    expect((await createMongoExportSuppression(observer).suppressedUserIds('org-1')).has(USER)).toBe(false);
    expect(await store.get(SCOPE, 'req-1')).toBeNull();

    // Re-application.
    const text = (await import('node:fs')).readFileSync(ledgerPath, 'utf8');
    const hash = ledgerSha256(text);
    const cursor = newCursor(hash);
    const report = await reapplyErasures(parseLedger(text), hash, mongoReapplyPorts(privacy), cursor);
    expect(report.applied).toMatchObject({ jobsInserted: 1, tombstones: 1 });
    expect(await raw.get(SCOPE, 'src-1')).toBeNull(); // content gone again
    expect(await raw.getTombstone(SCOPE, 'src-1')).toMatchObject({ sourceId: 'src-1' });
    expect(
      JSON.stringify(await env.service.control.collection('raw_artifacts').find({}).toArray()),
    ).not.toContain(SUBJECT_TEXT);
    expect((await createMongoExportSuppression(observer).suppressedUserIds('org-1')).has(USER)).toBe(true);
    expect((await store.get(SCOPE, 'req-1'))?.history).toHaveLength(1);
    expect(report.done).toBe(false);
    expect(report.pending).toEqual(REQUIRED_ATTESTATIONS.map((n) => `attestation required: ${n}`));

    // A second run with the finished cursor does no work and, with both attestations recorded, is DONE.
    for (const name of REQUIRED_ATTESTATIONS) cursor.attestations[name] = `ticket-${name}`;
    const again = await reapplyErasures(parseLedger(text), hash, mongoReapplyPorts(privacy), cursor);
    expect(again.applied).toEqual({ jobsInserted: 0, jobsAdvanced: 0, jobsKept: 0, tombstones: 0 });
    expect(again.done).toBe(true);
  });

  it('the CLI exits 5 while attestations are missing and 0 once they are recorded, using only the privacy principal', async () => {
    const ledgerPath = join(dir, 'ledger2.json');
    const cursorPath = join(dir, 'cursor2.json');
    const cliEnv = {
      MONGODB_PRIVACY_CONTROLLER_URI: process.env.MONGODB_TEST_URI!,
      EXPUNGE_LEDGER_MAC_KEY: 'k'.repeat(40),
      EXPUNGE_LEDGER_ENC_KEY: 'ef'.repeat(32),
      EXPUNGE_WORLD_DB: env.service.world.databaseName,
      EXPUNGE_CONTROL_DB: env.service.control.databaseName,
      EXPUNGE_PRIVATE_DB: env.service.privateDb!.databaseName,
    };
    expect(await cli(['export', '--ledger', ledgerPath], cliEnv)).toBe(0);
    expect(await cli(['apply', '--ledger', ledgerPath, '--cursor', cursorPath], cliEnv)).toBe(5);
    expect(statSync(cursorPath).mode & 0o777).toBe(0o600);
    expect(await cli(['attest', '--cursor', cursorPath, 'world-effects-reconciled=TICKET-1'], cliEnv)).toBe(
      0,
    );
    expect(await cli(['attest', '--cursor', cursorPath, 'bogus-name=x'], cliEnv)).toBe(2);
    expect(await cli(['attest', '--cursor', cursorPath, 'derived-artifacts-retracted=RUN-9'], cliEnv)).toBe(
      0,
    );
    expect(await cli(['apply', '--ledger', ledgerPath, '--cursor', cursorPath], cliEnv)).toBe(0);
    writeFileSync(join(dir, 'x'), ''); // keep the temp dir used
  });
});
