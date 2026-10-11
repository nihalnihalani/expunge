# U-0 operator audit

Owner: ui-ux-improver. Date: 2026-10-11. Subject: the OpenDots operator shell with the Expunge foundation additions, as present in `apps/operator/` (upstream pin `625452e0`), before any B3 work.

## 1. What this audit covers, and what it cannot

The operator was booted in **setup-only mode**: no domain service (`EXPUNGE_DOMAIN_URL` unset), no CopilotKit Intelligence key, no model provider key, no computer supervisor. There is no root `.env`. Consequences, stated plainly:

- **No conversation is possible.** Creating a conversation needs CopilotKit Intelligence and a model key (`platform.ts` `createConversation`), so no chat turn, no human-in-the-loop card and no agent run were exercised.
- **No Expunge job exists.** The Expunge view shows the "Connect the domain service" foundation card. No job list, workbench, evidence, candidate, evaluation, approval, receipt, lineage, campaign or privacy screen exists yet, so none could be audited; those are specified in `docs/ui/COMPONENT-STATES.md` and not claimed as built.
- Findings below are about the **shell and the foundation screen** the Expunge work must live inside. Automated scans are inputs, not WCAG compliance claims.

## 2. Method and environment

| Item | Value |
|---|---|
| Machine | macOS (Darwin 27.0.0), Node v25.2.1 default; Node v24.11.1 and v22.23.2 also installed via nvm |
| Operator under test | existing `apps/operator/dist` (built 13:37 the same day; contains the foundation screen; not rebuilt, no source edited for the screenshots) |
| Boot | `node dist/server/server/index.js` with a cleared environment (`env -i`), `HOST=127.0.0.1`, `PORT=4391`, a temporary synthetic owner token (generated with `openssl rand`, 41 characters, stored mode 0600 in the scratchpad, never printed or committed), `DATABASE_PATH` under the scratchpad (never under the repo), `DO_NOT_TRACK=1`, `COPILOTKIT_TELEMETRY_DISABLED=true`, `NODE_ENV=production` |
| Second instance | Port 4392, no owner token, loopback only, used only for a live look through the Browser pane; stopped afterward |
| Browser tools | Playwright 1.63.0 (operator dependency) driving the installed Google Chrome 154.0.8037.98, headless (the pinned Playwright Chromium build is not installed and no browser was downloaded); Browser pane (`mcp__Claude_Browser__*`) for the live accessibility tree, tablet 768 and mobile 375 emulation and the mobile navigation drawer |
| Theme | Light and dark through `colorScheme` emulation, which `public/theme.js` follows (`data-theme` verified) |
| Viewports | 1440x900, 1024x768, 768x1024, 390x844; device scale factor 1 |
| Not run | `npm ci` (not needed: `apps/operator/node_modules` present and the installed `zod` 4.6.5 and `@copilotkit/runtime` 1.75.0 equal the lock; typecheck passes), so the `.expunge/locks/npm.lock` mutex was never taken |

## 3. Checks run (exact commands, exit codes, counts)

All in `apps/operator` unless noted.

| Command | Result |
|---|---|
| `npm run typecheck` (Node 25.2.1), before changes | exit 0 |
| `npm test` (Node 25.2.1), before changes | **exit 1**: 49 files, 48 passed, 1 failed; 305 tests, 298 passed, **7 failed**, all in `tests/telemetry.test.ts` (7 of its 8) |
| `npm test` (Node 24.11.1), before changes | exit 1, identical counts |
| `npm test -- tests/telemetry.test.ts` (Node 22.23.2) | exit 0, 8 of 8 passed |
| `DO_NOT_TRACK=1 npx vitest run tests/telemetry.test.ts` in the pristine upstream clone `/private/tmp/expunge-opendots-625452e` (`git rev-parse HEAD` = `625452e06cde74cb25b0ce319e2c1be0488f5a5f`) on Node 25.2.1 | exit 1, 7 failed, 1 passed |
| Direct probe (scratchpad script): `new Console(...).error('x', <ZodError v3 from @ag-ui/core>)` | Node v25.2.1 throws `TypeError: Cannot read properties of undefined (reading 'value')`; Node v22.23.2 does not throw |

Classification of the 7 failures: **not an Expunge or OpenDots regression.** The verifier traced it (V-2.1) to a Node `util.inspect` regression (nodejs/node#60717, fixed in Node 24.13.1 and 25.4.0): logging a Zod v3 error with an inherited `errors` getter throws inside the CopilotKit run-request parser, so the 400 the test expects never arrives. My own reproduction agrees with every observable part of that account (fails on 24.11.1 and 25.2.1 including in the pristine clone, passes on 22.23.2, the direct probe above). The lead approved defense in depth; see section 8.

Boot probes against the running instance (token omitted from this record):

| Probe | Result |
|---|---|
| `GET /` | 200 (UI) |
| `GET /api/expunge/status` without token | 401 |
| `GET /api/expunge/status` with token | 200 `{"operator":"ready","domain":"unconfigured","authority":"mongodb"}` |
| `GET /api/expunge/jobs/job-1` with token | 503 `{"error":"Expunge domain service is not configured."}` |
| `GET /api/expunge/status` with token and `Origin: https://evil.invalid` | 403 |
| Browser, no token | unlock screen ("Your own little corner.") |

The temporary operator processes were stopped when the audit finished (section 9).

## 4. Screenshots (26 PNG, each under 140 KB, in `docs/ui/audit/`)

Names are `expunge-<view>-<width>-<theme>.png`. Views: `home` (chat home in setup-only state: "Connect your Dot"), `workbench` (the current Expunge foundation screen, "Cleanup workbench"), `setup` (the "Settings & setup" dialog), `unlock` (owner-token gate). Widths 1440, 1024, 768, 390; themes light and dark (24 files), plus `expunge-unlock-1440-light.png` and `expunge-unlock-390-dark.png`. I opened and inspected these images (1440 light and dark, 1024, 768, 390, the setup dialog at 1440 light and 390 dark, home at 390 and 768 dark, unlock) rather than relying on scripted checks alone.

## 5. Automated measurements (headless Chrome, computed styles)

Per capture: text-node contrast against the effective solid background (4.5:1 normal, 3:1 large), text under 12 px, interactive targets under 24 x 24, horizontal page overflow. "Fails" are distinct element/color/background groups.

| View | Viewport | Content width | Contrast fails (light) | Contrast fails (dark) | Text under 12 px (groups) | Targets under 24 px | Horizontal overflow |
|---|---|---|---|---|---|---|---|
| home | 1440 | n/a (no `main`) | 3 | 0 | 3 | 6 | no |
| home | 1024 | n/a | 3 | 0 | 3 | 6 | no |
| home | 768 | n/a | 3 | 0 | 3 | 6 | no |
| home | 390 | n/a | 2 | 0 | 0 | 4 | no |
| workbench | 1440 | 1090 | 3 | 0 | 4 | 3 | no |
| workbench | 1024 | 756 | 3 | 0 | 4 | 3 | no |
| workbench | 768 | 500 | 3 | 0 | 4 | 3 | no |
| workbench | 390 | 390 | 2 | 0 | 2 | 1 | no |
| setup dialog | 1440 | 1090 | 4 | 0 | 11 | 7 | no |
| setup dialog | 1024 | 756 | 4 | 0 | 11 | 7 | no |
| setup dialog | 768 | 500 | 4 | 0 | 11 | 7 | no |
| setup dialog | 390 | 390 | 4 | 0 | 11 | 7 | no |

Keyboard probe (Chrome, synthetic key events, 1440 light and dark): 23 of 23 element tab stops sampled per theme had a visible outline (2 px, `rgb(36,36,36)` light, `rgb(197,197,197)` dark, 2 px offset); no keyboard trap in the Settings dialog.

Performance baseline (loopback, no throttling, n=5, medians): see DESIGN.md section 11 (entry JS 2,754,692 bytes, CSS 122,404 bytes, 11 requests, FCP 140 ms, LCP 144 ms, one 56 ms long task, layout shift 0.0625, heap 13.2 MB, 203 DOM nodes).

## 6. Defects and gaps

Severity: High breaks WCAG 2.2 AA or the Expunge workflow's purpose; Medium degrades usability, density or accessibility; Low is polish or a recorded risk. "Approved" refers to the lead's 2026-10-11 decisions.

| ID | Sev | Finding | Evidence | Reference | Proposed handling |
|---|---|---|---|---|---|
| U0-01 | High | Light-theme text below AA in views Expunge renders in: `.eyebrow` "EXPUNGE" `#999ca8` on `#fff` 2.74:1 (and 8 px); page subtitle `#93949e` 3.01:1 (12 px, 11 px at 390); sidebar space name `#858690` on `#f9f9f9` 3.43:1; "Edit specialist" `#9296a7` 2.94:1; chat welcome copy `#777` 4.48:1; setup dialog eyebrow 2.71:1. Dark twins pass (0 failures in 12 dark captures). | `docs/ui/audit/*-light.png`, scan results | SC 1.4.3 | Replace values per DESIGN.md 3.1 (approved, measured defects only) |
| U0-02 | Medium | The shared token `--muted: #8c8d97` is 3.08:1 on `#f8f7f4` and 3.30:1 on white in light, and its generated dark twin is 3.17:1 / 3.35:1; the plugin does not lift colors that arrive through custom properties. Five `color: var(--muted)` uses. Computed from the token, not seen on the three audited screens. | `src/client/style.css` L9 and five uses; `darkColor('#8c8d97')` | SC 1.4.3 | `--muted: #62646f` (5.49:1 / 5.88:1 light; 5.00:1 / 5.28:1 dark twin) |
| U0-03 | Medium | Text under 12 px is pervasive: 131 declarations at 8 to 11 px in `style.css`; on the audited screens 8 px (eyebrow), 9.2 px (inline code), 10 px (nav group labels, setup copy), 11 px (sidebar note, Pause). | grep count; scan | legibility; SC 1.4.4 relies on zoom | Raise only where Expunge renders (sidebar labels, Pause); Expunge itself never goes below 12 px |
| U0-04 | Medium | Targets under 24 x 24 CSS px: top-bar Pause 59x22 (22x22 at 390), wordmark 195x18, space disclosure 20x17, "Edit specialist" 98x15, block links 15 to 23 px high, setup dialog checkboxes 15x15. | scan | SC 2.5.8 (new in 2.2, AA) | Expunge controls at least 24, 32 default, 44 on coarse pointers; shell offenders reported, not retyped |
| U0-05 | Medium | Structure: no skip link; 20 tab stops precede the first Expunge control at 1440 ("Refresh Expunge status" is the 21st; rail, sidebar and Dots/Spaces navs repeat); the chat home has **no `main` landmark** at any width and only an `h2`; `<title>` is "OpenDots" for every view and never changes; no `aria-live` or `role="status"` anywhere at rest, so view changes are silent. | scan, Browser pane accessibility tree | SC 2.4.1, 2.4.2, 1.3.1, 4.1.3 | App.tsx changes approved: skip link, `main`, per-view title; live region in Expunge |
| U0-06 | Medium | Expunge is a `useState` view (`App.tsx` L68, L606-L607): no URL, reload returns to chat, no deep link to a job, Back leaves the app (`history.replaceState` on view changes). Reconnect and reload have nowhere to land. | source | spec: reconnect from snapshot and sequence | Hash route `#/expunge/<jobId>` (approved) |
| U0-07 | Medium | Dark-only visual inconsistency: `button.desktop-nav-toggle.document-icon` has `border: 0`, transparent background in light but `1px solid rgb(43,43,43)` and filled background in dark. Root cause (measured by listing matching rules): the `style.css` dark twin `:root[data-theme=dark] button:not(.call-view, .call-view *)` has specificity (0,3,1) and beats the `editor.css` `.document-icon` twin (0,3,0), because only `style.css` twins carry the `:not(...)` wrapper. | `docs/ui/audit/expunge-workbench-1440-dark.png`, style probe | cascade defect | `.template-app .document-icon` in `editor.css` (approved); the same trap shapes Expunge CSS rules R1/R2 |
| U0-08 | Medium | Settings dialog (the shell's modal pattern): mechanics are right (role, `aria-modal`, `aria-labelledby`, Tab contained, Escape closes, focus returns to the invoker) but initial focus lands on the first checkbox rather than the title, the Close button comes after Save in DOM and tab order, the background is not `inert` (containment relies on a trap), and at 390 the navigation drawer stays open behind the dialog. | focus probe; `expunge-setup-390-dark.png` | APG modal dialog | Expunge uses its own `Dialog` with title-first focus and `inert` siblings (DESIGN.md 9.3) |
| U0-09 | Medium | The foundation screen cannot express the readiness the spec requires. It says the connection is "configured" and that "connectivity and cleanup readiness are checked when a job is loaded", so a wrong URL or token surfaces only as a later 503/502. No reachable/authorized/evidence-ready distinction, no actionable list of missing names, no jobs list, no submit. | `ExpungeFoundation.tsx`, screenshots | spec section 13 setup/readiness | `GET /api/expunge/readiness` with four checks (B3-PLAN 3.3) |
| U0-10 | Low | Foundation layout: the refresh icon button wraps under the subtitle at 390; the card icon sits against its heading; the icon-only refresh has an `aria-label` but no visible label or tooltip. | `expunge-workbench-390-*.png` | polish | Replaced wholesale by `ExpungeApp` |
| U0-11 | Medium | Content width: the shell chrome takes 268 px at 1440, 1024 and 768 (sidebar still present at 768), leaving 1172, 756 and 500 px; `.main-content` additionally caps at 1090 px with 64/54 px padding. A dense workbench needs more than 1090 px at 1440 and a layout driven by container width. | measured `main` widths 1090 / 756 / 500 / 390 | responsive | Own full-bleed `.ex-root` with container queries (DESIGN.md R7, section 7) |
| U0-12 | Low | Privacy copy: the home and settings screens say "Setup and usage metadata is collected by default" with a link to opt-out details. For a privacy-erasure product this default needs a deliberate lead decision. I booted with `DO_NOT_TRACK=1` and `COPILOTKIT_TELEMETRY_DISABLED=true` and did not inspect what is sent. | screenshots | product decision | Lead decision requested; not changed |
| U0-13 | Low | Load behavior: layout shift 0.0625 at load (shell, not Expunge), one 56 ms long task, static assets served uncompressed (2.7 MB JS), 465 asset files in `dist/client/assets`. Not a blocker at loopback speeds. | perf run | budgets | Lazy chunks and budgets in DESIGN.md section 11 |
| U0-14 | Low | The unlock screen is branded OpenDots with a mascot; its token input is named only by `aria-label` (no visible label); the primary button is lavender `#7689d3` with white text in its disabled state (disabled is exempt) and its enabled-state contrast was not measured; base `.primary` is 3.34:1 where not under `.template-app`. `autocomplete="current-password"` is present (good for SC 3.3.8). | `expunge-unlock-1440-light.png` | SC 1.4.3 if enabled state is lavender | Branding approved in App.tsx; verify enabled contrast during B3 |
| U0-15 | Info | The shell's mode badge (SELF-HOSTED / SETUP REQUIRED) is in the DOM but `display: none` at 1440, 768 and 390, so there is no visible contradictory "setup required" message beside Expunge views. | badge probe | n/a | none |

### What worked (no defect found)

- Visible focus on every sampled stop in both themes; focus color matches ink and is consistent with the shell.
- No horizontal page overflow in any of the 24 viewport and theme captures.
- The dark theme produced no text-contrast failures on the rendered screens (12 of 12 dark captures); its OKLab flip with a lightness floor works for rule-level text colors.
- The shell dialog's containment, Escape and focus-return behavior is correct and is the baseline Expunge's dialog must meet or exceed.
- `lang="en"`, a global `prefers-reduced-motion` rule, and owner/origin protections (401 without token, 403 for a foreign origin) are in place; `domain` unconfigured returns 503 instead of fabricated data.

## 7. Not tested, and limits of this audit

No screen reader was run; keyboard checks used synthetic key events in Chrome, not a human at a keyboard. No 320 px reflow, 200 percent zoom, text-spacing override, forced-colors or reduced-motion emulation yet (they are gates in DESIGN.md section 10). Only setup-only states were reachable. The contrast scan handles solid backgrounds and flags background images (none appeared) and does not evaluate icons or focus-ring contrast. Performance numbers are loopback, headless, unthrottled and not a Lighthouse score.

## 8. Follow-up F1: console wrapper for the Node regression (lead exception)

Implemented after the U-0 documents, as instructed, and recorded separately:

| Item | Result |
|---|---|
| Added `apps/operator/src/server/expunge/safe-console.ts` (retries a throwing `console.error/warn/info/log` once with `${name}: ${message}` for `Error` arguments only; never alters successful output, never changes or drops non-Error arguments, rethrows the original failure if no argument is an Error or the retry fails; idempotent) | new file |
| Added `apps/operator/tests/expunge-safe-console.test.ts` (7 tests; uses a real Zod v3 `ZodError` resolved from `@ag-ui/core`, a cross-realm Error, hostile accessors, idempotency, rethrow paths) | new file |
| `apps/operator/src/server/platform.ts` | exactly one import line added at the top with a two-line comment citing nodejs/node#60717; no other change |
| `npm test -- tests/telemetry.test.ts` on Node 25.2.1, before | exit 1, 7 failed, 1 passed |
| same, after | **exit 0, 8 passed, 0 failed**, test file unedited |
| `npm run typecheck` | exit 0 |
| `npx eslint src tests vite.config.ts` | exit 0 |
| `npx prettier --check` on the three touched files | exit 0 |
| `npm test` on Node 25.2.1 | exit 0, 50 files, 312 tests passed (305 before plus 7 new) |
| `npm test` on Node 24.11.1 | exit 0, 50 files, 312 passed |
| `npm test` on Node 22.23.2 | exit 0, 50 files, 312 passed |

`apps/operator/dist` was not rebuilt, so the already built server does not contain the wrapper; the verifier's committed-artifact smoke check needs `npm run build` first.

## 9. Cleanup

Temporary operator processes on ports 4391 and 4392 were stopped (`lsof -iTCP:4391 -sTCP:LISTEN` and `:4392` return nothing). The synthetic owner token and both SQLite files live only under the scratchpad, never in the repository. The Playwright and probe scripts are scratchpad files, not deliverables.
