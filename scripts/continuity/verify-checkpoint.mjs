#!/usr/bin/env node
// Re-hash a checkpoint against its recorded manifest and (optionally) a working tree.
//
//   node scripts/continuity/verify-checkpoint.mjs <checkpointDir|latest> [--repo DIR] [--pack-only] [--verbose] [--json]
//
// Reports MATCH / CHANGED / MISSING per file. Exit 0 only if every checked file is MATCH; 1 if any file is
// CHANGED or MISSING; 2 for usage errors or an unreadable/invalid manifest.
//
// Notes for readers of the result:
// - `latest` resolves <repo>/.expunge/checkpoints/LATEST. .expunge/ is gitignored, so a pack only reaches another
//   machine if the directory is copied with the repository; otherwise pass an explicit checkpoint directory.
// - LATEST lags HEAD: it names the last checkpoint taken, not the last commit. After a commit the files still
//   compare by content, but the checkpoint's briefing describes the tree before it. When HEAD differs from the
//   checkpoint's base the result says so (`headMoved`, and a `note:` line); take a new checkpoint after each
//   verified commit (`npm run checkpoint`).
import fs from 'node:fs';
import process from 'node:process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  countStatuses,
  headState,
  printErr,
  printLine,
  readManifest,
  resolveCheckpointArg,
  resolveRepoRoot,
  verifyPack,
  verifyWorktree,
} from './lib.mjs';

/** Library entry point used by tests and other tools. */
export function verifyCheckpoint(checkpointDir, { repo, packOnly = false } = {}) {
  const manifest = readManifest(checkpointDir);
  const pack = verifyPack(checkpointDir, manifest);
  const worktree = packOnly ? [] : verifyWorktree(repo, manifest);
  const ok = [...pack, ...worktree].every((r) => r.status === 'MATCH');
  let headMoved = null;
  if (repo) {
    try {
      const current = headState(repo).head;
      if (current !== manifest.head) headMoved = { checkpointBase: manifest.head, current };
    } catch {
      headMoved = null;
    }
  }
  return {
    manifest,
    pack,
    worktree,
    ok,
    headMoved,
    counts: { pack: countStatuses(pack), worktree: countStatuses(worktree) },
  };
}

function main(argv) {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        repo: { type: 'string' },
        'pack-only': { type: 'boolean' },
        verbose: { type: 'boolean' },
        json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      allowPositionals: true,
    });
  } catch (err) {
    printErr(`usage error: ${err.message}`);
    return 2;
  }
  if (parsed.values.help || parsed.positionals.length !== 1) {
    printLine(
      'Usage: node scripts/continuity/verify-checkpoint.mjs <checkpointDir|latest> [--repo DIR] [--pack-only] [--verbose] [--json]',
    );
    return parsed.values.help ? 0 : 2;
  }
  let repo;
  let dir;
  try {
    repo = parsed.values.repo ? resolveRepoRoot(parsed.values.repo) : resolveRepoRoot(process.cwd());
  } catch {
    repo = null;
  }
  try {
    dir = resolveCheckpointArg(parsed.positionals[0], repo ?? process.cwd());
    if (!fs.existsSync(dir)) throw new Error(`checkpoint directory not found: ${dir}`);
    if (!repo) {
      const m = readManifest(dir);
      repo = fs.existsSync(m.repoRoot) ? m.repoRoot : null;
    }
    if (!repo && !parsed.values['pack-only'])
      throw new Error('no repository to compare against; pass --repo or --pack-only');
    const result = verifyCheckpoint(dir, { repo, packOnly: parsed.values['pack-only'] });
    if (parsed.values.json) {
      printLine(
        JSON.stringify({
          checkpointId: result.manifest.checkpointId,
          ok: result.ok,
          counts: result.counts,
          headMoved: result.headMoved,
          pack: result.pack,
          worktree: result.worktree,
        }),
      );
    } else {
      printLine(
        `checkpoint: ${result.manifest.checkpointId}  base: ${result.manifest.head}  complete: ${result.manifest.complete}`,
      );
      for (const r of result.pack)
        if (parsed.values.verbose || r.status !== 'MATCH') printLine(`${r.status} pack ${r.path}`);
      for (const r of result.worktree)
        if (parsed.values.verbose || r.status !== 'MATCH')
          printLine(`${r.status} ${r.path}${r.note ? ` (${r.note})` : ''}`);
      const p = result.counts.pack;
      const w = result.counts.worktree;
      printLine(`pack: MATCH=${p.MATCH} CHANGED=${p.CHANGED} MISSING=${p.MISSING}`);
      if (!parsed.values['pack-only'])
        printLine(`worktree (${repo}): MATCH=${w.MATCH} CHANGED=${w.CHANGED} MISSING=${w.MISSING}`);
      if (result.headMoved) {
        const short = (h) => (h.length > 12 ? h.slice(0, 12) : h);
        printLine(
          `note: HEAD moved since the checkpoint (base ${short(result.headMoved.checkpointBase)}, now ${short(result.headMoved.current)}); files are compared by content, but the checkpoint's briefing describes the older tree. Take a new checkpoint after the commit: npm run checkpoint`,
        );
      }
      printLine(result.ok ? 'RESULT: ALL MATCH' : 'RESULT: MISMATCH');
    }
    return result.ok ? 0 : 1;
  } catch (err) {
    printErr(`verify failed: ${err.message}`);
    return 2;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
