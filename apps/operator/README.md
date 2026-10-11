# Expunge operator console

The owner's console for Expunge. It shows every step of the self-improvement loop as stored state, so the operator can see what the agent did, what the grader found and what the harness changed into. See the [project README](../../README.md) for the full system.

## Views

The Expunge workbench lives at `#/expunge`.

| View | Shows |
|---|---|
| **Jobs** | Cleanup jobs with their verdict and the harness version each one ran on |
| **New cleanup** | Preview and submit a cleanup for a registered scope |
| **Setup** | Readiness of the domain service, evidence pipeline and configuration |
| **Workbench** | Per-job coverage, reference graph, trace and decision log |
| **Evidence** | The delivery ladder from telemetry to evidence bundle, with truncation and dead-letter states |
| **Candidate** | The typed before/after harness patch, the capabilities it changes and the compiler result, plus the approval dialog |
| **Evaluation** | The stored gate report by split, comparing parent and candidate per pair, with cost |
| **Receipt** | The committed completion receipt, including incomplete verdicts and the model narrative, labelled as unverified |
| **Lineage** | Harness versions, promotions with their gate report and consumed grant, rollbacks and rejected candidates |
| **Campaign** | Hider and meta-improver campaigns, with no gain claim |
| **Privacy** | All nine erasure statuses |

Every screen labels its data source. Committed screenshots in [`docs/ui/screens`](../../docs/ui/screens) come from a labelled fixture backend.

## Run

From the repository root:

```bash
npm ci --prefix apps/operator --workspaces=false
node apps/operator/scripts/run-from-root.mjs dev     # then open #/expunge
```

The server binds to loopback. It requires the owner token and an exact origin allowlist, and it reads its configuration from `.env.operator` at the repository root (names in [docs/ENVIRONMENT.md](../../docs/ENVIRONMENT.md)). Until the domain service URL is configured, the console runs in setup-only mode.

## Test

```bash
npm test --prefix apps/operator          # unit and component tests
npm run typecheck --prefix apps/operator
```

## Notices

This app includes third-party code under its original license; see [LICENSE](LICENSE), [THIRD_PARTY.md](THIRD_PARTY.md) and the repository's [THIRD_PARTY.md](../../THIRD_PARTY.md).
