# A1 foundation handoff and verification

Recorded 2026-10-11. This records checks actually performed, and distinguishes configured source, fixture tests and live service probes. Provider/Intelligence/domain application readiness is still pending user-owned credentials and later domain integration.

## Imported source and modifications

| Source | Exact pin | License / preserved code |
|---|---|---|
| CopilotKit/OpenDots | `625452e06cde74cb25b0ce319e2c1be0488f5a5f` | MIT, `apps/operator/LICENSE`; full shell/auth/workspace/runtime/reviews/computer composition/docs/tests/lock copied, nested `.git` excluded. |
| OpenDots bundled CopilotKit/OpenBot | `b6932d31a8d6e7896c15139dfc27a6c6911deb27` | MIT, `apps/operator/deployment/computers/LICENSE.openbot`; BuildKit Git source, original computer Dockerfile, original supervisor source with retained fail-closed per-Dot HMAC patch. |
| OpenBot full main gateway reference | `a4dce8c47c7253ecd9bd6f4e2626f4205817a104` | Reference only in this lane, not imported as the bundled sidecar or claimed active governance. |

Package name changed to `@expunge/operator`; package-lock metadata changed only for that identity. Package versions remain upstream resolved versions: AG-UI 0.0.59, CopilotKit 1.75.0, TanStack 0.63.0 / OpenAI adapter 0.25.1. The app remains standalone to preserve its lock; root core workspaces exclude it. Expunge additions are `src/shared/expunge.ts`, client `expunge/ExpungeFoundation.tsx`, server `expunge/domain-service.ts` / `routes.ts`, auth-bound app/index registration, navigation, exact environment templates and root `.env` startup wrapper.

Read/copy patterns: `src/server/app.ts` auth/origin/body boundary; `src/server/index.ts` dependency injection; `platform.ts` / `dot-agent.ts` / `Chat.tsx` retained unchanged runtime/review composition; `computer-service.ts` retained per-Dot HMAC/endpoint/action validation; `compose.computers.yml`, `compose.computers-app.yml`, supervisor Dockerfile/hardening script retained unchanged. New candidate isolation lives in `infra/opendots/`, not upstream.

## Checks already completed

| Check | Command / result |
|---|---|
| Exact source | `gh repo clone CopilotKit/OpenDots /private/tmp/expunge-opendots-625452e -- --no-checkout`; `git -C ... checkout --detach 625452e...`; rsync excluding `.git`. OpenBot source likewise checked out at `b6932d3...` for inspection. |
| Original install | Temp clone `npm ci --cache /private/tmp/expunge-npm-cache --no-audit --no-fund` initially failed with sandbox DNS `ENOTFOUND`; approved network retry succeeded, 1023 packages. |
| Untouched upstream | Temp clone `npm run build && npm run typecheck` passed on Node 25.2.1/npm 11.6.2. Node meets upstream ≥24. Vite reports inherited configLoader and bundle-size warnings. |
| Modified standalone install | `npm ci --cache /private/tmp/expunge-npm-cache --no-audit --no-fund --workspaces=false` in `apps/operator` passed, exact imported lock. |
| Modified typecheck / build | `npm run typecheck`; `npm run build` in `apps/operator` passed. Build log `/private/tmp/expunge-operator-build.log`. |
| Operator boundary fixtures | `npm test -- tests/expunge-foundation.test.ts tests/app.test.ts tests/computer.test.ts tests/computer-deployment.test.js tests/setup.test.ts tests/app-origin.test.ts`: **47 passed**. Tests verify inherited owner/origin/HMAC/action fixtures and new dependency/binding/cursor checks. They are not live computers/provider calls. The first new-route run exposed wildcard middleware lacking path parameters; validation moved to each parameterized handler, then checks passed. |
| Proxy fixture HTTP tests | `node --test infra/opendots/candidate-proxy.test.mjs`: **5 passed**. Loopback bind required sandbox escalation; initial EPERM was not a passing test. Covers default-deny, exact origin/path, missing auth, fixed candidate binding, token reflection, redirects and invalid configuration. |
| Real operator HTTP | Built app started on loopback `4390` with a temporary synthetic owner token and SQLite file in `/private/tmp`. UI **200**; unauthenticated status **401**; authenticated status **200**; evil origin **403**; unconfigured domain job **503**. Workspace setup reported missing Intelligence key / OpenAI key / model. No real provider response claimed. Temporary operator process stopped afterward. |
| Docker host | Existing `colima list/status` showed no VM; `colima start --cpu 4 --memory 8 --disk 40` completed. Default local Docker context is `colima`. No existing profile, files or data deleted. Engine kept running for other lanes. |
| Candidate Compose config | Rendered with temporary synthetic credentials to `/private/tmp/expunge-a1-compose.json`; asserted read-only root, cap-drop ALL, network namespace sharing, 1 CPU/2 GiB/256 PIDs, tmpfs quotas and no privileged environment keys. Full rendered config is local only because it contains test secrets. |
| Candidate firewall/proxy images | `docker compose --env-file /private/tmp/expunge-a1-host.env -p expunge-a1-candidate -f infra/opendots/compose.candidates.yml build candidate-netguard candidate-proxy`: passed. Up started both; netguard healthy with IPv4/IPv6 rules installed. |
| Real namespace isolation probe | Temporary **Node test container**, cap-drop ALL/no-new-privileges/read-only/128 MiB/32 PIDs, joined the actual guarded network namespace. Proxy returned **403** (default-deny); Internet IP, metadata, host gateway, another network address and public DNS all timed out/failed. Repeated after ingress bridge change; all unintended paths remained blocked. This is live firewall verification but not a claim of OpenBot computer readiness. |
| Control ingress correction | Live Docker inspection showed internal-only network suppresses host port publication. Added a per-project control ingress bridge while keeping namespace OUTPUT/FORWARD DROP. Final Compose shows `127.0.0.1:4313->4100/tcp`. Actual OpenBot control handshake awaits its image. |

Temporary synthetic secrets are in a mode-0600 `/private/tmp/expunge-a1-host.env`, never output or copied into the repository. Candidate environment holds only its derived child computer token; it receives no computer master, supervisor, database, private grader, model or telemetry key. Proxy's broker token remains proxy-only.

## In progress / gaps

Pinned image build is running using:

```sh
docker compose --env-file /private/tmp/expunge-a1-host.env -f apps/operator/compose.computers.yml build computer-image computer-supervisor
```

BuildKit input is the exact OpenBot Git revision above and retained upstream supervisor patch. Logs are `/private/tmp/expunge-a1-openbot-build.log`. Original computer Dockerfile inputs include Node `24.18.1-bookworm-slim`, Bun `1.3.14` pinned digest `e10577f0db68676a7024391c6e5cb4b879ebd17188ab750cf10024a6d700e5c4`, Ubuntu `24.04`, Playwright `1.62.1`; supervisor uses Bun `1.3.14-alpine` with frozen lock. Source pinning does not make all OS apt packages or base tags reproducible; resolved image IDs will be recorded on completion.

Pending: actual supervisor health and per-Dot source-file action; two real computer workspaces and credentials; actual OpenBot candidate start/action under firewall; authenticated broker/artifact route against B2; real Intelligence conversation/provider response; domain job persistence/read projections; production deployment. Read configuration status is not a backend health check. Candidate firewall probes currently use a Node container and are labeled that way.

## Integration handoff

B3 owns operator source after this handoff: native runtime/review path is preserved, read projection service injected through AppOptions and startup; no new actor authority comes from UI/model arguments. Implement POST job/review routes and ExpungeProjectionAgent at the frozen backend contract. Continuing event stream should start from authoritative snapshot and resume event ID/sequence; no chat turn can mark a job complete.

B2 owns the candidate transport/lifecycle and OpenMuse runtime. Use the candidate-only profile; ordinary per-Dot upstream computers remain unrestricted. Each candidate profile has its own guarded namespace/private network and bounded tmpfs. Parallel profiles need distinct subnets/ports. Supply exact admitted broker/artifact paths, scoped short-lived candidate capability, job/run/hash binding and fixed server principal; empty proxy allowlist is deliberate. Do not treat the proxy as a generic internet proxy or let candidate artifacts dynamically import into privileged services.

Root coordinator owns `.env` and root scripts/dependencies. `node apps/operator/scripts/run-from-root.mjs dev|build|start` loads root `.env` in memory and executes the standalone operator with its exact lock. See [README](README.md) for exact vendor environment names and topology. Candidate infrastructure can continue verifying without editing operator files.

## Correction: DNS (2026-10-11, B2 / runtime-raindrop)

The "public DNS ... timed out/failed" result in the namespace probe row above tested only direct resolvers (and the `fetch` of a hostname through them). It did not test Docker's embedded resolver, which was reachable over the loopback ACCEPT and was forwarded upstream by `dockerd`: `docs/review/repro/cand-dns.repro.sh` returned exit 0 (REPRODUCED, `example.com` resolved to public A records) against the guard built from `netguard.sh` as first written. The guard now drops `127.0.0.11` and port 53 (see README, "DNS, exactly"). On the rebuilt guard that repro exits 1 (NOT REPRODUCED) and `verify-candidate.mjs` passes with four DNS probes all blocked (`dns-system-resolver` ECONNREFUSED, `dns-getaddrinfo` EAI_AGAIN, `dns-embedded-127.0.0.11` ECONNREFUSED, `dns-direct-1.1.1.1` ECONNREFUSED). The candidate computer container reports `unhealthy` in `docker ps` both before and after this change (its own health check, unrelated to the guard).

