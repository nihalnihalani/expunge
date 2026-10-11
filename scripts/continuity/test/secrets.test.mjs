import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCheckpoint } from '../checkpoint.mjs';
import { buildRedactionSet, classifyPath, parseEnv, readLatest, safeRelPath, scanBuffer } from '../lib.mjs';
import { Buffer } from 'node:buffer';
import { cleanupTmp, commitAll, mkRepo, secrets, sh, treeContains, write } from './helpers.mjs';

after(cleanupTmp);

const FIXED = new Date('2026-10-11T10:10:00.000Z');
const baseDir = (repo) => path.join(repo, '.expunge', 'checkpoints');

test('secret in an untracked file: snapshot incomplete, path listed, content never written, LATEST preserved', () => {
  const repo = mkRepo();
  write(repo, 'a.txt', 'a1\n');
  commitAll(repo);
  const good = createCheckpoint({ repo, now: FIXED });
  assert.equal(good.manifest.complete, true);

  write(repo, 'docs/leak.md', `connect with ${secrets.mongo()} please\n`);
  write(repo, 'scripts/ok.mjs', 'export const ok = true;\n');
  const bad = createCheckpoint({ repo, now: new Date('2026-10-11T10:11:00.000Z') });
  assert.equal(bad.manifest.complete, false);
  assert.equal(bad.latestUpdated, false);
  assert.equal(readLatest(baseDir(repo)), good.id);
  const blocker = bad.manifest.excluded.find((e) => e.path === 'docs/leak.md');
  assert.equal(blocker.kind, 'blocker');
  assert.equal(blocker.reason, 'secret-detected');
  assert.deepEqual(blocker.rules, ['mongodb-uri']);
  assert.ok(bad.manifest.incompleteReasons.includes('secret-detected:docs/leak.md'));
  assert.deepEqual(bad.manifest.secretScan.findings, [{ path: 'docs/leak.md', rules: ['mongodb-uri'] }]);
  assert.ok(
    bad.manifest.untracked.some((e) => e.path === 'scripts/ok.mjs'),
    'clean files are still exported',
  );
  assert.ok(!bad.manifest.untracked.some((e) => e.path === 'docs/leak.md'));
  assert.equal(bad.manifest.files['docs/leak.md'], undefined);
  assert.equal(
    treeContains(bad.dir, 'R4nd0mP4ssw0rd9x'),
    false,
    'secret bytes must not be anywhere in the checkpoint',
  );
});

test('secrets in tracked changes (worktree and staged) drop the patch section and mark incomplete', () => {
  const repo = mkRepo();
  write(repo, 'a.txt', 'a1\n');
  write(repo, 'b.txt', 'b1\n');
  write(repo, 'c.txt', 'c1\n');
  commitAll(repo);
  write(repo, 'a.txt', `a1\nkey=${secrets.aws()}\n`); // unstaged secret
  write(repo, 'b.txt', `b1\n${secrets.privateKey()}\n`);
  sh(repo, 'add', 'b.txt');
  write(repo, 'b.txt', 'b1\n'); // staged secret, worktree clean again
  write(repo, 'c.txt', 'c1\nclean change\n'); // clean unstaged change stays in the patch
  const r = createCheckpoint({ repo, now: FIXED });
  assert.equal(r.manifest.complete, false);
  const paths = r.manifest.excluded
    .filter((e) => e.reason === 'secret-detected')
    .map((e) => e.path)
    .sort();
  assert.deepEqual(paths, ['a.txt', 'b.txt']);
  assert.equal(treeContains(r.dir, 'ABCDEFGHIJKLMNOP'), false);
  assert.equal(treeContains(r.dir, 'BEGIN RSA'), false);
  assert.deepEqual(
    r.manifest.changes.unstaged.map((c) => c.path),
    ['c.txt'],
  );
  assert.deepEqual(r.manifest.changes.staged, []);
  assert.equal(r.manifest.files['a.txt'], undefined);
});

test('values from a present .env are redacted by value; only the key NAME is reported', () => {
  const repo = mkRepo();
  write(repo, 'a.txt', 'a1\n');
  write(repo, '.env.example', 'INTERNAL_TOKEN=\nPUBLIC_NAME=expunge-demo-name\n');
  commitAll(repo);
  write(repo, '.env', `INTERNAL_TOKEN=${secrets.envValue()}\nPUBLIC_NAME=expunge-demo-name\nSHORT=abc\n`);
  write(repo, 'docs/notes.md', `we pasted ${secrets.envValue()} here by mistake\n`);
  write(repo, 'docs/public.md', 'mentions expunge-demo-name which equals the committed example default\n');
  const r = createCheckpoint({ repo, now: FIXED });
  assert.equal(r.manifest.complete, false);
  const f = r.manifest.secretScan.findings;
  assert.deepEqual(f, [{ path: 'docs/notes.md', rules: ['env-value:INTERNAL_TOKEN'] }]);
  assert.ok(
    r.manifest.untracked.some((e) => e.path === 'docs/public.md'),
    'example-default values are not secrets',
  );
  assert.equal(treeContains(r.dir, secrets.envValue()), false);
  assert.deepEqual(r.manifest.secretScan.envRedaction, { sources: ['.env'], valueCount: 1 });
});

test('briefing and notes are scanned too', () => {
  const repo = mkRepo();
  write(repo, 'a.txt', 'a1\n');
  commitAll(repo);
  write(repo, 'HANDOFF.md', '# handoff\nall good\n');
  const clean = createCheckpoint({ repo, now: FIXED });
  assert.equal(clean.manifest.briefing.copy, 'briefing/HANDOFF.md');
  assert.equal(
    fs.readFileSync(path.join(clean.dir, 'briefing', 'HANDOFF.md'), 'utf8'),
    '# handoff\nall good\n',
  );
  assert.equal(clean.manifest.complete, true);

  write(repo, 'HANDOFF.md', `# handoff\n${secrets.openai()}\n`);
  const dirty = createCheckpoint({ repo, now: new Date('2026-10-11T10:12:00.000Z') });
  assert.equal(dirty.manifest.complete, false);
  assert.equal(dirty.manifest.briefing, null);
  assert.equal(treeContains(dirty.dir, 'abcDEF1234567890'), false);
  assert.equal(readLatest(baseDir(repo)), clean.id);

  assert.throws(
    () => createCheckpoint({ repo, notes: `token ${secrets.bearer()}` }),
    /--notes appears to contain a credential/,
  );
});

test('scanner rules: true positives, placeholders and look-alikes', () => {
  const hit = (text) => scanBuffer(Buffer.from(text));
  assert.deepEqual(hit(secrets.mongo()), ['mongodb-uri']);
  assert.deepEqual(hit(secrets.aws()), ['aws-access-key']);
  assert.deepEqual(hit(secrets.openai()), ['openai-style-key']);
  assert.deepEqual(hit(secrets.privateKey()), ['private-key-block']);
  assert.deepEqual(hit(`Authorization: ${secrets.bearer()}`), ['bearer-token']);
  assert.deepEqual(hit('mongodb' + '://admin:s3cretpw@db.internal:27017/x'), ['mongodb-uri']);
  // Not secrets: placeholders, docs, identifiers that merely contain the prefixes.
  assert.deepEqual(hit('use mongodb' + '+srv://<user>:<password>@cluster0.xxxxx.mongodb.net/db'), []);
  assert.deepEqual(hit('mongodb' + '://localhost:27017/?replicaSet=rs0'), []);
  // Fixture URIs on reserved or example hosts, or with a trivially short password, are not credentials.
  assert.deepEqual(hit('mongodb' + '://user:Fx9kQ2mZ7pL4@host.example/db'), []);
  assert.deepEqual(hit('mongodb' + '://user:Fx9kQ2mZ7pL4@db.invalid:27017/x'), []);
  assert.deepEqual(hit('mongodb' + '://admin:x@h/db'), []);
  assert.deepEqual(hit('mongodb' + '://user:Fx9kQ2mZ7pL4@127.0.0.1:27018/x'), []);
  assert.deepEqual(hit('mongodb' + '://user:Fx9kQ2mZ7pL4@db.internal.corp:27017/x'), ['mongodb-uri']);
  assert.deepEqual(
    hit(
      'SRV resolution of `mongodb' +
        '+srv://` failed and the seed-list `mongodb' +
        '://` URI is the fallback',
    ),
    [],
  );
  assert.deepEqual(hit('host is mongodb' + '+srv://cluster0.abc12.mongodb.net'), ['mongodb-uri']);
  assert.deepEqual(hit('task-runner disk-usage risk-register ask-me-anything'), []);
  assert.deepEqual(hit('Authorization: Bearer ${token} and Bearer <token>'), []);
  assert.deepEqual(hit('Bearer authentication-credentials-required'), []);
  assert.deepEqual(hit('export const sk = "sk-learn"'), []);
});

test('path policy and safe paths', () => {
  const sens = (p) => classifyPath(p).sensitive;
  assert.equal(sens('.env'), 'env-file');
  assert.equal(sens('apps/operator/.env'), 'env-file');
  assert.equal(sens('.env.production'), 'env-file');
  assert.equal(sens('infra/opendots/.env.candidates.local'), 'env-file');
  assert.equal(sens('.env.example'), null);
  assert.equal(
    sens('apps/operator/.env.hosted.example'),
    null,
    'committed example env files are not secrets',
  );
  assert.equal(sens('infra/opendots/.env.candidates.example'), null);
  assert.equal(classifyPath('.env.staging.example').approved, true);
  assert.equal(sens('.env.staging'), 'env-file');
  assert.equal(sens('.firecrawl/page.md'), 'excluded-dir:.firecrawl');
  assert.equal(sens('.expunge/checkpoints/LATEST'), 'excluded-dir:.expunge');
  assert.equal(sens('packages/x/node_modules/y/index.js'), 'excluded-dir:node_modules');
  assert.equal(sens('apps/operator/state.sqlite'), 'database-file');
  assert.equal(sens('docs/private-manifest.json'), 'private-manifest-or-seed');
  assert.equal(sens('packages/grader/heldout-seeds.json'), 'private-manifest-or-seed');
  assert.equal(sens('docs/raw-telemetry/x.json'), 'excluded-dir:raw-telemetry');
  assert.equal(
    sens('packages/mongo/src/private.ts'),
    null,
    'source files that merely say private are not excluded',
  );
  assert.equal(sens('packages/privacy/src/index.ts'), null);
  assert.equal(sens('.claude/settings.local.json'), 'local-settings');
  assert.equal(classifyPath('.claude/settings.json').approved, true);
  assert.equal(classifyPath('RESEARCH-REPORT.md').approved, true);
  assert.equal(classifyPath('EXPUNGE-CLAUDE-GOAL-SPEC.txt').approved, true);
  assert.equal(classifyPath('.prettierrc.json').approved, true);
  assert.equal(classifyPath('.env.example').approved, true);
  assert.equal(classifyPath('tmp/scratch.txt').approved, true);
  assert.equal(classifyPath('tmp/scratch.txt').unlistedRoot, 'tmp');
  assert.equal(classifyPath('docs/a.md').unlistedRoot, undefined);
  assert.equal(classifyPath('random-binary.bin').approved, false);
  assert.throws(() => safeRelPath('../x'), /unsafe/);
  assert.throws(() => safeRelPath('/etc/passwd'), /unsafe/);
  assert.throws(() => safeRelPath('a/.git/config'), /unsafe/);
  assert.throws(() => safeRelPath('a//b'), /unsafe/);
  assert.equal(safeRelPath('a/b.txt'), 'a/b.txt');
});

test('env parsing keeps quotes and comments out of values', () => {
  const parsed = parseEnv('A=1\nexport B="two words here"\nC=val # comment\n# D=skip\nE=\'q\'\n');
  assert.deepEqual(parsed, [
    { key: 'A', value: '1' },
    { key: 'B', value: 'two words here' },
    { key: 'C', value: 'val' },
    { key: 'E', value: 'q' },
  ]);
  const repo = mkRepo();
  assert.deepEqual(buildRedactionSet(repo), { entries: [], sources: [] });
});
