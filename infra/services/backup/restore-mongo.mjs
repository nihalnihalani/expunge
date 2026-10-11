#!/usr/bin/env node
// Restores a backup made by backup-mongo.mjs with the pinned mongorestore image.
//
//   EXPUNGE_RESTORE_URI=... node infra/services/backup/restore-mongo.mjs --manifest FILE \
//     --confirm-databases world_db,control_db,private_db [--map world_db=new_world,...] [--docker-network NAME] [--drop]
//
// Safety: the archive sha256 is checked against the manifest first; the databases to be written must be named again with
// --confirm-databases (a typo cannot overwrite a live database); without --drop the restore refuses to write into a
// database that already holds collections. After the restore the tool fingerprints the target (validators, indexes,
// document hashes) and compares it with the manifest's source fingerprint; exit 0 only when they are identical.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import mongodb from 'mongodb';

const { MongoClient } = mongodb;
import {
  diffFingerprints,
  fingerprintAll,
  refuseSetupPrincipal,
  runTools,
  sha256File,
  summarize,
  uriFromEnv,
} from './lib.mjs';

export async function restore({
  manifestPath,
  confirm,
  map = {},
  drop = false,
  network = 'host',
  env = process.env,
  uriVariable = 'EXPUNGE_RESTORE_URI',
  compare = true,
  acknowledgeReapply = false,
  allowExpired = false,
}) {
  const uri = uriFromEnv(uriVariable, env);
  refuseSetupPrincipal(uri, env);
  // B-1: a restore can bring back records erased after the backup. It is allowed only when the operator commits to
  // re-applying erasures afterwards, and an archive past its retention is refused.
  if (!acknowledgeReapply)
    throw new Error(
      'ReapplyNotAcknowledged: pass --reapply-erasures-after-restore, then do it (BACKUP-RESTORE.md)',
    );
  const manifestFile = resolve(manifestPath);
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
  if (manifest.format !== 'expunge-backup-v2') throw new Error('UnsupportedManifest');
  if (!allowExpired && Date.parse(manifest.expiresAt) < Date.now())
    throw new Error('BackupExpired: retention elapsed; erased data may still be in it');
  const archiveDir = dirname(manifestFile);
  for (const [kind, info] of Object.entries(manifest.archives)) {
    const file = resolve(archiveDir, info.file);
    if (!existsSync(file)) throw new Error(`ArchiveMissing:${kind}`);
    if ((await sha256File(file)) !== info.sha256) throw new Error(`ArchiveChecksumMismatch:${kind}`);
  }

  const sourceNames = manifest.databases;
  const targetNames = Object.fromEntries(
    Object.entries(sourceNames).map(([kind, name]) => [kind, map[name] ?? name]),
  );
  const written = Object.values(targetNames).sort().join(',');
  if ([...confirm].sort().join(',') !== written)
    throw new Error(`ConfirmationMismatch: --confirm-databases must equal the target databases (${written})`);

  const probe = new MongoClient(uri, { appName: 'expunge-restore-precheck', serverSelectionTimeoutMS: 8000 });
  try {
    await probe.connect();
    for (const name of Object.values(targetNames)) {
      const existing = await probe.db(name).listCollections({}, { nameOnly: true }).toArray();
      if (existing.length > 0 && !drop)
        throw new Error(
          `TargetNotEmpty: ${name} holds ${existing.length} collections; wipe it or pass --drop`,
        );
    }
  } finally {
    await probe.close();
  }

  for (const [kind, name] of Object.entries(sourceNames)) {
    const to = targetNames[kind];
    const mapArgs = to !== name ? `--nsFrom='${name}.*' --nsTo='${to}.*'` : '';
    const script = `set -eu; printf 'uri: %s\\n' "$${uriVariable}" > /tmp/restore.yml; mongorestore --config=/tmp/restore.yml --nsInclude='${name}.*' ${mapArgs} ${drop ? '--drop' : ''} --gzip --archive=/backup/${manifest.archives[kind].file}; rm -f /tmp/restore.yml`;
    const result = runTools({
      script,
      envNames: [uriVariable],
      mounts: [[archiveDir, '/backup', 'ro']],
      network,
      env,
      image: manifest.toolsImage,
    });
    if (result.status !== 0)
      throw new Error(
        `mongorestore ${kind} failed (exit ${result.status}): ${result.stderr.split('\n').slice(-5).join(' | ')}`,
      );
  }

  const restored = await fingerprintAll(uri, targetNames);
  const differences = compare ? diffFingerprints(manifest.sourceFingerprint, restored) : [];
  return {
    targetNames,
    restoredSummary: summarize(restored),
    differences,
    restored,
    postRestoreRequired: manifest.postRestoreRequired,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const args = process.argv.slice(2);
  const value = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const manifestPath = value('--manifest');
  const confirm = value('--confirm-databases')?.split(',').filter(Boolean);
  if (!manifestPath || !confirm) {
    console.error(
      'usage: restore-mongo.mjs --manifest FILE --confirm-databases a,b,c [--map src=dst,...] [--docker-network NAME] [--drop]',
    );
    process.exit(2);
  }
  const map = Object.fromEntries(
    (value('--map') ?? '')
      .split(',')
      .filter(Boolean)
      .map((pair) => pair.split('=')),
  );
  restore({
    manifestPath,
    confirm,
    map,
    drop: args.includes('--drop'),
    acknowledgeReapply: args.includes('--reapply-erasures-after-restore'),
    allowExpired: args.includes('--allow-expired'),
    network: value('--docker-network') ?? 'host',
  }).then(
    ({ targetNames, restoredSummary, differences }) => {
      console.log(
        JSON.stringify({
          targetNames,
          ...restoredSummary,
          identicalToBackupSource: differences.length === 0,
          differences,
        }),
      );
      process.exit(differences.length === 0 ? 0 : 4);
    },
    (error) => {
      console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'unknown' }));
      process.exit(1);
    },
  );
}
