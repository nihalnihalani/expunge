# Third-party code and attribution

| Component | Source and pin | License | Where | Modifications |
|---|---|---|---|---|
| CopilotKit OpenDots | https://github.com/CopilotKit/OpenDots at `625452e06cde74cb25b0ce319e2c1be0488f5a5f` | MIT (`apps/operator/LICENSE`) | `apps/operator/` | Package renamed to `@expunge/operator`; Expunge additions under `src/shared/expunge.ts`, `src/server/expunge/`, `src/client/expunge/`; see `apps/operator/THIRD_PARTY.md` |
| CopilotKit OpenBot (computer and supervisor services bundled by OpenDots) | https://github.com/CopilotKit/OpenBot at `b6932d31a8d6e7896c15139dfc27a6c6911deb27` | MIT (`apps/operator/deployment/computers/LICENSE.openbot`) | built by `apps/operator/compose.computers.yml`; reused by `infra/opendots/compose.candidates.yml` | Upstream per-Dot token patch retained; Expunge adds the candidate network guard and proxy (new code) |
| CopilotKit OpenBot main gateway (reference only) | `a4dce8c47c7253ecd9bd6f4e2626f4205817a104` | MIT | not imported | Ordering of resolution, policy, decision, action, outcome is re-implemented in the Expunge gateway |
| CopilotKit OpenMuse `tanstackAgent` helpers | https://github.com/CopilotKit/openmuse at `1ac68f3909f2478ab6280883f1ab5ea65eb5719d` | MIT | `packages/vendor-openmuse/` (commits fe12b51, 191cbb4) | Adapted to TanStack AI 0.63.0 / CopilotKit runtime 1.75.0; modifications M1 to M14 listed in that package's `THIRD_PARTY.md` |
| npm dependencies | see `package.json`, `package-lock.json`, `apps/operator/package-lock.json` | respective licenses | `node_modules/` (not committed) | none |
| Raindrop SDK and its transitive tree | `raindrop-ai` 1.0.1 (commit ba41d7b) pulling 126 third-party packages: OpenTelemetry 1.x, `@traceloop/*` instrumentations, `@grpc/grpc-js`, `protobufjs`, `@jitl/quickjs-*`, `@langchain/core`, `langsmith` | MIT 60, Apache-2.0 51, BSD-3-Clause 10, ISC 4, BSD-2-Clause 1 (verifier count on the regenerated lock) | `node_modules/` (not committed) | none; advisory assessment in `PRODUCTION-READINESS.md` |

Licensing permits reuse; it does not by itself certify event eligibility. The team confirmed fork permission with the organizers (see `BUILT_DURING_EVENT.md`).
