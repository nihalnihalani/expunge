# DA-3: runtime challenge (devils-advocate)

Reviewer: devils-advocate, effective model `claude-opus-5-5`. Date 2026-10-11. Scope: B2-1 in `apps/worker`,
`packages/runtime`, `packages/vendor-openmuse` and `infra/opendots`. Read-only except `docs/review/`. No Git state
touched, no credentials used.

Exit-code convention, as in DA-1 and DA-2: `0` = defect reproduced, `1` = not reproduced, `2` = setup error. The
runtime reproductions drive the real `ExpungeExecutionAgent`, the vendored helpers and CopilotKit's BuiltInAgent.
For the model, store and tools they use the runtime's own deterministic fakes (`packages/runtime/test/fakes.ts` and
the labelled `FakeChatModel`). That makes them protocol evidence, not provider evidence.

Coverage: items 1, 2, 3, 5 and 7 of the brief were assessed. Items 4 (wake endpoint) and 6 (netguard egress
attempts) were **not completed in this pass**; they are recorded as gaps in section 6, not as passes.

## 1. Reviewed snapshot (sha256)

```
75e71f627aadf006b693663a7dd1e288b97204013e2661766d749ec39cc8af52  apps/worker/package.json
00803aa7f4ea903b5d9188ee934d90ad2e4180683385992222970fe838ead481  apps/worker/src/config.ts
993e7c1333e2ea968434cf6ad1717cb26e31815b686247a0134bd62ea12029eb  apps/worker/src/dispatch.ts
5003624a018b428c4f1ab858762e920b54fdc29a1e660fffebe13ebff2383a81  apps/worker/src/domain-tools.ts
8d9fc947b5ce6c0d5c1a37ce77d5b45d9c62463006fcca47a0f30db0a1cff292  apps/worker/src/index.ts
eef75461016846d1c392a6cf55b278416445eeab010801cf10a435ce2cefe045  apps/worker/src/readiness.ts
94f703643eee6d63f4432fb27c8e7c101a905e84b0866dfaa3de8949a50924f2  apps/worker/src/receipts.ts
77b90e5db84dd9bbbb8442ff4cf20a40cc0757b55fed2bce6a83832ca988be07  apps/worker/src/terminal.ts
899aeec7c84d3a05892674d3c2efa1f5a36066a0edafc322322ece9583c762fd  apps/worker/src/wake.ts
3e33a4d12dd907c562edeea0ef5ea281e0dc5ede1aa018ce79bf1285a9ee2c98  apps/worker/src/wiring.ts
13ffd6440b9420f2c6e36301565f4d7d929521c9e7ef8cdf785a7ccda4fb0c7e  apps/worker/test/dispatch.integration.test.ts
3b1eb9cccd24568f8718fa72fde428f1616ad37f2f68b3e8f3b9211e90a12d5f  apps/worker/test/dispatch.test.ts
16a9289ee2ea1db7a923fafb4c0f3096486f6f6d3b91913705d51fd2ee7136c5  apps/worker/test/fakes.ts
0aeba46f8962c0bb9a0e919dd52fd0a052a8257248bce4bbf7e4d17758c8484e  apps/worker/test/live-provider.test.ts
afa5858b62000c2e4ef5dc6c2c8ac6954118c50cccf23828ccb3be76cb69bcce  apps/worker/test/terminal.test.ts
6183aaca3a40c0bee60530dc477ad3c893c7e9e016d037059b25ae3e64a56271  apps/worker/test/wake.test.ts
8d0d50ae3ea37269849b6620a5c85bd4ed21ffa9db8016b6d94683987d2a8838  infra/opendots/.env.candidates.example
b756fac90d3b852e8b944c7d6429db24125598f3a671fac59df505e3063f1e5b  infra/opendots/.gitignore
6a587fe749b888421438b79ab526634c54ce1929029c0bc741e9b838e8b90c55  infra/opendots/BUILD-A1.md
148dc950d364485ce25a325a4819b2f0c3838299b22a44d7e06f72c7622f5b2d  infra/opendots/README.md
d336f4a29274caf6e4439de28a7461546c9b20a3c81ee565517cffb83e2bf442  infra/opendots/candidate-proxy.mjs
f67619476fdb820a947478a4026bf0e3fede25f47e2e1ffb664623f0e2a688f7  infra/opendots/candidate-proxy.test.mjs
daf2ec0e7ad4545f009c54ac60aa9a5ca30fd052c6d040b225d7b489ef626d6d  infra/opendots/compose.candidates.yml
6e4632b7688f2e6d269f3fe19f7414c86d07c1b08977e5cfee72d1838d837b3b  infra/opendots/netguard.Dockerfile
0bbcbf58c3b1b1b1481ff25d7404b46299c6b8eef5c3e9ad028c54de23ce3ee6  infra/opendots/netguard.sh
d77a433f7d7ca991007d6211f7d00d7288f20cf82478fb5ac8956d2ec74de0ee  infra/opendots/proxy.Dockerfile
687299c61b1d557ab441cf12cfe89995c7ca0599d754b4c2f43773792f3c6283  infra/opendots/verify-candidate.mjs
04caff3557219d300260c4352e021d4c40682c3c5eb2987ebe5cb3096842e08b  infra/opendots/verify-computers.mjs
dd4dd3cf53988d47081dc522a5835a4410230eb9086418245a37688678b79a01  packages/runtime/package.json
4013ced5f65863f29c79c907dd3b47f6e2ae27e193bb54962c515d30b36c5bed  packages/runtime/src/agent.ts
6763acd5bc5a684dd1ed686c999c52353555c695f87012364a55b4c570622cee  packages/runtime/src/authority.ts
7775b29dc1f55e60a854ae86a774ba5c91615dfe2f9ac499b14c9bb89410376b  packages/runtime/src/errors.ts
20fef34201a3d149f9404f24c9738d8b0c76ea728d4ad954f36fa40b31975d89  packages/runtime/src/index.ts
e5afc643fecd1c155c2a8f4c019c11c43d1f7bc25b4a60a929af931efc7a075e  packages/runtime/src/lease-release.ts
3f1caf74d2d48c3561715ed190ddb8a56057febd01cc1c07c238226d136e1f39  packages/runtime/src/models.ts
bd005b5796ce1bd4292f64a6361c1444828ccd6768322484198dde3130b8c810  packages/runtime/src/ports.ts
75961acb931f53b8a0661c7fd81f58db6b2092c7a885ec59b0fbf9fc07e2e18a  packages/runtime/src/prompt.ts
d145016f3522f2cb5de57c47a7b4203ab3405a9affb6335a2cdbcaf273bad717  packages/runtime/src/session.ts
6ed2ae11440cdbe5bb80f31203df7d408dc6af604502bf571e279e0e9c1dbf90  packages/runtime/src/testing/fake-chat-model.ts
87edb530cec6b4c3d1a795e1d30ce721401a8df9669e7242b8283a7924aa6c4f  packages/runtime/test/ag-ui-pipeline.test.ts
e9781b97c75d5d374180054db7ef0aaa063e182bf741db69cb7e45311f0fc395  packages/runtime/test/agent.test.ts
2fb4734e42daef92b1869175f395bfbd467a77b8250d42c4763414e007e2431b  packages/runtime/test/authority.test.ts
65eec2560b262fe5ef9885d4f771de5914bae6f3123d8779d155ed30da84efe3  packages/runtime/test/fakes.ts
714b77001ade306cb60d2f383dfc0b87040f9e672e8186dea91119b0d3f5750f  packages/runtime/test/isolation.test.ts
9a8e7371787a4abe074cae8ed76d1cd1be4619e5352cde903c24bfffd0b242f4  packages/runtime/test/models.test.ts
ff73036351a4512cac8d82c7aa435136c9abdaec304cb3d248b4f08f078540e2  packages/runtime/test/usage.test.ts
399a9cccf1b228c9e8ad348ef66a0a5802d438d46735d0d068390925aee5ee36  packages/vendor-openmuse/LICENSE.openmuse
645310d900d8c0d0c05271069eeb43d0f4ea5c9828fa90403a28decdd61fb937  packages/vendor-openmuse/THIRD_PARTY.md
2de57bfac1dc40388c7549961f8e88d119b2e1f2f8a39708b8b3cca1ef9f2170  packages/vendor-openmuse/package.json
262b3145a784aa7ae106d17684f447de24e418265baac1a16831d6eac3e74c51  packages/vendor-openmuse/src/index.ts
a534c5a7eb3bb67140cf7fd878e140ffc7300e16517ed47b8f0412ff9f0ebb69  packages/vendor-openmuse/src/model-retries.ts
4e7939719615ec1ec7709b0aad3c783c38463fb476a3dbe5e778972d88a75436  packages/vendor-openmuse/src/provider.ts
c8460a45fed7acd9a6be2ff2ecad0a6b35cf21682a46d5d05dbac50c3bc6f63a  packages/vendor-openmuse/src/state-tools.ts
15d6520d6e1fe493790ceee1db118bf18f688a9b08003707c56e1535ce70e833  packages/vendor-openmuse/src/tanstack-agent.ts
04f60cdfa1e4808432edd440efdea775ec13446c42d73c97a4c2c1faeaf13e9e  packages/vendor-openmuse/test/dependency-coherence.test.ts
32bbf905ef0a61c5b0ee33f4840387a28264e95f59d17a074a412312ff58921d  packages/vendor-openmuse/test/helpers.ts
309f5b993a7a4aede4eedd9eb7456537479dd5542f5abf7dccec4573a845c187  packages/vendor-openmuse/test/provenance.test.ts
9365fb4630962ffe7b40da829feb920c8efc12c4d6e848f5f77b2e333e8df752  packages/vendor-openmuse/test/provider.test.ts
fbebec71853997b494917381cd9bd013996785a4d0e1bc1115386097a075e1ad  packages/vendor-openmuse/test/tanstack-agent.test.ts
```

Three files changed after this snapshot: `vendor-openmuse/src/tanstack-agent.ts` (snapshot 15d6520d),
`THIRD_PARTY.md` (snapshot 645310d9) and `test/provenance.test.ts` (snapshot 309f5b99). They now add M12, an
out-of-band `onStepLimit` callback. `packages/runtime/src/session.ts` is unchanged, so R3 below still reproduces.

## 2. Reproductions (all run; command -> exit code)

| Repro | First run | Latest run |
|---|---|---|
| `npx tsx docs/review/repro/rt-clone-concurrency.repro.ts` | 0 | 0 |
| `npx tsx docs/review/repro/rt-tool-outlives.repro.ts` | 0 | 0 |
| `npx tsx docs/review/repro/rt-steplimit-spoof.repro.ts` | 0 | 0 |

## 3. DEMONSTRATED defects (owner: runtime-raindrop)

**R1. The original agent and its clone can run one job concurrently under one fence (medium).**
`packages/runtime/src/agent.ts` `clone()` grafts the shared frozen `trusted` object but resets `active`, and the
`RunAlreadyActive` guard is per instance. Counterexample: the original runs (model call hanging) and
`original.clone().run()` also starts, giving two model loops for `job-1`/fence 3.

CopilotKit runtime 1.75.0 clones the registered agent on every request
(`dist/v2/runtime/handlers/shared/agent-utils.mjs`: `agents[agentId].clone()`). If this agent is ever registered
with a runtime, two requests produce two loops. Today only the dispatcher constructs it, which bounds exposure.

Mongo-fenced effects stay deduplicated, but token spend, checkpoints and tool side effects double.

Fix: hold the single-active-run guard in the shared trusted object (for example a mutable slot or a WeakMap keyed
by lease). Test: `clone().run()` while the original runs throws `RunAlreadyActive`.

**R2. Teardown releases the lease while tools are still executing (medium).**
`session.ts` `teardown()` runs `releaseAndSummarize()` at once. `boundedPhase` stops *awaiting* a tool on abort or
timeout, but the tool's `execute` keeps running. Counterexample timeline: `tool:start` ->
`settled(release=cancelled, job=cancelled)` -> `tool:end(job=cancelled)`.

Fenced Mongo writes would fail after release. Non-fenced side effects (vendor calls, telemetry, files) continue
after the job is terminal, and `RunStats` is returned before they end.

Fix: track in-flight executions and await them, with a bound, before `releaseLease`. Otherwise make "honour
`signal` before every non-fenced action" an enforced tool contract, with a per-tool test.

**R3. Model text can relabel how a run ended (low).**
`session.ts` sets `stepLimitReached` when a `TEXT_MESSAGE_CHUNK` delta *equals* `STEP_LIMIT_NOTE`, and keeps that
text out of the narrative hash. Counterexample: one model turn whose text is exactly the note, with a limit of 12,
gives `endedBy=step_limit`, and `decideTerminal` returns `StepLimitReached` instead of `NoCompletionReceipt`.

Fix: use the new out-of-band M12 `onStepLimit` callback and stop matching text. Keep the note text inside the
narrative hash.

## 4. LIKELY risks

- **K1 The fake is exported from the production entry point (runtime-raindrop, low).**
  `packages/runtime/src/index.ts` re-exports `FakeChatModel`, `fakeText`, `fakeToolCalls` and `fakeHang`. So
  `@expunge/runtime`, which the worker imports, carries the fake in its production module graph. The file header
  says "no production entrypoint imports it". `test/isolation.test.ts` explicitly allows "its re-export", so the
  guard tests the wrong property. No production code selects it: `EnvModelResolver` admits only openai and
  anthropic. Fix: a separate `@expunge/runtime/testing` export subpath, and an isolation test that the default
  entry has no fake export.
- **K2 A run's model provenance is not recorded (runtime-raindrop, medium for evidence claims).**
  `RunStats`, `terminalCheckpoint` (`apps/worker/src/terminal.ts`) and the dispatcher do not record the adapter's
  provider name or model ID. The `FAKE_DETERMINISTIC_TEST_PROVIDER` label exists only on the adapter object, so
  any run whose resolver was swapped would be indistinguishable in stored evidence. Record `adapter.name` and the
  `model` in the terminal checkpoint and the Raindrop span, and have live-evidence checks reject the fake name.
- **K3 No untrusted-narrative label for model_narrative bundles (runtime-raindrop, low).**
  `emitTerminalFromReceipt` runs only for `completionPolicy=verified_receipt`. For W0 (`model_narrative`) nothing
  marks the model's closing text as unverified. Spec section 7 asks for baseline narrative failures "clearly
  labeled untrusted ... alongside the actual verification result". Emit the `no_committed_receipt` terminal event
  for every policy.
- **K4 State stripping is a denylist (runtime-raindrop, low).** `authority.ts` `PROTECTED_STATE_KEYS` removes named
  keys, so variants (e.g. `harness_hash`, `toolGrants`, `terminalStatus`) pass through. The dispatcher sends
  `state: {}` and no runtime decision reads state, so this is defence in depth. If the agent is ever exposed to
  client input, use an allowlist of UI-projection keys.

## 5. Item 7: vendored OpenMuse modifications (M1-M11, plus M12 after the snapshot)

I found no change that alters the baseline's behaviour on the dispatcher path:
- M10: `splitTextAtToolCalls` is unchanged.
- `reportStepLimit` counts steps the same way (TOOL_CALL_START phases; it emits on RUN_FINISHED after results when
  steps >= maxSteps).
- M5 and M8 differences matter only when client state or context is non-empty, and the dispatcher always sends
  `state: {}`, `context: []` and `forwardedProps: {}`.
- M9 (`throwIfAborted` before a tool) makes cancellation stricter, not looser.
- M11 is formatting only.

R3 is the one place where the runtime depends on the step-limit *text*; M12 provides the out-of-band alternative.

## 6. Not completed in this pass (stated as gaps, not as passes)

- **Item 4, wake endpoint:** no adversarial assessment was performed. The in-memory command dedupe remains the
  admitted PARTIAL. Treat the endpoint as unreviewed by devils-advocate.
- **Item 6, netguard egress attempts:** no new active egress probes were run in DA-3. The DA-1 DNS probe
  (`cand-dns.repro.sh`, latest exit 1 after a clean rebuild) and the `iptables -S` order assertion the owner
  added are the only containment evidence from this reviewer. The remaining probes in the brief should run
  under the verifier's containment plan.
- **Item 2, partial:** the clone path was traced through `AbstractAgent.clone` and CopilotKit's per-request clone
  site, and R1 shows the gap. "Can a clone run with a different job" is answered **no**: the binding is fixed at
  construction and `run()` derives the job from `trusted.binding.lease.jobId`, not from input.
