// Shared helpers for the Expunge MongoDB backup, restore and drill tools. No secret value is ever printed: URIs are read
// from environment variables NAMED by the caller and handed to containers by name (`docker run -e NAME`).
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { spawnSync } from 'node:child_process';
import mongodb from 'mongodb';

const { BSON, MongoClient } = mongodb;
const { EJSON } = BSON;

/** Pinned tools image (mongodump/mongorestore 100.13.0, mongosh). Tag AND digest; verified by `docker pull` on 2026-10-11. */
export const MONGO_TOOLS_IMAGE =
  'mongo:8.0.15@sha256:f4d54619262ae3bc6a0a8efbebcef970b87b8ad70697479a75ce308a6f400158';

export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

/** The backup and restore principals must never be the setup principal (B-4): refuses an identical URI value. */
export function refuseSetupPrincipal(uri, env = process.env) {
  const setup = env.MONGODB_SETUP_URI?.trim();
  if (setup && uri === setup)
    throw new Error('SetupPrincipalRefused: use a dedicated backup/restore principal, not MONGODB_SETUP_URI');
}

/** Reads a URI from the environment variable `name`; throws naming the VARIABLE, never the value. */
export function uriFromEnv(name, env = process.env) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`MissingConfiguration:${name}`);
  if (!/^mongodb(\+srv)?:\/\//.test(value))
    throw new Error(`InvalidConfiguration:${name} is not a mongodb URI`);
  return value;
}

export function databasesFromEnv(env = process.env) {
  const names = {
    world: env.EXPUNGE_WORLD_DB?.trim(),
    control: env.EXPUNGE_CONTROL_DB?.trim(),
    private: env.EXPUNGE_PRIVATE_DB?.trim(),
  };
  for (const [kind, name] of Object.entries(names))
    if (!name || !/^[A-Za-z0-9_-]{1,63}$/.test(name))
      throw new Error(`InvalidConfiguration:EXPUNGE_${kind.toUpperCase()}_DB`);
  return names;
}

/**
 * Runs a command inside the pinned mongo tools image. `envNames` are passed by NAME so values never appear in argv; the
 * script itself builds the tool's --config from the variable inside the container, so the URI is not in any process argument
 * list either (neither on the host nor in `docker top`).
 */
export function runTools({
  script,
  envNames,
  mounts = [],
  network = 'host',
  env = process.env,
  image = MONGO_TOOLS_IMAGE,
}) {
  const args = [
    'run',
    '--rm',
    '--network',
    network,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
  ];
  args.push('--tmpfs', '/tmp:size=64m');
  for (const name of envNames) args.push('-e', name);
  for (const [host, container, mode] of mounts)
    args.push('-v', `${host}:${container}${mode ? `:${mode}` : ''}`);
  args.push('--entrypoint', 'sh', image, '-c', script);
  const result = spawnSync('docker', args, { env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

const stable = (value) =>
  JSON.stringify(value, (_k, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );

/**
 * A fingerprint of one database's durable shape: per collection the document count, an order-independent hash over every
 * document's canonical EJSON bytes (key order inside a document matters), the validator (hash and level/action) and the
 * index set (name, key, options; the default `_id_` included). Equal fingerprints mean the validators, indexes and
 * documents match exactly. It reads with whatever principal the URI names; it never writes.
 */
export async function fingerprintDatabase(client, dbName) {
  const db = client.db(dbName);
  const collections = await db.listCollections({}, { nameOnly: false }).toArray();
  const out = {};
  for (const info of collections
    .filter((c) => c.type !== 'view' && !c.name.startsWith('system.'))
    .sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const collection = db.collection(info.name);
    const docHashes = [];
    let count = 0;
    for await (const doc of collection.find(
      {},
      { sort: { _id: 1 }, promoteValues: false, promoteLongs: false },
    )) {
      docHashes.push(sha256(EJSON.stringify(doc, { relaxed: false })));
      count++;
    }
    docHashes.sort();
    const indexes = (await collection.indexes()).map((ix) => {
      const { v: _v, ns: _ns, ...rest } = ix;
      return rest;
    });
    indexes.sort((a, b) => (a.name < b.name ? -1 : 1));
    const options = info.options ?? {};
    const { validator, validationLevel, validationAction, ...otherOptions } = options;
    out[info.name] = {
      count,
      documentsSha256: sha256(docHashes.join('\n')),
      validatorSha256: sha256(stable(validator ?? null)),
      validation: { level: validationLevel ?? null, action: validationAction ?? null },
      indexesSha256: sha256(stable(indexes)),
      indexNames: indexes.map((ix) => ix.name),
      otherOptions: stable(otherOptions),
    };
  }
  return out;
}

export async function fingerprintAll(uri, names) {
  const client = new MongoClient(uri, {
    appName: 'expunge-backup-fingerprint',
    serverSelectionTimeoutMS: 8000,
  });
  try {
    await client.connect();
    const result = {};
    for (const [kind, name] of Object.entries(names)) result[kind] = await fingerprintDatabase(client, name);
    return result;
  } finally {
    await client.close();
  }
}

/** Compares two fingerprints (kind-keyed). Returns a list of human-readable differences; empty means identical. */
export function diffFingerprints(expected, actual) {
  const differences = [];
  for (const kind of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
    const left = expected[kind] ?? {};
    const right = actual[kind] ?? {};
    for (const collection of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const a = left[collection];
      const b = right[collection];
      if (!a || !b) {
        differences.push(
          `${kind}.${collection}: ${a ? 'missing after restore' : 'unexpected after restore'}`,
        );
        continue;
      }
      for (const field of ['count', 'documentsSha256', 'validatorSha256', 'indexesSha256', 'otherOptions'])
        if (a[field] !== b[field])
          differences.push(`${kind}.${collection}.${field}: ${a[field]} != ${b[field]}`);
      if (stable(a.validation) !== stable(b.validation))
        differences.push(`${kind}.${collection}.validation level/action`);
    }
  }
  return differences;
}

export function summarize(fingerprint) {
  let collections = 0,
    documents = 0,
    validators = 0,
    indexes = 0;
  for (const dbs of Object.values(fingerprint))
    for (const info of Object.values(dbs)) {
      collections++;
      documents += info.count;
      if (info.validation.level) validators++;
      indexes += info.indexNames.length;
    }
  return { collections, documents, collectionsWithValidator: validators, indexes };
}
