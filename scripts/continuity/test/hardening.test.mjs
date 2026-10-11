// Fixes for the DA-2 review of the continuity tooling (CT1 to CT4), each with a regression test.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createCheckpoint } from '../checkpoint.mjs';
import { classifyPath, readLatest, readManifest, sha256Buffer } from '../lib.mjs';
import { planRestore } from '../restore-checkpoint.mjs';
import {
  SCRIPTS,
  cleanupTmp,
  commitAll,
  hashTree,
  mkRepo,
  mkTmp,
  runNode,
  sh,
  treeContains,
  write,
} from './helpers.mjs';

after(cleanupTmp);

const base = (repo) => path.join(repo, '.expunge', 'checkpoints');

test('CT1: a snapshot is complete only if no non-ignored file was dropped, and every dropped path is listed with its reason', () => {
  const repo = mkRepo();
  write(repo, 'a.txt', 'a\n');
  commitAll(repo);
  // Gitignored paths (.env, node_modules/, .expunge/) are not "dropped files"; everything below is not ignored.
  write(repo, '.env', 'IGNORED=never-reported-1234\n');
  write(repo, 'node_modules/dep/index.js', 'x\n');
  const clean = createCheckpoint({ repo, now: new Date('2026-10-11T10:10:00.000Z') });
  assert.equal(clean.manifest.complete, true);
  assert.deepEqual(clean.manifest.excluded, []);

  write(repo, 'data.sqlite', 'not a real db\n');
  write(repo, '.env.local', 'OTHER=whatever-long-value-1234\n');
  write(repo, 'vendor/.cache/z.js', 'z\n');
  write(repo, 'vendor/.cache/y.js', 'y\n');
  write(repo, 'keys/server.pem', 'not a key\n');
  const dropped = createCheckpoint({ repo, now: new Date('2026-10-11T10:11:00.000Z') });
  const m = dropped.manifest;
  assert.equal(m.complete, false);
  assert.equal(dropped.latestUpdated, false);
  assert.equal(readLatest(path.join(repo, '.expunge', 'checkpoints')), clean.id);
  const byPath = Object.fromEntries(m.excluded.map((e) => [e.path, e]));
  assert.equal(byPath['data.sqlite'].reason, 'database-file');
  assert.equal(byPath['.env.local'].reason, 'env-file');
  assert.equal(byPath['keys/server.pem'].reason, 'credential-file');
  assert.equal(byPath['vendor/.cache/'].reason, 'excluded-dir:.cache');
  assert.equal(byPath['vendor/.cache/'].count, 2);
  assert.deepEqual(byPath['vendor/.cache/'].paths, ['vendor/.cache/y.js', 'vendor/.cache/z.js']);
  for (const e of m.excluded) assert.match(e.recovery, /\.gitignore/);
  for (const p of ['data.sqlite', '.env.local', 'keys/server.pem', 'vendor/.cache/']) {
    assert.ok(
      m.incompleteReasons.some((r) => r.startsWith('dropped:') && r.endsWith(`:${p}`)),
      p,
    );
  }
  assert.equal(m.files['data.sqlite'], undefined);

  // Making them ignored is the recovery: the next snapshot is complete again.
  write(repo, '.gitignore', '.env\nnode_modules/\n.expunge/\ndata.sqlite\n.env.local\nvendor/\nkeys/\n');
  const recovered = createCheckpoint({ repo, now: new Date('2026-10-11T10:12:00.000Z') });
  assert.equal(recovered.manifest.complete, true);
  assert.equal(recovered.latestUpdated, true);
});

test('CT1: conventional root files are exported; an unrecognised root file is a blocker, not a silent drop', () => {
  const repo = mkRepo();
  write(repo, 'a.txt', 'a\n');
  commitAll(repo);
  write(repo, 'Dockerfile', 'FROM node:24\n');
  write(repo, 'LICENSE', 'MIT\n');
  write(repo, 'Makefile', 'all:\n');
  write(repo, '.dockerignore', 'node_modules\n');
  const ok = createCheckpoint({ repo, now: new Date('2026-10-11T10:10:00.000Z') });
  assert.equal(ok.manifest.complete, true);
  assert.deepEqual(
    ok.manifest.untracked.map((e) => e.path),
    ['.dockerignore', 'Dockerfile', 'LICENSE', 'Makefile'],
  );

  write(repo, 'mystery.bin', 'unknown root artifact\n');
  const bad = createCheckpoint({ repo, now: new Date('2026-10-11T10:11:00.000Z') });
  assert.equal(bad.manifest.complete, false);
  assert.equal(bad.latestUpdated, false);
  assert.equal(readLatest(base(repo)), ok.id);
  const blocker = bad.manifest.excluded.find((e) => e.path === 'mystery.bin');
  assert.equal(blocker.kind, 'blocker');
  assert.equal(blocker.reason, 'unapproved-root-file');
  assert.match(blocker.recovery, /\.gitignore/);
  assert.ok(bad.manifest.incompleteReasons.includes('unapproved-root-file:mystery.bin'));
  assert.equal(classifyPath('mystery.bin').approved, false);
  assert.equal(classifyPath('random-binary.bin').unapprovedRootFile, true);
});

test('CT2: the checkpoint lock never looks ownerless and a live or fresh-unreadable lock is never broken', () => {
  const repo = mkRepo();
  write(repo, 'a.txt', 'a\n');
  commitAll(repo);
  fs.mkdirSync(base(repo), { recursive: true });
  const lock = path.join(base(repo), '.checkpoint.lock');

  // The window the review described: lock directory present, pid not (yet) written. A fresh one must be respected.
  fs.mkdirSync(lock);
  assert.throws(() => createCheckpoint({ repo }), /unreadable owner exists and is recent/);
  assert.ok(fs.existsSync(lock), 'a fresh ownerless lock is not removed');

  // The same lock, but old: provably abandoned, claimed by rename and replaced.
  const old = new Date(Date.now() - 10 * 60 * 1000);
  fs.utimesSync(lock, old, old);
  const r = createCheckpoint({ repo, now: new Date('2026-10-11T10:10:00.000Z') });
  assert.equal(r.manifest.complete, true);
  assert.ok(!fs.existsSync(lock), 'released after the run');
  assert.deepEqual(
    fs.readdirSync(base(repo)).filter((n) => n.startsWith('.checkpoint.lock')),
    [],
    'no lock leftovers',
  );

  // Dead pid: stale, replaced. Live pid: refused, left alone.
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), '2147483646\n');
  assert.equal(createCheckpoint({ repo, now: new Date('2026-10-11T10:20:00.000Z') }).manifest.complete, true);
  fs.mkdirSync(lock);
  fs.writeFileSync(path.join(lock, 'pid'), `${process.pid}\n`);
  assert.throws(() => createCheckpoint({ repo }), /another checkpoint is in progress/);
  assert.ok(fs.existsSync(lock));
});

test('CT2: concurrent checkpoint processes serialise; nobody breaks a live lock and every pack is intact', async () => {
  const repo = mkRepo();
  write(repo, 'a.txt', 'a\n');
  for (let i = 0; i < 40; i += 1) write(repo, `docs/f${i}.md`, `file ${i}\n`);
  commitAll(repo);
  const children = Array.from({ length: 6 }, () => {
    const child = spawn(
      process.execPath,
      [path.join(SCRIPTS, 'checkpoint.mjs'), '--repo', repo, '--no-briefing'],
      {
        env: process.env,
      },
    );
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    return once(child, 'close').then(([code]) => ({ code, out }));
  });
  const results = await Promise.all(children);
  const ok = results.filter((r) => r.code === 0);
  const refused = results.filter((r) => r.code === 1);
  assert.equal(ok.length + refused.length, results.length, JSON.stringify(results.map((r) => r.code)));
  assert.ok(ok.length >= 1);
  // A contender either meets a live pid or catches the lock between mkdir and the pid write; both must refuse.
  for (const r of refused)
    assert.match(r.out, /another checkpoint is in progress|unreadable owner exists and is recent/);
  const dirs = fs.readdirSync(base(repo)).filter((n) => /^\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(n));
  assert.equal(dirs.length, ok.length, 'one intact checkpoint directory per successful run');
  for (const d of dirs) assert.equal(readManifest(path.join(base(repo), d)).complete, true);
  assert.ok(dirs.includes(readLatest(base(repo))));
  assert.equal(
    fs.readdirSync(base(repo)).filter((n) => n.startsWith('.tmp-') || n.startsWith('.checkpoint.lock'))
      .length,
    0,
  );
});

test('CT3: pack-relative manifest fields are pinned to the pack layout', () => {
  const repo = mkRepo();
  write(repo, 'a.txt', 'a\n');
  commitAll(repo);
  write(repo, 'u.txt', 'u\n');
  write(repo, 'HANDOFF.md', '# briefing\n');
  const r = createCheckpoint({ repo, now: new Date('2026-10-11T10:10:00.000Z') });
  const mutate = (fn) => {
    const copy = mkTmp('expunge-ct3-');
    fs.cpSync(r.dir, copy, { recursive: true });
    const file = path.join(copy, 'manifest.json');
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    fn(m);
    fs.chmodSync(file, 0o644);
    fs.writeFileSync(file, JSON.stringify(m));
    return copy;
  };
  const cases = {
    'untracked copy escapes the pack': (m) => (m.untracked[0].copy = '../../../etc/hosts'),
    'untracked copy points at another pack file': (m) => (m.untracked[0].copy = 'staged.patch'),
    'patch file escapes the pack': (m) => (m.patches.staged.file = '../manifest.json'),
    'briefing copy escapes the pack': (m) => (m.briefing.copy = '../../x'),
    'briefing copy outside briefing/': (m) => (m.briefing.copy = 'untracked/u.txt'),
    'invalid untracked mode': (m) => (m.untracked[0].mode = '120000'),
    'non-hex file hash': (m) => (m.files['a.txt'] = 'nope'),
  };
  for (const [name, fn] of Object.entries(cases)) {
    const dir = mutate(fn);
    assert.throws(() => readManifest(dir), /manifest|unsafe|escapes/, name);
    assert.equal(planRestore(dir, mkTmp('expunge-ct3-target-')).reason, 'INVALID_MANIFEST', name);
  }
});

test('CT3: restore refuses to write through a symlinked directory in the target', () => {
  const src = mkRepo();
  write(src, 'a.txt', 'a\n');
  commitAll(src);
  write(src, 'docs/guide.md', 'guide\n');
  const cp = createCheckpoint({ repo: src, now: new Date('2026-10-11T10:10:00.000Z') });

  const target = path.join(mkTmp('expunge-ct3-sym-'), 'checkout');
  sh(path.dirname(target), 'clone', '-q', '--no-hardlinks', src, target);
  const outside = mkTmp('expunge-ct3-outside-');
  fs.symlinkSync(outside, path.join(target, 'docs')); // docs -> a directory outside the repository
  const before = hashTree(outside);

  const plan = planRestore(cp.dir, fs.realpathSync(target));
  assert.equal(plan.status, 'REFUSED');
  assert.equal(plan.reason, 'SYMLINKED_PATH');
  assert.match(plan.conflicts[0].reason, /passes through a symlink/);
  const cli = runNode('restore-checkpoint.mjs', [cp.dir, fs.realpathSync(target), '--apply']);
  assert.equal(cli.status, 5);
  assert.deepEqual(hashTree(outside), before, 'nothing was written outside the repository');
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('CT4: sealed material is withheld by name, by registered path and by registered content hash; scan limits are stated', () => {
  const repo = mkRepo();
  write(repo, 'a.txt', 'a\n');
  commitAll(repo);

  const dump = JSON.stringify({ splits: ['alpha', 'beta'], note: 'pretend sealed split plan' });
  write(
    repo,
    'docs/continuity/SEALED-PATHS.json',
    JSON.stringify({
      paths: ['packages/fixtures/sealed-out/', 'exact/only.json'],
      sha256: [sha256Buffer(Buffer.from(dump))],
    }),
  );
  write(repo, 'docs/sealed-split-plan.json', '{"x":1}\n'); // by name
  write(repo, 'docs/expected-poststate.json', '{"x":2}\n'); // by name
  write(repo, 'docs/answer_key.csv', 'a,b\n'); // by name
  write(repo, 'packages/fixtures/sealed-out/plan.ts', 'export const x = 1;\n'); // by registered path
  write(repo, 'exact/only.json', '{"x":3}\n'); // by exact registered path
  write(repo, 'notes/innocent-name.txt', dump); // by content hash, under a name no rule would catch
  write(repo, 'notes/fine.txt', 'ordinary notes\n');
  const r = createCheckpoint({ repo, now: new Date('2026-10-11T10:10:00.000Z') });
  const m = r.manifest;
  assert.equal(m.complete, false, 'withheld sealed files are dropped files, so the snapshot says so');
  assert.ok(m.incompleteReasons.includes('dropped:sealed-registry-hash:notes/innocent-name.txt'));
  const reasons = Object.fromEntries(m.excluded.map((e) => [e.path, e.reason]));
  assert.equal(reasons['docs/sealed-split-plan.json'], 'sealed-material-name');
  assert.equal(reasons['docs/expected-poststate.json'], 'sealed-material-name');
  assert.equal(reasons['docs/answer_key.csv'], 'sealed-material-name');
  assert.equal(reasons['packages/fixtures/sealed-out/plan.ts'], 'sealed-registry-path');
  assert.equal(reasons['exact/only.json'], 'sealed-registry-path');
  assert.equal(reasons['notes/innocent-name.txt'], 'sealed-registry-hash');
  const exported = m.untracked.map((e) => e.path);
  assert.ok(exported.includes('notes/fine.txt'));
  assert.ok(exported.includes('docs/continuity/SEALED-PATHS.json'), 'the registry itself is kept');
  assert.equal(
    treeContains(r.dir, 'pretend sealed split plan'),
    false,
    'registered content never reaches the pack',
  );
  assert.deepEqual(m.secretScan.sealedRegistry, {
    sources: ['docs/continuity/SEALED-PATHS.json'],
    paths: 2,
    hashes: 1,
  });
  assert.ok(m.secretScan.limitations.some((l) => /clean scan does not prove/.test(l)));

  // A tracked file edited into registered content has its patch section withheld too.
  write(repo, 'a.txt', dump);
  const edited = createCheckpoint({ repo, now: new Date('2026-10-11T10:11:00.000Z') });
  assert.equal(edited.manifest.excluded.find((e) => e.path === 'a.txt').reason, 'sealed-registry-hash');
  assert.deepEqual(edited.manifest.changes.unstaged, []);
  assert.equal(treeContains(edited.dir, 'pretend sealed split plan'), false);
  assert.equal(edited.manifest.files['a.txt'], undefined);
});

test('CT4: top-level "expungePrivate": true content marker and the .private.json suffix withhold fixture output under any name', () => {
  const repo = mkRepo();
  write(repo, 'a.txt', 'a\n');
  commitAll(repo);
  const secretish = 'sealed-answers-0123456789';
  write(repo, 'out/split-001.json', JSON.stringify({ expungePrivate: true, answers: [secretish] })); // marker, innocent name
  write(repo, 'out/rows.jsonl', `{"n":1}\n${JSON.stringify({ expungePrivate: true, row: secretish })}\n`); // marker on one line
  write(repo, 'out/world-7.private.json', JSON.stringify({ answers: [secretish] })); // suffix convention, no marker
  write(repo, 'out/public-split.json', JSON.stringify({ expungePrivate: false, commitment: 'abc' }));
  write(repo, 'out/nested.json', JSON.stringify({ meta: { expungePrivate: true }, ok: 1 })); // not top level
  write(repo, 'docs/format.md', 'Sealed outputs carry "expungePrivate": true at the top level.\n'); // mention only
  write(repo, 'packages/fixtures/note.ts', 'export const MARKER = \'{"expungePrivate": true}\';\n'); // source mention only
  const r = createCheckpoint({ repo, now: new Date('2026-10-11T10:10:00.000Z') });
  const m = r.manifest;
  const reasons = Object.fromEntries(m.excluded.map((e) => [e.path, e.reason]));
  assert.equal(reasons['out/split-001.json'], 'private-marker');
  assert.equal(reasons['out/rows.jsonl'], 'private-marker');
  assert.equal(reasons['out/world-7.private.json'], 'private-suffix');
  assert.equal(reasons['out/public-split.json'], undefined);
  assert.equal(reasons['out/nested.json'], undefined, 'only a top-level marker counts');
  assert.equal(reasons['docs/format.md'], undefined);
  assert.equal(reasons['packages/fixtures/note.ts'], undefined);
  assert.equal(m.complete, false);
  assert.equal(treeContains(r.dir, secretish), false, 'private fixture output never reaches the pack');
  const exported = m.untracked.map((e) => e.path);
  for (const p of [
    'out/public-split.json',
    'out/nested.json',
    'docs/format.md',
    'packages/fixtures/note.ts',
  ]) {
    assert.ok(exported.includes(p), p);
  }

  // Editing a tracked JSON file into a marked document withholds its patch section as well.
  write(repo, 'cfg.json', '{"a":1}\n');
  commitAll(repo, 'add cfg');
  write(repo, 'cfg.json', JSON.stringify({ expungePrivate: true, answers: [secretish] }));
  const edited = createCheckpoint({ repo, now: new Date('2026-10-11T10:11:00.000Z') });
  assert.equal(edited.manifest.excluded.find((e) => e.path === 'cfg.json').reason, 'private-marker');
  assert.deepEqual(edited.manifest.changes.unstaged, []);
  assert.equal(treeContains(edited.dir, secretish), false);
});
