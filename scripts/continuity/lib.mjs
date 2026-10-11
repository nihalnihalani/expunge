// Shared helpers for the Expunge continuity checkpoint tooling (spec section 20).
// Node 24+, no dependencies beyond node:* and the git CLI. Nothing in this module ever
// prints file contents or credential values: findings are reported as paths and rule IDs only.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { Buffer } from 'node:buffer';

export const MANIFEST_SCHEMA = 'expunge.checkpoint.manifest/1';
export const TOOL_VERSION = '1.0.0';
export const UNBORN = 'UNBORN';
export const CHECKPOINT_ID_RE = /^\d{8}T\d{6}Z-[0-9a-f]{8}$/;
export const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_TOTAL_BYTES = 256 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------
// git
// ---------------------------------------------------------------------------------------------

/** Run git without optional index locks so a checkpoint never refreshes or rewrites the index. */
export function git(cwd, args, opts = {}) {
  const res = spawnSync('git', ['--no-optional-locks', '-c', 'core.quotepath=false', ...args], {
    cwd,
    input: opts.input,
    maxBuffer: 1024 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', ...opts.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (res.error) throw res.error;
  const out = {
    status: res.status ?? 1,
    stdout: res.stdout ?? Buffer.alloc(0),
    stderr: res.stderr ?? Buffer.alloc(0),
  };
  if (out.status !== 0 && !opts.allowFail) {
    const firstLine = out.stderr.toString('utf8').trim().split('\n')[0] ?? '';
    throw new Error(`git ${args[0]} failed with exit ${out.status}: ${firstLine}`);
  }
  return out;
}

export function gitText(cwd, args, opts = {}) {
  return git(cwd, args, opts).stdout.toString('utf8').replace(/\n+$/, '');
}

export function splitNul(buf) {
  const parts = buf.toString('utf8').split('\0');
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  return parts;
}

export function parseNameStatus(buf) {
  const tokens = splitNul(buf);
  const out = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) out.push({ status: tokens[i], path: tokens[i + 1] });
  return out;
}

export function parseLsStage(buf) {
  return splitNul(buf).map((entry) => {
    const tab = entry.indexOf('\t');
    const [mode, sha, stage] = entry.slice(0, tab).split(' ');
    return { mode, sha, stage, path: entry.slice(tab + 1) };
  });
}

export function resolveRepoRoot(dir) {
  const top = gitText(dir, ['rev-parse', '--show-toplevel']);
  return fs.realpathSync(top);
}

export function headState(repo) {
  const r = git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { allowFail: true });
  if (r.status === 0) {
    const head = r.stdout.toString('utf8').trim();
    return { head, tree: gitText(repo, ['rev-parse', 'HEAD^{tree}']) };
  }
  const sym = git(repo, ['symbolic-ref', '-q', 'HEAD'], { allowFail: true });
  if (sym.status === 0) return { head: UNBORN, tree: null };
  throw new Error('HEAD is neither a valid commit nor an unborn branch');
}

export function branchName(repo) {
  const r = git(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { allowFail: true });
  return r.status === 0 ? r.stdout.toString('utf8').trim() : 'DETACHED';
}

export const DIFF_FLAGS = [
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '--no-renames',
  '--src-prefix=a/',
  '--dst-prefix=b/',
];

// ---------------------------------------------------------------------------------------------
// hashing and durable file helpers
// ---------------------------------------------------------------------------------------------

export function sha256Buffer(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** SHA-256 of a file's bytes, streamed in chunks. Symlinks hash their link text; missing is null. */
export function hashPath(abs) {
  let st;
  try {
    st = fs.lstatSync(abs);
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return null;
    throw err;
  }
  if (st.isSymbolicLink()) return sha256Buffer(Buffer.from(`symlink:${fs.readlinkSync(abs)}`));
  if (!st.isFile()) return 'non-regular-file';
  const hash = createHash('sha256');
  const fd = fs.openSync(abs, 'r');
  try {
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      hash.update(chunk.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function writeFileDurable(file, data, mode = 0o644) {
  const fd = fs.openSync(file, 'wx', mode);
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Directory fsync is best effort on filesystems that do not support it.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function fsyncTree(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) fsyncTree(path.join(dir, entry.name));
  }
  fsyncDir(dir);
}

export function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * Look for engineering-writer locks under <repo>/.expunge/locks. Every non-hidden entry (file or directory) counts
 * as a lock. A lock is stale only when it names a pid that is provably not running; an entry with no readable pid
 * is treated as active because nothing proves its owner is gone. Locks are never removed.
 */
export function findWriterLocks(repo) {
  const dir = path.join(repo, '.expunge', 'locks');
  let names;
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return { active: [], stale: [] };
  }
  const active = [];
  const stale = [];
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const abs = path.join(dir, name);
    let text = '';
    try {
      const st = fs.lstatSync(abs);
      if (st.isDirectory()) text = fs.readFileSync(path.join(abs, 'pid'), 'utf8');
      else if (st.isFile()) text = fs.readFileSync(abs, 'utf8').slice(0, 4096);
    } catch {
      // unreadable lock: no pid, so it stays active below
    }
    let pid = null;
    let owner = null;
    try {
      const obj = JSON.parse(text);
      if (Number.isInteger(obj)) {
        pid = obj;
      } else if (obj && typeof obj === 'object') {
        pid = Number.isInteger(obj.pid) ? obj.pid : null;
        const who = obj.agent ?? obj.owner ?? obj.writer;
        owner = typeof who === 'string' ? who : null;
      }
    } catch {
      const m = /^\s*(\d+)\b/.exec(text);
      if (m) pid = Number.parseInt(m[1], 10);
    }
    const entry = { name: `.expunge/locks/${name}`, pid, owner };
    if (pid !== null && pid > 0 && !pidAlive(pid)) stale.push(entry);
    else active.push(entry);
  }
  return { active, stale };
}

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function sortedObject(map) {
  const out = {};
  for (const key of [...Object.keys(map)].sort()) out[key] = map[key];
  return out;
}

// ---------------------------------------------------------------------------------------------
// path safety and export policy
// ---------------------------------------------------------------------------------------------

/** Validate a manifest/repo-relative path. Throws on absolute, parent-escaping or .git paths. */
export function safeRelPath(p) {
  if (typeof p !== 'string' || p.length === 0 || p.includes('\0'))
    throw new Error('unsafe path: empty or invalid');
  if (path.isAbsolute(p) || p.startsWith('/') || /^[A-Za-z]:/.test(p) || p.includes('\\')) {
    throw new Error('unsafe path: absolute or backslash path in manifest');
  }
  const segs = p.split('/');
  for (const seg of segs) {
    if (seg === '' || seg === '.' || seg === '..' || seg.toLowerCase() === '.git') {
      throw new Error(`unsafe path segment in manifest path ${JSON.stringify(p)}`);
    }
  }
  return p;
}

export function resolveInside(root, rel) {
  safeRelPath(rel);
  const abs = path.join(root, rel);
  if (!abs.startsWith(root + path.sep)) throw new Error(`path escapes root: ${JSON.stringify(rel)}`);
  return abs;
}

/**
 * Refuse a path whose parent directories (inside `root`) are symlinks: writing through one could land outside the
 * target even though the joined string looks safe. A missing parent is fine (it will be created as a real directory).
 */
export function assertNoSymlinkParents(root, rel) {
  safeRelPath(rel);
  const segs = rel.split('/');
  let cur = root;
  for (let i = 0; i < segs.length - 1; i += 1) {
    cur = path.join(cur, segs[i]);
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) return;
      throw err;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(
        `${JSON.stringify(rel)} passes through ${st.isSymbolicLink() ? 'a symlink' : 'a non-directory'} at ${JSON.stringify(segs.slice(0, i + 1).join('/'))}`,
      );
    }
    if (!fs.realpathSync(cur).startsWith(`${fs.realpathSync(root)}${path.sep}`)) {
      throw new Error(`${JSON.stringify(rel)} resolves outside the repository root`);
    }
  }
}

export const ALLOWED_ROOT_DIRS = [
  'apps',
  'packages',
  'scripts',
  'infra',
  'docs',
  'tests',
  'research',
  '.claude',
];
const ROOT_FILE_RE = /^[^/]+\.(md|txt|json|js|mjs|cjs|ts|mts|cts|yml|yaml|toml)$/i;
const ROOT_DOTFILES = new Set([
  '.gitignore',
  '.gitattributes',
  '.prettierignore',
  '.editorconfig',
  '.nvmrc',
  '.dockerignore',
  '.node-version',
  '.env.example',
]);
const EXCLUDED_DIRS = new Set([
  '.git',
  '.expunge',
  '.firecrawl',
  'node_modules',
  'dist',
  'coverage',
  '.cache',
  '.next',
  '.turbo',
  '.vite',
  '__pycache__',
  '.venv',
  'volumes',
  'secrets',
  '.secrets',
  '.private',
  'heldout',
  'held-out',
  'holdout',
  'raw-telemetry',
  'telemetry-raw',
]);
const ENV_EXAMPLE_RE = /\.(example|sample|template)$/;
// Extensionless or conventionally named root files that are real project source (a Dockerfile, a LICENSE, a Makefile).
const ROOT_NAMED_FILE_RE =
  /^(dockerfile(\..+)?|makefile|license(\..+)?|licence(\..+)?|notice|copying|authors|codeowners|procfile|brewfile)$/i;
// Material that holds sealed split plans, held-out answers or expected post-states, whatever the directory.
const SEALED_NAME_RE =
  /(sealed|held-?out|holdout|answer[-_]?key|ground[-_]?truth|expected[-_]?(post[-_]?)?state)/;
const SEALED_REGISTRY_PATH = 'docs/continuity/SEALED-PATHS.json';
const SEALED_DATA_EXT_RE = /\.(json|jsonl|ndjson|csv|tsv|bson|yaml|yml|txt|dump|sql)$/;

/**
 * Classify a repo-relative path.
 * Returns { sensitive: reason|null, approved: boolean, dirKey?: string }.
 * Sensitive paths are never hashed, copied or patched. Unapproved (not sensitive) paths are
 * hashed when tracked but not exported when untracked.
 */
export function classifyPath(rel, sealed) {
  try {
    safeRelPath(rel);
  } catch {
    return { sensitive: 'unsafe-path', approved: false };
  }
  const segs = rel.split('/');
  const base = segs[segs.length - 1];
  for (let i = 0; i < segs.length - 1; i += 1) {
    if (EXCLUDED_DIRS.has(segs[i])) {
      return {
        sensitive: `excluded-dir:${segs[i]}`,
        approved: false,
        dirKey: `${segs.slice(0, i + 1).join('/')}/`,
      };
    }
  }
  const lower = base.toLowerCase();
  if (!ENV_EXAMPLE_RE.test(lower) && (/^\.env(\..+)?$/.test(lower) || /\.env$/.test(lower))) {
    return { sensitive: 'env-file', approved: false };
  }
  if (/\.(sqlite3?|sqlite-(journal|wal|shm)|db|db-journal|mdb)$/.test(lower))
    return { sensitive: 'database-file', approved: false };
  if (
    /\.(pem|key|p12|pfx|jks|keystore)$/.test(lower) ||
    /^id_(rsa|ed25519|ecdsa|dsa)/.test(lower) ||
    ['.npmrc', '.netrc', '.pypirc', '.htpasswd', '.dockercfg'].includes(lower)
  ) {
    return { sensitive: 'credential-file', approved: false };
  }
  if (lower === '.ds_store' || /\.(tsbuildinfo|log|pid)$/.test(lower))
    return { sensitive: 'ignored-artifact', approved: false };
  if (rel === '.claude/settings.local.json') return { sensitive: 'local-settings', approved: false };
  if (/\.(ndjson|jsonl)$/.test(lower) && /(telemetry|trace|span)/.test(lower))
    return { sensitive: 'raw-telemetry', approved: false };
  if (
    (/(private|held-?out|holdout)/.test(lower) && /(manifest|seed)/.test(lower)) ||
    /^(private|heldout|holdout)\.(manifest|seed)/.test(lower)
  ) {
    return { sensitive: 'private-manifest-or-seed', approved: false };
  }
  if (rel === 'infra/opendots/.env.candidates.local') return { sensitive: 'env-file', approved: false };
  if (/\.private\.(json|jsonl|ndjson)$/.test(lower)) return { sensitive: 'private-suffix', approved: false };
  if (rel !== SEALED_REGISTRY_PATH && SEALED_DATA_EXT_RE.test(lower) && SEALED_NAME_RE.test(lower)) {
    return { sensitive: 'sealed-material-name', approved: false };
  }
  if (sealed && sealedPathMatch(rel, sealed.paths))
    return { sensitive: 'sealed-registry-path', approved: false };
  if (segs.length === 1) {
    const known =
      ROOT_FILE_RE.test(base) ||
      ROOT_DOTFILES.has(lower) ||
      ROOT_NAMED_FILE_RE.test(base) ||
      /^\.env\..+\.(example|sample|template)$/.test(lower);
    // An unknown root-level file is neither exported nor silently ignored: the checkpoint reports it as a blocker.
    return { sensitive: null, approved: known, unapprovedRootFile: !known };
  }
  // Known roots are approved by name. Any other top-level directory is approved too (silently dropping unlisted
  // project source from a continuity snapshot would be worse than exporting it) and is reported in the manifest
  // as an unlisted root so the lead can see it. Sensitive paths were already filtered out above.
  return {
    sensitive: null,
    approved: true,
    unlistedRoot: ALLOWED_ROOT_DIRS.includes(segs[0]) ? undefined : segs[0],
  };
}

/**
 * Content marker for held-out or private fixture output: a JSON document (or any line of a JSON Lines file) whose
 * top-level object carries `"expungePrivate": true`. Only top-level markers count, so source code, tests and docs
 * that merely mention the field name are not withheld. Returns true when the bytes carry the marker.
 */
export function privateMarker(buf, rel) {
  const lower = rel.toLowerCase();
  const marked = (text) => {
    try {
      const value = JSON.parse(text);
      return (
        value !== null && typeof value === 'object' && !Array.isArray(value) && value.expungePrivate === true
      );
    } catch {
      return false;
    }
  };
  if (lower.endsWith('.json')) return marked(buf.toString('utf8'));
  if (lower.endsWith('.jsonl') || lower.endsWith('.ndjson')) {
    return buf
      .toString('utf8')
      .split('\n')
      .some((line) => line.trim().startsWith('{') && marked(line));
  }
  return false;
}

/** Match a repo-relative path against sealed-registry entries: exact path, or a directory prefix ending in `/` or `/**`. */
export function sealedPathMatch(rel, entries) {
  for (const entry of entries) {
    if (entry === rel) return true;
    const prefix = entry.endsWith('/**') ? entry.slice(0, -2) : entry.endsWith('/') ? entry : null;
    if (prefix && rel.startsWith(prefix)) return true;
  }
  return false;
}

/**
 * Sealed-material registry: `docs/continuity/SEALED-PATHS.json` (tracked, maintained by the team lead) and
 * `.expunge/sealed-paths.json` (local), each `{ "paths": [...], "sha256": [...] }`. Paths are excluded by location,
 * and any file whose SHA-256 is listed is withheld under whatever name or directory it has been saved.
 */
export function loadSealedRegistry(repo) {
  const paths = [];
  const hashes = new Set();
  const sources = [];
  for (const rel of [SEALED_REGISTRY_PATH, '.expunge/sealed-paths.json']) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(repo, rel), 'utf8'));
    } catch {
      continue;
    }
    sources.push(rel);
    for (const entry of Array.isArray(parsed?.paths) ? parsed.paths : []) {
      if (typeof entry === 'string' && entry.length > 0 && !entry.includes('..')) paths.push(entry);
    }
    for (const h of Array.isArray(parsed?.sha256) ? parsed.sha256 : []) {
      if (typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)) hashes.add(h);
    }
  }
  return { paths, hashes, sources };
}

// ---------------------------------------------------------------------------------------------
// secret scanning (reports rule IDs only, never matched text)
// ---------------------------------------------------------------------------------------------

const PLACEHOLDER_RE = /[<>{}$]|\.\.\.|…|x{3,}|example|placeholder|changeme|your[-_ ]|\bpassword\b|:pass@/i;

const RESERVED_HOST_RE = /(^|\.)(example|invalid|test|localhost)(\.(com|org|net))?$|^127\.|^\[::1\]$/i;

function mongoFinding(text) {
  // A bare scheme mentioned in prose (nothing host-like after it) is not a connection string.
  const srv = /mongodb\+srv:\/\/([^\s'"`]*)/g;
  let m;
  while ((m = srv.exec(text)) !== null) {
    const rest = m[1];
    if (rest.length >= 3 && !PLACEHOLDER_RE.test(rest)) return true;
  }
  const plain = /mongodb:\/\/([^\s/'"`@]+):([^\s/'"`@]+)@([^\s/'"`?]*)/g;
  while ((m = plain.exec(text)) !== null) {
    if (PLACEHOLDER_RE.test(`${m[1]}:${m[2]}`)) continue;
    // Test fixtures: a reserved or example host (RFC 2606 / 6761 names, loopback) or a password too short to be a secret.
    const host = m[3].split('/')[0].replace(/:\d+$/, '');
    if (RESERVED_HOST_RE.test(host) || m[2].length < 3) continue;
    return true;
  }
  return false;
}

const SECRET_RULES = [
  { id: 'mongodb-uri', test: mongoFinding },
  { id: 'openai-style-key', re: /(?<![A-Za-z0-9_-])sk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{20,}/ },
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'private-key-block', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/ },
  {
    id: 'bearer-token',
    re: /\bBearer\s+(?=[A-Za-z0-9._~+/=-]*\d)(?=[A-Za-z0-9._~+/=-]*[A-Za-z])[A-Za-z0-9._~+/=-]{20,}/,
  },
  { id: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})/ },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { id: 'npm-auth-token', re: /:_authToken=[A-Za-z0-9_-]{10,}/ },
];

/**
 * Parse local .env style files into a redaction set. Only value bytes and key NAMES are kept in
 * memory; values equal to the committed .env.example default for the same key are public and skipped.
 */
export function buildRedactionSet(repo) {
  const sources = [];
  const candidates = ['.env', '.env.local', 'apps/operator/.env', 'infra/opendots/.env.candidates.local'];
  const exampleValues = new Map();
  const examplePath = path.join(repo, '.env.example');
  if (fs.existsSync(examplePath)) {
    for (const { key, value } of parseEnv(fs.readFileSync(examplePath, 'utf8')))
      exampleValues.set(key, value);
  }
  const entries = [];
  const seen = new Set();
  for (const rel of candidates) {
    const abs = path.join(repo, rel);
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    sources.push(rel);
    for (const { key, value } of parseEnv(text)) {
      if (value.length < 8 || exampleValues.get(key) === value || seen.has(value)) continue;
      seen.add(value);
      entries.push({ key, buf: Buffer.from(value, 'utf8') });
    }
  }
  return { entries, sources };
}

export function parseEnv(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = m[2].trim();
    if (/^(['"]).*\1$/.test(value) && value.length >= 2) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    out.push({ key: m[1], value });
  }
  return out;
}

/** Scan bytes; returns an array of rule IDs (never matched text). */
export function scanBuffer(buf, redaction = { entries: [] }) {
  const text = buf.toString('latin1');
  const hits = [];
  for (const rule of SECRET_RULES) {
    if (rule.test ? rule.test(text) : rule.re.test(text)) hits.push(rule.id);
  }
  for (const { key, buf: needle } of redaction.entries) {
    if (buf.includes(needle)) hits.push(`env-value:${key}`);
  }
  return hits;
}

// ---------------------------------------------------------------------------------------------
// patches
// ---------------------------------------------------------------------------------------------

/** Split a git diff into per-file sections (binary-safe via latin1). */
export function splitPatchSections(patch) {
  if (patch.length === 0) return [];
  const text = patch.toString('latin1');
  return text
    .split(/^(?=diff --git )/m)
    .filter((s) => s.length > 0)
    .map((s) => Buffer.from(s, 'latin1'));
}

// ---------------------------------------------------------------------------------------------
// manifest IO and verification
// ---------------------------------------------------------------------------------------------

export function readManifest(dir) {
  const file = path.join(dir, 'manifest.json');
  let manifest;
  try {
    if (!fs.lstatSync(file).isFile()) throw new Error('manifest.json is not a regular file');
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read manifest at ${file}: ${err.message}`);
  }
  if (manifest.schema !== MANIFEST_SCHEMA)
    throw new Error(`unsupported manifest schema ${JSON.stringify(manifest.schema)}`);
  if (typeof manifest.head !== 'string' || typeof manifest.files !== 'object' || manifest.files === null) {
    throw new Error('manifest is missing head or files');
  }
  const hex = /^[0-9a-f]{64}$/;
  for (const [p, h] of Object.entries(manifest.files)) {
    safeRelPath(p);
    if (typeof h !== 'string' || !hex.test(h))
      throw new Error(`manifest hash for ${JSON.stringify(p)} is not a SHA-256`);
  }
  for (const e of manifest.untracked ?? []) {
    safeRelPath(e.path);
    // Pack-relative fields are joined onto the checkpoint directory by verify and restore: pin them to the one
    // layout the tool writes so a crafted manifest cannot point at files outside the pack.
    if (e.copy !== `untracked/${e.path}`)
      throw new Error(`manifest copy path for ${JSON.stringify(e.path)} is not untracked/<path>`);
    if (typeof e.sha256 !== 'string' || !hex.test(e.sha256))
      throw new Error('manifest untracked entry has an invalid SHA-256');
    if (e.mode !== '100644' && e.mode !== '100755')
      throw new Error('manifest untracked entry has an invalid mode');
    resolveInside(dir, e.copy);
  }
  for (const key of ['staged', 'unstaged']) {
    const patch = manifest.patches?.[key];
    if (
      !patch ||
      patch.file !== `${key}.patch` ||
      !hex.test(patch.sha256 ?? '') ||
      !Number.isInteger(patch.bytes)
    ) {
      throw new Error(`manifest patch entry ${key} is invalid`);
    }
  }
  if (manifest.briefing) {
    const b = manifest.briefing;
    safeRelPath(b.copy);
    if (!b.copy.startsWith('briefing/') || !hex.test(b.sha256 ?? ''))
      throw new Error('manifest briefing entry is invalid');
    resolveInside(dir, b.copy);
  }
  for (const p of manifest.deleted ?? []) safeRelPath(p);
  for (const list of [manifest.changes?.staged ?? [], manifest.changes?.unstaged ?? []]) {
    for (const c of list) safeRelPath(c.path);
  }
  return manifest;
}

export function resolveCheckpointArg(arg, repo) {
  if (arg === 'latest') {
    const base = path.join(repo, '.expunge', 'checkpoints');
    const id = readLatest(base);
    if (!id) throw new Error(`no LATEST pointer under ${base}`);
    return path.join(base, id);
  }
  return path.resolve(arg);
}

export function readLatest(base) {
  try {
    const id = fs.readFileSync(path.join(base, 'LATEST'), 'utf8').trim();
    return CHECKPOINT_ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
}

/** Pack integrity: re-hash patches, untracked copies and the briefing copy inside the checkpoint. */
export function verifyPack(dir, manifest) {
  const results = [];
  const check = (rel, expected) => {
    const abs = path.join(dir, rel);
    // A pack member must be a regular file reached without a symlinked directory; a symlink could make restore copy
    // an outside file into the target while still "matching" a crafted hash.
    let regular = true;
    try {
      assertNoSymlinkParents(dir, rel);
      const st = fs.lstatSync(abs);
      regular = st.isFile();
    } catch (err) {
      regular = !(err && err.code !== 'ENOENT' && err.code !== 'ENOTDIR');
    }
    const actual = regular ? hashPath(abs) : 'not-a-regular-pack-file';
    const status = actual === null ? 'MISSING' : actual === expected ? 'MATCH' : 'CHANGED';
    results.push({ path: rel, status });
  };
  for (const key of ['staged', 'unstaged']) {
    const p = manifest.patches?.[key];
    if (p) check(p.file, p.sha256);
  }
  for (const e of manifest.untracked ?? []) check(e.copy, e.sha256);
  if (manifest.briefing) check(manifest.briefing.copy, manifest.briefing.sha256);
  return results;
}

/** Compare manifest hashes with a working tree: MATCH / CHANGED / MISSING per path. */
export function verifyWorktree(root, manifest) {
  const results = [];
  for (const [rel, expected] of Object.entries(manifest.files)) {
    const abs = resolveInside(root, rel);
    const actual = hashPath(abs);
    const status = actual === null ? 'MISSING' : actual === expected ? 'MATCH' : 'CHANGED';
    const result = { path: rel, status };
    if (status === 'CHANGED' && newerThanCheckpoint(abs, manifest)) {
      result.note = 'modified after checkpoint';
      result.modifiedAfterCheckpoint = true;
    }
    results.push(result);
  }
  for (const rel of manifest.deleted ?? []) {
    const actual = hashPath(resolveInside(root, rel));
    results.push({ path: rel, status: actual === null ? 'MATCH' : 'CHANGED', note: 'expected absent' });
  }
  return results;
}

/** True when the file on disk was modified after the checkpoint manifest was written (newer code than the narrative). */
export function newerThanCheckpoint(abs, manifest) {
  try {
    return fs.lstatSync(abs).mtimeMs > Date.parse(manifest.createdAt);
  } catch {
    return false;
  }
}

export function countStatuses(results) {
  const counts = { MATCH: 0, CHANGED: 0, MISSING: 0 };
  for (const r of results) counts[r.status] += 1;
  return counts;
}

// ---------------------------------------------------------------------------------------------
// tiny CLI helpers
// ---------------------------------------------------------------------------------------------

export function printLine(text = '') {
  process.stdout.write(`${text}\n`);
}

export function printErr(text = '') {
  process.stderr.write(`${text}\n`);
}
