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
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  databasesFromEnv,
  fingerprintAll,
  MONGO_TOOLS_IMAGE,
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
}) {
  const uri = uriFromEnv(uriVariable, env);
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
    const script = `set -eu; printf 'uri: %s\\n' "$${uriVariable}" > /tmp/dump.yml; mongodump --config=/tmp/dump.yml --db='${name}' --gzip --archive=/backup/${file}; rm -f /tmp/dump.yml`;
    const result = runTools({ script, envNames: [uriVariable], mounts: [[outDir, '/backup']], network, env });
    if (result.status !== 0)
      throw new Error(
        `mongodump ${kind} failed (exit ${result.status}): ${result.stderr.split('\n').slice(-5).join(' | ')}`,
      );
    archives[kind] = {
      file,
      sha256: await sha256File(`${outDir}/${file}`),
      bytes: statSync(`${outDir}/${file}`).size,
    };
  }

  const manifest = {
    format: 'expunge-backup-v2',
    createdAt: new Date().toISOString(),
    archives,
    toolsImage: MONGO_TOOLS_IMAGE,
    databases: names,
    sourceSummary: summarize(source),
    sourceFingerprint: source,
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
  backup({ out, network: value('--docker-network') ?? 'host' }).then(
    ({ archives, manifestPath, manifest }) => {
      console.log(JSON.stringify({ archives, manifest: manifestPath, ...manifest.sourceSummary }));
    },
    (error) => {
      console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'unknown' }));
      process.exit(1);
    },
  );
}
