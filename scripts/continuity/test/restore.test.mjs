import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { createCheckpoint } from '../checkpoint.mjs';
import { applyRestore, planRestore } from '../restore-checkpoint.mjs';
import { verifyCheckpoint } from '../verify-checkpoint.mjs';
import { cleanupTmp, commitAll, hashTree, mkRepo, mkTmp, runNode, sh, write } from './helpers.mjs';

after(cleanupTmp);

/** Source repo with staged, unstaged, binary, deleted and untracked WIP on top of a base commit. */
function sourceWithWip() {
  const repo = mkRepo();
  write(repo, 'a.txt', 'a1\n');
  write(repo, 'b.txt', 'b1\n');
  write(repo, 'c.txt', 'c1\n');
  write(repo, 'e.txt', 'e1\n');
  fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 255, 254, 0, 9, 8, 7]));
  write(repo, 'tools/run.sh', '#!/bin/sh\necho hi\n', 0o755);
  commitAll(repo);
  write(repo, 'a.txt', 'a1\na2\n'); // unstaged
  write(repo, 'b.txt', 'b1\nb2\n');
  sh(repo, 'add', 'b.txt'); // staged
  write(repo, 'c.txt', 'c1\nc2\n');
  sh(repo, 'add', 'c.txt');
  write(repo, 'c.txt', 'c1\nc2\nc3\n'); // staged then unstaged
  fs.rmSync(path.join(repo, 'e.txt')); // unstaged deletion
  fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 255, 254, 0, 10, 11, 12, 13]));
  sh(repo, 'add', 'bin.dat'); // staged binary
  write(repo, 'new-staged.txt', 'ns\n');
  sh(repo, 'add', 'new-staged.txt');
  write(repo, 'd.txt', 'untracked\n');
  write(repo, 'tools/new.sh', '#!/bin/sh\necho new\n', 0o755);
  return repo;
}

const cloneOf = (repo) => {
  const dir = path.join(mkTmp('expunge-target-'), 'checkout');
  sh(path.dirname(dir), 'clone', '-q', '--no-hardlinks', repo, dir);
  return fs.realpathSync(dir);
};

const names = (repo, ...args) =>
  sh(repo, ...args)
    .split('\n')
    .filter(Boolean)
    .sort();

test('restore onto a matching base: dry-run writes nothing, --apply reproduces hashes and staged/unstaged split, second restore is a no-op', () => {
  const src = sourceWithWip();
  const cp = createCheckpoint({ repo: src, now: new Date('2026-10-11T10:10:00.000Z') });
  assert.equal(cp.manifest.complete, true);
  const target = cloneOf(src);
  const before = hashTree(target);
  const statusBefore = sh(target, 'status', '--porcelain');

  // Dry-run (library and CLI): READY, nothing written.
  const plan = planRestore(cp.dir, target);
  assert.equal(plan.status, 'READY');
  assert.deepEqual(
    plan.actions.map((a) => a.kind),
    ['apply-staged-patch', 'apply-unstaged-patch', 'copy-untracked'],
  );
  const dry = runNode('restore-checkpoint.mjs', [cp.dir, target]);
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /status: READY/);
  assert.match(dry.stdout, /nothing written/);
  assert.deepEqual(hashTree(target), before);
  assert.equal(sh(target, 'status', '--porcelain'), statusBefore);

  // Apply.
  const applied = runNode('restore-checkpoint.mjs', [cp.dir, target, '--apply']);
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /status: APPLIED/);
  const v = verifyCheckpoint(cp.dir, { repo: target });
  assert.equal(v.ok, true, JSON.stringify(v.worktree.filter((r) => r.status !== 'MATCH')));
  assert.deepEqual(hashTree(target), hashTree(src), 'restored tree is byte-identical to the source tree');
  assert.deepEqual(
    names(target, 'diff', '--cached', '--name-only'),
    names(src, 'diff', '--cached', '--name-only'),
  );
  assert.deepEqual(names(target, 'diff', '--name-only'), names(src, 'diff', '--name-only'));
  assert.equal(sh(target, 'status', '--porcelain'), sh(src, 'status', '--porcelain'));
  assert.equal(fs.statSync(path.join(target, 'tools/new.sh')).mode & 0o111, 0o111, 'executable bit restored');

  // Second restore is a no-op: nothing is applied twice, nothing is rewritten.
  const mtimes = Object.fromEntries(
    Object.keys(hashTree(target)).map((p) => [p, fs.statSync(path.join(target, p)).mtimeMs]),
  );
  const second = runNode('restore-checkpoint.mjs', [cp.dir, target, '--apply']);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /status: ALREADY_APPLIED/);
  assert.deepEqual(hashTree(target), hashTree(src));
  for (const [p, t] of Object.entries(mtimes)) assert.equal(fs.statSync(path.join(target, p)).mtimeMs, t, p);

  // The same workspace (source) is also already at the checkpoint: restoring there changes nothing.
  assert.equal(planRestore(cp.dir, src).status, 'ALREADY_APPLIED');
});

test('UNBORN checkpoint restores onto an empty repository once', () => {
  const src = mkRepo();
  write(src, 'package.json', '{}\n');
  write(src, 'docs/a.md', 'a\n');
  write(src, 'scripts/run.mjs', 'export {};\n', 0o755);
  sh(src, 'add', 'docs/a.md');
  const cp = createCheckpoint({ repo: src, now: new Date('2026-10-11T10:10:00.000Z') });
  assert.equal(cp.manifest.head, 'UNBORN');
  const target = mkTmp('expunge-unborn-target-');
  sh(target, 'init', '-q', '-b', 'main');
  const plan = planRestore(cp.dir, target);
  assert.equal(plan.status, 'READY');
  assert.equal(applyRestore(plan).status, 'APPLIED');
  assert.deepEqual(hashTree(target), hashTree(src));
  assert.equal(planRestore(cp.dir, target).status, 'ALREADY_APPLIED');
  const second = runNode('restore-checkpoint.mjs', [cp.dir, target, '--apply']);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /ALREADY_APPLIED/);
});

test('restore refuses on a mismatched base and writes nothing', () => {
  const src = sourceWithWip();
  const cp = createCheckpoint({ repo: src, now: new Date('2026-10-11T10:10:00.000Z') });

  const moved = cloneOf(src);
  write(moved, 'extra.txt', 'a newer commit on the target\n');
  commitAll(moved, 'target moved on');
  const before = hashTree(moved);
  const refused = runNode('restore-checkpoint.mjs', [cp.dir, moved, '--apply']);
  assert.equal(refused.status, 4);
  assert.match(refused.stdout, /BASE_MISMATCH/);
  assert.deepEqual(hashTree(moved), before);

  const emptyTarget = mkTmp('expunge-empty-target-');
  sh(emptyTarget, 'init', '-q', '-b', 'main');
  assert.equal(
    planRestore(cp.dir, emptyTarget).reason,
    'BASE_MISMATCH',
    'manifest has a HEAD but target is UNBORN',
  );

  // And the reverse: an UNBORN manifest never restores onto a repository that has commits.
  const unbornSrc = mkRepo();
  write(unbornSrc, 'README.md', 'x\n');
  const unbornCp = createCheckpoint({ repo: unbornSrc, now: new Date('2026-10-11T10:11:00.000Z') });
  assert.equal(planRestore(unbornCp.dir, moved).reason, 'BASE_MISMATCH');
});

test('restore never overwrites newer target files and refuses partial presence', () => {
  const src = sourceWithWip();
  const cp = createCheckpoint({ repo: src, now: new Date('2026-10-11T10:10:00.000Z') });

  const conflicted = cloneOf(src);
  write(conflicted, 'd.txt', 'someone else wrote this\n');
  const before = hashTree(conflicted);
  const plan = planRestore(cp.dir, conflicted);
  assert.equal(plan.status, 'REFUSED');
  assert.equal(plan.reason, 'CONFLICT');
  assert.deepEqual(
    plan.conflicts.map((c) => c.path),
    ['d.txt'],
  );
  assert.equal(runNode('restore-checkpoint.mjs', [cp.dir, conflicted, '--apply']).status, 5);
  assert.deepEqual(hashTree(conflicted), before);

  const partial = cloneOf(src);
  write(partial, 'd.txt', 'untracked\n'); // identical to the checkpoint copy: that part is already present
  const pplan = planRestore(cp.dir, partial);
  assert.equal(pplan.reason, 'PARTIAL_PRESENT');

  const edited = cloneOf(src);
  write(edited, 'a.txt', 'a1\nlocal edit that the patch does not expect\n');
  const eplan = planRestore(cp.dir, edited);
  assert.equal(eplan.reason, 'CONFLICT');
  assert.deepEqual(
    eplan.conflicts.map((c) => c.path),
    ['a.txt'],
  );
  assert.equal(
    fs.readFileSync(path.join(edited, 'a.txt'), 'utf8'),
    'a1\nlocal edit that the patch does not expect\n',
  );
});

test('restore refuses incomplete, corrupt and mislocated inputs', () => {
  const src = sourceWithWip();
  const good = createCheckpoint({ repo: src, now: new Date('2026-10-11T10:10:00.000Z') });
  const target = cloneOf(src);

  // Corrupt a pack file: hash check fails before anything is applied.
  const copy = path.join(good.dir, 'untracked', 'd.txt');
  fs.chmodSync(copy, 0o644);
  fs.writeFileSync(copy, 'tampered\n');
  const corrupt = planRestore(good.dir, target);
  assert.equal(corrupt.reason, 'PACK_CORRUPT');
  assert.equal(runNode('restore-checkpoint.mjs', [good.dir, target, '--apply']).status, 3);

  // Incomplete manifests are refused unless explicitly allowed.
  const repo2 = mkRepo();
  write(repo2, 'a.txt', 'a\n');
  commitAll(repo2);
  write(repo2, 'docs/leak.md', ['AK', 'IAABCDEFGHIJKLMNOP'].join('') + '\n');
  const incomplete = createCheckpoint({ repo: repo2, now: new Date('2026-10-11T10:12:00.000Z') });
  const t2 = cloneOf(repo2);
  assert.equal(planRestore(incomplete.dir, t2).reason, 'INCOMPLETE_CHECKPOINT');

  // Target must be a repository root.
  const sub = path.join(target, 'tools');
  assert.equal(planRestore(good.dir, sub).reason, 'PACK_CORRUPT'); // pack check comes first
  const fresh = createCheckpoint({ repo: src, now: new Date('2026-10-11T10:13:00.000Z') });
  assert.equal(planRestore(fresh.dir, sub).reason, 'TARGET_NOT_REPO');
  assert.equal(planRestore(fresh.dir, mkTmp('expunge-notrepo-')).reason, 'TARGET_NOT_REPO');
});

test('manifest with path traversal is rejected', () => {
  const src = sourceWithWip();
  const cp = createCheckpoint({ repo: src, now: new Date('2026-10-11T10:10:00.000Z') });
  const evil = mkTmp('expunge-evil-');
  fs.cpSync(cp.dir, evil, { recursive: true });
  const manifestFile = path.join(evil, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  m.untracked[0].path = '../escape.txt';
  fs.chmodSync(manifestFile, 0o644);
  fs.writeFileSync(manifestFile, JSON.stringify(m));
  const plan = planRestore(evil, cloneOf(src));
  assert.equal(plan.status, 'REFUSED');
  assert.equal(plan.reason, 'INVALID_MANIFEST');
});
