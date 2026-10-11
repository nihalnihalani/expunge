#!/usr/bin/env node
// Restore a checkpoint's staged/unstaged patches and approved untracked copies onto a matching base.
//
//   node scripts/continuity/restore-checkpoint.mjs <checkpointDir|latest> <targetRepo> [--apply] [--allow-incomplete] [--force-review] [--json]
//
// Dry-run by default; --apply is required to write. The restore refuses unless the target HEAD matches the
// manifest base (or both are UNBORN), the pack re-hashes cleanly and the manifest is complete. It never applies
// a patch that is already present (file-hash comparison first, then `git apply --check` in an isolated scratch
// copy), never overwrites a differing file and never resets, stashes or checks out anything.
//
// Also refused: an active engineering-writer lock under <target>/.expunge/locks (exit 7, never removed, never
// overridden by any flag) and a stale checkpoint, i.e. files in the target that differ from both the checkpoint and
// the base commit (newer work than the narrative; exit 6 unless --force-review acknowledges it). Even then a path the
// restore would write is never overwritten.
//
// Exit codes: 0 READY (dry-run) / APPLIED / ALREADY_APPLIED; 2 usage; 3 invalid or incomplete checkpoint or bad
// target; 4 base mismatch; 5 conflict, partial presence or post-restore verification failure; 6 stale checkpoint
// needing --force-review; 7 active writer lock.
//
// After a successful --apply (APPLIED or ALREADY_APPLIED) the checkpoint's briefing is handed to the next agent:
// briefing/HANDOFF.md is copied to <target>/HANDOFF.md. A HANDOFF.md that already exists is never overwritten: if it
// is identical nothing happens, if it differs the copy is written beside it as HANDOFF.from-<checkpointId>.md (and
// if that name is taken by different content, nothing is written and the resume line names the pack copy). The
// result always ends with a `resume:` line naming the file to read first and the pack path. HANDOFF.md is
// gitignored in this project, so the copy does not appear in `git status`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  UNBORN,
  assertNoSymlinkParents,
  findWriterLocks,
  git,
  hashPath,
  headState,
  printErr,
  printLine,
  readManifest,
  resolveCheckpointArg,
  resolveInside,
  resolveRepoRoot,
  sha256Buffer,
  splitNul,
  verifyPack,
} from './lib.mjs';

function refuse(code, reason, detail = {}) {
  return { status: 'REFUSED', code, reason, ...detail };
}

function reviewedNotes(paths) {
  return paths.length > 0
    ? [`--force-review acknowledged ${paths.length} newer file(s) in the target; they are left untouched`]
    : [];
}

function copyIntoScratch(targetRoot, scratch, rel) {
  const src = resolveInside(targetRoot, rel);
  let st;
  try {
    st = fs.lstatSync(src);
  } catch {
    return;
  }
  const dest = resolveInside(scratch, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dest);
  else if (st.isFile()) {
    fs.copyFileSync(src, dest);
    fs.chmodSync(dest, st.mode & 0o777);
  }
}

/** Decide what a restore would do. Pure reads except for a throwaway scratch directory under the OS temp dir. */
export function planRestore(checkpointArg, targetArg, { allowIncomplete = false, forceReview = false } = {}) {
  const dir = path.resolve(checkpointArg);
  let manifest;
  try {
    manifest = readManifest(dir);
  } catch (err) {
    return refuse(3, 'INVALID_MANIFEST', { message: err.message });
  }
  const pack = verifyPack(dir, manifest);
  const badPack = pack.filter((r) => r.status !== 'MATCH');
  if (badPack.length > 0) {
    return refuse(3, 'PACK_CORRUPT', {
      message: `pack files not matching the manifest: ${badPack.map((r) => `${r.status} ${r.path}`).join('; ')}`,
    });
  }
  if (!manifest.complete && !allowIncomplete) {
    return refuse(3, 'INCOMPLETE_CHECKPOINT', {
      message: `manifest is incomplete: ${(manifest.incompleteReasons ?? []).join('; ')}`,
    });
  }
  let target;
  try {
    target = resolveRepoRoot(targetArg);
    if (fs.realpathSync(path.resolve(targetArg)) !== target)
      throw new Error('target must be the repository root');
  } catch (err) {
    return refuse(3, 'TARGET_NOT_REPO', { message: err.message });
  }
  const locks = findWriterLocks(target);
  if (locks.active.length > 0) {
    return refuse(7, 'ACTIVE_WRITER_LOCK', {
      message:
        'an engineering writer lock is active in the target; refusing to restore and not removing it: ' +
        locks.active
          .map(
            (l) =>
              `${l.name} (${l.pid ? `pid ${l.pid}` : 'no pid recorded'}${l.owner ? `, owner ${l.owner}` : ''})`,
          )
          .join('; ') +
        '. Stop the old writer or have its owner release the lock, then retry.',
      conflicts: locks.active.map((l) => ({ path: l.name, reason: 'active-writer-lock' })),
    });
  }
  const staleLocks = locks.stale.map((l) => `${l.name} (pid ${l.pid} not running; left in place)`);
  const targetHead = headState(target).head;
  if (targetHead !== manifest.head) {
    return refuse(4, 'BASE_MISMATCH', {
      message: `manifest base ${manifest.head} but target HEAD is ${targetHead}`,
      manifestHead: manifest.head,
      targetHead,
    });
  }

  const unborn = manifest.head === UNBORN;
  const stagedFile = path.join(dir, manifest.patches.staged.file);
  const unstagedFile = path.join(dir, manifest.patches.unstaged.file);
  const hasStaged = manifest.patches.staged.bytes > 0;
  const hasUnstaged = manifest.patches.unstaged.bytes > 0;
  const patchPaths = [
    ...new Set([...manifest.changes.staged, ...manifest.changes.unstaged].map((c) => c.path)),
  ].sort();
  const expected = (p) => manifest.files[p] ?? null;

  // Per-path classification by hash.
  const applied = [];
  const pending = [];
  const conflicts = [];
  const baseHash = (p) => {
    if (unborn) return null;
    const r = git(target, ['cat-file', 'blob', `HEAD:${p}`], { allowFail: true });
    return r.status === 0 ? sha256Buffer(r.stdout) : null;
  };
  // Newer work than this checkpoint: a file that differs from the checkpoint AND from the base state it would
  // otherwise still be at (HEAD content, or absent for untracked copies).
  const touched = new Set([...patchPaths, ...manifest.untracked.map((e) => e.path)]);
  // A path that reaches the target through a symlinked directory could be written outside the repository.
  const symlinked = [];
  for (const p of touched) {
    try {
      assertNoSymlinkParents(target, p);
    } catch (err) {
      symlinked.push({ path: p, reason: err.message });
    }
  }
  if (symlinked.length > 0) {
    return refuse(5, 'SYMLINKED_PATH', {
      message:
        'restore paths pass through symlinked directories in the target; refusing, nothing was written',
      conflicts: symlinked,
    });
  }
  const diverged = [];
  const divergedCheck = (p, want) => {
    const cur = hashPath(resolveInside(target, p));
    if (cur === want) return;
    if (touched.has(p) && cur === baseHash(p)) return;
    diverged.push(p);
  };
  for (const [p, want] of Object.entries(manifest.files)) divergedCheck(p, want);
  for (const p of manifest.deleted ?? []) divergedCheck(p, null);
  const divergedTouched = diverged.filter((p) => touched.has(p));
  if (divergedTouched.length > 0) {
    return refuse(5, 'CONFLICT', {
      message:
        'target files this restore would write were changed after the checkpoint and differ from the base; they are never overwritten, nothing was written',
      conflicts: divergedTouched.map((p) => ({ path: p, reason: 'changed-since-checkpoint' })),
    });
  }
  if (diverged.length > 0 && !forceReview) {
    return refuse(6, 'STALE_CHECKPOINT', {
      message: `${diverged.length} file(s) in the target differ from both the checkpoint and the base commit, so the target has newer work than this checkpoint. Review them, then rerun with --force-review; nothing was written`,
      conflicts: diverged.slice(0, 50).map((p) => ({ path: p, reason: 'changed-since-checkpoint' })),
    });
  }
  const reviewed = diverged;

  for (const p of patchPaths) {
    const cur = hashPath(resolveInside(target, p));
    if (cur !== expected(p)) pending.push(p);
    else if (expected(p) !== baseHash(p)) applied.push(p);
  }
  const copyPending = [];
  for (const e of manifest.untracked) {
    const cur = hashPath(resolveInside(target, e.path));
    if (cur === e.sha256) applied.push(e.path);
    else if (cur === null) copyPending.push(e);
    else conflicts.push({ path: e.path, reason: 'untracked-path-exists-with-different-content' });
  }
  const counts = { applied: applied.length, pending: pending.length + copyPending.length };

  if (conflicts.length > 0)
    return refuse(5, 'CONFLICT', {
      message: 'target has differing files at restore paths; nothing was written',
      conflicts,
      counts,
    });
  if (pending.length === 0 && copyPending.length === 0) {
    return {
      status: 'ALREADY_APPLIED',
      code: 0,
      manifest,
      target,
      dir,
      counts,
      actions: [],
      notes: [...staleLocks, ...reviewedNotes(reviewed)],
    };
  }
  if (applied.length > 0) {
    return refuse(5, 'PARTIAL_PRESENT', {
      message: 'part of the checkpoint is already present in the target and part is not; refusing to guess',
      conflicts: pending
        .map((p) => ({ path: p, reason: 'not-yet-restored' }))
        .concat(applied.map((p) => ({ path: p, reason: 'already-matches-checkpoint' }))),
      counts,
    });
  }

  // Index must be clean on touched paths so `git apply --index` and the recorded staged state stay exact.
  if (patchPaths.length > 0) {
    const stagedNow = new Set(splitNul(git(target, ['diff', '--cached', '--name-only', '-z']).stdout));
    const dirty = patchPaths.filter((p) => stagedNow.has(p));
    if (dirty.length > 0) {
      return refuse(5, 'INDEX_DIRTY', {
        message: 'target index already has staged changes on restore paths',
        conflicts: dirty.map((p) => ({ path: p, reason: 'staged-in-target' })),
        counts,
      });
    }
  }
  if (unborn && copyPending.length > 0) {
    const inIndex = new Set(splitNul(git(target, ['ls-files', '-z']).stdout));
    const dirty = copyPending.filter((e) => inIndex.has(e.path));
    if (dirty.length > 0) {
      return refuse(5, 'INDEX_DIRTY', {
        message: 'target index already lists restore paths',
        conflicts: dirty.map((e) => ({ path: e.path, reason: 'in-target-index' })),
        counts,
      });
    }
  }

  // Patch applicability: dry-run both patches in sequence against an isolated scratch copy of the touched files.
  if (hasStaged || hasUnstaged) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'expunge-restore-'));
    try {
      for (const p of patchPaths) copyIntoScratch(target, scratch, p);
      const env = { GIT_CEILING_DIRECTORIES: path.dirname(scratch) };
      if (hasStaged) {
        const check = git(scratch, ['apply', '--check', stagedFile], { allowFail: true, env });
        if (check.status !== 0) {
          return refuse(5, 'PATCH_DOES_NOT_APPLY', {
            message: `staged.patch does not apply: ${check.stderr.toString('utf8').trim().split('\n')[0]}`,
            counts,
          });
        }
        git(scratch, ['apply', stagedFile], { env });
      }
      if (hasUnstaged) {
        const check = git(scratch, ['apply', '--check', unstagedFile], { allowFail: true, env });
        if (check.status !== 0) {
          return refuse(5, 'PATCH_DOES_NOT_APPLY', {
            message: `unstaged.patch does not apply: ${check.stderr.toString('utf8').trim().split('\n')[0]}`,
            counts,
          });
        }
      }
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }

  const actions = [];
  if (hasStaged) actions.push({ kind: 'apply-staged-patch', files: manifest.patches.staged.files });
  if (hasUnstaged) actions.push({ kind: 'apply-unstaged-patch', files: manifest.patches.unstaged.files });
  if (copyPending.length > 0) actions.push({ kind: 'copy-untracked', files: copyPending.length });
  return {
    notes: [
      ...staleLocks,
      ...reviewedNotes(reviewed),
      ...(manifest.briefing
        ? [
            `--apply will also copy the briefing to ${path.basename(manifest.briefing.copy)} in the target (or ${briefingAlongsideName(manifest, path.basename(manifest.briefing.copy))} if one already exists)`,
          ]
        : []),
    ],
    status: 'READY',
    code: 0,
    manifest,
    target,
    dir,
    counts,
    actions,
    stagedFile,
    unstagedFile,
    hasStaged,
    hasUnstaged,
    patchPaths,
    copyPending,
  };
}

/** Apply a READY plan. Returns { status: 'APPLIED' | 'REFUSED', ... }. */
export function applyRestore(plan) {
  const { manifest, target } = plan;
  let stagedApplied = false;
  try {
    if (plan.hasStaged) {
      git(target, ['apply', '--index', plan.stagedFile]);
      stagedApplied = true;
    }
    if (plan.hasUnstaged) git(target, ['apply', plan.unstagedFile]);
  } catch (err) {
    if (stagedApplied) git(target, ['apply', '-R', '--index', plan.stagedFile], { allowFail: true });
    return refuse(5, 'APPLY_FAILED', {
      message: `${err.message}; staged patch was rolled back if it had been applied`,
    });
  }
  for (const e of plan.copyPending) {
    assertNoSymlinkParents(target, e.path);
    const dest = resolveInside(target, e.path);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.expunge-restore-${randomBytes(4).toString('hex')}`;
    fs.copyFileSync(path.join(plan.dir, e.copy), tmp);
    fs.chmodSync(tmp, e.mode === '100755' ? 0o755 : 0o644);
    fs.renameSync(tmp, dest);
  }
  const mismatches = [];
  for (const p of new Set([...plan.patchPaths, ...manifest.untracked.map((e) => e.path)])) {
    const cur = hashPath(resolveInside(target, p));
    if (cur !== (manifest.files[p] ?? null))
      mismatches.push({ path: p, reason: 'post-restore-hash-mismatch' });
  }
  if (mismatches.length > 0)
    return refuse(5, 'POST_VERIFY_FAILED', {
      message: 'restored files do not match the manifest hashes',
      conflicts: mismatches,
    });
  return {
    status: 'APPLIED',
    code: 0,
    manifest,
    target,
    dir: plan.dir,
    counts: plan.counts,
    actions: plan.actions,
    notes: plan.notes,
  };
}

const briefingAlongsideName = (manifest, name) => {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  return `${stem}.from-${manifest.checkpointId}${ext}`;
};

function writeExclusive(file, buf) {
  // 'wx' refuses an existing path and a symlink, so a concurrent writer or a planted link is never followed.
  fs.writeFileSync(file, buf, { flag: 'wx', mode: 0o644 });
}

function sameBytes(file, buf) {
  try {
    const st = fs.lstatSync(file);
    return st.isFile() && !st.isSymbolicLink() && fs.readFileSync(file).equals(buf);
  } catch {
    return false;
  }
}

/**
 * Hand the checkpoint's briefing to the next agent without ever overwriting an existing file.
 * Returns { status, file, packFile, resume } with status one of:
 *   none | written | already-present | written-alongside | already-present-alongside | not-written
 */
export function placeBriefing({ manifest, dir, target }) {
  const b = manifest.briefing;
  if (!b) {
    return {
      status: 'none',
      file: null,
      packFile: null,
      resume: `this checkpoint has no briefing; read the repository's own handoff documents and the pack at ${dir}`,
    };
  }
  const packFile = path.join(dir, b.copy);
  const buf = fs.readFileSync(packFile);
  if (sha256Buffer(buf) !== b.sha256)
    throw new Error('briefing copy in the pack no longer matches the manifest');
  const name = path.basename(b.copy);
  const primary = resolveInside(target, name);
  let status;
  let file = primary;
  try {
    writeExclusive(primary, buf);
    status = 'written';
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    if (sameBytes(primary, buf)) status = 'already-present';
    else {
      file = resolveInside(target, briefingAlongsideName(manifest, name));
      try {
        writeExclusive(file, buf);
        status = 'written-alongside';
      } catch (err2) {
        if (err2.code !== 'EEXIST') throw err2;
        if (sameBytes(file, buf)) status = 'already-present-alongside';
        else {
          status = 'not-written';
          file = null;
        }
      }
    }
  }
  const extra = ['CLAUDE.md', 'AGENTS.md', 'EXPUNGE-PORTABLE-RESUME-PROMPT.txt'].filter((f) =>
    fs.existsSync(path.join(target, f)),
  );
  const first = file ?? packFile;
  const resume =
    `read ${first} first${extra.length > 0 ? `, then ${extra.join(' and ')}` : ''}; ` +
    `the checkpoint pack is ${dir} (keep it with the repository: \`node scripts/continuity/verify-checkpoint.mjs ${dir} --repo ${target}\` re-hashes this tree against it)`;
  return { status, file, packFile, resume };
}

/** After a successful --apply: place the briefing and attach it plus the resume instruction to the result. */
export function completeRestore(result) {
  if (result.status !== 'APPLIED' && result.status !== 'ALREADY_APPLIED') return result;
  const placed = placeBriefing({ manifest: result.manifest, dir: result.dir, target: result.target });
  return { ...result, briefing: placed, notes: [...(result.notes ?? [])] };
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        apply: { type: 'boolean' },
        'allow-incomplete': { type: 'boolean' },
        'force-review': { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    });
  } catch (err) {
    printErr(`usage error: ${err.message}`);
    return 2;
  }
  if (parsed.values.help || parsed.positionals.length !== 2) {
    printLine(
      'Usage: node scripts/continuity/restore-checkpoint.mjs <checkpointDir|latest> <targetRepo> [--apply] [--allow-incomplete] [--force-review] [--json]',
    );
    printLine(
      'Dry-run by default. Exit: 0 ok; 2 usage; 3 invalid checkpoint/target; 4 base mismatch; 5 conflict; 6 stale checkpoint (needs --force-review); 7 active writer lock.',
    );
    return parsed.values.help ? 0 : 2;
  }
  try {
    let source;
    try {
      source = resolveRepoRoot(process.cwd());
    } catch {
      source = process.cwd();
    }
    const dir = resolveCheckpointArg(parsed.positionals[0], source);
    const plan = planRestore(dir, parsed.positionals[1], {
      allowIncomplete: parsed.values['allow-incomplete'],
      forceReview: parsed.values['force-review'],
    });
    let result = plan;
    if (plan.status === 'READY' && parsed.values.apply) result = applyRestore(plan);
    if (parsed.values.apply) result = completeRestore(result);
    const mode = parsed.values.apply ? 'APPLY' : 'DRY-RUN';
    if (parsed.values.json) {
      printLine(
        JSON.stringify({
          mode,
          status: result.status,
          code: result.code,
          reason: result.reason,
          message: result.message,
          counts: result.counts,
          actions: result.actions,
          conflicts: result.conflicts,
          notes: result.notes,
          briefing: result.briefing
            ? {
                status: result.briefing.status,
                file: result.briefing.file,
                packFile: result.briefing.packFile,
              }
            : undefined,
          resume: result.briefing?.resume,
        }),
      );
    } else {
      printLine(`restore (${mode}): ${dir} -> ${parsed.positionals[1]}`);
      printLine(`status: ${result.status}${result.reason ? ` ${result.reason}` : ''}`);
      if (result.message) printLine(`detail: ${result.message}`);
      for (const c of result.conflicts ?? []) printLine(`  ${c.reason}: ${c.path}`);
      for (const a of result.actions ?? []) printLine(`  ${a.kind}: ${a.files} file(s)`);
      for (const n of result.notes ?? []) printLine(`note: ${n}`);
      if (result.status === 'READY') printLine('nothing written; pass --apply to restore');
      if (result.status === 'ALREADY_APPLIED') printLine('no-op: the target already matches this checkpoint');
      if (result.briefing) {
        const bf = result.briefing;
        const label = {
          none: 'no briefing in this checkpoint',
          written: `copied to ${bf.file}`,
          'already-present': `already present at ${bf.file}`,
          'written-alongside': `an existing HANDOFF.md differs and was not touched; copied to ${bf.file}`,
          'already-present-alongside': `an existing HANDOFF.md differs and was not touched; the copy is already at ${bf.file}`,
          'not-written': `an existing HANDOFF.md and its alongside copy both differ; nothing written, read ${bf.packFile}`,
        }[bf.status];
        printLine(`briefing: ${label}`);
        printLine(`resume: ${bf.resume}`);
      }
    }
    return result.code;
  } catch (err) {
    printErr(`restore failed: ${err.message}`);
    return 3;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
