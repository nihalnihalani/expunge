# OpenDots and candidate computer topology

The operator is the real OpenDots source at `625452e06cde74cb25b0ce319e2c1be0488f5a5f`, retained in `apps/operator/`. Its ordinary per-Dot computer and supervisor are built from OpenBot `b6932d31a8d6e7896c15139dfc27a6c6911deb27`. Preserve its [computer setup](../../apps/operator/docs/COMPUTERS.md) and [MIT notice / token patch](../../apps/operator/deployment/computers/README.md). These are separate from the full OpenBot main gateway referenced by the blueprint.

## Operator startup

The operator intentionally remains a standalone npm project with its exact upstream lock. Root core workspaces use a separate lock. From repository root:

```sh
npm ci --prefix apps/operator --workspaces=false
node apps/operator/scripts/run-from-root.mjs dev
```

The wrapper loads the user's **root `.env`** in memory without copying or printing secrets, then runs the operator in its own directory. Root `npm run dev` can call this wrapper. Production uses wrapper `build`, then `start`; Vite serves development UI on `5173` and Hono on `4310`. Existing process environment takes precedence over root `.env`; the original operator startup can load an additional `apps/operator/.env` for standalone use.

Exact hosted names: `CPK_INTELLIGENCE_API_KEY` (preferred), legacy `INTELLIGENCE_API_KEY`, `CPK_TELEMETRY_ID`, `OPENAI_API_KEY`, `OPENAI_MODEL`, optional `OPENAI_BASE_URL`, `OWNER_ID`, `OWNER_TOKEN`, `APP_ORIGIN`, `DATABASE_PATH`. `APP_ORIGIN` uses exact origins with scheme and port. External HOST bindings require an owner token of at least 24 characters. Copy [hosted](../../apps/operator/.env.hosted.example) or [local evaluation](../../apps/operator/.env.local-evaluation.example) values into the user-owned root `.env`. Local evaluation does not make the Intelligence chat operational.

`EXPUNGE_DOMAIN_URL` is an origin such as `http://127.0.0.1:4320`; `EXPUNGE_INTERNAL_TOKEN` is its server-only read projection principal. Leave the URL unset to boot the independent shell. A configured URL is not a connectivity check. The service must authenticate the internal principal and bind its allowed owner/scope from trusted configuration, not accept a browser-supplied tenant/role. Native SQLite remains workspace/chat state only.

Read seams, all behind the original owner/origin boundary:

| Operator route | Trusted service method | Private transport route |
|---|---|---|
| `GET /api/expunge/status` | Configuration status only | none |
| `GET /api/expunge/jobs/:jobId` | `readJob(jobId, signal)` | `GET /internal/projection/jobs/:jobId` |
| `GET /api/expunge/jobs/:jobId/events?afterSequence=N` | `readCommittedEvents(jobId, N, signal)` | Same path with `/events?afterSequence=N` |

B3 owns submission/review/receipt screens and continuing SSE projection. Initial event pages are committed JSON with event IDs and ordered sequences; no model state is used to derive authority. Missing backend returns 503. The transport carries server-configured owner ID and service token; the backend must map that principal to the authoritative ActorContext and reject unauthorized job access. If multiple humans are added, replace the single owner binding with verified session-to-principal mapping.

## Ordinary OpenDots computers

From root, with server-only `COMPUTER_SUPERVISOR_TOKEN`, `COMPUTER_TOKEN` and stable `COMPUTER_NAMESPACE` in root `.env`:

```sh
docker compose --env-file .env -f apps/operator/compose.computers.yml build computer-image computer-supervisor
docker compose --env-file .env -f apps/operator/compose.computers.yml up -d computer-supervisor
```

The host app uses `COMPUTER_SUPERVISOR_URL=http://127.0.0.1:4312`. Only the supervisor mounts the Docker socket. Its child environment patch derives a separate token for each Dot. Neither the ordinary computer nor the app receives the socket. These ordinary computers preserve upstream persistent volumes and have upstream unrestricted network access; **they are not candidate execution sandboxes**.

## Restricted candidates

The new [candidate Compose file](compose.candidates.yml) runs the same pinned computer image in a separate disposable profile. A network guard container owns the network namespace and installs IPv4/IPv6 default-deny input/output/forward rules before the candidate starts. Only authenticated computer control on 4100, loopback, response packets and outbound TCP to the fixed proxy IP/4314 are admitted. The candidate has all capabilities dropped, `no-new-privileges`, no Docker socket and no NET_ADMIN. A root candidate cannot rewrite the namespace firewall without a kernel/container escape.

The artifact network is Docker `internal: true`; a separate per-project ingress bridge enables the loopback-published authenticated computer control port. Docker suppresses host port publication when a container joins only internal networks. The namespace firewall blocks all new outbound traffic on that ingress bridge as well as host gateways, neighboring computers, arbitrary private addresses, metadata and the public Internet. The candidate maps the proxy via `/etc/hosts`, so it never needs name resolution.

**DNS, exactly.** Direct DNS to public resolvers was always blocked by the default-deny policy. That was not enough: Docker's embedded resolver (`nameserver 127.0.0.11`) is reached over loopback, the guard accepts loopback, and `dockerd` forwards the query upstream because the guard also joins the non-internal ingress bridge. The result was a working recursive-DNS exfiltration channel (reproduced by `docs/review/repro/cand-dns.repro.sh`, exit 0, before the fix). `netguard.sh` now installs, ahead of every ACCEPT and in both IP families: `DROP` of all traffic to or from `127.0.0.11` (IPv4 only, matched by address because Docker's nat DNAT rewrites `127.0.0.11:53` to a high port before the filter table runs), and `DROP` of TCP/UDP destination port 53 outbound and source port 53 inbound on every interface including `lo`. The guard's startup self-check refuses to create `/run/ready` unless the DNS drops are present, and the Compose healthcheck keeps asserting the `127.0.0.11` drop. The fix is the filter rules; setting a `dns:` option would not help because user-defined networks always use the embedded resolver.

Proof, on the rebuilt guard: the devil's-advocate repro now reports `NOT REPRODUCED` (system resolver `ECONNREFUSED`), and `verify-candidate.mjs` runs four DNS probes from inside the guarded namespace through the candidate's own `/exec` (system resolver, `getaddrinfo`, the embedded resolver `127.0.0.11` explicitly, and `1.1.1.1`) and fails if any resolves or if any probe row is missing. What this does not cover: DNS-over-HTTPS or any other channel to the fixed proxy at `PROXY_IPV4:4314` (that route is exact-path admitted by the proxy, not DNS), and the rule set was not re-proven against a kernel/container escape. The proxy is a restricted reverse proxy with **exact method/path admission**, fixed broker origin, separate candidate authentication, server-held broker credential, fixed candidate ID, request/response byte limits, timeout and no redirect/CONNECT/upgrade/generic forwarding. Its empty allowlist denies every request. Merely setting an HTTP proxy would not restrict direct shell networking; the firewall supplies that boundary.

The proxy alone joins the separate internal broker network. Attach only B2's trusted candidate broker there; do not attach MongoDB, grader, promoter, privileged control APIs or the operator. The broker must bind job/run/candidate/artifact hashes and reject forbidden promotion/oracle/data actions even for an admitted route. A proxy path allowlist does not implement domain authorization.

```sh
# Fill only candidate-specific configuration; file should be mode 0600.
cp infra/opendots/.env.candidates.example infra/opendots/.env.candidates.local
docker compose --env-file infra/opendots/.env.candidates.local -p expunge-candidate-1 -f infra/opendots/compose.candidates.yml build candidate-netguard candidate-proxy
docker compose --env-file infra/opendots/.env.candidates.local -p expunge-candidate-1 -f infra/opendots/compose.candidates.yml up -d
```

The proxy-to-broker principal is `EXPUNGE_CANDIDATE_BROKER_TOKEN`. It is a different principal from the operator's `EXPUNGE_INTERNAL_TOKEN` (read-projection only): the proxy refuses to start if `EXPUNGE_INTERNAL_TOKEN` is present in its environment and, when `EXPUNGE_OPERATOR_TOKEN_SHA256` (the hex SHA-256 of the operator token, never the token) is set, refuses a broker or candidate token that hashes to it. The trusted broker must still authenticate the broker principal and reject the operator principal on candidate routes (broker work, not yet built). Do not use a master/supervisor key as `EXPUNGE_CANDIDATE_COMPUTER_TOKEN`. Derive the child token on the server for the candidate Dot ID, without exposing the master. B2 stages the separate scoped broker capability only when needed. No database, model, Intelligence, Raindrop or grader credentials are permitted in candidate environment/files.

One candidate runs per Compose project. Parallel projects need distinct loopback ports and non-overlapping /29 subnets; the proxy stays private to each. This is a candidate-only static provisioning seam, separate from native per-Dot supervisor lifecycle. B2 owns artifact transport and authenticated candidate lifecycle binding.

Bounds: 1 CPU, 2 GiB memory with no extra swap, 256 PIDs, read-only root, 64 MiB workspace, 256 MiB profiles, 512 MiB temporary directory, 32 MiB cache and 512 MiB shared memory. Candidate files are disposable tmpfs; export/hash artifacts before replacing the container. Ordinary Dot persistent volumes are untouched. The proxy has 0.25 CPU/128 MiB/32 PIDs. Docker shares the host kernel; this overlay does not install gVisor or establish a microVM boundary.

## Trusted broker (`--profile broker`)

`candidate-broker.mjs` is the only service behind the proxy and has exactly two typed routes, admitted by exact method/path in
`EXPUNGE_CANDIDATE_ALLOWED_ROUTES='[{"method":"POST","path":"/artifact/fetch"},{"method":"POST","path":"/result/submit"}]'`:

- `POST /artifact/fetch {artifactHash}` returns the bytes of an ADMITTED artifact (files named by their own sha256 in a read-only
  directory, re-hashed on every serve, at most 256 KiB).
- `POST /result/submit {ticketId, value}` takes a result for one RUN TICKET. The trusted side mints the ticket (a 128-bit random
  id bound to candidate, slot, artifact hash, input hash, job, run and call number, with an expiry of at most 10 minutes; see
  `mintRunTicket` in `@expunge/plugin-sandbox`) and writes it to the broker's read-only ticket directory; only that run is handed
  the id. The candidate names a ticket and supplies the value; it cannot choose any bound field, so it cannot write another
  run's result, and a guessed, unminted, expired or foreign-candidate ticket is refused. One value is accepted per ticket and per
  call (same value again is idempotent, a different one is a 409, even from a second ticket for the same call). The record of what
  was accepted is the append-only spool, which the broker re-reads at start, so a restart does not reopen a ticket. The trusted
  reader (`selectSpooledResult`) independently refuses a call with more than one distinct result and re-validates the value with
  the slot's strict schema.

The broker holds no database, model, grader, promoter, telemetry or operator credential. It starts only if every environment
name is in an ALLOWLIST (`ALLOWED_ENV` in the file: its own settings plus the node image defaults); anything else, whatever its
name, refuses to start. Its only secret is the inbound proxy-to-broker token, which the proxy never returns (it also refuses a
response that contains it). It enforces a per-candidate rate bound (default 120 requests per fixed one-minute window) and a cap
on concurrent requests (default 4), both answered with 429. It sits on the internal `broker-internal` network only. Every other
route is 403 at the proxy and 404 at the broker.

Start it with `--profile broker`, `EXPUNGE_BROKER_ARTIFACTS_DIR` (read-only), `EXPUNGE_BROKER_TICKETS_DIR` (read-only to the
broker, written by the trusted side) and `EXPUNGE_BROKER_SPOOL_DIR` (writable by the broker's `node` user). On macOS with colima
the directories must be under your home (the VM does not share `/tmp`). Prove it live with `node infra/opendots/verify-broker.mjs
<env-file> <artifact-sha256>`; unit/proxy chain: `node --test infra/opendots/candidate-broker.test.mjs`. What this does NOT do:
authenticate which candidate process holds the proxy access token (every process in the candidate that has it can call the two
routes, but only with a ticket it was handed), authorize by anything but the proxy's fixed candidate id, trust the ticket
directory beyond its mount (its integrity is the trust root, as for the artifact directory), or protect against a Docker or
kernel escape.

**Healthcheck.** The candidate computer's environment sets `http_proxy`/`https_proxy` to the proxy, so the upstream healthcheck's
request to `http://localhost:4100/health` went to the proxy and was answered 403: the container stayed `unhealthy` (over 1100
failed checks) while `/health` from the host answered 200. `no_proxy`/`NO_PROXY=localhost,127.0.0.1,::1` is now set in the Compose
file and the container reports `healthy`.

## Verification

Run `node --test infra/opendots/candidate-proxy.test.mjs` for proxy authentication/origin/path/binding/disclosure checks. With a candidate stack running, `node infra/opendots/verify-candidate.mjs <env-file>` exercises the live guarded computer (file roundtrip, proxy 403 default-deny, Internet/metadata/host-gateway blocked, and the four DNS probes above). These use local fixture HTTP responses and are not live domain tests. Operator tests include inherited owner/origin/computer credential/action fixtures plus the new projection checks. Live Docker checks and service readiness are tracked in [BUILD-A1.md](BUILD-A1.md). A setup-only shell or configured endpoint is not a provider response, a working computer or a passed containment test.
