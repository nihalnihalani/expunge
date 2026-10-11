import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createCheckpoint } from '../checkpoint.mjs';
import { readLatest, sha256Buffer } from '../lib.mjs';
import { cleanupTmp, commitAll, mkRepo, write } from './helpers.mjs';

after(cleanupTmp);

const base = (repo) => path.join(repo, '.expunge', 'checkpoints');
const listDirs = (repo) => fs.readdirSync(base(repo)).sort();

test('interrupted write before the atomic rename preserves the previous checkpoint and LATEST', () => {
  const repo = mkRepo();
  write(repo, 'a.txt', 'a1\n');
  commitAll(repo);
  const first = createCheckpoint({ repo, now: new Date('2026-10-11T10:10:00.000Z') });
  const firstManifest = sha256Buffer(fs.readFileSync(path.join(first.dir, 'manifest.json')));
  assert.equal(readLatest(base(repo)), first.id);

  write(repo, 'a.txt', 'a2\n');
  assert.throws(
    () =>
      createCheckpoint({
        repo,
        now: new Date('2026-10-11T10:20:00.000Z'),
        hooks: {
          beforeRename: () => {
            throw new Error('simulated crash before rename');
          },
        },
      }),
    /simulated crash before rename/,
  );
  assert.equal(readLatest(base(repo)), first.id, 'LATEST must still name the previous checkpoint');
  const dirs = listDirs(repo);
  assert.deepEqual(
    dirs.filter((d) => !d.startsWith('.') && d !== 'LATEST'),
    [first.id],
    'no final directory for the interrupted checkpoint',
  );
  assert.ok(
    dirs.some((d) => d.startsWith('.tmp-')),
    'an interrupted write leaves only a temp directory',
  );
  assert.equal(sha256Buffer(fs.readFileSync(path.join(first.dir, 'manifest.json'))), firstManifest);
  assert.ok(!dirs.includes('.checkpoint.lock'), 'lock released after failure');
});

test('crash after the rename but before LATEST: the complete directory exists, LATEST is still the previous one', () => {
  const repo = mkRepo();
  write(repo, 'a.txt', 'a1\n');
  commitAll(repo);
  const first = createCheckpoint({ repo, now: new Date('2026-10-11T10:10:00.000Z') });
  write(repo, 'a.txt', 'a2\n');
  assert.throws(
    () =>
      createCheckpoint({
        repo,
        now: new Date('2026-10-11T10:20:00.000Z'),
        hooks: {
          beforeLatest: () => {
            throw new Error('simulated crash before LATEST');
          },
        },
      }),
    /simulated crash before LATEST/,
  );
  assert.equal(readLatest(base(repo)), first.id);
  const finals = listDirs(repo).filter((d) => !d.startsWith('.') && d !== 'LATEST');
  assert.equal(finals.length, 2);

  // A later successful run prunes the stale temp dir, creates a new checkpoint and moves LATEST.
  const third = createCheckpoint({ repo, now: new Date('2026-10-11T10:30:00.000Z') });
  assert.equal(readLatest(base(repo)), third.id);
  assert.ok(!listDirs(repo).some((d) => d.startsWith('.tmp-')));
  assert.ok(fs.existsSync(path.join(first.dir, 'manifest.json')), 'earlier checkpoints are never removed');
});

test('a live lock blocks a concurrent checkpoint; a stale lock is replaced', () => {
  const repo = mkRepo();
  write(repo, 'a.txt', 'a1\n');
  commitAll(repo);
  fs.mkdirSync(base(repo), { recursive: true });
  const lock = path.join(base(repo), '.checkpoint.lock');
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), `${process.pid}\n`);
  assert.throws(() => createCheckpoint({ repo }), /another checkpoint is in progress/);
  assert.ok(fs.existsSync(lock), 'a live lock is never removed');

  fs.writeFileSync(path.join(lock, 'pid'), '2147483646\n'); // no such process
  const r = createCheckpoint({ repo, now: new Date('2026-10-11T10:40:00.000Z') });
  assert.equal(r.manifest.complete, true);
  assert.ok(!fs.existsSync(lock));
});
