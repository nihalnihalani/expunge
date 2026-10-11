// Test helpers: throwaway synthetic git repositories. Nothing here touches the real project repository.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { sha256Buffer } from '../lib.mjs';

// Keep user/system git configuration out of the synthetic repositories.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.env.GIT_AUTHOR_NAME = 'Test';
process.env.GIT_AUTHOR_EMAIL = 'test@example.invalid';
process.env.GIT_COMMITTER_NAME = 'Test';
process.env.GIT_COMMITTER_EMAIL = 'test@example.invalid';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCRIPTS = path.resolve(HERE, '..');
const TMP_BASE = fs.realpathSync(process.env.EXPUNGE_TEST_TMP ?? os.tmpdir());
const made = [];

export function mkTmp(prefix = 'expunge-cp-') {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(TMP_BASE, prefix)));
  made.push(dir);
  return dir;
}

export function cleanupTmp() {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
}

export function sh(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** Create a synthetic repo; `unborn: true` leaves it without commits. */
export function mkRepo({ ignore = '.env\nnode_modules/\n.expunge/\n' } = {}) {
  const repo = mkTmp('expunge-repo-');
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'commit.gpgsign', 'false');
  sh(repo, 'config', 'core.autocrlf', 'false');
  if (ignore) write(repo, '.gitignore', ignore);
  return repo;
}

export function write(repo, rel, content, mode) {
  const abs = path.join(repo, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
  if (mode) fs.chmodSync(abs, mode);
  return abs;
}

export function commitAll(repo, message = 'base') {
  sh(repo, 'add', '-A');
  sh(repo, 'commit', '-q', '-m', message);
  return sh(repo, 'rev-parse', 'HEAD').trim();
}

export function runNode(script, args, opts = {}) {
  const r = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8',
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** True if any file under dir contains the needle bytes (used to prove a secret never reached disk). */
export function treeContains(dir, needle) {
  const n = Buffer.from(needle);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (treeContains(abs, needle)) return true;
    } else if (fs.readFileSync(abs).includes(n)) {
      return true;
    }
  }
  return false;
}

export function hashTree(root, skip = ['.git', '.expunge']) {
  const out = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.includes(entry.name) && dir === root) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out[path.relative(root, abs)] = sha256Buffer(fs.readFileSync(abs));
    }
  };
  walk(root);
  return out;
}

// Secrets are assembled at run time so this source file never contains a scannable credential.
export const secrets = {
  mongo: () =>
    ['mongodb', '+srv://', 'svc_ingest:R4nd0mP4ssw0rd9x', '@cluster0.abc12.mongodb.net/app'].join(''),
  aws: () => ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join(''),
  openai: () => ['s', 'k-', 'proj-', 'abcDEF1234567890abcDEF1234'].join(''),
  privateKey: () => ['-----BEGIN ', 'RSA ', 'PRIVATE KEY-----'].join(''),
  bearer: () => ['Bear', 'er ', 'abcdefghij1234567890KLMNOP'].join(''),
  envValue: () => ['Zq8rT5vK', '2mN7pL4xW9cB'].join(''),
};
