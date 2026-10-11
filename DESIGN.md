# Expunge Design System

Owner: ui-ux-improver. Status: U-0 design, written before any product code (spec section 13: design the visual system first). Implemented in B3 under `apps/operator/src/client/expunge/`. Every number marked **measured** came from a command run on 2026-10-11 against the actual operator build (`docs/ui/AUDIT-U0.md` lists commands and evidence); numbers marked **proposed** are design decisions to be re-measured against the B3 build.

Sources used: spec sections 4, 7, 12, 13, 15, 17; `docs/expunge/CONTRACTS.md`; `docs/expunge/ACCEPTANCE.md`; the installed `frontend-design` and `vercel-react-best-practices` skills; WCAG 2.2 (new AA criteria 2.4.11 Focus Not Obscured, 2.5.7 Dragging Movements, 2.5.8 Target Size, 3.3.8 Accessible Authentication: <https://www.w3.org/WAI/standards-guidelines/wcag/new-in-22/>); the WAI-ARIA Authoring Practices modal dialog pattern: <https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/>.

## 1. Direction: "the ledger"

A precise editorial and technical workspace for people deciding whether a database deletion can be trusted.

- Editorial: serif display type for titles and for the one document the product exists to produce (the receipt), hairline rules instead of boxes, marginalia for limitations, generous but disciplined measure.
- Technical: monospace for identifiers, hashes, field paths and BSON types; tabular numerals; dense, readable tables; every identifier copyable and never truncated without a path to the full value.
- Restrained: flat paper-toned surfaces, no gradients, no drop shadows except the modal dialog, no decorative icons, no mascots inside Expunge views.
- One meaningful accent, the **seal** (cobalt). It has exactly one meaning: *the database committed this*. It appears on the committed seal, the committed path of the reference graph, the receipt rule and nothing else. It is never an interactive color, never a button fill, never a "brand" color. A user who learns one thing learns: blue ink means committed authority; everything else is ink, grey or a labeled state.
- Memorable interactions: (1) the **reference trace** (graph with an equal table), which draws committed effects along reference edges as they land; (2) the **verified receipt**, a ledger document with a seal rule that distinguishes what was checked, what remains, and what a model merely said.
- Not a dashboard. The landing surface is a job list and one primary action (New cleanup). No KPI tiles, no sparklines, no percent-complete rings. Counts appear as text with their denominators and provenance, inside the object they describe.
- Not a log viewer. Raw event streams are summarized into a decision log with expandable detail; raw payloads are a secondary, bounded view.

## 2. Principles (each has a test)

1. **Committed is not claimed.** Any authority label (Committed, Complete, Approved, Promoted, Rejected, Erasure confirmed) renders only from a committed record (`ProjectionEvent` with `eventId`/`sequence`, `CompletionReceipt`, `PromotionReceipt`, `ApprovalGrant`, `Candidate.state`, `ExternalErasureJob.providerStatus`). The component that draws the seal requires a `source` prop `{kind, id, sequence}`; there is no client-only authority badge. After a user action, the UI shows a neutral dashed "Submitted, waiting for the database to confirm" element until the committed event arrives. Test: static-render tests prove no seal markup without a `source`; grep test proves seal CSS classes are used only by the seal component.
2. **Model narrative is visibly a different thing.** Model text is drawn only inside `NarrativeBlock`: dashed border, narrative surface, italic display type, hatch gutter, a fixed label "Model narrative, not verified". It is never placed inside a status region, never colored success/danger, and in receipt mode the terminal text is generated from the committed receipt while any baseline model claim stays visible in a narrative block beside the verification result (spec section 7).
3. **Distinct verdicts stay distinct.** Four separate facts are never merged into one badge: model narrative; operational completion in the registered scope as of a revision; hidden-grader correctness (evaluation views only); external erasure (`not_required | pending | confirmed | failed`). A job `succeeded` with receipt `incomplete` shows both.
4. **Evidence before assurance.** A claim has its identifier next to it (receipt ID, Raindrop event/trace ID, outbox state, content hash). Missing, truncated or not-yet-visible evidence is shown as such. No placeholder metrics: an empty table says what is empty and why.
5. **Coverage is explicit.** Every place that says "complete" also says "in registered scope, revision N" and lists registered-but-uninspected collections.
6. **Dense but readable.** Minimum text size 12 px; body 14 px; tabular numerals; 36 px default table rows; 24 px minimum target; 44 px on coarse pointers.
7. **Stateful honesty.** Every region renders loading, empty, error, disconnected, retrying, waiting-evidence, waiting-approval, stale, rejected, cancelled and unavailable as applicable (`docs/ui/COMPONENT-STATES.md`). Non-color cues (icon shape, label text, border style) always accompany color.
8. **Safe by default.** Focus lands on the least destructive control in decision dialogs; Escape cancels; focus returns to the invoker; nothing irreversible is one click or one keypress away from a freshly opened dialog.

## 3. Coexistence with the OpenDots shell

Facts (all **measured** or read from source at the pinned upstream):

- The shell is OpenDots at `625452e0`. Its theme is attribute-driven: `public/theme.js` sets `<html data-theme="light|dark">` before first paint; `src/client/theme.ts` follows the system preference or the stored `opendots-theme` choice. There is no `prefers-color-scheme` media query in the shell CSS.
- Dark colors are **generated at build time** by `src/build/dark-theme.ts` (PostCSS plugin `opendots-dark-theme`, registered in `vite.config.ts`). For every rule that contains a color declaration it emits a twin `:root[data-theme='dark'] <selector>` holding only color declarations, mapped by flipping OKLab lightness (white becomes `#1b1b1b`, black becomes `#eeeeee`). It lifts a rule's own literal text color to a lightness floor, but it does not lift colors that arrive through custom properties.
- The plugin runs on every CSS file Vite processes, including any Expunge stylesheet. It matches only hex literals and the words `white`/`black`. `rgb()`, `hsl()` and `oklch()` literals are not touched, and a custom property is twinned only if its value contains a hex literal or `white`/`black` (probe run on 2026-10-11: `--x: #1D1F24` produced a flipped dark twin; `--x: rgb(29 31 36)` produced none).
- Specificity trap (**measured**, root cause of the existing dark-only border on `.desktop-nav-toggle`): twins generated from `style.css` carry an extra `:not(.call-view, .call-view *)`, which adds one class of specificity, while twins from `editor.css` do not. A `style.css` tag-level twin such as `:root[data-theme='dark'] button:not(...)` has specificity (0,3,1) and beats an `editor.css` class-level twin (0,3,0). Any Expunge CSS file behaves like `editor.css` here.
- The shell's primary action color is ink, not a hue: `.template-app { --accent: #242424 }`; focus ring is `2px solid var(--accent)` with 2 px offset (ink; verified visible in light and dark). Shell dialogs are `role="dialog" aria-modal="true" aria-labelledby`, trap focus, close on Escape and return focus to the invoker (**measured**).
- Shell content width is not the viewport: a 48 px icon rail plus a 220 px sidebar occupy 268 px at 1024 and 768 viewports. Measured `main` widths: 1090 (capped by `.main-content`) at 1440, 756 at 1024, 500 at 768, 390 at 390 (drawer navigation at 390, sidebar still present at 768).
- CSP (`src/server/index.ts`): `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' <realtime origin>`. No external fonts, CDNs or inline scripts. Inline SVG and `data:` images are allowed.
- The shell's global `prefers-reduced-motion` rule disables all animation and transition with `!important` (`style.css` ~L1833). Expunge must not rely on it alone.
- The shell's mode badge (SELF-HOSTED or SETUP REQUIRED) exists in the DOM but is `display: none` at 1440, 768 and 390 (**measured**), so it is not a user-visible signal today. If it is ever shown it reflects OpenDots chat configuration, not Expunge readiness; Expunge readiness appears only inside Expunge views.

Rules for Expunge CSS (R1 to R9). B3 includes a test that runs the real plugin over the Expunge stylesheet and asserts R2, R3 and R5 mechanically.

| Rule | Statement | Why |
|---|---|---|
| R1 | Every selector is `.ex-root .ex-*`. No bare tag selectors, no global selectors, no edits to shell classes. | Scoping gives light specificity (0,2,0); the generated dark twin is (0,4,0), which beats the shell's tag-level twins (0,3,1) on `button`, `a`, `input`. |
| R2 | Token values are authored in `rgb(R G B)` notation, in a light block on `.ex-root` followed by an explicit `:root[data-theme='dark'] .ex-root` block. No hex, `white` or `black` literal appears anywhere in the Expunge stylesheet. | The plugin never twins `rgb()` tokens, so the AA-verified dark values below are the only dark values. A hex literal would receive a generated, unverified flip. |
| R3 | No `@media (prefers-color-scheme)`. Dark is `:root[data-theme='dark']` only. | The user's explicit theme choice must win over the system preference. |
| R4 | Component rules use only `var(--ex-*)` for color, border-color, background, outline and fill/stroke. No `rgba()`/`color-mix()` literals. | Keeps every color in the verified token table; literal alpha colors would not flip in dark. |
| R5 | Primary buttons are ink-filled (`--ex-ink` background, `--ex-canvas`-colored text), matching the shell's `.template-app .primary`. The seal is not used on controls. | One accent, one meaning. Matches the shell so the two coexist. |
| R6 | Focus ring: `outline: 2px solid var(--ex-ink); outline-offset: 2px` on every interactive element and on SVG graph nodes (via a focus rectangle). Never `outline: none` without a replacement. Sticky bars set `scroll-padding-top`/`scroll-padding-bottom` so focused elements are not hidden. | WCAG 2.4.7, 2.4.11; matches shell focus color. |
| R7 | Expunge uses its own full-bleed wrapper, not `.main-content` (which caps width at 1090 px and pads 64/54 px). It reads its own width with `container-type: inline-size` and uses container queries (section 7). | The workbench needs more than 1090 px at 1440 and must adapt when the computer pane squeezes the content. |
| R8 | Expunge does not reuse `.eyebrow`, `.page-heading`, `.muted`, `.task-detail-card` or other shell typography/status classes. Only structural shell chrome (sidebar, top bar, `.icon-button` sizing, dialog scrim) is shared. | Shell typography has measured AA failures and 8 to 11 px sizes. |
| R9 | CSS ships in the lazy Expunge chunk (imported from the lazily loaded workbench module), never from `main.tsx`. | Keeps shell first load unchanged (section 11). |

### 3.1 Approved edits to shell CSS (lead decision, B3 time)

Limited to the measured AA failures and the dark/light inconsistency. Ratios computed with the same WCAG formula and the shell's own `darkColor`/`readableText` mapping. "Dark twin" is what the build plugin generates for the new light value.

| Defect (measured 2026-10-11) | Before (light) | Proposed | After (light) | Dark twin before to after |
|---|---|---|---|---|
| `.eyebrow` `#999ca8` on `#fff`, 8 px | 2.74:1 | `#5c5f6b`, 11 px | 6.36:1 | 6.92:1 to 6.93:1 |
| `.page-heading p` `#93949e` on `#fff` | 3.01:1 | `#5c5f6b` | 6.36:1 | 6.96:1 to 6.93:1 |
| `.text-button` `#9296a7` on `#fff` ("Edit specialist"), 10 px | 2.94:1 | `#5c5f6b`, 12 px | 6.36:1 | 6.95:1 to 6.93:1 |
| Sidebar space name `#858690` on `#f9f9f9` ("Everyday") | 3.43:1 | `#5c5f6b` | 6.04:1 | 6.67:1 to 6.70:1 |
| Chat welcome copy `#777` on `#fff` (just under) | 4.48:1 | `#6b6b6b` | 5.33:1 | dark already above 4.5:1 (0 dark text failures measured) |
| `--muted` `#8c8d97` (5 `color: var(--muted)` uses) on `#f8f7f4` / `#fff` | 3.08:1 / 3.30:1 | `#62646f` | 5.49:1 / 5.88:1 | variable, not lifted by the plugin: 3.17:1 / 3.35:1 to 5.00:1 / 5.28:1 |
| `.desktop-nav-toggle.document-icon` shows a 1 px border and filled background in dark only (`:root[data-theme=dark] button:not(...)` (0,3,1) beats the `editor.css` `.document-icon` twin (0,3,0)) | n/a | change the `editor.css` selector to `.template-app .document-icon` (light (0,2,0), twin (0,4,0)) | n/a | border `1px solid #2b2b2b` to `0` |

Sizes below 12 px (131 declarations of 8 to 11 px in `style.css`, **measured** by grep) are raised only on elements that render beside or inside Expunge views: the sidebar group labels (`.spaces-heading.nav-label` 10 px, `.sidebar-empty` 11 px) and top-bar `Pause` (11 px) to 12 px. Nothing else in the shell is retyped.

## 4. Color

Tokens are CSS custom properties on `.ex-root`. Names are fixed; values below are the verified pairs. Authoring form is the `rgb()` block at the end of this section (hex shown in comments).

### 4.1 Roles

| Token | Role |
|---|---|
| `canvas` | Page background (matches shell body `#f8f7f4` and dark `#1b1b1b`, the shell's `theme-color`). |
| `surface` | Tables, cards, committed content, dialog body. |
| `raised` | Sticky header and phase rail bands. |
| `sunken` | Wells, code, table header, selected row. |
| `narrative` | The model-narrative well only. |
| `ink` / `ink2` / `ink3` | Primary / secondary / tertiary text. `ink3` is the lowest text color allowed. |
| `rule` | Decorative hairlines only (1.24:1 on canvas, intentionally not a control boundary). |
| `ruleStrong` | Control borders, graph edges, table outer borders (3:1 or better). |
| `seal`, `sealText`, `sealInk`, `sealSubtle` | The one accent: committed authority (fill/icon/rule, text, text on fill, wash). |
| `success`, `warning`, `danger`, `neutral` (+ `...Bg`) | Semantic state text/icon and chip wash. Always paired with an icon and a label. |
| focus | `ink`, 2 px, 2 px offset. |
| scrim (dialog) | `rgb(29 31 36 / 0.48)` light, `rgb(0 0 0 / 0.64)` dark (explicit in both blocks; not a text surface). |

### 4.2 Semantic states and non-color cues

Color is never the only carrier. Each state has a distinct Lucide icon (already a dependency), a text label, and a border treatment. Labels are the user-facing words and are announced by assistive technology; icons are `aria-hidden`.

| State | Words | Icon | Family | Border / shape | Source of truth |
|---|---|---|---|---|---|
| committed | Committed | `badge-check` | seal | solid 1 px seal, filled seal-subtle | `ProjectionEvent` kinds `effect_committed`, `receipt_committed`, `harness_promoted`, `evidence_ready`; `CompletionReceipt` |
| queued | Queued | `clock` | neutral | solid | `Job.status=queued` |
| running | Running | `loader-circle` (static `circle-dot` under reduced motion) | neutral | solid, 2 px left bar | `Job.status=running` |
| waiting-evidence | Waiting for evidence | `hourglass` | neutral | dashed | `Job.status=waiting_evidence`; outbox below `evidence_ready` |
| waiting-approval | Needs your decision | `hand` | warning | solid, double top rule | `Job.status=waiting_approval`; `approval_required` |
| waiting-external | Waiting on provider | `globe` | neutral | dashed | `Job.status=waiting_external`; erasure `pending`/`in_progress` |
| succeeded | Job finished | `circle-check` | neutral (not success) | solid | `Job.status=succeeded`; domain verdict is a separate chip |
| complete-in-scope | Complete in registered scope, revision N | `shield-check` | success | solid | `CompletionReceipt.domainStatus=complete_in_registered_scope` |
| incomplete | Incomplete in registered scope | `triangle-alert` | warning | solid | `domainStatus=incomplete` |
| failed | Failed | `octagon-x` | danger | solid, heavy | `Job.status=failed`; `job_failed` |
| rejected | Rejected | `ban` | danger | outline only | `Candidate.state` in `schema_rejected`, `replay_rejected`, `behavior_rejected`; `GateReport.verdict=reject`; policy `deny` |
| cancelled | Cancelled | `circle-slash` | neutral | strikethrough label | `Job.status=cancelled` |
| stale | Out of date | `history` | warning | dashed | `Candidate.state=stale`; grant expired; projection older than live revision |
| disconnected | Disconnected | `wifi-off` | warning | banner, top | projection transport failing |
| retrying | Retrying | `refresh-cw` (static under reduced motion) | neutral | dashed | client backoff or outbox `retrying` |
| unavailable | Unavailable | `plug-zap` | neutral | dotted | 503/unconfigured/unreachable; resource missing from projection |
| pending-ack | Submitted, waiting for confirmation | `send` | neutral | dashed | client-side only; never styled as committed |

### 4.3 Contrast, computed (WCAG 2.2 AA)

Formula: WCAG relative luminance (sRGB linearization), ratio `(L1+0.05)/(L2+0.05)`. Computed by `node` script on 2026-10-11 over 48 text and non-text pairs: **0 failures; lowest text pair 5.44:1; lowest non-text pair 3.09:1.** Requirements: text 4.5:1 (SC 1.4.3, applied to all sizes, conservatively), UI components and graphical objects 3:1 (SC 1.4.11). B3 recomputes every pair from the shipped stylesheet in a test and fails on any pair below its requirement.

| Pair | Requirement | Light | Dark |
|---|---|---|---|
| `ink` on `canvas` | 4.5:1 (1.4.3) | #1D1F24 on #F8F7F4 = **15.39:1** | #ECEBE8 on #1B1B1B = **14.45:1**  |
| `ink` on `surface` | 4.5:1 (1.4.3) | #1D1F24 on #FFFFFF = **16.49:1** | #ECEBE8 on #242424 = **13.02:1**  |
| `ink` on `raised` | 4.5:1 (1.4.3) | #1D1F24 on #FBFAF8 = **15.81:1** | #ECEBE8 on #202020 = **13.67:1**  |
| `ink` on `sunken` | 4.5:1 (1.4.3) | #1D1F24 on #F0EEE9 = **14.22:1** | #ECEBE8 on #151515 = **15.32:1**  |
| `ink` on `narrative` | 4.5:1 (1.4.3) | #1D1F24 on #F3F1EC = **14.61:1** | #ECEBE8 on #202020 = **13.67:1**  |
| `ink` on `sealSubtle` | 4.5:1 (1.4.3) | #1D1F24 on #E9EDFB = **14.11:1** | #ECEBE8 on #1F2547 = **12.46:1**  |
| `ink2` on `canvas` | 4.5:1 (1.4.3) | #464955 on #F8F7F4 = **8.36:1** | #BDBCB7 on #1B1B1B = **9.06:1**  |
| `ink2` on `surface` | 4.5:1 (1.4.3) | #464955 on #FFFFFF = **8.96:1** | #BDBCB7 on #242424 = **8.16:1**  |
| `ink2` on `raised` | 4.5:1 (1.4.3) | #464955 on #FBFAF8 = **8.59:1** | #BDBCB7 on #202020 = **8.57:1**  |
| `ink2` on `sunken` | 4.5:1 (1.4.3) | #464955 on #F0EEE9 = **7.72:1** | #BDBCB7 on #151515 = **9.60:1**  |
| `ink2` on `narrative` | 4.5:1 (1.4.3) | #464955 on #F3F1EC = **7.93:1** | #BDBCB7 on #202020 = **8.57:1**  |
| `ink2` on `sealSubtle` | 4.5:1 (1.4.3) | #464955 on #E9EDFB = **7.66:1** | #BDBCB7 on #1F2547 = **7.81:1**  |
| `ink3` on `canvas` | 4.5:1 (1.4.3) | #5C5F6B on #F8F7F4 = **5.93:1** | #A3A29D on #1B1B1B = **6.74:1**  |
| `ink3` on `surface` | 4.5:1 (1.4.3) | #5C5F6B on #FFFFFF = **6.36:1** | #A3A29D on #242424 = **6.07:1**  |
| `ink3` on `raised` | 4.5:1 (1.4.3) | #5C5F6B on #FBFAF8 = **6.09:1** | #A3A29D on #202020 = **6.37:1**  |
| `ink3` on `sunken` | 4.5:1 (1.4.3) | #5C5F6B on #F0EEE9 = **5.48:1** | #A3A29D on #151515 = **7.14:1**  |
| `ink3` on `narrative` | 4.5:1 (1.4.3) | #5C5F6B on #F3F1EC = **5.63:1** | #A3A29D on #202020 = **6.37:1**  |
| `ink3` on `sealSubtle` | 4.5:1 (1.4.3) | #5C5F6B on #E9EDFB = **5.44:1** | #A3A29D on #1F2547 = **5.81:1**  |
| `sealText` on `canvas` | 4.5:1 (1.4.3) | #2B44B8 on #F8F7F4 = **7.48:1** | #A9B8FF on #1B1B1B = **9.01:1**  |
| `sealText` on `surface` | 4.5:1 (1.4.3) | #2B44B8 on #FFFFFF = **8.01:1** | #A9B8FF on #242424 = **8.12:1**  |
| `sealText` on `sunken` | 4.5:1 (1.4.3) | #2B44B8 on #F0EEE9 = **6.91:1** | #A9B8FF on #151515 = **9.55:1**  |
| `sealInk` on `seal` fill | 4.5:1 (1.4.3) | #FFFFFF on #2B44B8 = **8.01:1** | #10142B on #8FA2FF = **7.59:1**  |
| `sealText` on `sealSubtle` | 4.5:1 (1.4.3) | #2B44B8 on #E9EDFB = **6.85:1** | #A9B8FF on #1F2547 = **7.77:1**  |
| `success` on `successBg` (chip) | 4.5:1 (1.4.3) | #14653A on #E5F3EA = **6.21:1** | #6FD39A on #14291D = **8.40:1**  |
| `success` on `surface` | 4.5:1 (1.4.3) | #14653A on #FFFFFF = **7.11:1** | #6FD39A on #242424 = **8.47:1**  |
| `success` on `canvas` | 4.5:1 (1.4.3) | #14653A on #F8F7F4 = **6.64:1** | #6FD39A on #1B1B1B = **9.40:1**  |
| `warning` on `warningBg` (chip) | 4.5:1 (1.4.3) | #7F4A00 on #FBEFD9 = **6.40:1** | #F0B964 on #2E2412 = **8.59:1**  |
| `warning` on `surface` | 4.5:1 (1.4.3) | #7F4A00 on #FFFFFF = **7.29:1** | #F0B964 on #242424 = **8.74:1**  |
| `warning` on `canvas` | 4.5:1 (1.4.3) | #7F4A00 on #F8F7F4 = **6.80:1** | #F0B964 on #1B1B1B = **9.70:1**  |
| `danger` on `dangerBg` (chip) | 4.5:1 (1.4.3) | #AE2A22 on #FBE8E6 = **5.64:1** | #FF9890 on #34191A = **7.80:1**  |
| `danger` on `surface` | 4.5:1 (1.4.3) | #AE2A22 on #FFFFFF = **6.66:1** | #FF9890 on #242424 = **7.50:1**  |
| `danger` on `canvas` | 4.5:1 (1.4.3) | #AE2A22 on #F8F7F4 = **6.21:1** | #FF9890 on #1B1B1B = **8.32:1**  |
| `neutral` on `neutralBg` (chip) | 4.5:1 (1.4.3) | #464955 on #ECEAE4 = **7.45:1** | #BDBCB7 on #2C2C2A = **7.36:1**  |
| `neutral` on `surface` | 4.5:1 (1.4.3) | #464955 on #FFFFFF = **8.96:1** | #BDBCB7 on #242424 = **8.16:1**  |
| `neutral` on `canvas` | 4.5:1 (1.4.3) | #464955 on #F8F7F4 = **8.36:1** | #BDBCB7 on #1B1B1B = **9.06:1**  |
| `ruleStrong` (control border, graph edge) on `surface` | 3:1 (1.4.11) | #8C877B on #FFFFFF = **3.58:1** | #7C7A74 on #242424 = **3.62:1**  |
| `ruleStrong` on `canvas` | 3:1 (1.4.11) | #8C877B on #F8F7F4 = **3.34:1** | #7C7A74 on #1B1B1B = **4.01:1**  |
| `ruleStrong` on `sunken` | 3:1 (1.4.11) | #8C877B on #F0EEE9 = **3.09:1** | #7C7A74 on #151515 = **4.25:1**  |
| focus ring (`ink`) on `surface` | 3:1 (1.4.11) | #1D1F24 on #FFFFFF = **16.49:1** | #ECEBE8 on #242424 = **13.02:1**  |
| focus ring (`ink`) on `canvas` | 3:1 (1.4.11) | #1D1F24 on #F8F7F4 = **15.39:1** | #ECEBE8 on #1B1B1B = **14.45:1**  |
| focus ring (`ink`) on `sealSubtle` | 3:1 (1.4.11) | #1D1F24 on #E9EDFB = **14.11:1** | #ECEBE8 on #1F2547 = **12.46:1**  |
| focus ring (`ink`) on `dangerBg` | 3:1 (1.4.11) | #1D1F24 on #FBE8E6 = **13.96:1** | #ECEBE8 on #34191A = **13.55:1**  |
| `seal` fill/icon/rule on `surface` | 3:1 (1.4.11) | #2B44B8 on #FFFFFF = **8.01:1** | #8FA2FF on #242424 = **6.49:1**  |
| `seal` fill/icon/rule on `canvas` | 3:1 (1.4.11) | #2B44B8 on #F8F7F4 = **7.48:1** | #8FA2FF on #1B1B1B = **7.20:1**  |
| `success` icon/border on `surface` | 3:1 (1.4.11) | #14653A on #FFFFFF = **7.11:1** | #6FD39A on #242424 = **8.47:1**  |
| `warning` icon/border on `surface` | 3:1 (1.4.11) | #7F4A00 on #FFFFFF = **7.29:1** | #F0B964 on #242424 = **8.74:1**  |
| `danger` icon/border on `surface` | 3:1 (1.4.11) | #AE2A22 on #FFFFFF = **6.66:1** | #FF9890 on #242424 = **7.50:1**  |
| redaction bar (`ink`) on `surface` | 3:1 (1.4.11) | #1D1F24 on #FFFFFF = **16.49:1** | #ECEBE8 on #242424 = **13.02:1**  |


Notes on the table: `ink3` and `sealText` are the weakest permitted text colors; chips use their own `...Bg` wash with the matching state color; text on `seal` fill uses `sealInk`. Disabled controls are exempt from 1.4.3 but still carry the word "Unavailable" or a reason in adjacent text (never a bare faded button). Placeholder text uses `ink3` (not a label substitute).

### 4.4 Token block (authoring form)

CSS names are kebab-case with the `--ex-` prefix (`sealText` is `--ex-seal-text`, `ruleStrong` is `--ex-rule-strong`). Generated from the same palette that produced the contrast table.

```css
.ex-root {
  --ex-canvas: rgb(248 247 244); /* #F8F7F4 */
  --ex-surface: rgb(255 255 255); /* #FFFFFF */
  --ex-raised: rgb(251 250 248); /* #FBFAF8 */
  --ex-sunken: rgb(240 238 233); /* #F0EEE9 */
  --ex-narrative: rgb(243 241 236); /* #F3F1EC */
  --ex-ink: rgb(29 31 36); /* #1D1F24 */
  --ex-ink2: rgb(70 73 85); /* #464955 */
  --ex-ink3: rgb(92 95 107); /* #5C5F6B */
  --ex-rule: rgb(226 223 214); /* #E2DFD6 */
  --ex-rule-strong: rgb(140 135 123); /* #8C877B */
  --ex-seal: rgb(43 68 184); /* #2B44B8 */
  --ex-seal-text: rgb(43 68 184); /* #2B44B8 */
  --ex-seal-ink: rgb(255 255 255); /* #FFFFFF */
  --ex-seal-subtle: rgb(233 237 251); /* #E9EDFB */
  --ex-success: rgb(20 101 58); /* #14653A */
  --ex-success-bg: rgb(229 243 234); /* #E5F3EA */
  --ex-warning: rgb(127 74 0); /* #7F4A00 */
  --ex-warning-bg: rgb(251 239 217); /* #FBEFD9 */
  --ex-danger: rgb(174 42 34); /* #AE2A22 */
  --ex-danger-bg: rgb(251 232 230); /* #FBE8E6 */
  --ex-neutral: rgb(70 73 85); /* #464955 */
  --ex-neutral-bg: rgb(236 234 228); /* #ECEAE4 */
}
:root[data-theme='dark'] .ex-root {
  --ex-canvas: rgb(27 27 27); /* #1B1B1B */
  --ex-surface: rgb(36 36 36); /* #242424 */
  --ex-raised: rgb(32 32 32); /* #202020 */
  --ex-sunken: rgb(21 21 21); /* #151515 */
  --ex-narrative: rgb(32 32 32); /* #202020 */
  --ex-ink: rgb(236 235 232); /* #ECEBE8 */
  --ex-ink2: rgb(189 188 183); /* #BDBCB7 */
  --ex-ink3: rgb(163 162 157); /* #A3A29D */
  --ex-rule: rgb(53 53 47); /* #35352F */
  --ex-rule-strong: rgb(124 122 116); /* #7C7A74 */
  --ex-seal: rgb(143 162 255); /* #8FA2FF */
  --ex-seal-text: rgb(169 184 255); /* #A9B8FF */
  --ex-seal-ink: rgb(16 20 43); /* #10142B */
  --ex-seal-subtle: rgb(31 37 71); /* #1F2547 */
  --ex-success: rgb(111 211 154); /* #6FD39A */
  --ex-success-bg: rgb(20 41 29); /* #14291D */
  --ex-warning: rgb(240 185 100); /* #F0B964 */
  --ex-warning-bg: rgb(46 36 18); /* #2E2412 */
  --ex-danger: rgb(255 152 144); /* #FF9890 */
  --ex-danger-bg: rgb(52 25 26); /* #34191A */
  --ex-neutral: rgb(189 188 183); /* #BDBCB7 */
  --ex-neutral-bg: rgb(44 44 42); /* #2C2C2A */
}
```

Add `--ex-scrim` in both blocks (`rgb(29 31 36 / 0.48)` light, `rgb(0 0 0 / 0.64)` dark). Alpha overlays in light and dark are explicit; the plugin does not touch `rgb()`.

## 5. Typography

Lead decision: system stacks by default; at most one static OFL face if the design genuinely needs it.

| Token | Stack | Use |
|---|---|---|
| `--ex-font-ui` | inherit the shell (`-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif`) | controls, tables, body, labels |
| `--ex-font-display` | `'Iowan Old Style', 'Charter', 'Palatino Linotype', Palatino, Georgia, serif` | page titles, section titles, receipt headline, narrative text (italic) |
| `--ex-font-data` | `ui-monospace, 'SF Mono', 'Cascadia Mono', Menlo, Consolas, monospace` | hashes, IDs, field paths, BSON type tags, counters |

Decision: ship **zero** web fonts in B3's first slice. Review the three display fallbacks (macOS Iowan/Charter, Windows Palatino Linotype/Georgia, Linux serif) in screenshots. Only if the receipt headline is inconsistent across them, add one static OFL variable roman face (Newsreader, latin subset woff2) under `apps/operator/public/fonts/`, with `font-display: swap`, a `size-adjust` fallback to limit layout shift, a `THIRD_PARTY.md` entry, and its measured size recorded in this file. No monospace web font.

Scale (root font size is 14 px in the shell; implement as `rem`, so browser text zoom works; px shown for reference):

| Token | px / line | rem | Family | Use |
|---|---|---|---|---|
| `text-xs` | 12 / 16 | 0.857 | ui | chips, column meta, eyebrow labels (uppercase, 600, +0.06em) |
| `text-sm` | 13 / 18 | 0.929 | ui, data | dense table cells, inspector rows, hashes |
| `text-md` | 14 / 21 | 1 | ui | body |
| `text-lg` | 16 / 24 | 1.143 | ui 600 | card/section headings in dense views |
| `text-xl` | 20 / 26 | 1.429 | display 500 | section titles, dialog titles |
| `text-2xl` | 28 / 32 | 2 | display 500 | page title |
| `text-3xl` | 40 / 44 | 2.857 | display 400 | receipt headline counts, at wide/medium only |

Rules: no text under 12 px anywhere in Expunge (the shell has 8 to 11 px in 131 declarations, **measured**); line length 60 to 72 ch for prose and narrative; `font-variant-numeric: tabular-nums` in tables and counters, `slashed-zero` for hashes; no fixed-height text containers (SC 1.4.12 text spacing: line-height 1.5, paragraph spacing 2x, letter spacing 0.12em, word spacing 0.16em must not clip); no all-caps beyond 24 characters; headings are real `h1` to `h4` in order (one `h1` per view).

Identifiers: hashes render as first 8 and last 6 characters around an ellipsis; the visible form is `aria-hidden`, the full value is present as visually hidden text, and a copy button (`aria-label="Copy full hash"`) plus an expand control reveal the whole value. Domain addresses render as `collection / recordId` with a BSON-type tag (`objectId`, `string`, `int`, `long`) because identical-looking IDs of different BSON types are different records (CONTRACTS.md).

## 6. Spacing, layout and density

- Base unit 4 px. Scale `--ex-space-1..9` = 2, 4, 8, 12, 16, 24, 32, 48, 64 px.
- Page gutter 24 px at medium and wide, 16 px at narrow and phone. Content max width 1600 px.
- Radii: 3 px chips and tags, 6 px controls, cards and inputs, 12 px dialog. Hairline 1 px `rule`; control borders 1 px `ruleStrong`.
- Surfaces are separated by rules and spacing, not shadows. The only shadow is the dialog (`0 8px 32px` of scrim color).
- Density levels: **compact** 28 px rows, 13 px text, 4/8 cell padding (opt-in toggle, medium and wide, fine pointer, stored per browser with guarded `localStorage`); **default** 36 px rows; **touch** 44 px rows and controls, forced on `(pointer: coarse)` and at phone width. Controls are at least 32 px high at default and never smaller than 24 x 24 CSS px (SC 2.5.8; **measured** shell offenders: top-bar Pause 59x22 and 22x22 on phone, wordmark 18 px high, space disclosure 20x17, links 15 to 23 px high).
- Workbench zones at wide width: phase rail 260 px, trace/table fluid, inspector 360 px, limits strip full width below the header. A sticky job header (max 88 px, one line at narrow) carries subject, world, revision, status, Cancel.

```
+--------------------------------------------------------------------------------------+
| JOB HEADER  subject hash . world . scope@rev . [status chip] . [Cancel cleanup]      |
| phase: Inspect > Resolve > Discover > Preview > Apply > Verify > Complete            |
+----------------+---------------------------------------------+-----------------------+
| DECISION LOG   | REFERENCE TRACE            [Graph | Table]   | INSPECTOR             |
| committed      |  lanes by hop distance 0..5                 |  selected record      |
| events, newest |  nodes + reference edges                    |  mixed-array diff     |
| first, grouped |  coverage: 5 of 6 registered inspected      |  decisions, evidence  |
+----------------+---------------------------------------------+-----------------------+
| LIMITS  model calls 7/12 . tool calls 41/96 . docs scanned 212/500 . changed 9/50 ... |
+--------------------------------------------------------------------------------------+
| NARRATIVE (model, untrusted, optional)   |   COMMITTED STATUS / RECEIPT               |
+--------------------------------------------------------------------------------------+
```

## 7. Responsive behavior

Design checkpoints are viewport widths 1440, 1024, 768 and 390. Because the shell sidebar and the optional computer pane consume width, layout is driven by **container width** of `.ex-root` (`container-type: inline-size`, `@container`), measured at the four checkpoints: 1172 (full-bleed; the shell's `.main-content` would cap at 1090), 756, 500, 390.

| Container width | Name | Layout |
|---|---|---|
| 1100 and up | wide (1440 viewport) | Three zones: phase rail + trace/table + inspector; limits strip below; narrative and receipt in the bottom band. |
| 700 to 1099 | medium (1024) | Two zones: trace/table fills; inspector is a right drawer opened by selection (non-modal); phase rail becomes a horizontal stepper above the trace; decision log is a tab beside Trace. |
| 480 to 699 | narrow (768) | One column; Table is the default view (Graph is opt-in); inspector opens as a bottom sheet (modal dialog semantics); tabs: Trace, Log, Evidence, Receipt. |
| below 480 | phone (390) | One column; touch density (44 px); tables keep real `<table>` semantics inside a labeled, keyboard-scrollable region (`role="region"`, `tabindex="0"`, `aria-label`) with a sticky first column; the graph is replaced by the table with a link "Open graph" (works to 320 CSS px reflow; SC 1.4.10 allows two-dimensional scrolling for data tables). |

No horizontal page scroll at any checkpoint or at 320 CSS px; only labeled table regions may scroll. Large collections are paginated (default 50 rows) or windowed with `aria-rowcount`/`aria-rowindex`; the graph aggregates beyond 300 nodes into collection groups.

## 8. Motion

Tokens: `--ex-dur-1` 90 ms (hover, press), `--ex-dur-2` 160 ms (state change, disclosure), `--ex-dur-3` 280 ms (trace edge draw, drawer), `--ex-dur-seal` 420 ms (receipt seal rule, once). Easing `cubic-bezier(0.2, 0, 0, 1)`.

- Animate only `opacity`, `transform`, `stroke-dashoffset`, `clip-path`. Never animate layout properties.
- Purposeful motion only: (1) a committed effect draws its edge once as the event lands; (2) the receipt seal rule draws once when a receipt first arrives while the view is open (not on reload); (3) a drawer or sheet slides in. Nothing loops except the single activity indicator, which has a static equivalent.
- Live updates batch to at most 4 renders per second; rows never reorder under the pointer; no auto-scroll except an opt-in "follow latest" in the decision log.
- No flashing; nothing moves for more than 5 seconds without a pause control (SC 2.2.2, 2.3.1).
- `prefers-reduced-motion: reduce`: all durations become 0.01 ms; the spinner becomes the static `circle-dot` with the word "Running"; the edge draw and seal draw render in their final state; skeleton shimmer becomes a static fill; the drawer appears without slide. Verified by a browser test that emulates the media feature and asserts `getAnimations().length === 0` on the workbench.

## 9. Components

Vocabulary (one implementation each, in `apps/operator/src/client/expunge/components/`). States per component are listed in `docs/ui/COMPONENT-STATES.md`.

| Component | Rules |
|---|---|
| `StatusChip` | Taxonomy of section 4.2. Always icon + label. Variant `committed` is available only through `CommittedSeal`. |
| `CommittedSeal` | The only authority badge. Props: `source {kind: 'receipt' \| 'event' \| 'promotion' \| 'grant' \| 'candidate', id, sequence}`; renders "Committed", kind, short ID, sequence, link to the artifact. Refuses to render without `source`. |
| `PendingAcknowledgement` | Neutral dashed "Submitted, waiting for the database to confirm"; replaced only by a committed event; times out into `stale` with a Refresh action. |
| `NarrativeBlock` | Section 2 principle 2. Label, dashed border, hatch gutter (`repeating-linear-gradient` built from `rule`, 1 px lines every 6 px, no gradient hero), italic display text, max 68 ch, collapsible after 8 lines. |
| `PhaseStepper` | The seven workflow nodes: inspect, resolve, discover, preview, apply, verify, complete. Each node shows committed checkpoint state, not elapsed time. `aria-current="step"` on the active node; expand/retry/approval branches show as labeled side nodes. |
| `ReferenceTrace` | Memorable interaction 1 (below). Lazy chunk. |
| `ReferenceTable` | Equal data, semantic `<table>`: Collection, Record (with BSON type), Field path, Reached via, Eligibility decision, Effect, State, Evidence. Sortable (`aria-sort`), filterable, paginated. Default for AT users and for narrow/phone. |
| `RecordInspector` | Mixed-record detail: shows the record's fields with only target elements changed. Mixed arrays render element by element: removed element = redaction bar with strike and `[redacted element 2 of 5]` text; preserved elements plain; unrelated fields grouped under "Unchanged (n fields)". Preimage and postimage hashes in `HashChip`s. |
| `DecisionLog` | Windowed list of committed events grouped by phase; each row: sequence, kind chip, one-line summary, expand for sanitized payload. Newest first; "Follow latest" toggle; bounded buffer (section 11). |
| `LimitsStrip` | Inline counters `used / cap` as text plus a `<meter>`; unpriced calls shown as a separate count, never as zero cost. No tiles. |
| `CoverageStatement` | "Inspected 5 of 6 registered collections. Not inspected: payments_archive." Always visible in the workbench header region and in the receipt. |
| `EvidenceCard` | Raindrop external event and trace IDs as `HashChip` + deep link (opens in new tab with `rel="noreferrer"`), origin chip (`agent_self_report`, `verifier_feedback`, `human_feedback`, `raindrop_classifier`, `experiment_result`, `admission_service`, shown as plain words), permitted-use, content hash, and the outbox ladder (pending, leased, sdk_enqueued, ingest_accepted, query_visible, evidence_ready) with attained timestamps; `query_visible` is visibly short of `evidence_ready`; truncated or missing evidence says so. |
| `HarnessDiff` | Before/after typed patches grouped by surface (context, workflow, guardrails, tool policy, plugin) with hypothesis, source evidence links, and two separate chips: claimed class (advisory, labeled) and computed class (authoritative, from the trusted gate). |
| `TrialTable` | Paired rows: family, seed commitment, parent vs candidate metrics side by side, deltas as signed text, refusals/failures/timeouts as explicit columns, controls and costs below. Raw rows always available when a candidate loses. |
| `ApprovalDialog` | Section 9.3. |
| `ReceiptDocument` | Memorable interaction 2 (below). |
| `LineageGraph` | Version DAG with a text list alternative; tested parent marked; promotion and rollback receipts as edges. |
| `ConnectionBanner` | Disconnected, retrying, stale and unavailable banners; `role="status"`; one per view. |
| `EmptyState`, `ErrorState`, `Skeleton` | Empty states say what is empty and the next action ("No cleanup jobs yet. Choose a world and a subject to start."); error states say what failed, whether data may be stale, and offer Retry; skeletons are static under reduced motion and never imply data. |
| `HashChip`, `DomainAddress`, `CopyButton` | Section 5 identifier rules. |
| `LiveRegion` | One polite region per view; announces only phase changes, terminal states, approval-needed and connection changes; coalesces to at most one announcement per 2 seconds; never announces individual events or counters. |
| Forms | `fieldset`/`legend` groups; every control has a visible label; hint and error linked by `aria-describedby`; error summary at top with focus on submit failure; no placeholder-as-label; redundant entry avoided (SC 3.3.7: the chosen world and subject carry from preview to submit); exact subject identifiers only (type selector + value), no free-text name search (CONTRACTS: exact identity evidence, semantic similarity is insufficient); consistent Help link position in the header (SC 3.2.6). |

### 9.1 Reference trace (memorable interaction 1)

Purpose: let a person see *how the subject is connected, what was changed along each reference, and what was not examined*, then check any node's exact before/after.

- Layout: lanes by hop distance from the subject (0 to 5, matching the controlled-world bound of five reference hops), orthogonal hairline edges labeled with the reference field. Records are 12 px squares; large groups aggregate to a count pill that expands.
- Marks (never color alone): committed effect on a record = seal-filled square with the effect glyph (delete: bar through, redact: redaction bar, restrict: half-filled, tombstone: open square with slash); retained = hollow square labeled R; excluded = hatched; residual after verification = danger outline with triangle; registered-but-uninspected path = dashed outline labeled "not inspected"; cycle = loop arrowhead labeled "cycle"; namesake that failed exact identity = grey with "no exact identity".
- The committed path (records with `effect_committed` receipts) is drawn in seal at 2 px. This is the only place a graph uses the accent.
- Interaction: hover or focus a node isolates its connected path (other elements fall to `ink3`, never below 4.5:1); click or Enter selects and fills the inspector; arrow keys move along edges (Right/Left forward/back along a reference, Up/Down between siblings); Home/End jump to subject/last committed; Esc clears; `?` opens keyboard help; the whole graph is a single tab stop (roving tabindex) and has a visible "Table" toggle first in DOM order.
- Accessibility: SVG with `role="group"` and a text summary ("23 records, 5 collections, 14 effects committed, 2 residual, 1 collection not inspected") plus `aria-describedby` to the table; each node is a focusable element with an accessible name "users / 42 (objectId), 3 references, redacted in 1 array element"; selection changes are announced through the single live region; pointer-only gestures (drag, pan) are not required (SC 2.5.7): pan/zoom have buttons and keyboard equivalents.
- Performance: lazy chunk loaded on first graph view; deterministic layered layout; more than 300 nodes aggregate by collection and state; edge draw animation only for the latest batch.

### 9.2 Verified receipt (memorable interaction 2)

Purpose: a document a stranger can read to learn exactly what the database verified, what it did not, and what is still pending.

- Rendered only from a committed `CompletionReceipt` event; before that the region shows `PendingAcknowledgement` or the waiting state.
- Anatomy (top to bottom): display-type headline "Cleanup verified in registered scope" (success words only when `domainStatus=complete_in_registered_scope`; otherwise "Incomplete in registered scope" in warning, with the reason first); the always-present sentence "as of world revision N, scope S revision M"; the seal rule (4 px `seal` line drawing once) with `CommittedSeal`; an identifier block (receipt ID, job ID, run ID, harness hash, verification plan hash) with copy buttons; a two-column "What was checked" (inspected collections vs registered collections, discovered fields) and "What remains" (operational residuals, excluded or retained records, limitations as marginal notes); an external erasure ladder (not required, pending with due date shown as an absolute date, confirmed, failed) that never reads as complete while pending; and, beside the document, the model narrative block, when one exists, labeled untrusted.
- Counts always carry their denominator and scope (never a bare "142 deleted"). Hidden-grader results are never shown in a production receipt; in evaluation views they appear in a separate verdict row labeled "Independent grader (fixed evaluator hash ...)".
- Actions: copy canonical receipt JSON; open committed events; open Raindrop trace links. No "Mark complete" action exists anywhere.

### 9.3 Approval dialog (APG modal dialog pattern)

Reference: WAI-ARIA Authoring Practices, Modal Dialog Pattern, <https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/> (fetched 2026-10-11).

- Container `role="dialog"` with `aria-modal="true"`, named by `aria-labelledby` pointing to the visible title (for example "Approve harness promotion"). `aria-describedby` is omitted because the content is structured (lists and tables), per APG.
- Opening: focus moves inside. Because the content is long and the final step is consequential, focus goes to the dialog title (`tabindex="-1"`), and the least destructive action ("Decline") is first in the Tab order after the content; the approve control is last, is never the default, and is not triggered by Enter on open.
- Containment: Tab and Shift+Tab wrap inside the dialog; the page behind is inert (`inert` on the app root when supported, otherwise `aria-hidden` on siblings plus the wrapping trap). The shell's own dialog does not make the background inert (**measured**), so the Expunge dialog adds `inert` to its siblings and removes it on close.
- Escape closes the dialog without a decision ("Decline later"); it never approves. Focus returns to the control that opened it (the "Review" button or the chat review card); if that element no longer exists (the card re-rendered after a committed event), focus returns to the nearest `h2` of the approval region.
- Content (read from the stored descriptor, never from the model or client): what changes (parent hash to child hash, target kind), the trusted-computed authority class and the **flip set** (capabilities that change) with its digest, scope and revisions, gate report ID and digest, approver identity, expiry as an absolute time with a live "expires in" text updated at low frequency, and consequences in plain words ("This lets the worker delete from payments_archive. It does not take effect until the database commits the promotion.").
- Stale or expired: the dialog replaces its action area with the reason, disables nothing silently, and offers "Refresh" and "Close". Approve is removed, not just disabled, when `expiresAt` has passed or the active parent revision changed.
- After Approve: dialog shows `PendingAcknowledgement` until the committed `harness_promoted` event or a rejection arrives; it never displays "Promoted" from the click.
- The dialog sends only `{proposalId or grantId, decision, descriptorDigest}`; it never sends replacement executable arguments (CONTRACTS: `ApprovalGrant`).
- Screen-reader and keyboard test steps are part of the B3 verification list (section 10).

## 10. Accessibility rules and manual verification

Target: WCAG 2.2 AA for implemented flows. Automated scans (axe or Lighthouse) are not claimed as compliance; they are inputs. Required manual checks per delivered slice, recorded in `docs/ui/`:

| Check | Method |
|---|---|
| Keyboard only | Complete Setup, New cleanup, workbench navigation, approval and receipt using Tab, Shift+Tab, arrows, Enter, Space, Escape only; no keyboard trap; visible focus on every stop; focus not obscured by sticky bars (SC 2.4.7, 2.4.11). |
| Dialog behavior | Open, Tab around (contained), Escape, focus return; open from keyboard and from pointer; stale/expired state; reload while open. |
| Screen reader | VoiceOver with Safari on macOS for the four flows (readiness, live workbench with table view, approval dialog, receipt): headings, landmarks, table headers, status announcements restraint (one polite region), dialog name. Limitation: other screen readers are not tested here and are not claimed. |
| Reflow and zoom | 200 percent zoom and 320 CSS px width: no horizontal page scroll; labeled table regions scroll (SC 1.4.4, 1.4.10). |
| Text spacing | Apply the SC 1.4.12 values; nothing clips or overlaps. |
| Color and contrast | Token table recomputed in test; dark and light screenshots inspected; grayscale pass to confirm non-color cues. |
| Reduced motion | Emulate `prefers-reduced-motion: reduce`; assert no running animations; confirm the Running indicator is text. |
| Forced colors | Emulate `forced-colors: active`: statuses remain distinguishable by icon and label, graph uses `currentColor` and system colors. |
| Targets | Every pointer target at least 24 x 24 CSS px, 44 on coarse (SC 2.5.8). |
| Authentication | The owner-token unlock screen keeps `autocomplete="current-password"` and allows paste (SC 3.3.8). |

Landmarks and titles: one `main` per view; `header`, `nav` per region; per-view `document.title` ("Expunge: job a1b2... : Live workbench"); a skip link as the first focusable element (the shell has none; 20 tab stops precede the first Expunge content control at 1440, **measured**: "Refresh Expunge status" is the 21st).

## 11. Performance: baseline and budgets

Baseline **measured** 2026-10-11 on the built operator (`apps/operator/dist`), loopback, Google Chrome 154.0.8037.98 headless, no CPU or network throttling, cold context, n=5 (medians): entry JavaScript `index-BsUFgWoN.js` 2,754,692 bytes (786,017 gzip; the server sends static assets uncompressed, so transfer is the raw size), CSS 122,404 bytes, 11 requests, 3,599 KB total, FCP 140 ms, LCP 144 ms, one 56 ms long task, layout shift 0.0625 (the shell shifts at load; not caused by Expunge), JS heap 13.2 MB, 203 DOM nodes, switching to the Expunge view 33 ms. These are loopback figures; they bound the shell, not a user's network, and no Lighthouse score is claimed.

Proposed budgets (to be re-measured on the B3 build; any breach needs a recorded reason):

| Budget | Value |
|---|---|
| Shell entry JS added by Expunge (route shell, projection client, review-tool registration) | at most 25 KB gzip |
| Expunge CSS | lazy with the workbench chunk, at most 30 KB raw; no change to the 122,404-byte shell CSS beyond the approved edits |
| Reference trace chunk | loaded on first graph view only, at most 60 KB gzip; no new npm dependency |
| Rendered DOM in the workbench | at most 1,500 nodes at once (windowing and pagination) |
| Event buffer | at most 2,000 events and 2 MB in memory; older events remain addressable by sequence from the server |
| Update batching | at most 4 renders per second under event bursts; graph updates deferred with `startTransition` |
| Interaction latency | INP p75 at most 200 ms with 500 nodes and 2,000 events seeded (measured by Playwright event timing) |
| Heap growth | at most 40 MB over the 13.2 MB baseline after a 2,000-event session |

Implementation guidance from the Vercel React rules, applied to this client-only SPA: lazy `import()` for heavy views (`bundle-dynamic-imports`, `bundle-conditional`); import icons directly, no barrels (`bundle-barrel-imports`); parallel snapshot and event fetches with `Promise.all` (`async-parallel`); derive state during render, not in effects (`rerender-derived-state-no-effect`); functional `setState` and `startTransition` for batched projection updates (`rerender-functional-setstate`, `rerender-transitions`); `content-visibility: auto` on long log rows (`rendering-content-visibility`); Map-based indexes for graph lookups (`js-index-maps`); passive listeners (`client-passive-event-listeners`).

## 12. Non-goals and anti-patterns (rejected on purpose)

Gradient hero pages; decorative KPI cards or completion rings; green "Complete" without scope and revision; client-side badges for approval, promotion or completion; model text in status regions; raw log walls as the main view; icon-only controls under 24 px; animated counters; auto-scrolling feeds; modal confirmations for routine navigation; color-only status; placeholder numbers or prefilled success metrics; free-text subject search; any control that implies a cleanup stopped because a chat turn ended (a chat turn or a closed tab never cancels or completes a job).

## 13. Open decisions

1. Web font: default none; one OFL display face only if fallbacks prove inconsistent (lead rule: system stack preferred).
2. If the shell's hidden mode badge is ever enabled, it must be renamed so it cannot read as Expunge status (shell file; proposal only).
3. Compact density default for operators with fine pointers (currently opt-in).
4. Approver identity (known limitation, DA-7 K1): the approver recorded for a decision is the operator's single configured owner id (`OWNER_ID`, default `opendots-owner`), reached by presenting the owner access token. It is not bound per browser session or per person, so two people sharing the token are indistinguishable to the approval issuer. The approval dialog shows that identity as "Approver" from the stored descriptor and makes no per-session claim. Binding a session id into the decision is a backend change (the issuer must record it) and is not attempted in the operator alone.
5. Wide data tables scroll sideways (accepted, disclosed): the reference table, the receipt effects table and similar data tables keep real `<table>` semantics inside a labeled, focusable scroll region (`TableWrap`) and may scroll horizontally at 390 CSS px. This relies on the WCAG 2.2 SC 1.4.10 (Reflow) exception for data tables, where two-dimensional layout is required to preserve meaning. The page itself never scrolls horizontally (asserted in the browser checks). The jobs list is the exception to the exception: it stacks into one block per job at container widths of 640 px or less, because it is a list of records, not a grid to compare.
