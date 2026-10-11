// Spec section 20 verification scenarios: stale narrative versus newer code, and an active old-writer lock.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createCheckpoint } from '../checkpoint.mjs';
import { findWriterLocks } from '../lib.mjs';
import { planRestore } from '../restore-checkpoint.mjs';
import { cleanupTmp, commitAll, hashTree, mkRepo, mkTmp, runNode, sh, write } from './helpers.mjs';

after(cleanupTmp);

const FUTURE = new Date(Date.now() + 3600 * 1000);

function sourceWithWip() {
  const repo = mkRepo();
  write(repo, 'a.txt', 'a1\n');
  write(repo, 'b.txt', 'b1\n');
  write(repo, 'notes/plan.md', 'plan v1\n');
  commitAll(repo);
  write(repo, 'a.txt', 'a1\na2\n'); // unstaged WIP
  write(repo, 'b.txt', 'b1\nb2\n');
  sh(repo, 'add', 'b.txt'); // staged WIP
  write(repo, 'd.txt', 'untracked WIP\n');
  return repo;
}

const cloneOf = (repo) => {
  const dir = path.join(mkTmp('expunge-scn-target-'), 'checkout');
  sh(path.dirname(dir), 'clone', '-q', '--no-hardlinks', repo, dir);
  return fs.realpathSync(dir);
};

const touchLater = (file) => fs.utimesSync(file, FUTURE, FUTURE);

test('stale narrative vs newer code: verify reports CHANGED, restore refuses until --force-review, and never overwrites', () => {
  const src = sourceWithWip();
  const cp = createCheckpoint({ repo: src, now: new Date('2026-10-11T10:10:00.000Z') });

  // Newer code appears after the checkpoint: an unrelated tracked file and a WIP file edited again.
  write(src, 'notes/plan.md', 'plan v2, written after the checkpoint\n');
  touchLater(path.join(src, 'notes/plan.md'));

  const verify = runNode('verify-checkpoint.mjs', [cp.dir, '--repo', src]);
  assert.equal(verify.status, 1);
  assert.match(verify.stdout, /^CHANGED notes\/plan\.md \(modified after checkpoint\)$/m);
  assert.match(verify.stdout, /RESULT: MISMATCH/);

  // Same workspace: everything the checkpoint holds is present, but the target has newer work -> needs review.
  const before = hashTree(src);
  const refused = runNode('restore-checkpoint.mjs', [cp.dir, src]);
  assert.equal(refused.status, 6, refused.stdout + refused.stderr);
  assert.match(refused.stdout, /STALE_CHECKPOINT/);
  assert.match(refused.stdout, /--force-review/);
  assert.match(refused.stdout, /changed-since-checkpoint: notes\/plan\.md/);
  assert.equal(runNode('restore-checkpoint.mjs', [cp.dir, src, '--apply']).status, 6);
  assert.deepEqual(hashTree(src), before, 'a refused restore writes nothing');

  // Acknowledged: nothing is left to restore, and the newer file is untouched.
  const reviewed = runNode('restore-checkpoint.mjs', [cp.dir, src, '--apply', '--force-review']);
  assert.equal(reviewed.status, 0, reviewed.stdout);
  assert.match(reviewed.stdout, /ALREADY_APPLIED/);
  assert.match(reviewed.stdout, /--force-review acknowledged 1 newer file/);
  assert.deepEqual(hashTree(src), before);
  assert.equal(
    fs.readFileSync(path.join(src, 'notes/plan.md'), 'utf8'),
    'plan v2, written after the checkpoint\n',
  );

  // --force-review never lets a restore overwrite a path it would itself write.
  write(src, 'a.txt', 'a1\na2\nedited again after the checkpoint\n');
  const conflict = runNode('restore-checkpoint.mjs', [cp.dir, src, '--apply', '--force-review']);
  assert.equal(conflict.status, 5);
  assert.match(conflict.stdout, /changed-since-checkpoint: a\.txt/);
  assert.equal(
    fs.readFileSync(path.join(src, 'a.txt'), 'utf8'),
    'a1\na2\nedited again after the checkpoint\n',
  );
});

test('stale narrative on a transferred checkout: unrelated newer work needs review, then the WIP restores around it', () => {
  const src = sourceWithWip();
  const cp = createCheckpoint({ repo: src, now: new Date('2026-10-11T10:10:00.000Z') });
  const target = cloneOf(src);
  write(target, 'notes/plan.md', 'plan v3 from the new account\n'); // local edit unrelated to the WIP

  const dry = planRestore(cp.dir, target);
  assert.equal(dry.status, 'REFUSED');
  assert.equal(dry.reason, 'STALE_CHECKPOINT');
  assert.equal(dry.code, 6);
  assert.deepEqual(
    dry.conflicts.map((c) => c.path),
    ['notes/plan.md'],
  );
  assert.equal(fs.existsSync(path.join(target, 'd.txt')), false);

  const applied = runNode('restore-checkpoint.mjs', [cp.dir, target, '--apply', '--force-review']);
  assert.equal(applied.status, 0, applied.stdout);
  assert.match(applied.stdout, /status: APPLIED/);
  assert.equal(fs.readFileSync(path.join(target, 'd.txt'), 'utf8'), 'untracked WIP\n');
  assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'a1\na2\n');
  assert.equal(
    fs.readFileSync(path.join(target, 'notes/plan.md'), 'utf8'),
    'plan v3 from the new account\n',
    'newer local work is preserved',
  );
  assert.deepEqual(sh(target, 'diff', '--cached', '--name-only').split('\n').filter(Boolean), ['b.txt']);
});

test('active old-writer lock under .expunge/locks blocks restore with a clear message and is never removed', () => {
  const src = sourceWithWip();
  const cp = createCheckpoint({ repo: src, now: new Date('2026-10-11T10:10:00.000Z') });
  const target = cloneOf(src);
  const locks = path.join(target, '.expunge', 'locks');
  fs.mkdirSync(locks, { recursive: true });
  const lockFile = path.join(locks, 'old-lead.lock');
  fs.writeFileSync(
    lockFile,
    JSON.stringify({ pid: process.pid, agent: 'old-lead', since: '2026-10-11T09:00:00Z' }),
  );
  const before = hashTree(target);

  for (const args of [[], ['--apply'], ['--apply', '--force-review']]) {
    const r = runNode('restore-checkpoint.mjs', [cp.dir, target, ...args]);
    assert.equal(r.status, 7, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /ACTIVE_WRITER_LOCK/);
    assert.match(r.stdout, /\.expunge\/locks\/old-lead\.lock/);
    assert.match(r.stdout, new RegExp(`pid ${process.pid}`));
    assert.match(r.stdout, /owner old-lead/);
    assert.match(r.stdout, /not removing it/);
  }
  assert.deepEqual(hashTree(target), before, 'nothing restored while a writer lock is active');
  assert.ok(fs.existsSync(lockFile), 'the lock file is never removed');

  // A lock whose pid is provably dead is stale: reported, left in place, and does not block.
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 2147483646, agent: 'old-lead' }));
  const stale = runNode('restore-checkpoint.mjs', [cp.dir, target, '--apply']);
  assert.equal(stale.status, 0, stale.stdout);
  assert.match(stale.stdout, /status: APPLIED/);
  assert.match(
    stale.stdout,
    /note: \.expunge\/locks\/old-lead\.lock \(pid 2147483646 not running; left in place\)/,
  );
  assert.ok(fs.existsSync(lockFile));
});

test('writer lock forms: no pid blocks, plain-number and directory locks are understood, hidden entries ignored', () => {
  const repo = mkRepo();
  const locks = path.join(repo, '.expunge', 'locks');
  fs.mkdirSync(locks, { recursive: true });
  assert.deepEqual(findWriterLocks(repo), { active: [], stale: [] });

  fs.writeFileSync(path.join(locks, 'unknown-owner.lock'), '');
  fs.writeFileSync(path.join(locks, 'plain.lock'), `${process.pid}\n`);
  fs.writeFileSync(path.join(locks, 'dead.lock'), '2147483646\n');
  fs.mkdirSync(path.join(locks, 'npm.lock'));
  fs.writeFileSync(path.join(locks, 'npm.lock', 'pid'), `${process.pid}\n`);
  fs.mkdirSync(path.join(locks, 'nopid.lock'));
  fs.writeFileSync(path.join(locks, '.hidden'), 'ignored');

  const { active, stale } = findWriterLocks(repo);
  assert.deepEqual(
    active.map((l) => l.name),
    [
      '.expunge/locks/nopid.lock',
      '.expunge/locks/npm.lock',
      '.expunge/locks/plain.lock',
      '.expunge/locks/unknown-owner.lock',
    ],
  );
  assert.deepEqual(
    stale.map((l) => l.name),
    ['.expunge/locks/dead.lock'],
  );
  assert.equal(
    active.find((l) => l.name.endsWith('unknown-owner.lock')).pid,
    null,
    'no recorded pid is treated as active',
  );
});
