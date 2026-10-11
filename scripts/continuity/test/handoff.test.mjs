import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCheckpoint } from '../checkpoint.mjs';
import { placeBriefing } from '../restore-checkpoint.mjs';
import { cleanupTmp, commitAll, hashTree, mkRepo, mkTmp, runNode, sh, write } from './helpers.mjs';

after(cleanupTmp);

const BRIEFING = '# Handoff\n\nResume at packet PKT-17. The pack travels with the repository.\n';
const IGNORE = '.env\nnode_modules/\n.expunge/\nHANDOFF.md\n';

/** A source repo whose gitignored HANDOFF.md becomes the checkpoint briefing, as in the real project. */
function source({ briefing = BRIEFING } = {}) {
  const repo = mkRepo({ ignore: IGNORE });
  write(repo, 'a.txt', 'a1\n');
  commitAll(repo);
  write(repo, 'a.txt', 'a1\na2\n');
  write(repo, 'new.txt', 'n\n');
  if (briefing !== null) write(repo, 'HANDOFF.md', briefing);
  return repo;
}

const cloneOf = (repo) => {
  const dir = path.join(mkTmp('expunge-target-'), 'checkout');
  sh(path.dirname(dir), 'clone', '-q', '--no-hardlinks', repo, dir);
  return fs.realpathSync(dir);
};

const checkpointOf = (repo) => createCheckpoint({ repo, now: new Date('2026-10-11T12:30:00.000Z') });
const restore = (cp, target, ...flags) => runNode('restore-checkpoint.mjs', [cp.dir, target, ...flags]);

test('after --apply the briefing is copied to the target root, a resume line names it and the pack, a rerun is a no-op', () => {
  const src = source();
  const cp = checkpointOf(src);
  assert.equal(cp.manifest.complete, true);
  assert.equal(cp.manifest.briefing.copy, 'briefing/HANDOFF.md');
  const target = cloneOf(src);

  // Dry-run writes nothing and says what --apply will do.
  const dry = restore(cp, target);
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(fs.existsSync(path.join(target, 'HANDOFF.md')), false);
  assert.match(dry.stdout, /--apply will also copy the briefing to HANDOFF\.md/);

  const applied = restore(cp, target, '--apply');
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /status: APPLIED/);
  assert.equal(fs.readFileSync(path.join(target, 'HANDOFF.md'), 'utf8'), BRIEFING);
  assert.match(applied.stdout, new RegExp(`briefing: copied to ${path.join(target, 'HANDOFF.md')}`));
  const resume = applied.stdout.split('\n').find((l) => l.startsWith('resume: '));
  assert.ok(resume, applied.stdout);
  assert.ok(resume.includes(path.join(target, 'HANDOFF.md')), 'resume line names the file to read');
  assert.ok(resume.includes(cp.dir), 'resume line names the pack path');
  assert.equal(
    sh(target, 'status', '--porcelain').includes('HANDOFF'),
    false,
    'gitignored: not in git status',
  );

  // Rerun: ALREADY_APPLIED, the identical briefing is left alone.
  const mtime = fs.statSync(path.join(target, 'HANDOFF.md')).mtimeMs;
  const again = restore(cp, target, '--apply', '--json');
  assert.equal(again.status, 0, again.stderr);
  const json = JSON.parse(again.stdout);
  assert.equal(json.status, 'ALREADY_APPLIED');
  assert.equal(json.briefing.status, 'already-present');
  assert.equal(json.briefing.packFile, path.join(cp.dir, 'briefing', 'HANDOFF.md'));
  assert.ok(json.resume.includes(cp.dir));
  assert.equal(fs.statSync(path.join(target, 'HANDOFF.md')).mtimeMs, mtime);
});

test('a differing HANDOFF.md is never overwritten: the copy lands as HANDOFF.from-<checkpointId>.md', () => {
  const src = source();
  const cp = checkpointOf(src);
  const target = cloneOf(src);
  const mine = '# My own notes\n\nDo not lose these.\n';
  write(target, 'HANDOFF.md', mine);

  const applied = restore(cp, target, '--apply', '--json');
  assert.equal(applied.status, 0, applied.stderr);
  const json = JSON.parse(applied.stdout);
  assert.equal(json.status, 'APPLIED');
  assert.equal(json.briefing.status, 'written-alongside');
  const alongside = path.join(target, `HANDOFF.from-${cp.manifest.checkpointId}.md`);
  assert.equal(json.briefing.file, alongside);
  assert.equal(
    fs.readFileSync(path.join(target, 'HANDOFF.md'), 'utf8'),
    mine,
    'the existing file is untouched',
  );
  assert.equal(fs.readFileSync(alongside, 'utf8'), BRIEFING);
  assert.ok(json.resume.includes(alongside));

  // Rerun: the alongside copy is already there and identical.
  const again = JSON.parse(restore(cp, target, '--apply', '--json').stdout);
  assert.equal(again.briefing.status, 'already-present-alongside');
  assert.equal(fs.readFileSync(path.join(target, 'HANDOFF.md'), 'utf8'), mine);
});

test('when HANDOFF.md and the alongside name both hold different content nothing is written and the resume line names the pack copy', () => {
  const src = source();
  const cp = checkpointOf(src);
  const target = cloneOf(src);
  const alongside = path.join(target, `HANDOFF.from-${cp.manifest.checkpointId}.md`);
  write(target, 'HANDOFF.md', 'one\n');
  fs.writeFileSync(alongside, 'two\n');

  const applied = JSON.parse(restore(cp, target, '--apply', '--json').stdout);
  assert.equal(applied.status, 'APPLIED');
  assert.equal(applied.briefing.status, 'not-written');
  assert.equal(applied.briefing.file, null);
  assert.equal(fs.readFileSync(path.join(target, 'HANDOFF.md'), 'utf8'), 'one\n');
  assert.equal(fs.readFileSync(alongside, 'utf8'), 'two\n');
  assert.ok(applied.resume.includes(path.join(cp.dir, 'briefing', 'HANDOFF.md')));
});

test('a symlinked HANDOFF.md is not followed: its target is untouched and the copy goes alongside', () => {
  const src = source();
  const cp = checkpointOf(src);
  const target = cloneOf(src);
  const outside = path.join(mkTmp('expunge-outside-'), 'victim.txt');
  fs.writeFileSync(outside, 'keep me\n');
  fs.symlinkSync(outside, path.join(target, 'HANDOFF.md'));

  const applied = JSON.parse(restore(cp, target, '--apply', '--json').stdout);
  assert.equal(applied.briefing.status, 'written-alongside');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'keep me\n');
  assert.ok(fs.lstatSync(path.join(target, 'HANDOFF.md')).isSymbolicLink());
});

test('a checkpoint without a briefing reports none and still names the pack; a refused restore writes no briefing', () => {
  const noBriefing = source({ briefing: null });
  const cp = checkpointOf(noBriefing);
  assert.equal(cp.manifest.briefing, null);
  const target = cloneOf(noBriefing);
  const applied = JSON.parse(restore(cp, target, '--apply', '--json').stdout);
  assert.equal(applied.status, 'APPLIED');
  assert.equal(applied.briefing.status, 'none');
  assert.ok(applied.resume.includes(cp.dir));
  assert.equal(fs.existsSync(path.join(target, 'HANDOFF.md')), false);

  // Base mismatch: refused with exit 4, nothing written (no briefing either).
  const src = source();
  const cp2 = checkpointOf(src);
  const other = cloneOf(src);
  write(other, 'zzz.txt', 'x\n');
  commitAll(other, 'moved');
  const before = hashTree(other);
  const refused = restore(cp2, other, '--apply');
  assert.equal(refused.status, 4);
  assert.deepEqual(hashTree(other), before);
  assert.equal(fs.existsSync(path.join(other, 'HANDOFF.md')), false);
});

test('placeBriefing refuses a pack copy whose hash no longer matches the manifest', () => {
  const src = source();
  const cp = checkpointOf(src);
  const target = cloneOf(src);
  fs.chmodSync(path.join(cp.dir, 'briefing', 'HANDOFF.md'), 0o644);
  fs.writeFileSync(path.join(cp.dir, 'briefing', 'HANDOFF.md'), 'tampered\n');
  assert.throws(() => placeBriefing({ manifest: cp.manifest, dir: cp.dir, target }), /no longer matches/);
  assert.equal(fs.existsSync(path.join(target, 'HANDOFF.md')), false);
});

test('verify reports when HEAD moved since the checkpoint, and explains a missing LATEST pointer', () => {
  const src = source();
  const cp = checkpointOf(src);

  const same = JSON.parse(runNode('verify-checkpoint.mjs', [cp.dir, '--repo', src, '--json']).stdout);
  assert.equal(same.headMoved, null);
  assert.equal(
    runNode('verify-checkpoint.mjs', [cp.dir, '--repo', src]).stdout.includes('HEAD moved'),
    false,
  );

  // Commit exactly the checkpointed work: content still matches, but HEAD is no longer the checkpoint base.
  sh(src, 'add', '-A');
  sh(src, 'commit', '-q', '-m', 'land the checkpointed work');
  const text = runNode('verify-checkpoint.mjs', [cp.dir, '--repo', src]);
  assert.equal(text.status, 0, text.stdout + text.stderr);
  assert.match(text.stdout, /note: HEAD moved since the checkpoint/);
  assert.match(text.stdout, /npm run checkpoint/);
  const json = JSON.parse(runNode('verify-checkpoint.mjs', [cp.dir, '--repo', src, '--json']).stdout);
  assert.equal(json.ok, true);
  assert.equal(json.headMoved.checkpointBase, cp.manifest.head);
  assert.equal(json.headMoved.current, sh(src, 'rev-parse', 'HEAD').trim());

  // A clone has no .expunge/ (gitignored): `latest` fails with an explanation that names the cause.
  const clone = cloneOf(src);
  const latest = runNode('verify-checkpoint.mjs', ['latest', '--repo', clone]);
  assert.equal(latest.status, 2);
  assert.match(latest.stderr, /no LATEST pointer/);
  assert.match(latest.stderr, /does not travel with git/);
});
