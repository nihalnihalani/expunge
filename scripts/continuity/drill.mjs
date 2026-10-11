#!/usr/bin/env node
// Claude-to-Codex handoff drill (spec section 20) on disposable synthetic checkouts, driven through the real CLIs
// (checkpoint.mjs, verify-checkpoint.mjs, restore-checkpoint.mjs) as separate processes. It never touches the real
// project repository. Unlike the in-process tests under ./test, the interrupted write here is a real SIGKILL.
//
//   node scripts/continuity/drill.mjs [--keep]
//
// Exit 0 when every scenario behaved as specified, 1 otherwise. Output is one line per assertion.
import { spawn, spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const keep = process.argv.includes('--keep');
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'expunge-drill-')));
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Drill',
  GIT_AUTHOR_EMAIL: 'drill@example.invalid',
  GIT_COMMITTER_NAME: 'Drill',
  GIT_COMMITTER_EMAIL: 'drill@example.invalid',
};

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function cli(script, args) {
  const r = spawnSync(process.execPath, [path.join(HERE, script), ...args], {
    encoding: 'utf8',
    env: gitEnv,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}
function put(repo, rel, content) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
function newRepo(name) {
  const repo = path.join(root, name);
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  put(repo, '.gitignore', '.env\nnode_modules/\n.expunge/\n');
  put(repo, 'a.txt', 'a1\n');
  put(repo, 'gone.txt', 'will be deleted\n');
  put(repo, 'HANDOFF.md', '# narrative\na.txt is at v2 and the staged b.txt is final.\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  return repo;
}
function addWip(repo) {
  put(repo, 'a.txt', 'a1\na2\n'); // unstaged
  put(repo, 'b.txt', 'staged b\n');
  git(repo, 'add', 'b.txt'); // staged
  put(repo, 'c.txt', 'untracked c\n');
  fs.mkdirSync(path.join(repo, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'assets', 'bin.dat'), Buffer.from([0, 1, 2, 255, 254, 0, 7]));
  fs.rmSync(path.join(repo, 'gone.txt')); // deleted
}
function cloneOf(src, name) {
  const dst = path.join(root, name);
  git(root, 'clone', '-q', src, dst);
  return dst;
}
function latest(repo) {
  return fs.readFileSync(path.join(repo, '.expunge', 'checkpoints', 'LATEST'), 'utf8').trim();
}
function packDir(repo) {
  return path.join(repo, '.expunge', 'checkpoints', latest(repo));
}

let failures = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`FAIL  ${name}\n      ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
  }
}

try {
  // 1. Disposable synthetic checkout restore.
  const src = newRepo('src');
  addWip(src);
  let cp;
  await step(
    '1a checkpoint of a repo with staged, unstaged, untracked, binary and deleted WIP exits 0',
    () => {
      cp = cli('checkpoint.mjs', ['--repo', src]);
      assert.equal(cp.status, 0, cp.out);
      assert.match(cp.out, /complete: true/);
    },
  );
  const pack = packDir(src);
  const target = cloneOf(src, 'target-matching');
  await step('1b dry-run restore onto a matching base writes nothing', () => {
    const before = git(target, 'status', '--porcelain');
    const r = cli('restore-checkpoint.mjs', [pack, target]);
    assert.equal(r.status, 0, r.out);
    assert.equal(git(target, 'status', '--porcelain'), before);
  });
  await step(
    '1c --apply reproduces every file and the staged/unstaged split; a second apply is a no-op',
    () => {
      const r = cli('restore-checkpoint.mjs', [pack, target, '--apply']);
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /status: APPLIED/);
      assert.equal(fs.readFileSync(path.join(target, 'a.txt'), 'utf8'), 'a1\na2\n');
      assert.equal(fs.readFileSync(path.join(target, 'c.txt'), 'utf8'), 'untracked c\n');
      assert.deepEqual(
        [...fs.readFileSync(path.join(target, 'assets', 'bin.dat'))],
        [0, 1, 2, 255, 254, 0, 7],
      );
      assert.ok(!fs.existsSync(path.join(target, 'gone.txt')));
      assert.equal(git(target, 'diff', '--cached', '--name-only'), 'b.txt');
      const again = cli('restore-checkpoint.mjs', [pack, target, '--apply']);
      assert.equal(again.status, 0, again.out);
      assert.match(again.out, /ALREADY_APPLIED/);
    },
  );
  await step(
    '1d the restored tree re-hashes clean against the pack (verify exits 0, no CHANGED or MISSING)',
    () => {
      const v = cli('verify-checkpoint.mjs', [pack, '--repo', target, '--json']);
      assert.equal(v.status, 0, v.out.slice(0, 600));
      const j = JSON.parse(v.out);
      assert.equal(j.counts.worktree.CHANGED, 0);
      assert.equal(j.counts.worktree.MISSING, 0);
    },
  );

  // 2. Stale narrative against newer code.
  const stale = cloneOf(src, 'target-stale');
  put(stale, 'a.txt', 'a1\nNEWER LOCAL EDIT\n'); // newer than the checkpoint, not in the narrative
  put(stale, 'newer-only.txt', 'work done after the checkpoint\n');
  await step('2a restore onto newer local work is refused without --force-review and writes nothing', () => {
    const snapshot = fs.readFileSync(path.join(stale, 'a.txt'), 'utf8');
    const r = cli('restore-checkpoint.mjs', [pack, stale, '--apply']);
    assert.notEqual(r.status, 0, r.out);
    assert.ok([5, 6].includes(r.status), `exit ${r.status}: ${r.out.slice(0, 300)}`);
    assert.equal(fs.readFileSync(path.join(stale, 'a.txt'), 'utf8'), snapshot);
    assert.ok(!fs.existsSync(path.join(stale, 'c.txt')), 'no partial write');
  });
  await step('2b newer files are never overwritten, even with --force-review', () => {
    const r = cli('restore-checkpoint.mjs', [pack, stale, '--apply', '--force-review']);
    assert.equal(
      fs.readFileSync(path.join(stale, 'a.txt'), 'utf8'),
      'a1\nNEWER LOCAL EDIT\n',
      r.out.slice(0, 300),
    );
    assert.equal(
      fs.readFileSync(path.join(stale, 'newer-only.txt'), 'utf8'),
      'work done after the checkpoint\n',
    );
  });
  await step('2c verify against the changed source reports CHANGED and exits non-zero', () => {
    put(src, 'a.txt', 'a1\na2\nedited after the checkpoint\n');
    const v = cli('verify-checkpoint.mjs', [pack, '--repo', src]);
    assert.notEqual(v.status, 0, v.out.slice(0, 300));
    assert.match(v.out, /CHANGED/);
    put(src, 'a.txt', 'a1\na2\n');
  });

  // 3. Mismatched base.
  const moved = cloneOf(src, 'target-moved-base');
  put(moved, 'extra.txt', 'a commit the checkpoint did not see\n');
  git(moved, 'add', '-A');
  git(moved, 'commit', '-q', '-m', 'other base');
  await step('3 restore onto a different HEAD exits 4 and leaves the target byte-identical', () => {
    const before = git(moved, 'status', '--porcelain');
    const r = cli('restore-checkpoint.mjs', [pack, moved, '--apply']);
    assert.equal(r.status, 4, r.out.slice(0, 400));
    assert.equal(git(moved, 'status', '--porcelain'), before);
    assert.ok(!fs.existsSync(path.join(moved, 'c.txt')));
  });

  // 4. Interrupted write: a real SIGKILL during a checkpoint.
  await step(
    '4 SIGKILL during a checkpoint write keeps the previous checkpoint and LATEST; the next checkpoint recovers',
    async () => {
      const before = latest(src);
      const prevManifest = fs.readFileSync(path.join(packDir(src), 'manifest.json'));
      for (let i = 0; i < 400; i += 1) put(src, `bulk/f${i}.txt`, `${i}:${'x'.repeat(200_000)}\n`);
      const child = spawn(process.execPath, [path.join(HERE, 'checkpoint.mjs'), '--repo', src], {
        stdio: 'ignore',
        env: gitEnv,
      });
      const cpDir = path.join(src, '.expunge', 'checkpoints');
      const deadline = Date.now() + 60_000;
      let killed = false;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      const poll = () => {
        const tmp = fs.existsSync(cpDir) && fs.readdirSync(cpDir).some((d) => d.startsWith('.tmp-'));
        if (tmp) {
          child.kill('SIGKILL');
          killed = true;
        } else if (Date.now() < deadline && child.exitCode === null) {
          setTimeout(poll, 2);
        }
      };
      poll();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 90_000))]);
      assert.ok(killed, 'the child finished before a temp directory could be observed; enlarge the bulk set');
      assert.equal(child.signalCode, 'SIGKILL');
      assert.equal(latest(src), before, 'LATEST must still name the previous checkpoint');
      assert.deepEqual(fs.readFileSync(path.join(packDir(src), 'manifest.json')), prevManifest);
      const finals = fs.readdirSync(cpDir).filter((d) => !d.startsWith('.') && d !== 'LATEST');
      assert.deepEqual(finals, [before], 'no final directory for the killed checkpoint');
      const again = cli('checkpoint.mjs', ['--repo', src]);
      assert.equal(again.status, 0, `recovery checkpoint after the kill: ${again.out.slice(0, 400)}`);
      assert.notEqual(latest(src), before);
      const v = cli('verify-checkpoint.mjs', [packDir(src), '--repo', src, '--pack-only']);
      assert.equal(v.status, 0, v.out.slice(0, 300));
      fs.rmSync(path.join(src, 'bulk'), { recursive: true, force: true });
    },
  );

  // 5. Old-writer lock.
  const locked = cloneOf(src, 'target-locked');
  const lockFile = path.join(locked, '.expunge', 'locks', 'old-lead.lock');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  const holder = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  try {
    fs.writeFileSync(
      lockFile,
      JSON.stringify({ pid: holder.pid, agent: 'old-lead', since: '2026-10-11T09:00:00Z' }),
    );
    await step(
      '5a a live old-writer lock blocks restore with exit 7, even with --apply --force-review, and is not removed',
      () => {
        for (const args of [[], ['--apply'], ['--apply', '--force-review']]) {
          const r = cli('restore-checkpoint.mjs', [pack, locked, ...args]);
          assert.equal(r.status, 7, `${args.join(' ')}: ${r.out.slice(0, 300)}`);
          assert.match(r.out, /ACTIVE_WRITER_LOCK/);
        }
        assert.ok(fs.existsSync(lockFile));
        assert.ok(!fs.existsSync(path.join(locked, 'c.txt')));
      },
    );
  } finally {
    const gone = new Promise((resolve) => holder.once('exit', resolve));
    holder.kill('SIGKILL');
    await gone; // reaped, so the pid is really dead and not a zombie
  }
  await step(
    '5b once the holder is dead the lock is reported stale, left in place, and restore proceeds',
    () => {
      const r = cli('restore-checkpoint.mjs', [pack, locked, '--apply']);
      assert.equal(r.status, 0, r.out.slice(0, 400));
      assert.match(r.out, /not running; left in place/);
      assert.ok(fs.existsSync(lockFile));
    },
  );
} finally {
  if (keep) console.log(`kept ${root}`);
  else fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? 'DRILL OK' : `DRILL FAILED: ${failures} scenario(s)`);
process.exitCode = failures === 0 ? 0 : 1;
