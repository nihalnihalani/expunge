#!/usr/bin/env node
// Logical backup of the three Expunge databases with the pinned mongodump image.
//
//   EXPUNGE_BACKUP_URI=... EXPUNGE_WORLD_DB=... EXPUNGE_CONTROL_DB=... EXPUNGE_PRIVATE_DB=... \
//     node infra/services/backup/backup-mongo.mjs --out /var/backups/expunge [--docker-network NAME]
//
// - The URI comes from the environment variable EXPUNGE_BACKUP_URI (a read-only backup principal). It is never the setup
//   principal and never a runtime principal; if it is missing the tool stops and names the variable.
// - Quiesce writers first (docs/runbooks/BACKUP-RESTORE.md): a logical dump is consistent per collection, not across
//   collections, while the worker and observer are writing.
// - Output: <out>/expunge-<UTC stamp>.{world,control,private}.archive.gz and <same>.manifest.json (per-archive sha256 and
//   size, tools image, source fingerprint).
import { chmodSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  databasesFromEnv,
  diffFingerprints,
  fingerprintAll,
  MONGO_TOOLS_IMAGE,
  refuseSetupPrincipal,
  runTools,
  sha256File,
  summarize,
  uriFromEnv,
} from './lib.mjs';

export async function backup({
  out,
  network = 'host',
  env = process.env,
  uriVariable = 'EXPUNGE_BACKUP_URI',
  retentionDays = 30,
}) {
  const uri = uriFromEnv(uriVariable, env);
  refuseSetupPrincipal(uri, env);
  const names = databasesFromEnv(env);
  const outDir = resolve(out);
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const base = `expunge-${stamp}`;

  const source = await fingerprintAll(uri, names);
  // mongodump takes one --db per archive, so each database is its own archive (the three are one backup set).
  const archives = {};
  for (const [kind, name] of Object.entries(names)) {
    const file = `${base}.${kind}.archive.gz`;
    const script = `set -eu; umask 077; printf 'uri: %s\\n' "$${uriVariable}" > /tmp/dump.yml; mongodump --config=/tmp/dump.yml --db='${name}' --gzip --archive=/backup/${file}; rm -f /tmp/dump.yml`;
    const result = runTools({ script, envNames: [uriVariable], mounts: [[outDir, '/backup']], network, env });
    if (result.status !== 0)
      throw new Error(
        `mongodump ${kind} failed (exit ${result.status}): ${result.stderr.split('\n').slice(-5).join(' | ')}`,
      );
    chmodSync(`${outDir}/${file}`, 0o600);
    archives[kind] = {
      file,
      sha256: await sha256File(`${outDir}/${file}`),
      bytes: statSync(`${outDir}/${file}`).size,
    };
  }

  // B-3: the source must not have changed while it was dumped; otherwise the set is torn and is discarded.
  const sourceAfter = await fingerprintAll(uri, names);
  const drift = diffFingerprints(source, sourceAfter);
  if (drift.length > 0) {
    for (const a of Object.values(archives)) rmSync(`${outDir}/${a.file}`, { force: true });
    throw new Error(`SourceChangedDuringBackup: ${drift.length} differences; quiesce writers and retry`);
  }
  const manifest = {
    format: 'expunge-backup-v2',
    createdAt: new Date().toISOString(),
    archives,
    toolsImage: MONGO_TOOLS_IMAGE,
    databases: names,
    sourceSummary: summarize(source),
    sourceFingerprint: source,
    expiresAt: new Date(Date.now() + retentionDays * 86_400_000).toISOString(),
    postRestoreRequired: [
      'BEFORE wiping: node --import tsx packages/privacy/src/reapply-cli.ts export --ledger FILE',
      'AFTER restoring, before any service starts: reapply-cli.ts apply --ledger FILE --cursor FILE (exit 0 only when DONE)',
      'reconcile effects and receipts against the owner source',
      'rebuild or reset projection streams',
    ],
    consistency: 'per-collection logical dump; cross-collection consistency requires quiesced writers',
  };
  const manifestPath = `${outDir}/${base}.manifest.json`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { archives, manifestPath, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const args = process.argv.slice(2);
  const value = (name) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const out = value('--out');
  if (!out) {
    console.error('usage: backup-mongo.mjs --out DIR [--docker-network NAME]');
    process.exit(2);
  }
  backup({
    out,
    network: value('--docker-network') ?? 'host',
    retentionDays: Number(value('--retention-days') ?? 30),
  }).then(
    ({ archives, manifestPath, manifest }) => {
      console.log(JSON.stringify({ archives, manifest: manifestPath, ...manifest.sourceSummary }));
    },
    (error) => {
      console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'unknown' }));
      process.exit(1);
    },
  );
}
