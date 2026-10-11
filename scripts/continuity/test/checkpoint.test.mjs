import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCheckpoint } from '../checkpoint.mjs';
import {
  CHECKPOINT_ID_RE,
  hashPath,
  readLatest,
  readManifest,
  sha256Buffer,
  verifyPack,
  verifyWorktree,
} from '../lib.mjs';
import { cleanupTmp, commitAll, mkRepo, runNode, sh, write } from './helpers.mjs';

after(cleanupTmp);

const FIXED = new Date('2026-10-11T10:10:00.000Z');

test('UNBORN repository: all approved files become untracked copies, no HEAD diff, gitignored paths are not dropped files', () => {
  const repo = mkRepo();
  write(repo, 'package.json', '{"name":"x"}\n');
  write(repo, 'README.md', '# x\n');
  write(repo, 'scripts/a.mjs', 'export const a = 1;\n', 0o755);
  write(repo, 'docs/x.md', 'doc\n');
  write(repo, 'apps/web/index.ts', 'export {};\n');
  write(repo, '.env', 'SOME_TOKEN=abcdef123456XYZ-private\n'); // ignored by .gitignore
  write(repo, 'node_modules/dep/index.js', 'x\n'); // ignored by .gitignore
  write(repo, 'tools/helper.sh', 'echo\n'); // top-level directory that is not in the listed roots
  sh(repo, 'add', 'docs/x.md'); // staged while UNBORN

  const r = createCheckpoint({ repo, now: FIXED });
  const m = r.manifest;
  assert.match(m.checkpointId, CHECKPOINT_ID_RE);
  assert.equal(m.checkpointId, r.id);
  assert.equal(m.head, 'UNBORN');
  assert.equal(m.headTree, null);
  assert.equal(m.branch, 'main');
  assert.equal(m.git.unborn, true);
  assert.equal(m.complete, true);
  assert.equal(r.latestUpdated, true);
  assert.equal(readLatest(path.join(repo, '.expunge', 'checkpoints')), r.id);
  assert.equal(m.patches.staged.bytes, 0);
  assert.equal(m.patches.unstaged.bytes, 0);
  assert.deepEqual(m.tracked, []);
  assert.deepEqual(m.git.stagedPaths, ['docs/x.md']);
  const copied = m.untracked.map((e) => e.path).sort();
  assert.deepEqual(copied, [
    '.gitignore',
    'README.md',
    'apps/web/index.ts',
    'docs/x.md',
    'package.json',
    'scripts/a.mjs',
    'tools/helper.sh',
  ]);
  assert.equal(m.untracked.find((e) => e.path === 'scripts/a.mjs').mode, '100755');
  for (const e of m.untracked) {
    const copy = fs.readFileSync(path.join(r.dir, e.copy));
    assert.equal(sha256Buffer(copy), e.sha256);
    assert.equal(hashPath(path.join(repo, e.path)), e.sha256);
    assert.equal(m.files[e.path], e.sha256);
  }
  assert.deepEqual(Object.keys(m.files), [...Object.keys(m.files)].sort());
  assert.deepEqual(m.excluded, [], 'ignored paths are not reported as dropped');
  assert.deepEqual(m.incompleteReasons, []);
  assert.equal(m.files['.env'], undefined);
  assert.ok(m.git.statusPorcelainV2.includes('# branch.oid (initial)'));
  assert.ok(verifyPack(r.dir, readManifest(r.dir)).every((x) => x.status === 'MATCH'));
  assert.ok(verifyWorktree(repo, m).every((x) => x.status === 'MATCH'));
  // staged.patch and unstaged.patch exist but are empty for UNBORN.
  assert.equal(fs.statSync(path.join(r.dir, 'staged.patch')).size, 0);
  assert.equal(fs.statSync(path.join(r.dir, 'unstaged.patch')).size, 0);
});

test('repo with commits, staged, unstaged, binary, deleted and untracked changes', () => {
  const repo = mkRepo();
  write(repo, 'a.txt', 'a1\n');
  write(repo, 'b.txt', 'b1\n');
  write(repo, 'c.txt', 'c1\n');
  write(repo, 'e.txt', 'e1\n');
  fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 255, 254, 0, 9]));
  write(repo, 'tools/run.sh', '#!/bin/sh\necho hi\n', 0o755);
  const base = commitAll(repo);
  write(repo, 'a.txt', 'a1\na2\n'); // unstaged
  write(repo, 'b.txt', 'b1\nb2\n');
  sh(repo, 'add', 'b.txt'); // staged
  write(repo, 'c.txt', 'c1\nc2\n');
  sh(repo, 'add', 'c.txt');
  write(repo, 'c.txt', 'c1\nc2\nc3\n'); // staged and then unstaged
  fs.rmSync(path.join(repo, 'e.txt')); // unstaged deletion
  fs.writeFileSync(path.join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 3, 255, 254, 0, 10, 11]));
  sh(repo, 'add', 'bin.dat'); // staged binary change
  write(repo, 'new-staged.txt', 'ns\n');
  sh(repo, 'add', 'new-staged.txt');
  write(repo, 'd.txt', 'untracked\n');

  const r = createCheckpoint({ repo, now: FIXED, notes: 'unit test' });
  const m = r.manifest;
  assert.equal(m.complete, true);
  assert.equal(m.head, base);
  assert.equal(m.headTree, sh(repo, 'rev-parse', 'HEAD^{tree}').trim());
  assert.ok(m.git.statusPorcelainV2.includes(`# branch.oid ${base}`));
  assert.equal(m.notes, 'unit test');
  assert.deepEqual(m.changes.staged.map((c) => c.path).sort(), [
    'b.txt',
    'bin.dat',
    'c.txt',
    'new-staged.txt',
  ]);
  assert.deepEqual(m.changes.unstaged.map((c) => `${c.status}:${c.path}`).sort(), [
    'D:e.txt',
    'M:a.txt',
    'M:c.txt',
  ]);
  assert.deepEqual(m.deleted, ['e.txt']);
  assert.deepEqual(
    m.untracked.map((e) => e.path),
    ['d.txt'],
  );
  assert.ok(!m.tracked.includes('e.txt'));
  for (const p of ['a.txt', 'b.txt', 'c.txt', 'bin.dat', 'new-staged.txt', 'tools/run.sh', '.gitignore']) {
    assert.equal(m.files[p], hashPath(path.join(repo, p)), p);
  }
  assert.equal(m.patches.staged.sha256, sha256Buffer(fs.readFileSync(path.join(r.dir, 'staged.patch'))));
  assert.equal(m.patches.unstaged.sha256, sha256Buffer(fs.readFileSync(path.join(r.dir, 'unstaged.patch'))));
  assert.ok(m.patches.staged.bytes > 0 && m.patches.unstaged.bytes > 0);
  // The patches must be real git diffs: they apply to a pristine checkout of the base commit.
  assert.equal(sh(repo, 'diff', '--cached', '--name-only').split('\n').filter(Boolean).length, 4);
  assert.equal(r.latestUpdated, true);
});

test('a checkpoint after a commit is a NEW immutable manifest and the previous one is preserved', () => {
  const repo = mkRepo();
  write(repo, 'a.txt', 'a1\n');
  const base = commitAll(repo);
  write(repo, 'a.txt', 'a2\n');
  const first = createCheckpoint({ repo, now: new Date('2026-10-11T10:10:00.000Z') });
  const firstBytes = fs.readFileSync(path.join(first.dir, 'manifest.json'));
  assert.equal(first.manifest.head, base);

  const newHead = commitAll(repo, 'second');
  const second = createCheckpoint({ repo, now: new Date('2026-10-11T10:20:00.000Z') });
  assert.notEqual(second.id, first.id);
  assert.equal(second.manifest.head, newHead);
  assert.notEqual(second.manifest.head, first.manifest.head);
  assert.deepEqual(
    fs.readFileSync(path.join(first.dir, 'manifest.json')),
    firstBytes,
    'earlier manifest must be unchanged',
  );
  assert.equal(readLatest(path.join(repo, '.expunge', 'checkpoints')), second.id);
  assert.equal(second.manifest.patches.staged.bytes, 0);
  assert.equal(second.manifest.patches.unstaged.bytes, 0);
  // Pack files are read-only to signal immutability.
  assert.equal(fs.statSync(path.join(second.dir, 'manifest.json')).mode & 0o222, 0);
});

test('worktree edited during capture: retried when it settles, incomplete when it never does', () => {
  const repo = mkRepo();
  write(repo, 'a.txt', 'a1\n');
  commitAll(repo);
  const settled = createCheckpoint({
    repo,
    now: FIXED,
    attempts: 3,
    hooks: {
      afterCollect: ({ attempt }) => {
        if (attempt === 1) write(repo, 'a.txt', 'edited during first attempt\n');
      },
    },
  });
  assert.equal(settled.manifest.stability.attempts, 2);
  assert.equal(settled.manifest.stability.stable, true);
  assert.equal(settled.manifest.complete, true);
  assert.equal(settled.manifest.files['a.txt'], hashPath(path.join(repo, 'a.txt')));

  let n = 0;
  const churn = createCheckpoint({
    repo,
    now: new Date('2026-10-11T10:30:00.000Z'),
    attempts: 2,
    hooks: { afterCollect: () => write(repo, 'a.txt', `churn ${(n += 1)}\n`) },
  });
  assert.equal(churn.manifest.stability.stable, false);
  assert.equal(churn.manifest.complete, false);
  assert.ok(churn.manifest.incompleteReasons.some((x) => x.startsWith('worktree-changed-during-capture:')));
  assert.equal(churn.latestUpdated, false);
  assert.equal(
    readLatest(path.join(repo, '.expunge', 'checkpoints')),
    settled.id,
    'LATEST stays on the last complete checkpoint',
  );
});

test('checkpoint CLI: exit 0 with a complete snapshot, 3 when incomplete, summary prints paths only', () => {
  const repo = mkRepo();
  write(repo, 'a.txt', 'a1\n');
  commitAll(repo);
  const ok = runNode('checkpoint.mjs', ['--repo', repo, '--no-briefing', '--notes', 'cli']);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /complete: true/);
  assert.match(ok.stdout, /LATEST: updated to /);

  write(repo, 'docs/leak.md', ['AK', 'IAABCDEFGHIJKLMNOP'].join('') + '\n');
  const bad = runNode('checkpoint.mjs', ['--repo', repo, '--no-briefing']);
  assert.equal(bad.status, 3);
  assert.match(bad.stdout, /BLOCKER secret-detected path=docs\/leak\.md rules=aws-access-key/);
  assert.ok(!bad.stdout.includes('ABCDEFGHIJKLMNOP'));
  assert.match(bad.stdout, /NOT updated/);

  const usage = runNode('checkpoint.mjs', ['--bogus']);
  assert.equal(usage.status, 2);
});
