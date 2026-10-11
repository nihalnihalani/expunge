import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCheckpoint } from '../checkpoint.mjs';
import { verifyCheckpoint } from '../verify-checkpoint.mjs';
import { cleanupTmp, commitAll, mkRepo, runNode, write } from './helpers.mjs';

after(cleanupTmp);

test('verify reports MATCH / CHANGED / MISSING per file and exits non-zero on any difference', () => {
  const repo = mkRepo();
  write(repo, 'a.txt', 'a1\n');
  write(repo, 'b.txt', 'b1\n');
  write(repo, 'gone.txt', 'g\n');
  commitAll(repo);
  fs.rmSync(path.join(repo, 'gone.txt')); // deleted at checkpoint time: expected absent
  write(repo, 'u.txt', 'untracked\n');
  const cp = createCheckpoint({ repo, now: new Date('2026-10-11T10:10:00.000Z') });

  const ok = runNode('verify-checkpoint.mjs', [cp.dir, '--repo', repo]);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /RESULT: ALL MATCH/);

  write(repo, 'a.txt', 'a changed\n');
  fs.rmSync(path.join(repo, 'b.txt'));
  write(repo, 'gone.txt', 'came back\n');
  const bad = runNode('verify-checkpoint.mjs', [cp.dir, '--repo', repo]);
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /^CHANGED a\.txt \(modified after checkpoint\)$/m);
  assert.match(bad.stdout, /^MISSING b\.txt$/m);
  assert.match(bad.stdout, /^CHANGED gone\.txt \(expected absent\)$/m);
  assert.match(bad.stdout, /RESULT: MISMATCH/);

  const json = JSON.parse(runNode('verify-checkpoint.mjs', [cp.dir, '--repo', repo, '--json']).stdout);
  assert.equal(json.ok, false);
  assert.equal(json.counts.worktree.MISSING, 1);
  assert.ok(json.worktree.some((r) => r.path === 'u.txt' && r.status === 'MATCH'));

  // --pack-only ignores the working tree and still passes.
  assert.equal(runNode('verify-checkpoint.mjs', [cp.dir, '--pack-only']).status, 0);

  // 'latest' resolves through the LATEST pointer.
  assert.equal(runNode('verify-checkpoint.mjs', ['latest', '--repo', repo, '--pack-only']).status, 0);
});

test('verify detects a tampered pack file and an unreadable manifest', () => {
  const repo = mkRepo();
  write(repo, 'a.txt', 'a1\n');
  write(repo, 'u.txt', 'untracked\n');
  commitAll(repo);
  write(repo, 'v.txt', 'wip\n');
  const cp = createCheckpoint({ repo, now: new Date('2026-10-11T10:10:00.000Z') });
  assert.equal(verifyCheckpoint(cp.dir, { repo }).ok, true);
  const copy = path.join(cp.dir, 'untracked', 'v.txt');
  fs.chmodSync(copy, 0o644);
  fs.writeFileSync(copy, 'tampered');
  const r = verifyCheckpoint(cp.dir, { repo, packOnly: true });
  assert.equal(r.ok, false);
  assert.deepEqual(
    r.pack.filter((x) => x.status !== 'MATCH'),
    [{ path: 'untracked/v.txt', status: 'CHANGED' }],
  );
  fs.rmSync(copy);
  assert.equal(
    verifyCheckpoint(cp.dir, { repo, packOnly: true }).pack.find((x) => x.path === 'untracked/v.txt').status,
    'MISSING',
  );

  const notACheckpoint = path.join(repo, 'docs');
  fs.mkdirSync(notACheckpoint, { recursive: true });
  assert.equal(runNode('verify-checkpoint.mjs', [notACheckpoint, '--repo', repo]).status, 2);
  assert.equal(runNode('verify-checkpoint.mjs', []).status, 2);
});
