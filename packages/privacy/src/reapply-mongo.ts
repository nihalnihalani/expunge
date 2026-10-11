import { chmodSync, closeSync, fsyncSync, openSync, renameSync, writeSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import type { ExternalErasureJob, ScopeKey } from '@expunge/contracts';
import {
  ErasureSuppressionRepository,
  RawArtifactRepository,
  type MongoService,
  type Tombstone,
} from '@expunge/mongo';
import { suppressionUserKey } from '@expunge/observer';
import { MongoErasureStore, erasureId, reconcileExportSuppression } from './mongo.js';
import { LEDGER_FORMAT, type ErasureLedger, type ReapplyPorts } from './reapply.js';

/** Ports over the real repositories, as the privacy_controller principal (the services refuse any other for these stores). */
export function mongoReapplyPorts(service: MongoService): ReapplyPorts {
  const suppression = new ErasureSuppressionRepository(service);
  const store = new MongoErasureStore(service, suppression);
  const raw = new RawArtifactRepository(service);
  return {
    getJob: (scope, key) => store.get(scope, key),
    insertJob: (job) => store.insert(job),
    replaceJob: (job, length) => store.replace(job, length),
    reconcileSuppression: (org) => reconcileExportSuppression(service, org),
    async suppressionGap(job: ExternalErasureJob) {
      if (job.localExportSuppression !== 'active') return 0;
      const jobId = erasureId(job, job.requestKey);
      const held = new Set(
        (await suppression.activeForJob(jobId))
          .filter((r) => r.providerOrganizationId === job.providerOrganizationId)
          .map((r) => r.userKey),
      );
      let gap = 0;
      for (const userId of job.namespacedUserIds) {
        const entry = job.subjectEntries.find((e) => e.user_id === userId);
        if ((!entry || entry.revoked_at === null) && !held.has(suppressionUserKey(userId))) gap++;
      }
      return gap;
    },
    getTombstone: (scope, id) => raw.getTombstone(scope, id),
    putTombstone: (scope, tombstone: Tombstone) => raw.tombstone(scope, tombstone),
  };
}

const PAGE = 500;
/**
 * Reads every erasure job and every source tombstone from a database that is still readable, for replay after a restore.
 * Run it BEFORE the damaged database is wiped (privacy_controller principal). It holds opaque provider ids and hashes, no
 * subject literals, but treat it as sensitive: it is written 0600 and must travel with the backup, not beside it in the open.
 */
export async function exportErasureLedger(service: MongoService, now = new Date()): Promise<ErasureLedger> {
  const jobs: ExternalErasureJob[] = [];
  const deletions = service.control.collection('external_deletions');
  for (let after: string | null = null; ;) {
    const rows = await deletions
      .find(after === null ? {} : { _id: { $gt: after as never } })
      .sort({ _id: 1 })
      .limit(PAGE)
      .toArray();
    for (const { _id: _ignored, ...job } of rows) jobs.push(job as unknown as ExternalErasureJob);
    if (rows.length < PAGE) break;
    after = rows.at(-1)!._id as unknown as string;
  }
  const tombstones: ErasureLedger['tombstones'] = [];
  const raws = service.control.collection('raw_artifacts');
  for (let after: string | null = null; ;) {
    const rows = await raws
      .find({ deletedAt: { $exists: true }, ...(after === null ? {} : { _id: { $gt: after as never } }) })
      .sort({ _id: 1 })
      .limit(PAGE)
      .toArray();
    for (const row of rows) {
      const scope: ScopeKey = { tenantId: row.tenantId, env: row.env, scopeId: row.scopeId };
      tombstones.push({
        scope,
        tombstone: {
          sourceId: row.sourceId,
          kind: row.kind,
          deletedAt: row.deletedAt,
          reasonCode: row.reasonCode,
          policyHash: row.policyHash,
          closureId: row.closureId ?? null,
        },
      });
    }
    if (rows.length < PAGE) break;
    after = rows.at(-1)!._id as unknown as string;
  }
  return { format: LEDGER_FORMAT, exportedAt: now.toISOString(), jobs, tombstones };
}

/** Atomic 0600 write (exclusive temp, fsync, rename), for the ledger and the cursor. */
export function writePrivateFile(path: string, text: string): void {
  const temp = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temp, 0o600);
  renameSync(temp, path);
}
