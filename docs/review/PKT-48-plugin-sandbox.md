# PKT-48 security review: packages/plugin-sandbox

Reviewer: devils-advocate (claude-opus-5-5), 2026-10-11, about 15:10Z.

**Scope.** Static read of `src/` and `test/`, plus a local check of which capabilities the Node 24.13.1 permission model restricts under the profile's flags. I did not run the live Docker suite. The pinned hash list matched at the start; re-check against the closing packet after the `attest()` change.

**Disposition: ACCEPT-WITH-CONDITIONS** (PS-1 and PS-2 required).

## Confirmed working

- **Process containment.** Under the profile's flags, child processes, worker threads, native bindings, WASI, the inspector, file reads outside the run directory and all file writes are denied.
- **Compile and staging.**
  - The esbuild options are fixed, and any import is a hard error.
  - The staged artifact is re-hashed after it is written.
  - The runner re-hashes it again before loading.
- **Command construction.** The shell command is built only from validated values: the compiled hash, the admitted export name and a hex marker.
- **Output handling.** Output is parsed as text and validated against strict per-slot zod schemas in the trusted process. Refusal codes are a closed set.

## Findings

**PS-1 (MEDIUM, DEMONSTRATED locally): network access is not restricted by Node, and loopback is untested.**
- Node 24's permission model does not cover networking. Plugin code with zero imports can still reach the network through runtime globals.
- The README correctly says egress denial comes from the container firewall. The live hostile-plugin test checks the internet, the metadata service, the host gateway and the candidate proxy.
- *Gap:* it does not check loopback inside the candidate computer, where the authenticated control API listens.
- *Required:* a live test showing that a plugin cannot reach the in-container control API, or any other loopback service, in any useful way. Either the firewall blocks loopback for the plugin's process, or the request is refused without credentials.

**PS-2 (MEDIUM, DEMONSTRATED static): the plugin result is not bound to its input or its run.**
- `GatewayPluginInput` carries the output hash plus the source, compiled, ABI and profile hashes, but no input hash and no run or call identity.
- A gateway consumer therefore cannot tell that a result belongs to this input and this call, so a cached or replayed result would verify.
- *Required before any gateway call site:* add an `inputHash` and the run binding (job, run, call number), and record them with the decision.

**PS-3 (LOW-MEDIUM, LIKELY): a time-of-check gap inside the runner.**
- The runner hashes the artifact's bytes, then loads it from the path again.
- Only a writer inside the candidate computer could exploit the gap, and the plugin itself has no write permission. Load from the hashed bytes, or make the run directory read-only to everything but the control agent.

**PS-4 (LOW): the nonce framing is not authentication against the plugin.**
- The plugin runs in the runner's process, so it can learn the marker or alter the runner's own checks. Security therefore rests entirely on the trusted-side schema validation, which is sound.
- State this in the README, so the marker is not read as an authenticity control.

**PS-5 (LOW): resource bounds.**
- `--max-old-space-size` does not bound ArrayBuffer or WebAssembly memory. The real ceiling is the container limit (2 GiB). Disclose it, or add a container memory cap per run.

**PS-6 (LOW, SPECULATIVE): the static boundary scan is a regression guard, as it says.**
- It misses eval-equivalents such as the AsyncFunction and GeneratorFunction constructors, `Function(` without `new`, string timers, `createRequire` and `process.getBuiltinModule('vm')`.
- It also omits `packages/harness-compiler`, `packages/evolution`, `packages/gate` and `apps/operator`.
- Extend both lists. Runtime `--disallow-code-generation-from-strings` covers the sandbox side, not privileged processes.

**PS-7 (LOW): free-text output fields go into the model context.**
- The `reason` and `value` fields, up to 200 characters each, may flow into the model context. The plugin is candidate-authored, so this stays within the candidate's authority. It is still an injection channel, so label plugin text as untrusted when it is rendered into the context.

**Note.** `PluginArtifactStore` is in memory and local to one process, so attestation fails closed in any other process. A durable store is needed before admission and execution run in separate processes.

## Final-hash re-check (about 15:20Z)

The final list from runtime-raindrop matches the tree: 14 paths, 0 mismatches, the same bytes this review covers. `EXPUNGE_CANDIDATE_ENV_FILE=/tmp/expunge-a1-host.env npx vitest run packages/plugin-sandbox` exits 0: 4 files and 46 tests passed, the live container suite included. The disposition is unchanged: ACCEPT-WITH-CONDITIONS. PS-1 (no live test for in-container loopback services) and PS-2 (no input or run binding on results) are still open in these bytes.

## Broker and spool review (about 15:35Z)

**Pin.** Both scratchpad lists match the tree: `plugin-sandbox-hashes.txt` (16 paths, 0 mismatches) and `broker-hashes.txt` (7 paths, 0 mismatches). Static read only of `infra/opendots/candidate-broker.mjs`, `compose.candidates.yml` and `packages/plugin-sandbox/src/spool.ts`.

**Confirmed.**
- Route admission is an exact method and path match. Every other request gets 404, and CONNECT or upgrade gets 403.
- The bearer is compared in constant time, and the candidate id is bound from the environment.
- Artifacts are served only under a 64-hex name and re-hashed on every serve, so traversal is impossible. A symlink or a stat-then-read swap can only give a 404, and the directory is read-only to the broker.
- Spool lines are `JSON.stringify` output, so a value cannot inject a newline. The trusted side re-applies the strict slot schema and binds candidate, run, slot and artifact (spool.ts).
- The broker sits only on `broker-internal` with the proxy, and compose passes it only explicitly listed variables.

**BR-1 (MEDIUM, DEMONSTRATED static): one result per run is enforced only in memory.**
- The `seen` map is rebuilt empty on restart (candidate-broker.mjs:57,129-149). After a restart, a second, different result for the same `runId` is appended.
- `validateSpooledResult` takes one line, and the rule for choosing among several lines for one run is not specified.
- *Required:* the trusted reader refuses a run with more than one distinct result (`ConflictingResults`). Separately, the broker rebuilds `seen` from the spool at start.
- *Test:* restart the broker between two different submissions for one run. The trusted side refuses both.

**BR-2 (MEDIUM, DEMONSTRATED static): `runId` is chosen by the candidate.**
- Any holder of the candidate access token, and every plugin holds it by design, can submit under any `runId` that matches `ID`. That includes runs it is not executing, before the legitimate run submits. First writer wins, and the real result then gets 409.
- *Required:* the trusted side mints each run's id as an unguessable value, delivered only to that run. Combined with PS-2, the spooled result must also carry the input hash, so a precomputed result cannot satisfy a different input.

**BR-3 (LOW, DEMONSTRATED static): the credential refusal names the wrong variables.**
- `createCandidateBroker` refuses only `EXPUNGE_INTERNAL_TOKEN` and `MONGODB_URI`. The actual principal variables are `MONGODB_<PRINCIPAL>_URI` (frozen interface 4), and model, Raindrop, owner and approval tokens are not checked either.
- Compose's explicit environment is the real control. Make the check an allowlist of the variables the broker expects.

**BR-4 (LOW): no rate bound.**
- Each submit and fetch re-reads and re-hashes up to 256 KiB synchronously, with no request rate limit. A plugin holding the token can saturate its own broker. The blast radius is one candidate, but disclose it, or add a per-token rate limit in the proxy.

## Final re-read (2026-10-11, about 15:27Z)

**Sandbox: 16 paths, matching the list.** `EXPUNGE_CANDIDATE_ENV_FILE=/tmp/expunge-a1-host.env npx vitest run packages/plugin-sandbox` exits 0: 5 files and 71 tests passed, the live containers included.

| Item | Disposition | Basis |
|---|---|---|
| PS-1 | CLOSED | A live test shows a zero-import plugin gets 401 or 403 from the control API, both without a token and with a guessed one. The only loopback listener is port 4100 (sandbox.live.test.ts:198-221). |
| PS-2 | CLOSED | `GatewayPluginInput` carries `inputHash`, `jobId`, `runId` and `callNumber`. The runner echoes them and they are compared before use, else `BindingInvalid` (execute.ts:46-49,104-116). The spool reader binds the same fields (spool.ts:15-50). |
| PS-5 | CLOSED as a disclosed limit | README:36-38: the heap flag bounds the heap only. Other memory is bounded by the shared 2 GiB cgroup; a multi-GiB plugin is killed (tested) and the control server survives. `ulimit -v` was rejected with a stated reason. |

**Broker: NOT DISPOSED.**
- `candidate-broker.mjs`, `compose.candidates.yml` and `.gitignore` changed after `broker-hashes.txt` was written. The list was written at 15:23:40Z, and the broker was modified at 15:25:46Z.
- `node --test infra/opendots/candidate-broker.test.mjs` currently fails every test with "Set the artifact, spool and ticket directories."
- The new design looks right for BR-2: a trusted-minted 128-bit run ticket, bound to candidate, slot, artifact, input hash, job, run and call, and the candidate submits only `{ticketId, value}`.
- BR-1 and BR-2 will be disposed on a settled hash list with a passing broker test. *Note for that read:* the trusted reader should still refuse more than one spooled line per ticket, as defence in depth.

## Broker final re-read (about 15:40Z)

Both lists match the tree: plugin-sandbox 16 paths and broker 7 paths, 0 mismatches each. `node --test infra/opendots/candidate-broker.test.mjs` passes all 11 tests (exit 0). `EXPUNGE_CANDIDATE_ENV_FILE=/tmp/expunge-a1-host.env npx vitest run packages/plugin-sandbox` passes all 76 tests in 5 files (exit 0), the live containers included.

| Item | Disposition | Basis |
|---|---|---|
| BR-1 | CLOSED | The broker rebuilds per-ticket state from the spool at start. The trusted reader `selectSpooledResult` refuses distinct results for one call (`ConflictingResults`), requires the ticket's own record, and then applies the strict schema (spool.ts:126-142). |
| BR-2 | CLOSED | The candidate submits only `{ticketId, value}`. A ticket is a 128-bit random id (`/^[a-f0-9]{32}$/`, so no path traversal), minted trusted-side and bound to candidate, slot, artifact, input hash, job, run, call and expiry. Tickets are read from a `:ro` mount, and the candidate cannot choose any bound field (candidate-broker.mjs:166-205, compose:128-129). |
| BR-3 | CLOSED | The environment check is now an allowlist (`ALLOWED_ENV`): any other variable refuses start. |
| BR-4 | CLOSED as disclosed | A fixed-window rate bound per broker; one broker per candidate. |

**Accepted residuals, as stated by the owner.**
- Any process in the candidate that holds both the proxy token and a handed ticket can submit for that ticket.
- The integrity of the ticket directory is the trust root.
- Differences in value key order between two submissions read as conflicting, which fails safe.

**PKT-48/50 overall: no open findings from me.**
