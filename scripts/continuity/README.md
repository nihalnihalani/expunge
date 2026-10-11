# Continuity tooling

Owned by the verifier. Three commands, no dependencies beyond Node and git. They never run `git add`, `commit`,
`stash`, `checkout` or `reset`.

| Command | What it does |
|---|---|
| `npm run checkpoint` | Writes an immutable pack under `.expunge/checkpoints/<UTC timestamp>-<8 hex>/`: `manifest.json`, `staged.patch`, `unstaged.patch`, `untracked/<path>` copies and `briefing/HANDOFF.md`. Moves `LATEST` only when the pack is `complete` and re-hashes clean. |
| `npm run checkpoint:verify -- <dir\|latest> [--repo DIR] [--pack-only] [--json]` | Re-hashes the pack and the working tree: `MATCH`, `CHANGED` or `MISSING` per file. Exit 0 only when everything matches. |
| `npm run checkpoint:restore -- <dir\|latest> <targetRepo> [--apply] [--force-review] [--allow-incomplete] [--json]` | Dry-run by default. Applies the staged and unstaged patches and the untracked copies onto a target whose HEAD equals the manifest base. Exit codes: 0 ok, 2 usage, 3 invalid or incomplete pack or bad target, 4 base mismatch, 5 conflict, 6 stale checkpoint (needs `--force-review`), 7 active writer lock. |

`npm run test:continuity` runs the suite (`scripts/continuity/test/*.test.mjs`).

## Taking the pack to another machine

- `.expunge/` is gitignored, so **the pack does not travel with git**. `checkpoint:verify -- latest` and
  `checkpoint:restore -- latest` read `<repo>/.expunge/checkpoints/LATEST`; on a fresh clone that pointer does not
  exist and the command says so. Copy the `.expunge/checkpoints` directory (or the whole working directory) with the
  repository, or pass the explicit checkpoint directory.
- **`LATEST` lags HEAD.** It names the last checkpoint taken, not the last commit. After a commit the files still
  compare by content, but the pack's `HANDOFF.md` describes the tree before it. `verify` prints
  `note: HEAD moved since the checkpoint` (and `headMoved` in `--json`) when the base differs. Take a new checkpoint
  after each verified commit.

## What `restore --apply` hands to the next agent

After a successful apply (`APPLIED`, or `ALREADY_APPLIED` on a rerun) the checkpoint's `briefing/HANDOFF.md` is copied
to `<target>/HANDOFF.md` (gitignored in this project, so `git status` stays clean). An existing `HANDOFF.md` is never
overwritten:

| State of the target | Result |
|---|---|
| no `HANDOFF.md` | copied (`written`) |
| identical `HANDOFF.md` | left alone (`already-present`) |
| differing `HANDOFF.md` or a symlink | copy written as `HANDOFF.from-<checkpointId>.md` (`written-alongside`); the existing file or link target is untouched |
| that name also taken by different content | nothing written (`not-written`); the resume line names the pack copy |

The command always ends with a `resume:` line naming the file to read first (then `CLAUDE.md`, `AGENTS.md` and
`EXPUNGE-PORTABLE-RESUME-PROMPT.txt` when present), the pack path, and the `verify-checkpoint` command that re-hashes
the restored tree.

## What a checkpoint withholds

Secrets and sealed or private material are never copied or patched; rule ids are reported, values never. A dropped
non-ignored file makes the checkpoint `complete: false`, and an incomplete pack never moves `LATEST`. The scanner
treats credentialed `mongodb://` and `mongodb+srv://` URIs as secrets unless the host is reserved or example
(`localhost`, `127.*`, `*.example`, `*.invalid`, `*.test`) or the password is shorter than three characters, and ignores
bearer tokens that name themselves as fixtures (`test`, `fake`, `dummy`, `mock`, `example`, `sample`, `fixture`,
`canary`, `placeholder`, `changeme`, `redacted`). A random-looking bearer token is still a finding.
