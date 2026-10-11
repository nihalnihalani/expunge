#!/usr/bin/env node
// End-to-end backup/restore drill against a LOCAL replica set that this machine owns.
//
//   docker compose -p expunge-rr -f <copy of packages/mongo/test/docker-compose.yml, port 127.0.0.1:27318> up -d --wait
//   node infra/services/backup/restore-drill.mjs [--uri mongodb://127.0.0.1:27318/?replicaSet=expunge-local&directConnection=true]
//
// Steps: (1) seed throwaway databases through scripts/setup-mongo.ts and the repositories; (2) fingerprint them;
// (3) back them up with the pinned mongodump image; (4) drop all three databases; (5) restore with the pinned mongorestore
// image; (6) fingerprint again and require validators, indexes and every document hash to match; (7) prove the restored
// validators still reject an invalid insert and a unique index still rejects a duplicate; (8) drop the throwaway databases.
// It refuses any URI whose host is not 127.0.0.1/localhost. Output is one JSON line per step; exit 0 only if all pass.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongodb from 'mongodb';

const { MongoClient } = mongodb;
import { backup } from './backup-mongo.mjs';
import { restore } from './restore-mongo.mjs';
import { diffFingerprints, fingerprintAll, sha256, summarize } from './lib.mjs';

const REPO = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..');
const args = process.argv.slice(2);
const uri = args.includes('--uri')
  ? args[args.indexOf('--uri') + 1]
  : 'mongodb://127.0.0.1:27318/?replicaSet=expunge-local&directConnection=true';
const host = new URL(uri).hostname;
if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
  console.error(JSON.stringify({ error: 'drill refuses a non-local URI' }));
  process.exit(2);
}

const suffix = randomBytes(4).toString('hex');
const names = {
  world: `expunge_drill_${suffix}_world`,
  control: `expunge_drill_${suffix}_control`,
  private: `expunge_drill_${suffix}_private`,
};
const step = (name, detail) => console.log(JSON.stringify({ step: name, ...detail }));
const results = [];
const check = (name, ok, detail = {}) => {
  results.push(ok);
  step(name, { ok, ...detail });
};

const drillEnv = {
  ...process.env,
  MONGODB_SETUP_URI: uri,
  EXPUNGE_BACKUP_URI: uri,
  EXPUNGE_RESTORE_URI: uri,
  EXPUNGE_WORLD_DB: names.world,
  EXPUNGE_CONTROL_DB: names.control,
  EXPUNGE_PRIVATE_DB: names.private,
  EXPUNGE_TENANT_ID: 'drill-tenant',
  EXPUNGE_ENV: 'evaluation',
  EXPUNGE_SCOPE_ID: 'drill-scope',
  EXPUNGE_AUTHORITY_FLOOR_HASH: sha256('expunge restore drill authority floor'),
};
const tsx = (file) =>
  spawnSync(process.execPath, ['--import', 'tsx', file], { cwd: REPO, env: drillEnv, encoding: 'utf8' });

const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
const outDir = mkdtempSync(join(homedir(), '.expunge-drill-'));
try {
  await client.connect();
  const hello = await client.db('admin').command({ hello: 1 });
  check('replica-set', Boolean(hello.setName), { setName: hello.setName });

  const setup = tsx('scripts/setup-mongo.ts');
  check('setup-mongo', setup.status === 0, {
    stdout: setup.stdout.trim().slice(0, 300),
    stderr: setup.stderr.trim().slice(0, 300),
  });
  const seed = tsx('infra/services/backup/drill-seed.ts');
  check('seed-repositories', seed.status === 0, {
    stdout: seed.stdout.trim().slice(0, 300),
    stderr: seed.stderr.trim().slice(0, 300),
  });
  if (results.includes(false)) throw new Error('SeedFailed');

  const before = await fingerprintAll(uri, names);
  const beforeSummary = summarize(before);
  check(
    'fingerprint-source',
    beforeSummary.documents > 0 && beforeSummary.collectionsWithValidator > 0,
    beforeSummary,
  );

  const made = await backup({ out: outDir, env: drillEnv });
  check(
    'backup',
    Object.values(made.archives).every((a) => a.bytes > 0),
    { archives: made.archives, toolsImage: made.manifest.toolsImage },
  );

  for (const name of Object.values(names)) await client.db(name).dropDatabase();
  const left = (await client.db().admin().listDatabases({ nameOnly: true })).databases
    .map((d) => d.name)
    .filter((n) => Object.values(names).includes(n));
  check('wipe', left.length === 0, { remainingDrillDatabases: left.length });

  const restored = await restore({
    manifestPath: made.manifestPath,
    confirm: Object.values(names),
    env: drillEnv,
  });
  check('restore', restored.differences.length === 0, {
    ...restored.restoredSummary,
    differences: restored.differences,
  });

  const after = await fingerprintAll(uri, names);
  const diff = diffFingerprints(before, after);
  check('compare-validators-indexes-documents', diff.length === 0, {
    differences: diff,
    collections: beforeSummary.collections,
  });

  // Behavioral proof that the restored validators and indexes are live, not just present in metadata.
  const jobs = client.db(names.control).collection('jobs');
  const invalid = await jobs.insertOne({ _id: 'invalid-drill-job', nonsense: true }).then(
    () => 'accepted',
    (e) => `code ${e.code}`,
  );
  check('restored-validator-rejects-invalid-insert', invalid === 'code 121', {
    outcome: invalid,
    expected: 'code 121 (DocumentValidationFailure)',
  });
  const sample = await jobs.findOne({});
  const duplicate = sample
    ? await jobs.insertOne({ ...sample }).then(
        () => 'accepted',
        (e) => `code ${e.code}`,
      )
    : 'no-sample';
  check('restored-unique-index-rejects-duplicate', duplicate === 'code 11000', {
    outcome: duplicate,
    expected: 'code 11000 (DuplicateKey)',
  });

  // Negative controls: the comparator and the checksum gate must be able to fail.
  await client
    .db(names.world)
    .collection('world_revisions')
    .updateOne({}, { $set: { drillTamper: 1 } }, { bypassDocumentValidation: true });
  const tampered = diffFingerprints(before, await fingerprintAll(uri, names));
  check('negative-control-comparator-detects-a-changed-document', tampered.length > 0, {
    differences: tampered.length,
  });
  const badManifest = JSON.parse(JSON.stringify(made.manifest));
  badManifest.archives.world.sha256 = '0'.repeat(64);
  const badPath = join(outDir, 'tampered.manifest.json');
  writeFileSync(badPath, JSON.stringify(badManifest));
  const refused = await restore({ manifestPath: badPath, confirm: Object.values(names), env: drillEnv }).then(
    () => 'restored',
    (e) => e.message,
  );
  check('negative-control-checksum-mismatch-refused', refused.startsWith('ArchiveChecksumMismatch'), {
    outcome: refused,
  });
  const nonEmpty = await restore({
    manifestPath: made.manifestPath,
    confirm: Object.values(names),
    env: drillEnv,
  }).then(
    () => 'restored',
    (e) => e.message.split(':')[0],
  );
  check('negative-control-refuses-non-empty-target', nonEmpty === 'TargetNotEmpty', { outcome: nonEmpty });
  const wrongConfirm = await restore({
    manifestPath: made.manifestPath,
    confirm: [names.world],
    env: drillEnv,
  }).then(
    () => 'restored',
    (e) => e.message.split(':')[0],
  );
  check('negative-control-wrong-confirmation-refused', wrongConfirm === 'ConfirmationMismatch', {
    outcome: wrongConfirm,
  });
} catch (error) {
  check('drill', false, { error: error instanceof Error ? `${error.name}: ${error.message}` : 'unknown' });
} finally {
  for (const name of Object.values(names))
    await client
      .db(name)
      .dropDatabase()
      .catch(() => undefined);
  await client.close();
  rmSync(outDir, { recursive: true, force: true });
}
const pass = results.length > 0 && results.every(Boolean);
step('result', { pass, checks: results.length, failed: results.filter((r) => !r).length });
process.exit(pass ? 0 : 1);
