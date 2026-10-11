#!/usr/bin/env node
// Expunge continuity checkpoint (spec section 20, "Checkpoint transaction" steps 3 to 5 and 8).
//
// Captures actual repo root/branch/HEAD (or UNBORN), git status, staged and unstaged binary patches,
// approved untracked file copies and per-file SHA-256 hashes into an immutable
// .expunge/checkpoints/<UTC timestamp>-<8 hex nonce>/ directory, scans everything exported for
// secrets (paths and rule IDs only are ever reported), writes through a temp directory with fsync and
// an atomic rename, and moves the LATEST pointer only when the manifest is complete and the pack
// re-hashes cleanly on re-read. Earlier checkpoint directories are never modified.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { Buffer } from 'node:buffer';
import {
  DEFAULT_MAX_FILE_BYTES,
  DEFAULT_MAX_TOTAL_BYTES,
  DIFF_FLAGS,
  MANIFEST_SCHEMA,
  TOOL_VERSION,
  UNBORN,
  branchName,
  buildRedactionSet,
  classifyPath,
  fsyncDir,
  fsyncTree,
  git,
  gitText,
  loadSealedRegistry,
  hashPath,
  headState,
  parseLsStage,
  parseNameStatus,
  privateMarker,
  pidAlive,
  printErr,
  printLine,
  readLatest,
  readManifest,
  resolveInside,
  resolveRepoRoot,
  scanBuffer,
  sha256Buffer,
  sleepSync,
  sortedObject,
  splitNul,
  splitPatchSections,
  verifyPack,
  writeFileDurable,
} from './lib.mjs';

const RULE_IDS_VERSION = 1;

function utcStamp(date) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

// ---------------------------------------------------------------------------------------------
// state collection (read only)
// ---------------------------------------------------------------------------------------------

/**
 * Read the repository state. Pure reads: nothing under the repo is written and git index locks are not taken.
 * With keepBuffers=false the exported file bytes are hashed and dropped (used for the stability re-read).
 */
export function collectState(repo, opts) {
  const { maxFileBytes, maxTotalBytes, redaction, keepBuffers, sealed } = opts;
  const { head, tree } = headState(repo);
  const unborn = head === UNBORN;
  const branch = branchName(repo);
  const statusText = gitText(repo, ['status', '--porcelain=v2', '--branch']);
  const index = parseLsStage(git(repo, ['ls-files', '-z', '--stage']).stdout);
  const untrackedRaw = splitNul(git(repo, ['ls-files', '-z', '--others', '--exclude-standard']).stdout);
  const deletedSet = new Set(splitNul(git(repo, ['ls-files', '-z', '--deleted']).stdout));

  const excluded = new Map();
  const blockers = [];
  const DROPPED_RECOVERY =
    'add the path to .gitignore (it is deliberately not exported), move it out of the repository, or commit it; then checkpoint again';
  const MAX_LISTED_PATHS = 500;
  // Every dropped path is recorded; a directory-wide exclusion lists its files (capped, with a count and a flag).
  const exclude = (rel, cls, reasonOverride) => {
    if (cls.dirKey && !reasonOverride) {
      const key = `dir:${cls.dirKey}`;
      const prev = excluded.get(key);
      if (prev) {
        prev.count += 1;
        if (prev.paths.length < MAX_LISTED_PATHS) prev.paths.push(rel);
        else prev.truncated = true;
      } else {
        excluded.set(key, {
          path: cls.dirKey,
          reason: cls.sensitive,
          kind: 'policy',
          count: 1,
          paths: [rel],
          recovery: DROPPED_RECOVERY,
        });
      }
    } else {
      excluded.set(`file:${rel}`, {
        path: rel,
        reason: reasonOverride ?? cls.sensitive ?? 'unapproved-root',
        kind: 'policy',
        recovery: DROPPED_RECOVERY,
      });
    }
  };
  const block = (rel, reason, recovery, rules) => {
    blockers.push({ path: rel, reason, kind: 'blocker', ...(rules ? { rules } : {}), recovery });
  };

  const unlistedRoots = new Set();
  const files = {};
  const tracked = [];
  const deleted = [];
  const exported = [];
  let totalBytes = 0;
  const secretPaths = new Set();

  // Candidate files that become copies: untracked files, plus every index entry when UNBORN.
  const candidates = new Set(untrackedRaw);
  for (const entry of index) {
    if (entry.stage !== '0') {
      block(entry.path, 'unmerged-index-entry', 'resolve the merge conflict, then checkpoint again');
      continue;
    }
    if (entry.mode === '160000') {
      exclude(entry.path, { sensitive: 'submodule' });
      continue;
    }
    if (unborn) {
      candidates.add(entry.path);
      continue;
    }
    const cls = classifyPath(entry.path, sealed);
    if (cls.sensitive) {
      exclude(entry.path, cls);
      continue;
    }
    if (deletedSet.has(entry.path)) {
      deleted.push(entry.path);
      continue;
    }
    const trackedHash = hashPath(resolveInside(repo, entry.path));
    if (trackedHash === null) {
      deleted.push(entry.path);
      continue;
    }
    files[entry.path] = trackedHash;
    tracked.push(entry.path);
  }

  for (const rel of [...candidates].sort()) {
    const cls = classifyPath(rel, sealed);
    if (cls.sensitive) {
      exclude(rel, cls);
      continue;
    }
    if (!cls.approved) {
      // Only an unrecognised root-level file lands here. Dropping it would make the snapshot silently incomplete.
      block(
        rel,
        'unapproved-root-file',
        'add it to .gitignore, move it under a project directory, give it a known extension, or commit it, then checkpoint again',
      );
      continue;
    }
    const abs = resolveInside(repo, rel);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      if (deletedSet.has(rel)) deleted.push(rel);
      continue;
    }
    if (cls.unlistedRoot) unlistedRoots.add(cls.unlistedRoot);
    if (st.isSymbolicLink()) {
      block(
        rel,
        'symlink-not-exported',
        'replace the symlink with a regular file or commit it before checkpointing',
      );
      continue;
    }
    if (!st.isFile()) {
      exclude(rel, cls, 'non-regular-file');
      continue;
    }
    if (st.size > maxFileBytes || totalBytes + st.size > maxTotalBytes) {
      block(
        rel,
        st.size > maxFileBytes ? 'file-too-large' : 'total-size-exceeded',
        'raise --max-file-bytes/--max-total-bytes or move the file out of the export set',
      );
      continue;
    }
    const buf = fs.readFileSync(abs);
    const sha256 = sha256Buffer(buf);
    if (sealed.hashes.has(sha256)) {
      exclude(rel, cls, 'sealed-registry-hash');
      continue;
    }
    if (privateMarker(buf, rel)) {
      exclude(rel, cls, 'private-marker');
      continue;
    }
    const rules = scanBuffer(buf, redaction);
    if (rules.length > 0) {
      secretPaths.add(rel);
      block(
        rel,
        'secret-detected',
        'remove the credential from the file (use a local .env), then checkpoint again',
        rules,
      );
      continue;
    }
    totalBytes += buf.length;
    files[rel] = sha256;
    exported.push({
      path: rel,
      sha256,
      bytes: buf.length,
      mode: st.mode & 0o111 ? '100755' : '100644',
      copy: `untracked/${rel}`,
      ...(keepBuffers ? { buf } : {}),
    });
  }

  // Patches: not produced for UNBORN (all approved files are copies instead).
  const rawPatches = { staged: Buffer.alloc(0), unstaged: Buffer.alloc(0) };
  const names = { staged: [], unstaged: [] };
  if (!unborn) {
    names.staged = parseNameStatus(
      git(repo, ['diff', '--cached', '--name-status', '-z', ...DIFF_FLAGS]).stdout,
    );
    names.unstaged = parseNameStatus(git(repo, ['diff', '--name-status', '-z', ...DIFF_FLAGS]).stdout);
    rawPatches.staged = git(repo, ['diff', '--cached', '--binary', ...DIFF_FLAGS]).stdout;
    rawPatches.unstaged = git(repo, ['diff', '--binary', ...DIFF_FLAGS]).stdout;
  }

  // Scan changed tracked files in the worktree (binary patches hide content behind base85).
  for (const change of [...names.staged, ...names.unstaged]) {
    if (change.status === 'D' || secretPaths.has(change.path) || classifyPath(change.path, sealed).sensitive)
      continue;
    const abs = resolveInside(repo, change.path);
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > maxFileBytes) {
      secretPaths.add(change.path);
      block(
        change.path,
        'file-too-large-to-scan',
        'raise --max-file-bytes or commit the file before checkpointing',
      );
      continue;
    }
    const changedBuf = fs.readFileSync(abs);
    if (sealed.hashes.has(sha256Buffer(changedBuf))) {
      secretPaths.add(change.path);
      exclude(change.path, { sensitive: 'sealed-registry-hash' });
      continue;
    }
    if (privateMarker(changedBuf, change.path)) {
      secretPaths.add(change.path);
      exclude(change.path, { sensitive: 'private-marker' });
      continue;
    }
    const rules = scanBuffer(changedBuf, redaction);
    if (rules.length > 0) {
      secretPaths.add(change.path);
      block(
        change.path,
        'secret-detected',
        'remove the credential from the file (use a local .env), then checkpoint again',
        rules,
      );
    }
  }

  const patches = {};
  const changes = {};
  for (const key of ['staged', 'unstaged']) {
    const sections = splitPatchSections(rawPatches[key]);
    const list = names[key];
    const kept = [];
    const keptNames = [];
    if (sections.length !== list.length) {
      const rules = scanBuffer(rawPatches[key], redaction);
      if (rules.length > 0) {
        block(
          `(${key} patch)`,
          'secret-detected',
          'remove the credential from the changed files, then checkpoint again',
          rules,
        );
      } else {
        block(
          `(${key} patch)`,
          'patch-section-mismatch',
          'inspect git status for unmerged or unusual paths, then checkpoint again',
        );
      }
      patches[key] = Buffer.alloc(0);
      changes[key] = [];
      continue;
    }
    sections.forEach((section, i) => {
      const change = list[i];
      const cls = classifyPath(change.path, sealed);
      if (cls.sensitive) {
        exclude(change.path, cls, `patch-omitted:${cls.sensitive}`);
        return;
      }
      if (secretPaths.has(change.path)) return;
      const rules = scanBuffer(section, redaction);
      if (rules.length > 0) {
        secretPaths.add(change.path);
        block(
          change.path,
          'secret-detected',
          'remove the credential from the file or its history of staged content, then checkpoint again',
          rules,
        );
        return;
      }
      kept.push(section);
      keptNames.push(change);
    });
    patches[key] = Buffer.concat(kept);
    changes[key] = keptNames;
    if (patches[key].length > maxTotalBytes) {
      block(`(${key} patch)`, 'patch-too-large', 'raise --max-total-bytes or commit part of the work first');
    }
  }

  for (const key of Object.keys(files)) {
    if (secretPaths.has(key)) delete files[key];
  }

  return {
    head,
    tree,
    branch,
    unborn,
    statusText,
    files: sortedObject(files),
    tracked: tracked.filter((p) => !secretPaths.has(p)).sort(),
    deleted: [...new Set(deleted)].sort(),
    exported,
    rawPatches,
    patches,
    changes,
    stagedPaths: unborn
      ? index
          .filter((e) => e.stage === '0')
          .map((e) => e.path)
          .sort()
      : names.staged.map((c) => c.path),
    unstagedPaths: names.unstaged.map((c) => c.path),
    excluded: [...excluded.values()],
    unlistedRoots: [...unlistedRoots].sort(),
    blockers,
    scannedFiles: exported.length,
  };
}

function fingerprint(state) {
  return sha256Buffer(
    Buffer.from(
      JSON.stringify({
        head: state.head,
        files: state.files,
        deleted: state.deleted,
        staged: sha256Buffer(state.rawPatches.staged),
        unstaged: sha256Buffer(state.rawPatches.unstaged),
        blockers: state.blockers.map((b) => [b.path, b.reason]),
      }),
    ),
  );
}

function diffStates(a, b) {
  const changed = new Set();
  if (a.head !== b.head) changed.add('(HEAD)');
  for (const p of new Set([...Object.keys(a.files), ...Object.keys(b.files)])) {
    if (a.files[p] !== b.files[p]) changed.add(p);
  }
  if (sha256Buffer(a.rawPatches.staged) !== sha256Buffer(b.rawPatches.staged)) changed.add('(staged.patch)');
  if (sha256Buffer(a.rawPatches.unstaged) !== sha256Buffer(b.rawPatches.unstaged))
    changed.add('(unstaged.patch)');
  if (changed.size === 0 && fingerprint(a) !== fingerprint(b)) changed.add('(inventory)');
  return [...changed].sort();
}

// ---------------------------------------------------------------------------------------------
// locking and LATEST pointer
// ---------------------------------------------------------------------------------------------

// A lock whose owner file cannot be read is not broken until it is this old. mkdir creates the lock atomically but
// the pid file is written a moment later; during that moment a live lock looks ownerless, so "unreadable and recent"
// must mean "somebody is acquiring", never "stale".
const UNREADABLE_LOCK_GRACE_MS = 60_000;

function readLockPid(lockDir) {
  try {
    const pid = Number.parseInt(fs.readFileSync(path.join(lockDir, 'pid'), 'utf8'), 10);
    return pid > 0 ? pid : 0;
  } catch {
    return 0;
  }
}

/**
 * Acquire the single-writer checkpoint lock.
 *  - Create: mkdir is atomic, so exactly one contender creates the directory; the winner writes its pid and then
 *    re-reads it to confirm nobody replaced the lock in between.
 *  - Contend: a live pid, or an unreadable owner younger than the grace period, is respected and the run fails.
 *  - Stale: only a dead pid (or an unreadable owner older than the grace period) can be taken over, by renaming the
 *    directory aside (only one contender can win the rename) and re-checking what was moved; if it turns out to belong
 *    to a live pid it is put back untouched.
 *  - Release: the lock directory is removed only if it still carries our own pid, i.e. we never remove a lock we did
 *    not create.
 */
function acquireLock(base) {
  const lockDir = path.join(base, '.checkpoint.lock');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(path.join(lockDir, 'pid'), `${process.pid}\n`);
      if (readLockPid(lockDir) !== process.pid) {
        throw new Error('the checkpoint lock was replaced while it was being acquired; not proceeding');
      }
      return () => {
        if (readLockPid(lockDir) === process.pid) fs.rmSync(lockDir, { recursive: true, force: true });
      };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const pid = readLockPid(lockDir);
    let ageMs;
    try {
      ageMs = Date.now() - fs.statSync(lockDir).mtimeMs;
    } catch {
      continue; // the lock vanished between mkdir and now; try again
    }
    if (pid > 0 && pidAlive(pid)) {
      throw new Error(`another checkpoint is in progress (pid ${pid}); not removing a live lock`);
    }
    if (pid === 0 && ageMs < UNREADABLE_LOCK_GRACE_MS) {
      throw new Error('a checkpoint lock with an unreadable owner exists and is recent; not breaking it');
    }
    const aside = path.join(base, `.checkpoint.lock.stale-${randomBytes(4).toString('hex')}`);
    try {
      fs.renameSync(lockDir, aside);
    } catch {
      continue; // another contender claimed the stale lock first
    }
    const claimed = readLockPid(aside);
    if (claimed !== pid && claimed > 0 && pidAlive(claimed)) {
      try {
        fs.renameSync(aside, lockDir); // changed hands between the check and the rename: put it back
      } catch {
        // someone re-created the lock meanwhile; the moved directory stays aside for inspection
      }
      throw new Error(`another checkpoint is in progress (pid ${claimed}); not removing a live lock`);
    }
    // The moved-aside directory is a proven-dead artifact; the next lock holder's cleanup pass deletes it.
  }
  throw new Error('could not acquire the checkpoint lock');
}

export function updateLatest(base, id) {
  const tmp = path.join(base, `.LATEST.tmp-${randomBytes(4).toString('hex')}`);
  writeFileDurable(tmp, `${id}\n`, 0o644);
  fs.renameSync(tmp, path.join(base, 'LATEST'));
  fsyncDir(base);
}

// ---------------------------------------------------------------------------------------------
// the checkpoint transaction
// ---------------------------------------------------------------------------------------------

/**
 * Create one immutable checkpoint. `hooks` are test seams: afterCollect({attempt}), beforeRename({tmpDir}),
 * beforeLatest({dir}). An exception from a hook (or anywhere) leaves any earlier checkpoint and LATEST untouched.
 */
export function createCheckpoint(options = {}) {
  const repo = resolveRepoRoot(options.repo ?? process.cwd());
  const base = path.resolve(options.out ?? path.join(repo, '.expunge', 'checkpoints'));
  const hooks = options.hooks ?? {};
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
  const attempts = Math.max(1, options.attempts ?? 3);
  const now = options.now ?? new Date();
  const notes = options.notes ?? '';

  const redaction = buildRedactionSet(repo);
  const sealed = loadSealedRegistry(repo);
  if (notes && scanBuffer(Buffer.from(notes, 'utf8'), redaction).length > 0) {
    throw new Error('--notes appears to contain a credential; refusing to write it into a manifest');
  }

  fs.mkdirSync(base, { recursive: true });
  const release = acquireLock(base);
  try {
    // Under the lock no other checkpoint writer exists, so leftover temp directories are interrupted writes.
    for (const name of fs.readdirSync(base)) {
      if (name.startsWith('.tmp-') || name.startsWith('.checkpoint.lock.stale-')) {
        fs.rmSync(path.join(base, name), { recursive: true, force: true });
      }
    }

    let state;
    let changed = [];
    let used = 0;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      used = attempt;
      state = collectState(repo, { maxFileBytes, maxTotalBytes, redaction, sealed, keepBuffers: true });
      hooks.afterCollect?.({ attempt, repo });
      const again = collectState(repo, {
        maxFileBytes,
        maxTotalBytes,
        redaction,
        sealed,
        keepBuffers: false,
      });
      changed = diffStates(state, again);
      if (changed.length === 0) break;
      if (attempt < attempts) sleepSync(250);
    }
    const stable = changed.length === 0;

    const id = `${utcStamp(now)}-${randomBytes(4).toString('hex')}`;
    const tmpDir = path.join(base, `.tmp-${id}`);
    const finalDir = path.join(base, id);
    if (fs.existsSync(finalDir))
      throw new Error(`checkpoint ${id} already exists; checkpoints are immutable`);
    fs.mkdirSync(tmpDir);

    // Briefing copy (local HANDOFF.md): scanned like everything else, optional.
    let briefing = null;
    let briefingBuf = null;
    const incompleteReasons = [];
    const blockers = [...state.blockers];
    if (options.briefing !== false) {
      const briefingRel = typeof options.briefing === 'string' ? options.briefing : 'HANDOFF.md';
      const briefingAbs = path.resolve(repo, briefingRel);
      if (fs.existsSync(briefingAbs) && fs.statSync(briefingAbs).isFile()) {
        const buf = fs.readFileSync(briefingAbs);
        const rules = scanBuffer(buf, redaction);
        if (rules.length > 0) {
          blockers.push({
            path: path.relative(repo, briefingAbs) || briefingRel,
            reason: 'secret-detected',
            kind: 'blocker',
            rules,
            recovery: 'remove credentials from the briefing, then checkpoint again',
          });
        } else {
          briefingBuf = buf;
          briefing = {
            source: path.relative(repo, briefingAbs) || briefingRel,
            copy: `briefing/${path.basename(briefingAbs)}`,
            sha256: sha256Buffer(buf),
            bytes: buf.length,
          };
        }
      }
    }

    const excluded = [...state.excluded, ...blockers].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    for (const b of blockers) incompleteReasons.push(`${b.reason}:${b.path}`);
    // A snapshot is complete only if every non-ignored file is either exported or covered by the patches. Anything
    // dropped for a reason other than being a gitignored path makes it incomplete, whatever the reason.
    for (const e of state.excluded) incompleteReasons.push(`dropped:${e.reason}:${e.path}`);
    if (!stable) incompleteReasons.push(`worktree-changed-during-capture:${changed.slice(0, 20).join(',')}`);
    const complete = incompleteReasons.length === 0;

    const patchEntry = (key) => ({
      file: `${key}.patch`,
      sha256: sha256Buffer(state.patches[key]),
      bytes: state.patches[key].length,
      files: state.changes[key].length,
    });

    const manifest = {
      schema: MANIFEST_SCHEMA,
      checkpointId: id,
      createdAt: now.toISOString(),
      repoRoot: repo,
      branch: state.branch,
      head: state.head,
      headTree: state.tree,
      git: {
        unborn: state.unborn,
        statusPorcelainV2: state.statusText,
        stagedPaths: state.stagedPaths,
        unstagedPaths: state.unstagedPaths,
      },
      files: state.files,
      tracked: state.tracked,
      untracked: state.exported.map(({ path: p, sha256, bytes, mode, copy }) => ({
        path: p,
        sha256,
        bytes,
        mode,
        copy,
      })),
      deleted: state.deleted,
      changes: state.changes,
      patches: { staged: patchEntry('staged'), unstaged: patchEntry('unstaged') },
      briefing,
      excluded,
      unlistedRoots: state.unlistedRoots,
      secretScan: {
        rulesVersion: RULE_IDS_VERSION,
        envRedaction: { sources: redaction.sources, valueCount: redaction.entries.length },
        scannedExportedFiles: state.scannedFiles,
        sealedRegistry: { sources: sealed.sources, paths: sealed.paths.length, hashes: sealed.hashes.size },
        limitations: [
          'pattern based: known token formats, exact local .env values and path/name rules only',
          'a clean scan does not prove the absence of held-out, private or credential material',
          'material saved under an unrecognised name is withheld only if its path or SHA-256 is in the sealed registry (docs/continuity/SEALED-PATHS.json or .expunge/sealed-paths.json)',
        ],
        findings: blockers
          .filter((b) => b.reason === 'secret-detected')
          .map((b) => ({ path: b.path, rules: b.rules })),
      },
      stability: { attempts: used, stable, changedDuringCapture: changed.slice(0, 50) },
      tool: {
        name: 'expunge-checkpoint',
        version: TOOL_VERSION,
        node: process.version,
        git: gitText(repo, ['--version']),
        platform: `${process.platform}-${os.arch()}`,
      },
      complete,
      incompleteReasons,
      notes,
    };

    writeFileDurable(path.join(tmpDir, 'staged.patch'), state.patches.staged, 0o444);
    writeFileDurable(path.join(tmpDir, 'unstaged.patch'), state.patches.unstaged, 0o444);
    for (const entry of state.exported) {
      const dest = path.join(tmpDir, entry.copy);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      writeFileDurable(dest, entry.buf, 0o444);
    }
    if (briefing && briefingBuf) {
      const dest = path.join(tmpDir, briefing.copy);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      writeFileDurable(dest, briefingBuf, 0o444);
    }
    writeFileDurable(path.join(tmpDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 0o444);
    fsyncTree(tmpDir);

    hooks.beforeRename?.({ tmpDir, id });
    fs.renameSync(tmpDir, finalDir);
    fsyncDir(base);

    // Re-read from disk: the manifest must parse and every pack file must re-hash to its recorded value.
    const reread = readManifest(finalDir);
    const packResults = verifyPack(finalDir, reread);
    const packOk = reread.checkpointId === id && packResults.every((r) => r.status === 'MATCH');
    let latestUpdated = false;
    if (reread.complete && packOk) {
      hooks.beforeLatest?.({ dir: finalDir, id });
      updateLatest(base, id);
      latestUpdated = true;
    }
    return { id, dir: finalDir, manifest: reread, packOk, latestUpdated, latest: readLatest(base) };
  } finally {
    release();
  }
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function summarize(result, repo) {
  const m = result.manifest;
  const rel = path.relative(repo, result.dir) || result.dir;
  printLine(`checkpoint: ${result.id}`);
  printLine(`dir: ${rel}`);
  printLine(`branch: ${m.branch}  head: ${m.head}${m.headTree ? `  tree: ${m.headTree}` : ''}`);
  printLine(
    `tracked: ${m.tracked.length}  untracked-exported: ${m.untracked.length}  deleted: ${m.deleted.length}`,
  );
  printLine(
    `patches: staged ${m.patches.staged.bytes} bytes (${m.patches.staged.files} files), unstaged ${m.patches.unstaged.bytes} bytes (${m.patches.unstaged.files} files)`,
  );
  printLine(`briefing: ${m.briefing ? `${m.briefing.source} (${m.briefing.bytes} bytes)` : 'none'}`);
  const policy = m.excluded.filter((e) => e.kind === 'policy');
  const blockers = m.excluded.filter((e) => e.kind === 'blocker');
  printLine(`dropped by policy: ${policy.length} entries  blockers: ${blockers.length}`);
  for (const e of policy) {
    const listed = e.paths ? e.paths.slice(0, 20) : [e.path];
    printLine(`DROPPED ${e.reason} path=${e.path}${e.count ? ` count=${e.count}` : ''}`);
    if (e.paths) for (const p of listed) printLine(`  ${p}`);
  }
  if (m.unlistedRoots.length > 0)
    printLine(
      `note: exported untracked files under unlisted top-level directories: ${m.unlistedRoots.join(', ')}`,
    );
  for (const b of blockers) {
    printLine(`BLOCKER ${b.reason} path=${b.path}${b.rules ? ` rules=${b.rules.join(',')}` : ''}`);
  }
  printLine(
    `stability: ${m.stability.stable ? 'stable' : 'UNSTABLE'} after ${m.stability.attempts} attempt(s)${m.stability.stable ? '' : ` changed=${m.stability.changedDuringCapture.join(',')}`}`,
  );
  printLine(`pack re-read: ${result.packOk ? 'all hashes match' : 'MISMATCH'}`);
  printLine(`complete: ${m.complete}`);
  printLine(
    `LATEST: ${result.latestUpdated ? `updated to ${result.id}` : `NOT updated (still ${result.latest ?? 'unset'})`}`,
  );
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        repo: { type: 'string' },
        out: { type: 'string' },
        notes: { type: 'string' },
        briefing: { type: 'string' },
        'no-briefing': { type: 'boolean' },
        'max-file-bytes': { type: 'string' },
        'max-total-bytes': { type: 'string' },
        attempts: { type: 'string' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: false,
    });
  } catch (err) {
    printErr(`usage error: ${err.message}`);
    return 2;
  }
  const v = parsed.values;
  if (v.help) {
    printLine(
      'Usage: node scripts/continuity/checkpoint.mjs [--repo DIR] [--out DIR] [--notes TEXT] [--briefing FILE | --no-briefing]',
    );
    printLine('       [--max-file-bytes N] [--max-total-bytes N] [--attempts N] [--json]');
    printLine(
      'Exit: 0 complete and LATEST updated; 1 error; 2 usage; 3 incomplete snapshot written, LATEST preserved.',
    );
    return 0;
  }
  try {
    const repo = resolveRepoRoot(v.repo ?? process.cwd());
    const result = createCheckpoint({
      repo,
      out: v.out,
      notes: v.notes ?? '',
      briefing: v['no-briefing'] ? false : v.briefing,
      maxFileBytes: v['max-file-bytes'] ? Number(v['max-file-bytes']) : undefined,
      maxTotalBytes: v['max-total-bytes'] ? Number(v['max-total-bytes']) : undefined,
      attempts: v.attempts ? Number(v.attempts) : undefined,
    });
    if (v.json) {
      const m = result.manifest;
      printLine(
        JSON.stringify({
          checkpointId: result.id,
          dir: result.dir,
          head: m.head,
          branch: m.branch,
          complete: m.complete,
          latestUpdated: result.latestUpdated,
          packOk: result.packOk,
          incompleteReasons: m.incompleteReasons,
        }),
      );
    } else {
      summarize(result, repo);
    }
    return result.manifest.complete && result.packOk && result.latestUpdated ? 0 : 3;
  } catch (err) {
    printErr(`checkpoint failed: ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
