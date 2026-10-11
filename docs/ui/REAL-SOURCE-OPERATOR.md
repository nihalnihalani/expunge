# Real-source operator boundary

The OpenDots shell and existing Expunge views remain in place. This packet migrates the operator's environment vocabulary to include `staging` and `production`, and adds two backend-reported readiness checks: source registration and cleanup permission.

The backend source DTO records `registration`, `permission`, `sourceId`, `sourceKind`, `sourceRegistrationHash`, and registration/policy/authorization revisions. An absent producer, incomplete binding, unsupported registration, revocation, denied permission, or legacy fixture backend blocks cleanup. Service credential presence remains a separate configuration fact.

World, preview and receipt projections may carry a source binding. A receipt with no source binding is explicitly unreported. `original` identifies the owner's registered source; operational completion still requires source effects and independent read-back. `isolated_replay` identifies a snapshot/replay copy, whose result does not establish erasure of the original source. The browser never supplies source authority or target effects.

Preview and submit routes perform refusal-only checks against backend readiness and the current projected source scope. Only staging/production scopes with exact source identity, registration hash and revisions can reach cleanup routes. The domain remains responsible for transactional authority, current source versions, preimages, cancellation, revocation and completion. This operator packet does not establish that native execution routes are implemented.

The root launcher reads `.env.operator`, and both the launcher and the first server import reject any nonblank `MONGODB_*` variable by name without printing its value. The operator accesses database authority through scoped domain APIs. Existing process variables keep Node's normal precedence. Upstream telemetry remains off unless the owner opts in.

Credential-bearing domain origins use one validator across readiness configuration, environment construction and the transport constructor: canonical HTTPS or explicit loopback HTTP only, with no userinfo, non-root path, query or hash. Fetch refuses redirects. Guarded routes also refuse malformed configuration before reaching a supplied domain service.

Startup validates numeric port bounds (1–65535), listener host grammar, persistent incidental SQLite path and a supplied owner identity before constructing stores or a listener. Blank `HOST`, `PORT` and `DATABASE_PATH` use explicitly labelled local defaults (`127.0.0.1`, `4310`, and an absolute `data/opendots.sqlite` path under the startup working directory). `OWNER_ID` has no invented fallback. External binds still require the owner token. Configuration validation does not establish authentication, reachability or production deployment.

The deterministic checks also cover origin rejection, startup numeric/path configuration and typed ObjectId normalization. The normalization helper is included in the packet's import closure; other string and integer spellings remain exact.

`npm test` uses an explicit deterministic/static test list: source DTOs, binding changes, fixed-copy rendering/escaping, environment guards, actual stylesheet contrast, error formatting and runtime-version parity. These results certify those checks only. `npm run test:historical` preserves prior upstream/fixture discovery and does not establish production acceptance. The historical fixture browser runner requires `--legacy-fixture-inspection` and is disabled by default.

Real operator → domain → worker → source/provider/Raindrop journeys, screenshots, automated accessibility and manual assistive checks remain pending actual authorized inputs and current executable bindings. No customer data, service/provider responses, remote events, cleanup success or browser acceptance were fabricated for this packet.

Engine: Codex native subagent, logical role `ui-ux-improver`; GPT-6 family, exact deployed variant unavailable. No Git index or commit changes were performed by this role.
