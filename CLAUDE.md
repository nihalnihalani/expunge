# Expunge workspace bootstrap

Read before editing, in this order:

1. `EXPUNGE-CLAUDE-GOAL-SPEC.txt` (full build specification; section 20 is the continuity protocol).
2. `HANDOFF.md` (local, ignored from Git) if present, else report that no prior checkpoint exists.
3. `docs/continuity/PROJECT-STATE.md`, `docs/continuity/TASKS.json`, `docs/continuity/OWNERSHIP.md`.
4. `COMMIT-LEDGER.md`, `PHASE-CHECKPOINTS.md`, and `.expunge/checkpoints/LATEST` if present.

Then run `git status`, `npm run typecheck`, `npx vitest run` and reconcile actual files against the recorded state before continuing. Never reset or discard user changes. Only the designated commit role writes the Git index. Credentials are read from the local `.env` and are never printed or committed.
