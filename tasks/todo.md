# Task 7: AI Chat redesign — "The Living Orb" 2026-05-25

Direction A approved (living gradient orb identity). Scope: visual + IA restructure across floating / docked / mobile (one component system). Personality: expressive but calm — motion is purposeful, never twitchy. Diagnostics (Code Intel, Shadow verify, Regression) collapse into one drawer.

## Design decisions (locked)
- Orb is Vectant's identity. State machine: idle (slow breathe + drift) → thinking (faster drift + one orbiting highlight ring) → answering (steady orb + soft outward pulse) → error (one-shot tint to red, settle) → applied (one-shot brand bloom).
- Motion: transform/opacity/background-position only. `prefers-reduced-motion` → static gradient + state-by-color. Orb animation pauses when chat off-screen (`isVisible`/`paused`).
- Brand tokens only: bg #06060a, brand gradient #ff3d8a→#ff3737→#a23dff→#3d6dff, attention-purple #b545ff, muted-lavender accents, text #f4f5f8/#9ba2b8/#5a6178.
- Reuse signals already in AIChatWindow: isThinking/showThinking, streamingMessage, progressStatus, applySuggestion.

## Plan
- [x] P1 Foundation: `chat.css` (orb + chat classes + keyframes + reduced-motion) and `VectantOrb.jsx` (state/size/paused props).
- [x] P2 Derive `orbState` in AIChatWindow from existing signals; small orb in the header (replaced static Sparkles tile).
- [x] P3 `DiagnosticsDrawer.jsx`: collapses Code Intel metrics + ShadowCostPanel + RegressionFindingsCard behind one discreet drawer (default closed). Removes the failing "500" from the empty state.
- [x] P4 `ChatEmptyState.jsx`: large orb + "What can Vectant help with?" + suggestion chips that prefill the composer.
- [x] P5 Composer: brand-gradient focus ring via `vx-composer-shell` (kept all existing wiring).
- [x] P6 Message restyle: DONE + builds clean (Docker prod, exit 0). Assistant turns are now editorial — a lightweight CSS gradient mark (`.vx-msg-mark`, NOT WebGL) + "VECTANT" role label + full-width content (no heavy bubble). User turns are a quiet right-aligned chip (`.vx-user-bubble`). Streaming + thinking use a live pulsing mark + the gradient caret. NOTE: a live screenshot of a rendered conversation is still pending — the workspace page wouldn't reach document_idle for the screenshot tool, and sending a message needs the AI backend (showed "Client is not running" after the container restart). Layout is presentational-only; low risk.
- [ ] P7 Responsive pass (floating/docked/mobile) + live verification. Preserve ALL existing features.

## Orb tech (updated after iteration with user)
- Orb is now a **WebGL fragment shader** (`VectantOrb.jsx`), not CSS. Solid brand gradient warped like liquid; silhouette morphs via 2·3·4 angular harmonics + envelope-gated higher harmonics (spike count varies). Intensity uniform eased per state so transitions melt smoothly (no spin — phase is accumulated, not time×intensity). Guards: prefers-reduced-motion → 1 static frame; pause via `paused` prop + IntersectionObserver; DPR capped at 2; CSS gradient fallback if no WebGL.

## Notes / risks
- AIChatWindow.jsx is 1824 lines — make focused changes, extract presentational components, keep hook wiring intact. Do not touch agent/suggestion logic.
- Dev server on :3000 is a PRODUCTION build (from prior task) — source edits won't hot-reload there; verify via `npm run build`/lint or a dev server.

## Round 2 — message-area + cards + composer (approved)
Surfaces: agent reasoning card (timeline), error consolidation, diff/command cards, composer + session tabs. Centerpiece = live reasoning timeline; context as inline chips; errors consolidated into the card.
- [x] R2.1 `ReasoningCard.jsx` — live timeline (working) → collapsed summary (finished) → error surface (failed) with Try again / Copy error. Context parsed from logs into header chips (file count + ctx meter). `chat.css` card-system added. Wired into AIChatWindow (replaces old progress block) + `handleRetry`.
- [x] R2.2 Error consolidation — removed the duplicate `inlineSummary` "Generation failed… Try again" assistant message in `useAISuggestions`; the reasoning card's failed state is the single error surface. VERIFIED LIVE: send → single error card (502 chip, message, Try again/Copy error, steps below); no duplicate. (Working/Done states need a non-502 backend to view.)
- [ ] R2.3 Unify diff / apply-reject + command/multiverse/regression cards onto the shared card chrome.
- [x] R2.4 Session tabs restyled (`.vx-tab` system: quiet inactive, active = gradient dot + elevated pill, close-on-hover, `.vx-tab-new`). VERIFIED LIVE. Composer control row left as-is (functional + already has gradient focus ring; low-value to rework).
- [x] R2.3 Card-chrome unification (compile-only, per user — cards need a non-502 backend to view live):
      - `CommandApprovalCard.jsx` fully re-chromed onto `.vx-rcard` + `.vx-btn` with Vectant tokens (status accent drives border/glyph/pill); Allow = gradient primary, Deny = danger ghost.
      - `MultiverseCard.jsx` emoji 🛡 → lucide `ShieldCheck` (no-emoji rule).
      - File-suggestion + AI-suggestion cards: Apply → `vx-btn--primary`, Reject → `vx-btn--ghost` (danger). 
      - Left as-is (lower impact / risky blind): diff-card borders/headers, the 'context' sources card. Verify all cards live once backend is healthy.

## Round 2 — DONE
All four approved surfaces shipped + frontend image rebuilt (prod build exit 0) and loaded:
- Reasoning timeline card (working → collapsed summary → consolidated error), context chips, Try again / Copy error. [verified live: error state]
- Error consolidation (removed duplicate message). [verified live]
- Session tabs restyled. [verified live]
- Card chrome unified: CommandApprovalCard, MultiverseCard emoji, Apply/Reject → vx-btn. [compile-verified; needs non-502 backend for live view]
Pending (needs healthy AI backend / optional): live view of working/done reasoning timeline + diff/command/multiverse cards; optional polish of the 'context' sources card + composer control row.

## Round 3 — Layout refactor "Rail + Stream" (approved; spec: docs/superpowers/specs/2026-05-26-...)
Decisions: rail always starts collapsed (never open by default), click-to-expand+pin on wide / dropdown on narrow; hero composer glides to docked on first send; single live WebGL orb anchored to the current answer's mark, re-anchors/resets per turn (older turns static marks); transform/opacity motion, reduced-motion snaps.
- [x] S1 ChatRail.jsx slide-in overlay drawer (collapsed default) + header PanelLeft toggle + scrim + collapse control + width mode via ResizeObserver (wide/narrow @440px). VERIFIED LIVE: starts collapsed, toggle opens, ✕/scrim closes. (Rail contents still placeholders; header still has old tabs/diagnostics — consolidated in S2.)
- [x] S2 Rail real contents (session list + New chat + Context/diagnostics in footer); narrow `ChatSessionDropdown`; header slimmed (tabs + inline diagnostics removed on wide). Breakpoint = offsetWidth < 380 (contentRect undercounted padding). VERIFIED LIVE: wide floating(~420)=rail; narrow docked(~345)=dropdown + inline diagnostics. (Settings row omitted — no settings surface yet.)
- [x] S3 Composer hero⇄docked: `.vx-stream` centers the {orb→title→composer→chips} group when empty (composer = centerpiece, chips below it); FLIP (useLayoutEffect translateY, eased, reduced-motion-aware) glides composer to docked bottom on first send. VERIFIED LIVE (centered hero + glide-to-dock). Also: removed the big active-file chip; added a small active-file toggle pill next to the model (icon + truncated filename, accent when included). VERIFIED.
- [~] S4 Living orb: ONE live WebGL orb anchors to the current answer's mark — thinking/answering while working, idle on the last assistant message; older answers use static `.vx-msg-mark`; `.vx-msg-orb` pops in on re-anchor. Header orb + hero orb unchanged. Compiles + thinking orb shows live; answering/idle on a COMPLETED answer can't be visually confirmed yet — AI backend is 502 (no successful answer lands). Verify when backend healthy.

## Notes
- AI backend returns 502 (ai-engine/ai-gateway) + intermittent infra (DB at 34.32.85.168 unreachable, docker.sock ENOENT). Frontend itself builds/runs; these block end-to-end AI verification.

## Review
- VERIFIED LIVE (rebuilt frontend Docker image, `docker compose up -d --build frontend`, prod build compiled clean exit 0):
  - Header orb (WebGL, 24px) + Vectant AI wordmark.
  - DIAGNOSTICS drawer replaces the 3 stacked panels; green health dot; expands to Code Intel + Shadow spend. No more "500" in empty state.
  - Empty-state living orb (WebGL, 84px, confirmed not fallback, no shader/React errors) + chips.
  - Suggestion chip prefills composer (tested "Explain this file"); send button activates.
  - Composer gradient-ring shell, Agent/Gemini/attach/send intact.
  - Only console errors present are pre-existing LSP/WebRTC DataChannel noise (unrelated).
- Remaining: P6 per-message assistant marks (CSS, not WebGL) + editorial message spacing; P7 mobile/narrow responsive pass. ShadowCostPanel inside the drawer renders a bit raw (pre-existing component) — optional restyle.

---

# Task: Slice-2 Git provider — final-review follow-ups (2026-06-03, tool-compatibility)

TDD throughout (vitest from `synthi/`). No `npm run build` (disk gate).
Verify gate: `cd synthi && npx vitest run src/lib/git src/app/api/integrations/git` (currently 26 tests, must stay green).

Two spec corrections found during exploration:
- #7: `synthi/.env.example` already exists (documents GitLab/GitHub/SYNTHI_RL_GIT) → UPDATE it (add NEXTAUTH_URL, revise GitHub note), not create.
- #2: extract ONE `upsertOAuthProvider` into `store.js` (DRY) rather than duplicate find-or-create in callback + device/poll.

## MUST
- [x] #1 `oauthClient(provider)` in providerConfig.js — github→GITHUB_ID/SECRET, gitlab→GITLAB_CLIENT_ID/SECRET. Wired into start, callback, device/start, device/poll, token.js. E2E doc note reverted.
- [x] #2 `upsertOAuthProvider` in store.js — finds {ownerUserId,providerType,authType:'oauth'} → updates (repoints to new secrets, deletes old EncryptedSecrets) else creates. Wired callback + device/poll.

## MINOR
- [x] #3 token.js — guards `conn.secret` null → clean needs_relink (no TypeError).
- [x] #4 gitlab getStatus — empty statuses → state:'unknown', total:0.
- [x] #5 github adapter — per-segment encode repo (`encRepo`) in createPullRequest/getStatus.
- [x] #6 gitFetch — callback/device-start/device-poll routed through gitFetch; assertSafeUrl mock added to oauthDevice test.
- [x] #7 UPDATED synthi/.env.example — added NEXTAUTH_URL + GitHub reuse note (file already existed).

## VERIFY
- [x] `npx vitest run src/lib/git src/app/api/integrations/git` → 8 files, **43 passed** (was 26; +17 TDD tests).

## REVIEW
All 7 follow-ups landed via strict red→green TDD (saw each test fail for the right reason before implementing).
- #2 extracted ONE `upsertOAuthProvider` helper (DRY) rather than duplicating find-or-create across two routes; mirrors `deleteProvider`'s orphan-cleanup ordering (repoint row → then deleteMany old secrets).
- callback + device/poll no longer import prisma/encryptToken directly (delegated to the store helper).
- Spec deviations (both surfaced + handled): `synthi/.env.example` already existed → updated not created; E2E doc env note reverted to "GitHub reuses GITHUB_ID/GITHUB_SECRET".
- Out of scope / not done: `npm run build` (disk gate, per instructions). Pre-existing unused-`describe` lint nit in the two oauth test files left untouched.

---

# Task: Slice-2 hardening commit + Slice-3 phase-1 discovery (2026-06-03)

Disk gate: do not run `next build`, `docker build`, or `docker compose build`.

## Plan
- [x] A1 Verify Slice-2 git test gate: `cd synthi && npx vitest run src/lib/git src/app/api/integrations/git` → 8 files, 43 passed.
- [x] A2 Stage only the OAuth hardening files and confirm the cached file list matches the requested set exactly.
- [x] A3 Commit on `tool-compatibility` with the requested message + Co-Authored-By trailer, then push `origin tool-compatibility` → pushed `01ba2c07`.
- [x] A4 Run `cd synthi && npx vitest run` and confirm no new failures beyond the known preview-store stub note.
- [x] B1 Read the approved workspace runtime design and roadmap sections 6, 10, and 11.
- [x] B2 Resolve the blocking Phase-1 decisions with the user one question at a time, starting with R-1.
- [x] B3 After decisions are settled, write the Phase-1 plan in `docs/superpowers/plans/` and update this file with checkable implementation tasks before any Slice-3 coding.

## Phase-1 Implementation Tasks (do not start until user checks in on the plan)
- [x] C1 Docking multiplicity TDD: make dedupe respect per-panel `allowMultiple`; prove Integrations stays single-instance and Program Session tabs can be multi-instance.
- [x] C2 Prisma/store foundation: add `MarketplaceProgram`, `ProgramVersion`, `ProgramInstall`, `ProgramSession`, `PermissionGrant`, `ProgramRuntimeEvent`; run `npx prisma generate` + `prisma db push`; add store tests.
- [x] C3 collab-server runtime manager: wrap `createHeadlessSession` + proxy reuse for managed sessions; enforce env scrub, output caps, idle culling, kill switch; add backend tests.
- [x] C4 Next.js API contracts: permission-gated program-session launch/list/get/stop/restart/events routes with consent via `PermissionGrant`; add route tests.
- [x] C5 Minimal Programs surface: separate Programs activity-bar entry + panel with Launch Command / Running / Recent only; no marketplace/install UX in Phase 1.
- [x] C6 Unified program session tab: docked multi-instance session panels with App / Logs / Terminal / Ports / Health / Settings; reuse existing terminal + proxy paths.
- [x] C7 Regression + security sweep: targeted vitest/node tests, `npx prisma generate`, `prisma db push`, and full `npx vitest run` with only the known preview-store stub tolerated.

## Review
- Part A completed on `tool-compatibility`: staged set matched the requested 16-file OAuth hardening slice exactly; noise files stayed unstaged.
- Commit/push: `01ba2c07` (`fix(slice2): git-OAuth env reuse + dedupe re-OAuth provider rows`) pushed fast-forward to `origin/tool-compatibility`.
- Regression sweep: `cd synthi && npx vitest run` reported 24 passing suites / 174 passing tests plus the known pre-existing empty `src/lib/__tests__/preview-store.test.js` stub (`No test suite found in file`). No new failures surfaced.
- Slice-3 discovery: approved spec + roadmap sections 6/10/11 reviewed, all three blocking decisions resolved with the user, and the Phase-1 plan is written in `docs/superpowers/plans/2026-06-03-slice3-phase1-workspace-program-runtime-plan.md`.
- Decision log: R-1 locked — `synthi.program.json` is the Synthi superset and Slice 3 also detects/imports `devcontainer.json`; keep Phase 1 scoped to managed launches only, with manifest/devcontainer work planned for later phases.
- Decision log: R-3 locked — docking dedupe must respect a per-panel `allowMultiple` rule; Programs opt in to multiple session tabs, Connected Tools remains single-instance.
- Decision log: R-4 locked — keep Extensions, Connected Tools, and Programs as separate clearly labeled surfaces; no unified "Extend Synthi" hub in Phase 1.
- C1 complete: added a JSX-free panel-registry core for reducer/util access, made `openTab` and `floatTab` consult panel registration metadata, preserved `extension-view` keyed dedupe, and added reducer coverage for multi-instance docked/floating panels plus singleton floating reuse. Validation: `npx vitest run src/components/docking-wm/state/__tests__/layout-slice.panel-multiplicity.test.js` (4 passed), `npx vitest run src/components/docking-wm` (35 passed), targeted diagnostics on touched files (no errors).
- C2 complete: added the six approved Prisma models, kept `ProgramSession.installId` nullable for Phase-1 ad hoc command launches, implemented `src/lib/programs/store.js` for permission grants / sessions / runtime events, and removed the denormalized `PermissionGrant.installId` field so install↔grant linkage stays single-sourced on `ProgramInstall.grantId`. Validation: `npx vitest run src/lib/programs/__tests__/store.test.js` (8 passed), `npx prisma generate`, `npx prisma db push`, targeted diagnostics on touched files (no errors).
- C3 complete: extracted `backend/collab-server/programRuntimeManager.js` as the managed runtime authority for headless-session lifecycle, env scrubbing, output caps, idle culling, port snapshots, restart/stop, and redacted runtime events; wired `terminalService.js#createHeadlessSession` to accept scrubbed env overrides and clean up headless PTYs on exit; routed `/exec-terminal/:slug` through the manager; and exposed internal `GET /program-runtime/:slug/sessions`, `GET /program-runtime/:slug/sessions/:sessionId`, `GET /program-runtime/:slug/sessions/:sessionId/events`, `POST /program-runtime/:slug/sessions/:sessionId/stop`, and `POST /program-runtime/:slug/sessions/:sessionId/restart`. Validation: `node --check backend/collab-server/server.js`, `node --check backend/collab-server/terminalService.js`, `node --test backend/collab-server/__tests__/programRuntimeManager.test.js` (6 passed), targeted diagnostics on touched backend files (no errors).
- C4 complete: added `src/lib/programs/runtimeClient.js` plus the workspace program-session API routes for list/launch/get/stop/restart/events, enforced workspace member read vs owner/admin write through `resolveActor()` + scope helpers, gated first launch on a persisted `PermissionGrant`, reused the Prisma `ProgramSession.id` as the collab runtime `sessionId`, and redacted command/env fields from returned runtime events. Validation: `node --check backend/collab-server/server.js`, `node --test backend/collab-server/__tests__/programRuntimeManager.test.js` (6 passed) after the `sessionId` plumbing patch, `cd synthi && npx vitest run src/app/api/workspace/[slug]/program-sessions/__tests__/programSessionRoutes.test.js` (8 passed), targeted diagnostics on touched synthi files (no errors).
- C5 complete: added a dedicated Programs activity-bar entry and a minimal `ProgramsPanel` for both the legacy sidebar path and the active docking-wm path, with Launch Command plus Running and Recent session sections backed by the new workspace program-session API; kept Phase 1 intentionally scoped to managed ad hoc commands only, with no marketplace/install flows or session-detail tabs yet. Validation: `cd synthi && npx vitest run src/components/programs/__tests__/programSessionSections.test.js src/components/docking-wm/state/__tests__/layout-slice.panel-multiplicity.test.js` (8 passed), targeted diagnostics on touched frontend files (no errors).
- C6 complete: validated the in-progress C6 patch (validate-and-repair, no redesign) and fixed two TEST-ONLY defects — the production code (ProgramSessionPanel, panel-dedupe, layout-slice/layout-ops, wrappers + registry) was sound. (1) `ProgramSessionPanel.test.jsx` clicked `button:nth-of-type(2)`, which in document order resolves to the header **Stop** button (not the Logs sub-tab), so it never switched tabs and `launch_ack` never rendered → switched to the text-based `find(...includes('Logs'))` pattern already used for Terminal/Settings in that file. (2) `layout-slice.panel-multiplicity.test.js` registered a synthetic `'program-session-test'` panel type that bypassed the keyed-dedupe branch in `panel-dedupe.js`, so `shouldDeduplicatePanel` fell through to `allowMultiple !== true` (false) and openTab never deduped → use the real `'program-session'` type so it dedupes by `programSessionId` (same id reuses, different id opens new); traced all 5 cases incl. the float path to confirm no regressions. Wiring statically verified: `ide-panels` → `ProgramSessionPanelWrapper` → dynamic `import('@/components/programs/ProgramSessionPanel')` → props (`sessionId={data.programSessionId}`) all line up, and ProgramsPanel's `openTab/activateTabAction/setFocusedTabGroup/selectNodes/selectTabs` imports all exist in `layout-slice.js`. Validation: `cd synthi && npx vitest run ProgramSessionPanel.test.jsx layout-slice.panel-multiplicity.test.js` (2 files, 7 passed); `npx vitest run src/components/programs src/components/docking-wm` (6 files, 42 passed). Follow-up for C7: confirm the launch POST returns `{ session }` so open-on-launch fires (manual Open works regardless).
- C7 complete (Phase-1 regression + security sweep): synthi `npx vitest run` → 30 files, **201 passed** (only the known empty `src/lib/__tests__/preview-store.test.js` stub tolerated); backend `node --test backend/collab-server/__tests__/programRuntimeManager.test.js` → **6 passed** (env-scrub + output-caps, restart/stop kill-switch, idle-cull + crash marking). `npx prisma generate` ✔ (client v6.19.3); `npx prisma db push` → "already in sync" (C2 models live; schema unchanged since C5/C6 were frontend-only). Security sweep verified the Phase-1 hard constraints in code: env scrub is a default-allow denylist — `BLOCKED_ENV_KEYS` + `BLOCKED_ENV_PREFIXES` + `BLOCKED_ENV_VALUE_FRAGMENTS` covering DATABASE/POSTGRES/REDIS/PRISMA/GOOGLE/GCS/KUBERNETES/K8S/DOCKER_HOST+SOCKET+CERT/NEXTAUTH/AUTH/YSWEET + SYNTHI_PLATFORM/DB/GCS — plus `DEFAULT_OUTPUT_CAP=50k`, stop=kill, idle-cull; the launch route gates on workspace write authz + a `PermissionGrant` (409 `consent_required` when none and no requested scopes, else creates a grant incl. `program.launch`). C6 follow-up RESOLVED: launch POST returns `{ session, grant, launch }`, so ProgramsPanel open-on-launch (`launched.session`) fires. Minor forward note (NOT a Phase-1 blocker): `selectConsentGrant` returns `grants[0]` without scope-matching — fine while `program.launch` is the only scope; should scope-match when later phases add scopes.

---

## Slice 3 Phase 1 — COMPLETE (C1–C7, on `tool-compatibility`)
All seven checkpoints landed and verified. C6 committed as `e82b69e8`. Regression green (synthi 201 + backend 6; only the pre-existing empty preview-store stub tolerated), schema synced, Phase-1 security constraints verified. Deferred by environment gate: `next build` / `docker build` (disk). Branch not pushed (awaiting direction).

---

# Task: Slice 3 Phase 2 — Recipe Manifests & Persisted Installs (2026-06-06, tool-compatibility)

Plan: `docs/superpowers/plans/2026-06-06-slice3-phase2-recipe-manifests-installs-plan.md`.
Branch: `tool-compatibility` only. Disk gate: TDD only (vitest / `node --test` / `prisma generate|db push`); NO `next build` / `docker build`. No schema change expected (C2 models exist).

## Phase-2 Implementation Tasks (TDD, commit per task)
- [x] P2-T1 `synthi.program.json` manifest parser/validator (`src/lib/programs/manifest.js`) — normalize + fail-closed validation (path-escape, unknown-scope, port range, unsupported runtime). Committed `bed5f6cf`; 14 new tests, `src/lib/programs` 22 pass.
- [x] P2-T2 devcontainer import mapper (`src/lib/programs/devcontainer.js`) — documented subset → same normalized shape; reject host mounts / docker.sock / privileged; strip blocked env. Committed `ae81151d`; 11 new tests, `src/lib/programs` 33 pass. Refinement: workspaceFolder ignored-with-warning (container path) instead of path_escape false-reject.
- [x] P2-T3 Local program + install store helpers (`src/lib/programs/store.js`) — upsertLocalProgram / install CRUD / toPublicInstall redaction. Committed `3db60ced`; 6 new tests, `src/lib/programs` 39 pass.
- [x] P2-T4 Manifest discovery + install/launch orchestration (`runtimeClient.js` + `programRuntimeManager.js` + `server.js`). composeProgramCommand (`cd && install && launch`), launchManagedProgram (declared env scrubbed, declared ports seeded), runtimeClient discoverManifest/launchInstalledProgram, collab `POST /launch-program` + `GET /manifest` endpoints. Backend `node --test` 8 pass; `src/lib/programs` 43 pass; server.js `node --check` ok.
- [x] P2-T5 Program install/launch API routes (marketplace/installed/install/[installId]/launch) — owner-admin write, member read, consent→PermissionGrant w/ manifest scopes (scope-matched, resolving the C7 forward note). Added store `listLocalPrograms`/`getProgramVersion`. `src/app/api/workspace` 19 pass (8 phase-1 + 11 new); `src/lib/programs` 45 pass.
- [x] P2-T6 Programs sidebar Installed section + install-from-manifest + consent prompt + launch-from-install. Member view gated (canManage = role !== 'member') hides install/launch. `src/components/programs` 10 pass (6 existing + 4 new).
- [x] P2-T7 Regression + security sweep (full vitest + backend node test + prisma; security checklist). Full `npx vitest run` → 34 passed / **253 tests passed** (only the known empty `src/lib/__tests__/preview-store.test.js` stub tolerated); backend `node --test programRuntimeManager.test.js` → **8 pass**; `npx prisma generate` ✔ (v6.19.3); `npx prisma db push` → "already in sync" (no Phase-2 schema change).

## Phase-2 security checklist (each invariant pinned by a committed test)
- [x] Manifest fail-closed — workingDir/install path traversal → `path_escape`; unknown scope → `unknown_scope`; port out of range → `invalid_port`; gui/unknown runtime → `unsupported_runtime`. (`manifest.test.js`, T1)
- [x] Devcontainer host-escape denied — privileged, host bind mounts, `/var/run/docker.sock`, `--privileged`/`--security-opt`/`-v`/`--device`/`--cap-add` runArgs, docker-in-docker & sshd features → `host_escape`; image/build kept informational only. (`devcontainer.test.js`, T2)
- [x] Declared env cannot reintroduce platform secrets — `launchManagedProgram` scrubs `config.env` through the same denylist (DATABASE/POSTGRES/REDIS/PRISMA/GOOGLE/GCS/K8S/DOCKER_HOST+SOCKET+CERT/NEXTAUTH/AUTH/YSWEET/SYNTHI_*), proven by the DATABASE_URL-in-manifest scrub test. (`programRuntimeManager.test.js`, T4)
- [x] Install records never leak secrets — `toPublicInstall` is allow-listed (id/programId/slug/version/status/installedBy/grantId/timestamps/packageId/publisher); manifestJson/env never serialized. (`store.test.js`, T3)
- [x] Failed install short-circuits launch — `composeProgramCommand` = `cd "<wd>" && <install...> && <launch>`; shell `&&` aborts before launch on non-zero install → existing crash path. (`programRuntimeManager.test.js`, T4)
- [x] Role + consent gates — install/launch require owner/admin (`canWriteScope`); reads require member; missing/insufficient grant → 409 `consent_required` carrying the manifest's requested scopes; grant must cover required scopes (scope-matched, closing the C7 forward note). (`programRoutes.test.js`, T5)
- [x] Member UI gating — install-from-manifest, consent prompt, and launch-from-install controls hidden when `role === 'member'`. (`programsPanelInstall.test.jsx`, T6)
- [x] Inherited Phase-1 guards still enforced — output cap (`DEFAULT_OUTPUT_CAP`), idle cull, stop=kill, redacted runtime events — carried by the managed runtime the program launch path reuses. (`programRuntimeManager.test.js`)

## Phase-2 Review — COMPLETE (P2-T1..T7, on `tool-compatibility`)
All seven Phase-2 tasks landed via strict red→green TDD, each committed with the `Co-Authored-By: Claude Opus 4.8` trailer (only specific files staged; pre-existing noise files left untouched).
- Recipe ingestion: `manifest.js` (synthi.program.json superset) and `devcontainer.js` (documented subset) both normalize to the single `NormalizedProgramConfig` shape and run through the **same** `parseProgramManifest` invariants, so devcontainer imports inherit every fail-closed rule (path-escape / unknown-scope / port / runtime) plus host-escape rejection. devcontainer `image`/`build` are informational `sourceHints` only — never executed; `workspaceFolder` is ignored-with-warning rather than false-rejected.
- Persistence: `upsertLocalProgram` namespaces workspace recipes as `local:<slug>:<id>` (publisher `local`) via idempotent upserts; install CRUD + `toPublicInstall` redaction keep manifest/env server-side.
- Orchestration: `composeProgramCommand` + `launchManagedProgram` reuse the Phase-1 managed runtime (env scrub / caps / idle-cull / kill switch); collab `GET /manifest` discovers the recipe and `POST /launch-program` runs it; `runtimeClient` bridges Next→collab.
- API + UI: marketplace/installed/install/[installId]/launch routes enforce owner-admin write vs member read with manifest-scoped consent; ProgramsPanel gains an Installed section, install-from-manifest, a scope-listing consent prompt, and launch-from-install, all hidden from plain members.
- Verification: synthi `npx vitest run` **253 passed** (1 known empty stub tolerated); backend `node --test` **8 pass**; prisma generate ✔ + db push "already in sync" (C2 models reused, no schema delta).
- Deviations / forward notes: C7's `selectConsentGrant` non-scope-matched note is **resolved** — install consent now scope-matches (`grantCoversScopes`). Disk-gated out (per instructions): `next build` / `docker build` — Phase 2 is TDD-only; an end-to-end docker rebuild (frontend + collab) remains the eventual live check before shipping. Branch not pushed (awaiting direction); ~13 unpushed `tool-compatibility` commits accumulated.

---

# Task: Slice 3 Phase 3 — Web-Port Auto-Detection + Polished Program Tab UX (2026-06-08, tool-compatibility)

Plan: `docs/superpowers/plans/2026-06-08-slice3-phase3-web-port-detection-program-ux-plan.md`.
Branch: `tool-compatibility` only. Disk gate: TDD only (vitest / `node --test` / `prisma generate|db push`); NO `next build` / `docker build`. No schema change expected (`ProgramSession.lastHealthState` exists).

Existing plumbing reused: `proxyService` global scanner (`getActivePorts`/`onPortsChanged`/`/port/<N>/` proxy), manager `refreshManagedSessionPorts` + `ports_updated`, panel App/Ports/Health surfaces, `mergeProgramSession`, manifest `health` ({type,target,intervalMs}) + `surfaces`.

## Phase-3 Implementation Tasks (TDD, commit per task)
- [x] P3-T1 Pure port-attribution + web-port-selection helpers (`attributeSessionPorts`, `selectWebPort`, `samePorts`) in programRuntimeManager.js. Committed `0e095c1d`; 7 node --test cases (backend 8→15).
- [x] P3-T2 Continuous per-session port recompute (`recomputeManagedPorts`) wired to `proxyService.onPortsChanged`; thread `declaredPorts` onto the record; `refreshManagedSessionPorts` delegates. Committed `8012566c`; +2 tests (→17) + server `node --check`. NOTE: started the previously-inert `proxyService.startScanner` at collab startup (see deviations).
- [x] P3-T3 Injectable HTTP health probing (`probeManagedSessionHealth`, path-only `healthPath`, clamp interval); start on launch / clear on stop+exit; snapshot exposes `healthState`, hides `health`/`healthTimer`. Committed `b03fd99c`; +4 tests (→21).
- [x] P3-T4 `mergeProgramSession` surfaces live `healthState` as `lastHealthState`; route assertion. Committed `ced3f7aa`; new `routeHelpers.test.js` (3) + program-sessions route assertion.
- [x] P3-T5 ProgramSessionPanel polish — App waiting state, actionable Ports (Open / Set as App), live health badge. Committed `75cf90ec`; 3 jsdom tests (panel 2→5).
- [x] P3-T6 Regression + security sweep (full vitest + backend node test + prisma; security checklist) + Phase-3 review. Full `npx vitest run` → 35 passed / **259 tests** (only the known empty `preview-store.test.js` stub tolerated); backend `node --test` → **21 pass**; prisma generate ✔ + db push "already in sync".

## Phase-3 security checklist (each invariant pinned by a Phase-3 test)
- [x] Port attribution never cross-assigns a declared port to another session — declared∩detected per session; undeclared live ports only go to a *single* no-declared running session, else dropped; stopped sessions excluded. (`attributeSessionPorts` tests, T1)
- [x] Health probe targets ONLY `PROXY_HOST:<webPort>` + a path — a manifest-supplied scheme/host is stripped by `healthPath` (proven by `http://evil.example.com/steal → http://127.0.0.1:8080/steal`), so a manifest can't aim the probe at an arbitrary host (SSRF guard). (T3)
- [x] Runtime snapshot never leaks `health` config, `healthTimer`, `runtime`, or `launchRequest` (env) — `toPublicManagedSession` redaction + the snapshot-leak test. (T3)
- [x] Health timer cleared on stop + exit (no probe leak past session end); idle/health timers all `unref`'d. (manager teardown)
- [x] Inherited Phase-1/2 guards intact (env scrub, output cap, idle cull, kill switch, role/consent gates) — unchanged code paths; full regression + backend suite green.

## Slice 3 Phase 3 — COMPLETE (P3-T1..T6, on `tool-compatibility`)
All six Phase-3 tasks landed via strict red→green TDD, each committed with the `Co-Authored-By: Claude Opus 4.8` trailer (specific files staged; noise files untouched).
- Web-port auto-detection: two pure helpers (`attributeSessionPorts`, `selectWebPort`) + `recomputeManagedPorts` drive each running session's live `activePorts`/`webPort`, fed by the global `proxyService` scanner via `onPortsChanged`. `ports_updated` emits only on change.
- Health: injectable `probeManagedSessionHealth` (path-only, own-port) flips `unknown→ok/unhealthy` and emits `health_changed`; scheduled on launch for `health.type==='http'`, cleared on stop/exit; defaults wire real `http.get` + interval in production with no server change.
- Surfacing: `mergeProgramSession` maps live `healthState` → `lastHealthState`; the panel gained a live health badge, a "waiting for web server" App state, and actionable Ports (Open / Set-as-App via a client-side `appPortOverride`).
- Verification: backend `node --test` 21 pass; targeted suites 14 files/116; full `npx vitest run` **259 passed** (1 known empty stub tolerated); prisma generate ✔ + db push "already in sync" (no schema delta).
- **Deviations / forward notes:**
  1. `selectWebPort` simplified — dropped the planned `runtimeType`/`surfaces` gate (it would have broken the existing Phase-1 test that expects a default-`cli` session with attributed ports to get a `webPort`; attribution already decides ownership). Consequently `surfaces` is NOT threaded onto the record (YAGNI — nothing consumed it).
  2. **Discovered latent gap:** `proxyService.startScanner` was defined/exported but **never called** anywhere — so `activePorts` was always empty and the `/port/<N>/` preview + Phase-1 port refresh were effectively inert. Phase 3 starts the scanner at collab-server startup (passing the server's own PORT to exclude self). This is required for auto-detection to work at all.
  3. Disk gate: `next build`/`docker build` not run (TDD-only). The scanner-start + `onPortsChanged` wiring and the real `http.get` health probe are verified by `node --check` + injectable-unit tests; **end-to-end behavior (a real dev server's port lighting up the App tab, live health) needs a live collab-server rebuild** — the remaining live check before shipping.
  4. Transient `ENOSPC` truncated `routeHelpers.js` mid-edit during T4; restored from HEAD and re-applied cleanly (disk ~5.5G free; not actually full). No data lost.
  Branch not pushed (awaiting direction); ~19 unpushed `tool-compatibility` commits accumulated. [UPDATE: pushed `fb800aa2..c1dc12c7` to origin/tool-compatibility — 8 commits; branch stays open, no merge/PR.]

---

# Task: Slice 3 Phase 4 (Thin Slice) — GUI Runtime Type + Stubbed Surface (2026-06-08, tool-compatibility)

Plan: `docs/superpowers/plans/2026-06-08-slice3-phase4-gui-runtime-type-thin-slice-plan.md`.
Decision: Phase 4's real GUI capture (Xvfb/GStreamer/WebRTC + broker lease/freshness) is **deferred** — it needs live infra + the broker rollout + its own branch, and is not TDD-able under the disk gate. This phase ships only the TDD-able sliver; the deferred work is fully enumerated in the plan's "DEFERRED" section.
Branch: `tool-compatibility` only. Disk gate: TDD only. No schema change (`ProgramSession.runtimeType` exists).

## Phase-4 (thin) Implementation Tasks (TDD, commit per task)
- [x] P4-T1 Un-defer `gui` in `manifest.js` (`SUPPORTED_RUNTIME_TYPES` + `normalizeRuntimeType` + `deriveSurfaces` gives gui an `app` surface). Committed `d1b3238e`; flipped the gui-rejection manifest test → acceptance + added unknown-runtime rejection (manifest 14→16... net 15 file tests).
- [x] P4-T2 Stubbed GUI surface shell in `ProgramSessionPanel` — `runtimeType==='gui'` App tab renders `gui-surface` (placeholder for the future WebRTC `<video>`) instead of the web iframe. Committed `e087eeb2`; panel 5→6 jsdom tests.
- [x] P4-T3 Regression (targeted + backend unchanged + full vitest) + Phase-4 (thin) review. Backend `node --test` 21 (unchanged); targeted `src/lib/programs src/components/programs` 8 files/63; full `npx vitest run` → 35 passed / **261 tests** (only the known empty `preview-store.test.js` stub tolerated).

## Slice 3 Phase 4 (thin slice) — COMPLETE (P4-T1..T3, on `tool-compatibility`)
The TDD-able sliver of Phase 4 landed via red→green TDD, committed with the `Co-Authored-By: Claude Opus 4.8` trailer (specific files staged; noise untouched):
- `gui` is now a first-class runtime type: `manifest.js` accepts it (and devcontainer stays web/background-only, since it has no gui signal — gui is `synthi.program.json`-only), and `deriveSurfaces` gives gui an `app` (stream) surface.
- The Program session tab routes a `gui` session's App tab to a stubbed `gui-surface` shell (placeholder for the future WebRTC `<video>`), bypassing the web iframe / waiting / no-port chain.
- Verification: backend 21 (unchanged), targeted 8/63, full `npx vitest run` **261 passed** (1 known stub tolerated). No schema change.
- **Deferred (by decision):** the real GUI capture — Xvfb/GStreamer/WebRTC via the Rust worker + signaling-server, broker lease/freshness for input, the live `<video>` surface — is fully enumerated in the plan's "DEFERRED — Broker / WebRTC GUI capture" section. It needs live infra + the broker rollout + (per the Slice-3 spec) its own broker-companion branch with the disk gate lifted. Revisit there.

---

## Mid-test fixes (2026-06-08, surfaced during live Phase-2/3 testing)
- Recipe filename rebranded `synthi.program.json` → `vectant.program.json` → **`vectant.programs.json`** (plural, per product). Pushed.
- ProgramsPanel surfaces the install route's `manifest_invalid` `message` on a 422 (was a generic toast). Pushed.
- **Per-user repo discovery bug (root cause of the 422):** the Phase-2 manifest endpoint called `resolveWorkspaceCwd(slug)` without userId, so per-user-repo workspaces (`repos/<slug>/<userId>`) read the shared dir and missed the manifest. Fixed: `discoverManifest(slug, userId)` forwards the actor's id → `GET /manifest` → `resolveWorkspaceCwd(slug, userId)`. Install route now returns 422 only for real `ProgramManifestError`, 502 for infra/connectivity. Committed `17fb3290`, pushed.

---

# Task: Slice 3 Phase 5 v1 — Open Marketplace (Publish + Browse + Install) (2026-06-08, tool-compatibility)

Plan: `docs/superpowers/plans/2026-06-08-slice3-phase5-open-marketplace-v1-plan.md`. Design approved by user.
Scope (approved): Publish (`@<slug>/<name>`, owner/admin) + global Browse/search + Install-from-catalog + `installCount` reputation. **Deferred:** signing, ratings/reviews, abuse/takedown, private visibility (enumerated in the plan's DEFERRED section).
Branch: `tool-compatibility` only. Disk gate: TDD only (vitest / `node --test` / `prisma generate|db push`). Schema change: +4 additive cols on `MarketplaceProgram` (Task 1 db push).

## Phase-5 v1 Implementation Tasks (TDD, commit per task)
- [x] P5-T1 Schema (+displayName/description/publishedByUserId/installCount) + manifest optional `description`. Committed `f8df7845`; manifest 16 pass + db push applied.
- [x] P5-T2 Store: `publishProgram` (`@slug/<name>`, publisher=slug) + `toPublicMarketplaceProgram` (redacts manifest). Committed `8fed5435`; store 18 pass.
- [x] P5-T3 Store: `listPublishedPrograms({q})` (publisher≠local, search, order by installCount) + `getPublishedProgramVersion` + `incrementInstallCount`. Committed `36a67f5e`; store 23 pass.
- [x] P5-T4 API: `POST /programs/publish` (owner/admin) + `GET /programs/marketplace?q=` → global published catalog. Committed `c5d28d78`; programRoutes 16 pass.
- [x] P5-T5 API: extend `POST /programs/install` to install a published `{packageId,version}` (manifest from its version) + bump installCount; local path unchanged. Committed `7e02de73`; programRoutes 19 pass.
- [x] P5-T6 UI: ProgramsPanel Publish action (gated) + Marketplace browse/search + install-from-catalog (consent reused). Committed `f184358c`; programs components 18 pass.
- [x] P5-T7 Regression + security sweep + Phase-5 review. Full `npx vitest run` → 35 passed / **281 tests** (only the known empty `preview-store.test.js` stub tolerated); backend `node --test` → **21 pass**; prisma generate ✔ + db push "already in sync".

## Phase-5 security checklist (each invariant pinned by a committed test)
- [x] Publish/install require owner/admin (`canWriteScope`); browse requires member (`canReadScope`). 403 otherwise. (`programRoutes.test.js`: publish-member-403, marketplace-non-member-403, install-member-403)
- [x] Published install still gates on consent → a `PermissionGrant` covering the manifest's declared scopes; 409 `consent_required` (listing scopes) otherwise; install-count is only bumped after a successful install. (`programRoutes.test.js`: 409 consent + published-install bump)
- [x] `toPublicMarketplaceProgram` never leaks `manifestJson`/`versions`/`publishedByUserId` — allow-listed projection only. (`store.test.js`: toPublicMarketplaceProgram leak test)
- [x] Published manifests are parsed through `parseProgramManifest` at publish time (via `discoverManifest`) — same fail-closed validation; install reads the already-validated stored config (`getPublishedProgramVersion` parses the stored manifestJson). (`programRoutes.test.js` publish 422/502 + `store.test.js`)
- [x] Namespace `@<slug>/...` prevents cross-workspace name squatting; `publisher != 'local'` cleanly separates the public catalog from workspace-local rows (browse + version lookup both exclude `local`). (`store.test.js`: listPublishedPrograms where-clause, getPublishedProgramVersion local→null)
- [x] Member UI gating — Publish + install-from-catalog controls hidden when `role === 'member'`. (`programsPanelInstall.test.jsx`: hides Publish for member)

## Phase-5 v1 Review — COMPLETE (P5-T1..T7, on `tool-compatibility`)
All seven Phase-5 v1 tasks landed via strict red→green TDD, each committed with the `Co-Authored-By: Claude Opus 4.8` trailer (specific files staged; pre-existing noise files untouched). Open marketplace = publish + browse/search + install-from-catalog + `installCount` reputation.
- Publish: an owner/admin's workspace recipe is re-discovered (`discoverManifest(slug, actor.userId)` — per-user-repo safe) and upserted as a `MarketplaceProgram` with `publisher=<slug>`, `packageId=@<slug>/<name>`; idempotent re-publish updates the version's manifest / bumps `latestVersion`.
- Browse: `GET /programs/marketplace?q=` now returns the **global** published catalog (`publisher != 'local'`, case-insensitive contains on packageId/displayName/publisher, ordered by `installCount desc`) — replacing the Phase-2 local-only listing; `toPublicMarketplaceProgram` redacts the manifest.
- Install: `POST /programs/install` accepts either a published `{packageId, version}` (manifest from its stored `ProgramVersion`) or the local workspace manifest (unchanged); both gate on the same consent `PermissionGrant`; published installs `incrementInstallCount` only on success. The 422/502 manifest/infra disambiguation is preserved.
- UI: ProgramsPanel gained a gated Publish action, a Marketplace browse/search section, and install-from-catalog that reuses the existing consent prompt (`consent.published` routes approve → `handleInstallPublished`).
- Verification: targeted `src/lib/programs` + `programs` routes + `programs` components → 9 files / 94; backend `node --test` 21 (unchanged); full `npx vitest run` **281 passed** (1 known empty stub tolerated); prisma generate ✔ + db push "already in sync" (T1 applied the 4 additive columns).
- **Deferred (by decision, enumerated in the plan's DEFERRED section, NOT in v1):** cryptographic version signing+verify, ratings/reviews, abuse reporting + `disabled`/takedown, private/unlisted visibility, version pinning / update-available flow.
- Disk gate (per instructions): `next build` / `docker build` not run — Phase-5 is TDD-only; an end-to-end live publish→browse→install across two workspaces remains the eventual live check before shipping.

## Phase-5 LIVE VERIFICATION — DONE (2026-06-09, rebuilt Docker stack)
User lifted the disk gate to rebuild + verify. Freed ~18.5 GB of Docker build cache/dangling images, rebuilt the **frontend** image (only `synthi/` changed this phase), recreated the container. Drove the flow in the logged-in browser (authenticated fetch + the real Programs panel):
- **Publish** `marketplace-pub` recipe → `200`, persisted as `@n964u0lg/web` (publisher `n964u0lg`, displayName/description carried, manifest not leaked).
- **Browse** + **search** (`?q=demo`) from a *different* workspace `gyo5w46k` → `200`, lists `@n964u0lg/web` (case-insensitive match on displayName).
- **Install** → `409 consent_required` (`["program.launch"]`) without consent, then `200 installed` with consent (+ a new `PermissionGrant`); **installCount bumped 0→1**.
- **Programs panel UI** renders the `Marketplace` section, owner-gated **Publish** button, and the catalog card "Demo Web Server · @n964u0lg/web · 1 installs · Install".
- **Two pre-existing infra issues found (NOT Phase-5 bugs):** (1) frontend service was missing `COLLAB_SERVER_URL` → server-side program calls 502'd on `localhost:1234`; fixed by wiring it to the compose hostname (committed `1668e0ff`, pushed). (2) program-runtime resolves the repo dir by the DB `User.id` (cuid) while workspace files are stored under the GitHub id (`session.user.id`) → IDE-saved manifests are invisible to publish/install; worked around for the test by placing the manifest at the shared workspace root; flagged as a separate background task to fix properly.

---

# Task: Default Marketplace Programs + Programs Panel UI Redesign (2026-06-09, tool-compatibility)

Spec: `docs/superpowers/specs/2026-06-09-default-marketplace-programs-and-ui-design.md`. Plan: `docs/superpowers/plans/2026-06-09-default-marketplace-programs-and-ui-plan.md`. Executed via subagent-driven development (fresh implementer per task + spec-compliance + code-quality review each).

## Tasks (TDD, commit per task)
- [x] T1 `defaultPrograms.js` — `DEFAULT_PROGRAM_RECIPES` (7: web×4 + background + tui + devcontainer) + `buildDefaultPrograms()`. Committed `777e030e`; 3 tests.
- [x] T2 `ensureDefaultPrograms(prisma)` — idempotent upsert (publisher `vectant`, verified true; `update` omits `installCount` to preserve reputation). Committed `31d59700` (+lint `0ab9c7bb`); 5 tests.
- [x] T3 Seed route `POST /api/programs/seed-defaults` — auth-gated + `ENABLE_PROGRAM_SEED=1`-gated (404 when off, 401 unauth). Committed `55cd922a`; 3 tests.
- [x] T4 Marketplace card redesign + Verified badge (`verified-badge-<pkg>`) + descriptions. Committed `57c1cb79`; +1 UI test.
- [x] T5 Cohesive panel restyle — shared `SectionHeader`, hover chrome, consistent empty states. Committed `899d492a` (+Marketplace count alignment fix `be7d504c`).
- [x] T6 Regression + (live seed/verify PENDING) + review.

## Verification
- Targeted `src/lib/programs` + `api/programs` + `api/workspace/[slug]/programs` + `components/programs` → 11 files / **103 pass**.
- Backend `node --test programRuntimeManager.test.js` → **21 pass** (unchanged — no backend changes).
- Full `npx vitest run` → **290 pass** (37 files; only the known empty `preview-store.test.js` stub tolerated).
- `prisma generate` ✔ + `db push` "already in sync" (NO schema change — defaults reuse the Phase-5 `MarketplaceProgram`/`ProgramVersion` models).
- **Final holistic review: READY** — schema-safe (every field `ensureDefaultPrograms` writes exists on the model; `programId_version` compound key matches), validation chain unbroken (manifest recipes via `parseProgramManifest`, devcontainer via `importDevcontainer` → same fail-closed rules), security gates correct (auth before flag; `verified:true` only on `@vectant/*`; `manifestJson` never leaked), browse+install work with ZERO store/route changes (`publisher != 'local'` + `getPublishedProgramVersion`).

## Security checklist
- [x] Seed route inert by default — requires auth (401) AND `ENABLE_PROGRAM_SEED=1` (404 otherwise). (`seedDefaultsRoute.test.js`)
- [x] Every default validated through `parseProgramManifest`/`importDevcontainer` — no bypass; host-escape rules inherited by the devcontainer default. (`defaultPrograms.test.js`)
- [x] `installCount` never written on re-seed `update` (preserves reputation). (`defaultPrograms.test.js`)
- [x] `verified:true` only on seeded `@vectant/*`; user `publishProgram` stays `verified:false`. (verified in final review)
- [x] No manifest/secret leak — relies on the existing allow-listed `toPublicMarketplaceProgram`.

## Live verification — DONE (2026-06-09, after Docker Desktop restart)
Rebuilt the frontend image (host disk dipped to ~1.2 GB during build but completed exit 0), recreated with a TEMPORARY `ENABLE_PROGRAM_SEED=1`, and drove the flow in the logged-in browser:
- **Seed:** `POST /api/programs/seed-defaults` → `200 { count: 7 }` (all 7 `@vectant/*` created).
- **Browse:** workspace marketplace returns the 7 defaults, all `verified:true` with descriptions (8 rows total incl. the prior user-published `@n964u0lg/web`, which is `verified:false`).
- **Install-from-catalog:** `@vectant/nextjs-dev` → `409 consent_required` listing its 3 scopes (`program.launch`,`network.outbound`,`ports.expose`) → `200 installed` with consent → **installCount 0→1**.
- **UI:** Programs panel renders all 7 defaults with gradient **Verified** badges (7 badges; the user-published one has none), descriptions, and non-web cards (Background Worker, Dev Container with its honest "runs in the managed runtime today" copy). Redesigned cards/section-headers look on-brand (screenshot captured).
- **Cleanup:** removed the temporary `ENABLE_PROGRAM_SEED` flag + recreated frontend → seed route now returns **404** (inert), the 7 seeded rows persist. `docker-compose.yml` reverted to its committed state (only the committed `COLLAB_SERVER_URL` remains).

## Deferred (not in this task)
- Native Docker / container runtime (own slice — backlog below).
- Per-card runtime-type chip/filter (needs denormalized `runtimeType` column).
- Auto-seed on boot/deploy; per-default icons.

---

# Task: Make Default Programs Runnable (2026-06-09, tool-compatibility)

Spec: `docs/superpowers/specs/2026-06-09-make-default-programs-runnable-design.md`. Plan: `docs/superpowers/plans/2026-06-09-make-default-programs-runnable-plan.md`. Subagent-driven (implementer + spec + code-quality review per task; final holistic review READY).

## Tasks (TDD, commit per task)
- [x] T1 `resolveActor()` += `workspaceUserId = session.user.id || email` (IDE repo-dir id; DB `userId`/cuid kept for FK records). `839881..` (+coverage `15ac79a4`); 4 tests.
- [x] T2 Thread `workspaceUserId` into publish/install/launch **cwd resolution** (`discoverManifest`/`launchInstalledProgram`); DB-record fields stay on `actor.userId`. `dd0fd7e9` (+comment `ad9421a5`).
- [x] T3 App-tab CSP fix — `buildContentSecurityPolicy(collabUrl)` adds the collab origin to `frame-src`; wired in `next.config.mjs` (localhost fallback non-prod-guarded). `133c4a3e` (+`04b873bb`); 4 tests.
- [x] T4 `scaffoldTemplates.js` — minimal inline starters for 5 defaults (nextjs/vite/flask/static/worker) + `getScaffoldTemplate`/`SCAFFOLDABLE_PACKAGE_IDS` (own-property guard). `7851af75` (+proto fix `af635a59`); 5 tests.
- [x] T5 collab `applyScaffoldFiles(cwd,files)` (write-missing, 2-layer path guard) + `POST /program-runtime/:slug/scaffold`. `5b0a36e3` (+`982f1343`); 4 node tests.
- [x] T6 `runtimeClient.scaffoldProgram` + owner-gated `POST /api/workspace/[slug]/programs/scaffold` (server-side templates, `workspaceUserId`). `94266bef` (+`b4079c4d`); 3 route tests.
- [x] T7 UI "Set up project" action (confirm → scaffold → launch) on scaffoldable installs. `b1414cf9` (+`409030bc`); 2 UI tests.
- [x] T8 Regression + live verify + review.

## Verification
- Targeted `src/lib/programs|security|integrations` + `api/workspace/[slug]/programs` + `components/programs` → 18 files / **145 pass**.
- Backend `node --test programRuntimeManager + scaffold` → **25 pass**.
- Full `npx vitest run` → **305 pass** (only the known empty `preview-store.test.js` stub tolerated). prisma `db push` "already in sync" (no schema change).
- **Final holistic review: READY** — cross-hop shapes consistent end-to-end (`{path,contents}` files + `{written,skipped}` return + `workspaceUserId` threaded UI→route→runtimeClient→collab→`resolveWorkspaceCwd`); security solid (owner-gated, server-side templates, path-traversal + proto guards); CSP non-regressive.

## LIVE VERIFICATION — DONE (rebuilt frontend + collab-server)
- **CSP fix proven:** live `frame-src` header now = `'self' blob: http://localhost:1234` (the collab proxy origin), so the App tab can embed a running web program (was "this content is blocked").
- **Dir-consistency fix proven end-to-end:** authenticated `POST /programs/scaffold {@vectant/flask-api}` → `200 {written:["requirements.txt","app.py"]}`; the files landed in the **IDE's per-user dir** `/data/repos/gyo5w46k/242593757/` (where the editor reads), NOT the shared `/data/repos/gyo5w46k/` fallback the cuid used to hit. So launch/publish/install now operate on the user's real project files. (Test artifacts cleaned up afterward.)
- Routes deployed: scaffold route 401 (gated); collab scaffold endpoint 200.
- Note: the full launch→`npm install`→dev-server→App-tab-embed chain wasn't driven end-to-end live (long/network-bound), but its only blocker (CSP `frame-src`) is verified fixed and launches now run in the correct dir.

## Security checklist
- [x] Scaffold route owner/admin-gated (`canWriteScope`); 403 for members. (`programRoutes.test.js`)
- [x] Server-side templates only — client `files` ignored (the route uses `getScaffoldTemplate(packageId)`). (route + final review)
- [x] `applyScaffoldFiles` rejects path traversal/absolute (2 layers) + never clobbers existing files. (`scaffold.test.js`)
- [x] `getScaffoldTemplate` own-property guard (no `__proto__`/`constructor` bypass). (`scaffoldTemplates.test.js`)
- [x] CSP only extends `frame-src` (no other directive regressed); prod gets no localhost noise. (`csp.test.js` + final review)
- [x] DB-record FK fields keep `actor.userId` (cuid); only cwd resolution uses `workspaceUserId`. (`programRoutes.test.js` + final review)

## Deferred / notes
- Empty-`workspaceUserId` → shared-dir fallback is a pre-existing low-risk edge (auth guarantees email non-null); not changed.
- `scaffoldTemplates.js` is imported client-side for `SCAFFOLDABLE_PACKAGE_IDS` (bundles ~3KB of template strings — negligible; could split later).

## Follow-up: runtime toolchain for the defaults (DONE for dev) — commit `b8b2a570`
Live testing surfaced that the program runtime (collab-server image, node:20/Debian 12) is Node-first: Node defaults run, but **Flask hit `pip: command not found`** and **lazygit had no binary**. Fixes:
- `backend/collab-server/Dockerfile`: added `python3-venv python3-pip curl ca-certificates` + the **lazygit** binary (GitHub release v0.44.1).
- `defaultPrograms.js`: `@vectant/flask-api` recipe → **venv-based** (`python3 -m venv .venv && .venv/bin/pip install -r requirements.txt && .venv/bin/flask run …`), because Debian 12 system Python is externally-managed (PEP 668). Re-seeded so the DB recipe updated (verified: venv install/launch stored).
- Live-verified in the rebuilt collab-server: `pip3`/`lazygit` present, `python3 -m venv` works, and `flask` installs+runs in a venv (Flask 3.1.3).
- Also: a Next.js launch failed with npm `ENOTEMPTY` — that was stale `node_modules` from an **interrupted install** (not a feature bug); cleaning `node_modules` → fresh `npm install` succeeds. (Robustness idea for later: self-healing install / cleanup of `.pkg-XXXX` temp dirs after an interrupted launch.)
- **PROD TODO:** the prod program runtime is the per-workspace **worker pod** (`workspacePodSpawner.js`), NOT collab-server. The same toolchain (python3-venv/pip + lazygit) must be added to the prod worker image for Flask/lazygit to work in production. (Dev = collab-server, now done.)

---

# BACKLOG — do AFTER all 6/7 slices are complete

## Recipe-authoring AI awareness (program scripts)
**Goal:** Make Vectant's own AI — and any external AI/CLI agents linked into the app (terminal-based: Claude Code, Codex, Gemini CLI, etc.) — *aware of the program-recipe system* so they generate valid, working recipes instead of guessing/“rubbish”.

**Trigger:** when a user asks the AI to create or edit a program script — i.e. a `vectant.programs.json` (preferred) or `devcontainer.json` — inject the relevant knowledge into context (system prompt / tool description / retrieved context), e.g. on detecting intent to author/modify those files or on opening them in the editor.

**Knowledge the AI must have (single source of truth, reused everywhere):**
- The `vectant.programs.json` manifest schema + fail-closed validation rules (from `src/lib/programs/manifest.js`): required `packageId`/`version`/`launch`; optional `displayName`/`description`/`runtimeType`/`workingDir`/`install`/`env`/`ports`/`surfaces`/`health`/`permissions`; supported `runtimeType` values (`web`/`background`/`gui`/`cli`); valid permission scopes; port range; path-escape / unknown-scope / unsupported-runtime rejections; **filename is `vectant.programs.json` (plural)**.
- The documented `devcontainer.json` subset Vectant imports (`src/lib/programs/devcontainer.js`) and what is rejected (host bind mounts, `docker.sock`, privileged, etc.).
- The **default/official `@vectant/*` starter programs** (the seeded catalog from the current task): what each is, its launch command + ports, and how to install/run it (install-from-catalog → consent → launch). So the AI can recommend an existing starter instead of authoring a worse one.
- The install/launch/publish flow + consent model (so generated recipes declare the right `permissions`).

**Surfaces to wire (design later):**
1. Vectant AI gateway/system-prompt: a recipe-authoring context block injected on the trigger above (reuse the AI backend prompt-caching path).
2. External CLI agents in the terminal: a discoverable, machine-readable context file in the workspace (e.g. `AGENTS.md` / a `.vectant/` doc, or an MCP resource the CLI can read) describing the same schema + default catalog, so terminal-linked agents don't need our gateway.

**Note:** keep ONE canonical schema/catalog description and render it into both surfaces (don’t fork the docs). Depends on the seeded `@vectant/*` catalog (current task) being final.

## Production cost controls for the program runtime (its own track)
**Why:** programs execute inside the per-workspace worker pod (`workspacePodSpawner.js` k8s in prod / `localWorkerSpawner.js` docker in dev). The defaults/catalog cost ~nothing; running programs cost in-pod CPU/RAM/disk. Idle-cull (`DEFAULT_IDLE_TTL_MS` 10 min) + output caps + kill-switch already bound abandoned sessions. The remaining prod levers are infra/config:
- Per-workspace **concurrent-session cap** (limit how many heavy programs one workspace runs at once).
- Per-workspace pod **CPU/mem limits** + **scale-to-zero / idle pod shutdown** when the workspace is inactive (the dominant cost — pods, not programs).
- Per-workspace volume **disk quota** + node_modules cleanup (install/scaffold growth).
- Optional **npm/pip registry cache** to cut egress.
- Cost **visibility** (pairs with Slice-7 observability + Slice-3 `ProgramRuntimeEvent`).
**Definition of ready:** own spec (quota/limit model + k8s resource policy). Not part of the "make default programs runnable" FE effort.

## Native Docker / container runtime (its own slice)
**Goal:** Let programs actually run as containers (e.g. `docker compose up`, devcontainer build/run), not just as managed commands in the workspace session.
**Why deferred:** the sandbox deliberately blocks real Docker today — devcontainer import rejects `docker.sock`/`--privileged`/host mounts/`--device`/`--cap-add` (`host_escape`), and the runtime manager scrubs `DOCKER_HOST`/`DOCKER_SOCKET` + blocks `/var/run/docker.sock`. There is no `container`/`docker` runtime type.
**Scope (later):** add a `container`/`docker` runtime type; provide a real container runtime to the managed session (mount `docker.sock` carefully, or a rootless/DinD sidecar per workspace); a security review to safely relax the host-escape block for *this* path only; execute devcontainer `image`/`build` (currently informational `sourceHints` only); surface container logs/exec in the program tab. The current task's **Dev Container** default (`@vectant/devcontainer`) becomes natively runnable once this lands.

---

## Native Docker — Phase 1 (hybrid dev slice) — Review (2026-06-10)

**Status:** code complete + reviewed; backend core live-verified. UI-level criterion #3 and the
compose bind-mount fix remain (see "Open" below).

**Done & verified live (against real Docker + the synthi-runtime:local image):**
- #1 `docker run hello-world` works inside a container program (rootless per-workspace daemon). PASS
- #2 `docker compose` available inside the runtime. PASS
- #4 isolation: workspace B cannot see workspace A's containers. PASS
- Security: host `/var/run/docker.sock` is NOT reachable from inside a program. PASS
- Spike gate (Task 1): rootless dind runs under Docker Desktop/WSL2 (needs `--privileged` outer container);
  published ports reachable cross-container by DNS name (validates `/wsport`).
- synthi-runtime:local image built; bakes `ENV DOCKER_HOST=unix:///run/user/1000/docker.sock`
  (base image does not set it — discovered in the spike).

**Open (blocks the deployed compose UI flow, not the core):**
- **Bind-mount of workspace files (correctness):** `ensureRuntimeContainer` binds `${REPOS_DIR}/<slug>/<user>:/workspace`.
  That works when collab-server runs on the host, but in compose collab-server is a container and that path
  lives on the `collab-data` *named volume* — the host daemon would mount an empty `/workspace`. Fix: mount the
  named volume (e.g. `Binds: ['<project>_collab-data:/data']`) and point the program cwd at `/data/repos/<slug>/<user>`,
  or use a Docker volume subpath mount. Needs full-stack verification.
- **Criterion #3 (UI):** devcontainer building a real image + the App tab rendering via `/wsport/<slug>/<port>/`
  in the actual IDE — needs the full compose stack + browser.

**Phasing recap:** Phase 1b = uniform execution (all programs into the runtime container) + per-workspace
port-system rework. Phase 2 = prod (k8s pod + Sysbox; replaces `Privileged: true`).

### Follow-up (after all slices) — unify port forwarding for terminal-launched servers
**Concern (user-raised):** when a user types e.g. `npm run dev` in a *terminal* (not a container
program), the dev server's port must be reachable through the workspace's forwarded-port proxy, the
same way container-program ports render as `/wsport/<slug>/<port>/` — not a bare, unreachable localhost.

**Today (hybrid Phase 1):** this already works, but via a *different* path: interactive terminals run as
PTYs in the shared collab-server, so `localhost:<port>` is detected by the global port scanner and served
at `/port/<N>/`. Container programs use `/wsport/<slug>/<port>/`. Two paths = inconsistent.

**Why it needs fixing (Phase 1b — uniform execution):** once terminals/all programs move INTO the
per-workspace runtime container, a terminal's `npm run dev` binds *inside* that container; the global
localhost scanner can no longer see it, so it must be detected + forwarded through the per-workspace
`/wsport` routing (port detection inside the runtime container + slug-scoped proxy + UI surfacing). Fold
this into the Phase 1b port-system rework so terminal-launched servers and container-program ports share
one consistent forwarded-port path.

### Follow-up (Phase 1b / web previews) — apply COEP/CORP to the global /port/ proxy
The container `/wsport` proxy now sets `Cross-Origin-Embedder-Policy: credentialless` +
`Cross-Origin-Resource-Policy: cross-origin` so its App-tab iframe renders under the IDE's
COEP:credentialless document (verified live). The EXISTING global `/port/<N>/` proxy
(`proxyService.proxyHttpRequest`) has the SAME latent gap — web-program/dev-server previews
embedded in the App tab will hit Chrome's blocked-frame error for the same reason. Mirror the
two response headers in proxyService when wiring up web-program previews (was never noticed
because web programs need a real package.json, which test workspaces lacked).

---

# Task: Phase 2 Sysbox Runtime — Slice 0 (cluster substrate) (2026-06-12, feat/docker-sysbox-engine)

Spec: `docs/superpowers/specs/2026-06-12-sysbox-runtime-design.md` §4. Plan: `docs/superpowers/plans/2026-06-12-sysbox-runtime-phase2-plan.md` (Slice 0).
**Decision (user):** stand up Sysbox on a **dedicated scratch cluster** (NOT the prod `synthi-beta-cluster`) — spec "scratch-first" rule + REGULAR-channel auto-upgrade can't be disabled on prod.

## Grounded facts (verified this session — do not re-derive)
- gcloud authed `aleksandar.georgiev@vectant.dev`, project `vectant-proj`; kubectl context `gke_vectant-proj_europe-west10-a_synthi-beta-cluster`.
- Prod cluster: Standard, zonal `europe-west10-a`, k8s **1.35.3**, channel **REGULAR**; pools `default-pool`(e2-standard-4 COS), `workspace-pool`(n2-standard-16 COS); RuntimeClasses present = gvisor, confidential-linked-runner (**no sysbox-runc**).
- Sysbox **v0.7.0** (latest, 2026-06-02). Install = single manifest `sysbox-k8s-manifests/sysbox-install.yaml` @ tag `v0.7.0`. Namespace **kube-system**. One image **`registry.nestybox.com/nestybox/sysbox-deploy-k8s:v0.7.0-0`** (CRI-O handled on-node by the script, no separate image). Bundles **RuntimeClass `sysbox-runc`**. Supports k8s 1.32–1.35; needs **Ubuntu nodes, kernel 5.4+**.
- DaemonSet nodeSelector `sysbox-install: "yes"`; tolerates only `sysbox-runtime=not-running:NoSchedule` → **must add a `workload=sysbox:NoSchedule` toleration to the vendored DaemonSet** or it won't install on our tainted pool.
- `reject-mutable-images` (cloudbuild.yaml:58) greps `Dockerfile`+`*.yaml`/`*.yml` for `:latest` NOT followed by `@sha256` → a `:tag@sha256:` AR ref passes. `vulnerability-scan` (cloudbuild.yaml:190, default OFF) scans a hardcoded 7-image list, fails on any CRITICAL — sysbox image not in it yet.
- Main `k8s/kustomization.yaml` forces `namespace: synthi` + commonLabels → **Sysbox install must be a standalone `k8s/sysbox/` kustomization**, applied directly, NOT wired into it.

## Phase A — Author + pin (files only; reversible; no infra mutation) — DONE
- [x] A1 Vendored `k8s/sysbox/sysbox-install.yaml` from the **`v0.7.0` tag**; added `workload=sysbox:NoSchedule` toleration to the DaemonSet; image → AR ref (tag now; B3 appends `@sha256`). Verified via `kubectl kustomize` render (both tolerations + RuntimeClass present, namespace kube-system preserved, no `:latest`).
- [x] A2 `k8s/sysbox/kustomization.yaml` — standalone (no namespace override), references only `sysbox-install.yaml`. NOT wired into top-level kustomization (would force `synthi` ns + break install).
- [x] A3 `k8s/sysbox/create-scratch-cluster.ps1` (**.ps1**, not .sh — matches `ops/gke/*.ps1` + user shell). Parameterized, idempotent (list-filter existence guards), echo-before-run. Flags confirmed via `gcloud ... --help`.
- [x] A4 `k8s/sysbox/smoke-pod.yaml` — `runtimeClassName: sysbox-runc`, `privileged: false`, `workload` toleration (RuntimeClass injects the nodeSelector), dind image `docker:27-dind`.
- [x] A5 `k8s/sysbox/README.md` — runbook (B1–C2), re-host commands, Spike-5 rehearsal, codified warm-floor/maintenance/PDB policy, teardown.
- Cleanup: deleted the loose `sysbox-install.upstream.yaml` (footgun: stray `apply -f dir` would clobber the patched copy); provenance kept via the pinned Source URL in the vendored header.

## Phase B — Create infra
- [x] B1 Created scratch cluster `synthi-sysbox-scratch` — Standard, zonal `europe-west10-a`, channel None, pinned `1.35.3-gke.2190000`, default VPC, 1× e2-medium, no auto-upgrade/repair. RUNNING; kubeconfig context set. (Ran the bare `gcloud ... create` directly — the script's existence-skip wrapper had skipped it under `-File`+`Stop`; script since fixed to `Continue`.)
- [x] B2 Created `sysbox-pool` — `ubuntu_containerd`, e2-standard-4, 1 node, no auto-upgrade/repair, label `sysbox-install=yes`, taint `workload=sysbox:NoSchedule`. Verified via `kubectl get nodes`: node Ready, label + taint present; default-pool clean.
- [x] B3 Re-hosted via **crane** (daemon-free; Docker Desktop was down). `crane copy sysbox-deploy-k8s:v0.7.0-0 → AR`; auth via `gcloud auth print-access-token`. AR index digest `sha256:c7859de4753a0baaf9d51f577e2290393254fea83206c1f9cc56c57684a294fb`, pinned into `sysbox-install.yaml` (tag+digest, passes reject-mutable).
- [x] B4 `kubectl apply -k k8s/sysbox/` → all 6 resources created. DaemonSet installed Sysbox v0.7.0-0 (~1.5 min). **Grounding finds:** node kernel **6.8 → idmapped mounts, shiftfs skipped** (so Secure-Boot was moot here); **containerd 2.1.5 + sysbox-runc, no CRI-O swap**. RuntimeClass `sysbox-runc` present; node flipped `sysbox-runtime=running`; transient `not-running` taint cleared (only `workload` remains). Log: "Sysbox installation completed (version v0.7.0-0). Done."

## Phase C — Acceptance + Spike 5 + gate (evidence required)
- [⛔] C1 **BLOCKED — upstream Sysbox bug.** Smoke pod (`runtimeClassName: sysbox-runc`, no privileged) never starts: pod **sandbox** fails with `mounting "sysfs" ... mount through procfd: operation not permitted`. This is open bug **nestybox/sysbox#1006** — Sysbox **v0.7.0** + containerd 2.x CRI; reproduced exactly on our node (k8s 1.35.3, containerd 2.1.5). Version bind: v0.7.0 is the ONLY release supporting k8s 1.33–1.35 (needs containerd ≥2.0.5) and it's buggy; prior-stable v0.6.7 supports only k8s ≤1.32 (min available GKE node here = 1.33.11). **No stock Sysbox version works on currently-available GKE.** STOPPED to re-plan with user. See memory `sysbox-070-cri-blocker`.
- [ ] C2 **Spike 5** — recreate/upgrade a sysbox node; confirm DaemonSet re-installs + a sysbox-runc pod recovers; measure the window; codify PDB + warm-floor + maintenance-exclusion policy in the README.
- [ ] C3 **Gate** — `gcloud artifacts docker images scan` the re-hosted image; record CRITICAL count; if any, surface honestly (third-party installer image — decide accept/patch policy; doesn't block scratch validation but blocks prod wiring).
- [ ] C4 Hardcoded-values audit (prod-bound) + 1–2 sentence plain-words recap.

## Open question to resolve before B
- Scratch cluster networking: default new VPC vs. reuse prod VPC (default new is simpler/isolated for a throwaway; will confirm at B1). [RESOLVED: used default VPC.]

---

## Slice 0 — PARKED (2026-06-12)
Substrate blocked by Sysbox **#1006** (see C1 + memory `sysbox-070-cri-blocker`). Scripts in `k8s/sysbox/` + the AR image are kept (one command to rebuild when #1006 is fixed). ⚠️ **Scratch cluster teardown FAILED on expired gcloud auth (DELETE_EXIT:1, masked by a trailing `echo`) — cluster still running/billing; awaiting user re-auth to delete `synthi-sysbox-scratch`.**

---

# Task: Slice 2 — spawnRuntimePod() (TDD, flag-gated dark) (2026-06-12, feat/docker-sysbox-engine)

Spec §3/§5; plan Slice 2. Per-workspace Sysbox runtime pod lifecycle, mirroring `workspacePodSpawner.ensurePod()`. Flag-gated `RUNTIME_BACKEND=sysbox-pod` (default off → zero behavior change). **Unit-tested now; integration/security tests deferred until the substrate works (#1006).** Local-dev `ENABLE_CONTAINER_RUNTIME` path untouched.
Test gate (lessons — scope it): `node --test --test-timeout=20000 backend/collab-server/__tests__/*.test.js`.

## TDD checklist (red→green per item) — pure builder + gate DONE (61/61 green)
- [x] T1 `buildRuntimeDeployment()` pure spec builder (`runtimePodSpec.js`): `runtimeClassName: sysbox-runc`, never privileged. (test 1)
- [x] T2 PVC `collab-data-pvc` mounted at `/workspace` with `subPath: repos/<slug>/<fsUser>` (tenant confinement). (test 2)
- [x] T3 `hostUsers: false`; labels `app: runtime` + `synthi/runtime-id`; matching selector. (test 3)
- [x] T4 sysbox-pool nodeSelector + toleration `workload=sysbox:NoSchedule` (env-driven `RUNTIME_NODE_*`, separate from worker's). (test 4)
- [x] T5 runtime container: image (`RUNTIME_POD_IMAGE`) + env `DOCKER_HOST` (in-pod unix socket) + slug/scope/fs-user. (test 5)
- [x] T6→ flag predicate `isSysboxRuntimeEnabled()` (`RUNTIME_BACKEND=sysbox-pod`, default off, read at call time). (test 6)
- [x] **Slice 2 — DONE (scope: function + wire call-site; 2026-06-14 on `b741c7eb`). Suite 71: 69 pass + 2 skip.**
  Pure spec fixes (`runtimePodSpec.js`) — RED→GREEN, all safe vs T1–T6 (none assert these):
  - [x] S2-T8 runtime Deployment `metadata.name` DISTINCT from the worker's `runtimeResourceId(sessionId)` (worker+runtime coexist per session → no 409). Name `rt-<hash>-rt` via `runtimeDeploymentName()`; `synthi/runtime-id` label stays `runtimeResourceId`.
  - [x] S2-T9 runtime pods labeled `app.kubernetes.io/managed-by=runtime-spawner` (NOT `workspace-spawner`) so the worker culler/count never match/delete them. Value is the exported single-source `RUNTIME_MANAGED_BY`.
  - [x] S2-T10 runtime container has a dockerd-readiness `readinessProbe` (exec `sh -c 'docker info'`, failureThreshold 12 for cold start); still never privileged.
  spawnRuntimePod + separate runtime lifecycle (`workspacePodSpawner.js`):
  - [x] S2-T11 `spawnRuntimePod()` no-ops (no k8s) when `!isSysboxRuntimeEnabled()` → `{skipped, reason:'runtime_backend_disabled'}`.
  - [x] S2-T12 `spawnRuntimePod()` local-bypass when `SPAWNER_MODE=local` → `{skipped, reason:'local_mode'}` (leaves `workspaceRuntimeContainer.js` path untouched).
  - [x] S2-T13 pure `runtimeCullDecision(deployments, now, timeoutMs)` selects idle runtime deployments (excludes fresh).
  - [x] S2-T14 pure `runtimeAtCapacity(count, max)` guard.
  - [x] S2-T15 `workspacePodSpawner` exports `spawnRuntimePod` (so the `/api/spawner/ensure` call-site resolves in k8s mode).
  - [x] FS pin: runtime pins under its OWN scope (`runtimeDeploymentName(sessionId)`); refcounted `repoCache` → repo stays pinned until BOTH worker+runtime release. `runtimeTeardown`/cull releases the runtime scope only (never the worker's).
  k8s integration (written now, tests SKIPPED — reason: #1006 substrate):
  - [x] S2-T16 (skip) create + dockerd-ready watch (`app=runtime` scoped) — written; `waitForRuntimePodReady` + `getReadyRuntimePodForSession` live, validation deferred.
  - [x] S2-T17 (skip) cross-tenant subPath confinement (live) — skipped pending cluster.
  Wiring (DARK; every path a no-op when flag off — all runtime fns self-gate):
  - [x] `/api/spawner/ensure` → fire-and-forget `spawner.spawnRuntimePod?.(...)` after `ensurePod` (existence-guarded for non-k8s modes).
  - [x] extend `teardown()` (covers release + session-ended + culler), `touch()` (bump runtime `lastActive`), `startCuller()`/`stopCuller()` (runtime culler) inside `workspacePodSpawner.js`.
  - [x] Necessary worker fix: `waitForPodRunning`/`getReadyPodForSession`/`getPodSnapshotForSession` now scope to `app=workspace` (runtime pods share `synthi/runtime-id`, so unscoped selectors would have matched them).
  - [x] Gate: full collab-server suite green — **71 (69 pass + 2 skip)**, syntax-checked (`node --check`). Frontend/Prisma untouched.
  - [ ] DEFERRED follow-ups: runtime container resources block (env-driven) for the sysbox-pool; on-demand spawn trigger (only when a container runtime is actually requested) — currently spawns alongside every session when the flag is on. Both fine for DARK validation.
- [x] T7 Regression: full collab-server suite green — **61/61** (55 existing + 6 new). Local-dev path untouched.

## Reconciled with origin/main (2026-06-12, commit 5382e8d8)
Merged `origin/main` (the prod "cloud-deploy runtime stack", 39 commits ahead of our dev base) into the feature branch so `spawnRuntimePod()` builds on the CURRENT prod spawner. `workspacePodSpawner.js` is now **main's +285-line version** (gained `warm()`, `lifecycleSnapshot()`, `getPodSnapshotForSession()`, `workflowBridgeContainers()`, beta runtime caps — reuse these for Slices 2/5). main has NOT started Sysbox work, so ours stays purely additive. Conflicts resolved (4): spawner←main, schema.prisma kept-both (+`invitedByEmail`), route.js CRLF-inflated (merged/ours), package-lock←main. Verified: 61/61 green, prisma schema valid, `HEAD..origin/main`=0. **→ Re-read main's `workspacePodSpawner.js` before writing `spawnRuntimePod()` (it's a different, larger file now).**

## Reconciled with origin/main again (2026-06-14, merge `b741c7eb`)
`origin/main` had advanced **8** commits since the last merge (wildcard-subdomain previews `proxyService.js` +362, preview asset rewriting, re-enable beta IAP, **explicit runtime cleanup**, idle-timeout/node-pool-cap/runtime-cap tuning). `merge-tree` predicted a CLEAN merge (LF-normalized via `.gitattributes`); merged with the `ort` strategy, **0 conflicts**, `HEAD..origin/main`=0. Re-read `workspacePodSpawner.js` on the merged commit before coding (lessons #24). **Scratch cluster (priority 1) — RESOLVED 2026-06-14: user re-authed; `describe` EXIT=0 confirmed it still existed; deleted via `gcloud container clusters delete synthi-sysbox-scratch --zone europe-west10-a` (DELETE_EXIT=0); VERIFIED gone (`clusters list` shows only `synthi-beta-cluster`; filtered check empty). Billing stopped.**

## Slice 1 — Hardened runtime image (2026-06-14, PARTIAL: image done; vuln gate → CI)
`backend/runtime-image/Dockerfile` hardened for the Sysbox runtime: added **kind v0.32.0** (pinned binary, SHA-256 `50030de2…` verified at build via `sha256sum -c`), **kubectl 1.34.2** + **helm 3.19.0** (Alpine community, apk-signed); compose v5.1.4 + buildx v0.34.1 are already bundled in the `docker:dind-rootless` base (digest-pinned). No privileged hacks to drop — privilege is applied at run-time, the image is privilege-agnostic (Sysbox/no-priv in prod, `--privileged` on Docker Desktop in dev).
- [x] Hardened Dockerfile (kind/kubectl/helm; header notes Sysbox).
- [x] **Built locally** (`vectant-runtime:slice1`, sha256:6feb4c9d4ec6…) — clean.
- [x] **Toolchain smoke-tested** — kubectl 1.34.2 / helm 3.19.0 / kind 0.32.0 / docker 29.5.3 / compose 5.1.4 / buildx 0.34.1 all run.
- [x] ✅ **CRITICAL-vuln gate PASSES** (trivy v0.71.0 host-native; DB/temp on D: since C: was full; Docker Desktop had crashed under the trivy-container + low C: disk — lesson #19/#27). Two criticals found → resolved: **kind v0.25.0→v0.32.0** fixes CVE-2025-68121 (Go stdlib v1.22.9→patched); **CVE-2026-33186** (grpc v1.78.0 vendored in the base's containerd, no patched dind base yet) waived in `backend/runtime-image/.trivyignore` (local in-pod containerd socket, not network-exposed; revisit on base bump). alpine + all node deps = 0; exit 0.
- [ ] **CI/deploy TODO (no local Docker needed):** add Kaniko build of the runtime image + a **trivy CRITICAL gate** to `cloudbuild.yaml`; digest-pin the AR image; wire `RUNTIME_POD_IMAGE` in `k8s/configmap.yaml` (currently defaults to `vectant-runtime:local`).
- [ ] Live acceptance (`docker run hello-world`, `kind create cluster`, `kubectl`) — #1006-blocked.

## Slice 3 — Terminal routing into the runtime pod (2026-06-14, DARK, unit-tested)
When `RUNTIME_BACKEND=sysbox-pod` (+ `SYNTHI_TERMINAL_BACKEND=k8s-exec` + `spawner.mode=k8s`), terminals exec into the **runtime pod's `runtime` container** (the workspace's own dockerd → `docker`/`kind` work in the shell) at `/workspace`; otherwise the existing worker-pod exec (`worker` container) and the local 3-way fallback are preserved. Wired through the existing `terminalService.createRuntimeProcess` → `createRuntimePodPty` path (no new call-site).
- [x] S3-T1 pure `runtimeTerminalTarget(sysboxEnabled)` selector (runtime vs worker container) — unit-tested both branches.
- [x] `createRuntimePodPty` routes via the selector: `spawner.spawnRuntimePod` + `runtime` container + `/workspace` cwd when on; `ensurePod` + `worker` otherwise.
- [x] S3-T2 (skip) integration: terminal execs into the runtime pod, docker works — #1006-blocked.
- [x] Gate: full suite **73 (70 pass + 3 skip)**, `node --check` clean. Local 3-way terminal path untouched.

## Slice 4 — Port routing (2026-06-14, PARTIAL: reachability done; detection+config deferred)
main's `proxyService.js` (+362) already routes runtime-scoped previews (`/runtime/<scope>/port/<port>`, `PREVIEW_TARGET_TEMPLATE`, wildcard URLs) → the proxy needs **no code change**, only (a) the runtime pod exposing a preview sidecar+Service, (b) the deploy pointing `PREVIEW_TARGET_TEMPLATE` at the runtime Service.
- [x] S4-T1 pure `buildRuntimeService(sessionId)` — headless Service, `app=runtime` selector, preview-proxy port, name distinct from the worker Service (`runtimeDeploymentName` = `rt-<hash>-rt`). Unit-tested.
- [x] **Reachability:** `spawnRuntimePod` pushes the preview-proxy sidecar (reuses the worker's `previewSidecarScript`) + `ensureRuntimeService` (fast-path + create); `runtimeTeardown` deletes the Service. (integration validated on a cluster — #1006.)
- [x] **Detection (2026-06-15):** `runtimeRunOnce(runtimeScope, argv)` (k8s-exec one-shot into the `runtime` container) in `runtimePodTerminal.js`; `runtimeSessionsFromDeployments` (pure) + `listActiveRuntimeSessions` (k8s list) in the spawner; a 2nd `createContainerPortMonitor` in `server.js` (sysbox-gated) keyed `(slug, runtimeScope)` → `broadcastRuntimePorts` emits `{type:'runtime-ports', slug, runtimeScope, ports}`. Reuses the tested `parseListeningPorts`/baseline; `createContainerPortMonitor` now `await`s `listContainers` (sync local OR async k8s). Tests S4-T3 (mapper) + S4-T4 (exports); S4-T5 live k8s-exec deferred (#1006). FRONTEND follow-up: Ports panel consume `runtime-ports` → render `/runtime/<scope>/port/<N>` (pairs with programs UX).
- [x] **Config (2026-06-15):** `SYNTHI_PREVIEW_TARGET_TEMPLATE` added to `k8s/configmap.yaml` → `http://{runtimeId}-rt.synthi.svc.cluster.local:{sidecarPort}{sidecarPrefix}/{port}` (placeholders verified against proxyService: `{runtimeId}`/`{sidecarPort}`/`{sidecarPrefix}`/`{port}`; Service = `rt-<hash>-rt`). Inert unless a preview carries a runtimeScope (sysbox on).
- [x] S4-T2 (skip) integration: opened ports detected + reachable — #1006.
- [x] Gate: full suite **74 (71 pass + 3 skip)**, `node --check` clean.

## Slice 5 — Lifecycle & hibernate (2026-06-15, core pre-existing; cache-persist added)
Core hibernate ALREADY works: worker culler (`cullIdleWorkspaces`) + runtime culler (`cullIdleRuntimePods`/`runtimeCullDecision`) scale idle pods to 0; `collab-data-pvc` persists `/workspace` across cull → respawn; `/api/spawner/ensure` re-spawns on resume (fast-path or create). So "idle ≈ storage only; resume restores files" is satisfied.
- [x] **Docker image/build-cache survival (S5-T1):** opt-in `RUNTIME_PERSIST_DOCKER_DATA` (default OFF = ephemeral, current behavior) mounts a per-runtime PVC subPath `docker-data/<runtimeId>` at `/var/lib/docker` so `docker` images/cache survive idle-cull → respawn (resume = WARM docker). Same `collab-data-pvc` volume, distinct subPath (sibling to `repos/`, no git pollution). `isRuntimeDockerDataPersisted()` read at call time. Suite 79 (74 pass + 5 skip).
- [ ] DEFERRED: tiered idle timeout by plan (currently single `RUNTIME_IDLE_TIMEOUT_MS`); honest `starting`/`resuming` UI states (frontend + a runtime `lifecycleSnapshot`); permanent-delete cleanup of the `docker-data/<id>` subPath (idle-cull keeps it by design); **Spike 2** resume-latency SLO + docker-data-on-PVC overlay2 validation — live cluster / #1006.

## Slice 6 — Egress controls + abuse monitoring (2026-06-15, NetworkPolicy done; abuse deferred)
- [x] **Egress hardening** (`k8s/network-policies.yaml` → `runtime-egress-hardening`, podSelector app=runtime, Egress): allow DNS (kube-dns) + PUBLIC internet (registries, user-app API calls); DENY cluster-internal lateral movement (10/8 incl. pod/service CIDR), RFC1918, and the GKE metadata server (169.254.0.0/16 — node-credential theft). Additive egress rules so DNS works despite the 10/8 except. Inert until runtime pods exist; REQUIRES a NP-enforcing dataplane (Dataplane V2 / Calico).
- [x] **Ingress allow** (`allow-to-runtime-pods`): collab-server → runtime preview sidecar :18080 (`default-deny-ingress` is in effect; mirrors `allow-to-workspace-pods`).
- [x] Fixed a Slice-4 configmap bug found via `kubectl kustomize`: `SYNTHI_PREVIEW_TARGET_TEMPLATE` was DUPLICATED (existing worker `{runtimeId}` value + my runtime `{runtimeId}-rt` add) → invalid YAML. Removed the dup; documented that enabling sysbox switches the template to the `-rt` (runtime Service) variant. `kubectl kustomize k8s/` → exit 0.
- [ ] DEFERRED (Spike 3 / infra): per-pod bandwidth cap (`kubernetes.io/egress-bandwidth`), abuse detection (Cilium/Falco flow-logs), dedicated egress IPs, auto-hibernate on abuse + false-positive soak.

## Slice 7 — Image pull-through cache (2026-06-15, registry-mirror hook; cache-persist via Slice 5)
- [x] **Build cache on PVC** — DONE via Slice 5 (`/var/lib/docker` on the PVC subPath includes the build cache; survives idle-cull → respawn when `RUNTIME_PERSIST_DOCKER_DATA` on).
- [x] **Registry-mirror hook (S7-T1):** env-gated `RUNTIME_REGISTRY_MIRROR` → the runtime container gets dockerd `--registry-mirror=<url>` (dind forwards container args to dockerd). Off by default. Point at an AR remote repository to cut Docker Hub egress + rate limits.
- [ ] DEFERRED (infra): create the AR **remote repository** (`gcloud artifacts repositories create … --mode=remote-repository` w/ Docker Hub upstream) + set `RUNTIME_REGISTRY_MIRROR`. Live-validate a 2nd workspace hits the cache (pull-time + egress delta) — needs cluster. CAVEAT: confirm AR remote-repo behaves as a transparent dockerd `--registry-mirror` before enabling.

## Slice 8 — GPU on-demand (2026-06-15, spec hook; GATED on Spike 1)
- [x] **On-demand GPU hook (S8-T1):** per-spawn `metadata.gpu` → the runtime pod requests `nvidia.com/gpu: 1` + tolerates the `nvidia.com/gpu:NoSchedule` node taint (keeps the sysbox toleration), and routes to a GPU pool when `RUNTIME_GPU_NODE_SELECTOR_VALUE` is set. Off by default (never warm — requested per spawn); idle GPU pods are culled by the existing runtime culler (released on idle). `RUNTIME_GPU_RESOURCE` overridable.
- [ ] DEFERRED (GATED on Spike 1 / infra): **Spike 1** — does `docker run --gpus` nest under Sysbox on a GKE GPU node? If not, the pod-level GPU (above) is the fallback. Needs a GPU+Sysbox node pool + nvidia device plugin (infra), a billing/metering hook, and a hard time-box so a user can't hold a GPU 24/7. Live-validate a CUDA container + idle release.

---

# Task: Sysbox #1006 unblock spike (2026-06-14, feat/docker-sysbox-engine)

Goal: get a non-privileged `runtimeClassName: sysbox-runc` pod to run `docker run hello-world` on a fresh GKE scratch cluster — defeat #1006. User-approved (config-first; master-static only if needed). Scratch-first per guardrails.

## Upstream re-check + pre-flight (DONE — see memory `sysbox-070-cri-blocker`)
- #1006 OPEN (last activity 2026-05-26); NO sysbox release past v0.7.0 (2026-06-02).
- Fix for the procfd error = sysbox-runc **PR #106** (`features` cmd), MERGED to master 2025-08-29.
- **Pre-flight (cluster-free, definitive):** the v0.7.0 deploy image we already deploy (AR digest `c7859de4…` == public upstream) bundles `sysbox-runc` 0.7.0 (commit a4dd414) whose **`features` subcommand EXISTS + returns OCI JSON** → **PR #106 IS in the release binary; building master-static is NOT needed.**
- So our earlier failure was NOT a missing binary fix. **Prime suspect: `smoke-pod.yaml` never set `hostUsers: false`** → containerd invoked sysbox-runc outside a k8s userns → sysfs `mount through procfd` failure. Working recipe REQUIRES `hostUsers: false` (k8s>=1.33 + containerd>=2.0.5; we have 1.35.3 + 2.1.5).

## Plan (cheapest-first)
- [x] P0 Pre-flight (binary has `features`) + add `hostUsers: false` to `smoke-pod.yaml`. (Docker pull of public deploy image confirmed it.)
- [x] P1 Recreate scratch cluster + sysbox-pool (`create-scratch-cluster.ps1`) — cluster `synthi-sysbox-scratch` 1.35.3, `sysbox-pool` e2-standard-4 ubuntu_containerd. (Needed `gcloud auth login` first.)
- [x] P2 `kubectl apply -k k8s/sysbox/` → DaemonSet rolled out, RuntimeClass `sysbox-runc` present, node `sysbox-runtime=running`. Installer log: "Detected containerd version 2.1.5 … The k8s runtime on this node is containerd + Sysbox. Done."
- [x] P3 NOT NEEDED — the v0.7.0 installer configured containerd 2.1.5 correctly out of the box (no manual config-scheme patch required on GKE).
- [x] P4 **Smoke test WITH `hostUsers: false` PASSED.** Pod Ready (sandbox created, no procfd error); `docker run hello-world` → "Hello from Docker!"; `privileged=false`; `hostUsers=false`; uid_map `0 41549824 65536` (root-in-userns, NOT host root); no host docker.sock. **#1006 DEFEATED config-only → 9-slice substrate validated GO.**
- [x] P5 N/A — master-static build NOT needed (release binary already has PR#106).
- [x] P6 Smoke pod deleted; evidence captured; memory/index/lessons updated; **scratch cluster DELETED + verified GONE (billing stopped)**, prod untouched. AR install image kept (digest-pinned) for 1-command re-spin. (Teardown needed `--async` after a host-RAM `gcloud.ps1` OutOfMemoryException — see lessons.)

## RESULT — #1006 DEFEATED (2026-06-14)
Root cause of the 2-day park was a misdiagnosis: the Slice-0 smoke pod omitted `hostUsers: false`. The v0.7.0 release binary already carries sysbox-runc PR#106 (`features` cmd), and the GKE installer configures containerd 2.1.5 for sysbox correctly. One-line fix (`hostUsers: false`, already present in `runtimePodSpec.js`) → a non-privileged `sysbox-runc` pod runs docker on GKE. **The entire Phase-2 9-slice arc is unblocked.**

## Post-spike — runtime image in AR + configmap wired (2026-06-14)
- [x] Pushed `vectant-runtime:slice1` (the vuln-gate-validated kind-v0.32.0 image) → AR `europe-west10-docker.pkg.dev/vectant-proj/synthi/vectant-runtime`, digest `sha256:101bd456852a53efd52302a7fa1e2cd697279710f5d029db15872fe6d0d2018e` (verified via `gcloud artifacts ... describe`).
- [x] Wired `RUNTIME_POD_IMAGE` (digest-pinned, passes reject-mutable-images) in `k8s/configmap.yaml` — inert in prod (flag off). TODO Slice-1 CI: cloudbuild Kaniko build + trivy CRITICAL gate → switch to `:build-tag-required` like WORKER_IMAGE.
- [x] Step #2 — live runtime-pod validation (2026-06-15, scratch re-spun + deleted). Applied the REAL `buildRuntimeDeployment` output under sysbox:
  - **Slice 2 mechanics VALIDATED end-to-end:** pod scheduled on sysbox-pool, sandbox created (no #1006), `collab-data-pvc` dynamically provisioned + subPath `repos/smoke-repo/242593757` mounted & writable, image pulled from AR, non-privileged, deterministic `rt-…-rt` name/labels.
  - **Slice 1 image FINDING (action below):** the `vectant-runtime` image (`docker:dind-rootless`) CRASH-LOOPS under sysbox — `[rootlesskit:parent] error: failed to start the child: fork/exec /proc/self/exe: operation not permitted` (rootless tries to nest a userns inside sysbox's). Swapping the SAME Deployment to a ROOTFUL image (`docker:27-dind`) → pod READY, `docker run hello-world` OK, uid_map `0 3016228864 65536` (root-in-userns), `/workspace` subPath writable. So Slice 2's `DOCKER_HOST=/var/run/docker.sock` default is CORRECT; the fix is Slice 1's base image.

## Slice 1 image rework — rootless → rootful (Dockerfile DONE; build blocked on env)
- [x] `backend/runtime-image/Dockerfile` ARG-parameterized so ONE Dockerfile builds BOTH:
      - **rootless (default args)** = the local-dev hybrid image (`RUNTIME_IMAGE`, Docker Desktop `--privileged`, user `rootless`, socket `/run/user/1000`). Default build is functionally identical to before → **zero local regression** (only cosmetic: sudoers file renamed `rootless`→`runtime-user`).
      - **rootful (override args)** for Sysbox (`RUNTIME_POD_IMAGE`): `--build-arg RUNTIME_BASE=docker:dind@sha256:… RUNTIME_USER=root RUNTIME_HOME=/root DOCKER_SOCK=/var/run/docker.sock`.
      Chosen over editing `workspaceRuntimeContainer.js` (which is hard-coupled to `rootless`/`/home/rootless`/`/run/user/1000`) so the local path needs NO change — the two targets already use separate env vars (`RUNTIME_IMAGE` vs `RUNTIME_POD_IMAGE`).
- [x] `k8s/configmap.yaml`: WARNING comment that the pinned `RUNTIME_POD_IMAGE` is the rootless image (crashes under sysbox) → must be replaced by the rootful build before flipping `RUNTIME_BACKEND=sysbox-pod`.
- [x] **CI wired (env-independent build path):** added `build-runtime-image` Kaniko step to `cloudbuild.yaml` (rootful `--build-arg`s: `RUNTIME_BASE=docker:dind@sha256:ad68e89b…`, `RUNTIME_USER=root`, `RUNTIME_HOME=/root`, `DOCKER_SOCK=/var/run/docker.sock`), gated on `reject-mutable-images` + added to the deploy `waitFor`. Switched `RUNTIME_POD_IMAGE` → `vectant-runtime:build-tag-required` (CI sed-substitutes the tag at deploy, like `WORKER_IMAGE`). cloudbuild triggers ONLY on push to `main`, so this is dark until a gated merge — NOT yet executed/tested.
- [x] **Rootful image built + validated locally (2026-06-15):** `docker build` with the rootful args → clean build; smoke test = `uid=0(root)`, `HOME=/root`, `DOCKER_HOST=unix:///var/run/docker.sock`, full toolchain (docker 29.5.3 / kind v0.32.0 / kubectl v1.36.1 / helm v3.19.0 / node / python / git / claude / lazygit). Confirms the ARG refactor + Slice 2's DOCKER_HOST default. (Optional: a scratch re-spin to run THIS exact image under sysbox — rootful-dind-under-sysbox already proven with docker:27-dind, so high-confidence; skipped to save cluster cost.)
- [x] **Zero local-dev regression confirmed:** default build (no args) → `uid=1000(rootless)`, `HOME=/home/rootless`, `DOCKER_HOST=unix:///run/user/1000/docker.sock`, full toolchain. `vectant-runtime:local` restored (was wiped by the Docker data-disk reset).
- [ ] Add a **trivy CRITICAL-vuln gate** to CI — NO trivy step exists in cloudbuild.yaml today (the Slice-0 note was stale); the CRITICAL gate is manual-only. The rootful image is NOT yet scanned (only the prior rootless one was, 2 days ago) but shares the same base family (docker:dind 29.5.3) + toolchain + `.trivyignore` waiver, so it should pass the same. Gate `build-runtime-image` (ideally all images) before enabling the backend in prod.
- NOTE: CI `build-runtime-image` builds the canonical rootful image on main-merge; the local build above just validated the Dockerfile (not pushed — CI owns the prod image via `build-tag-required`).

---

# Task: Sysbox deferred bits + live validation (2026-06-15, feat/docker-sysbox-engine) — IN PROGRESS

User asked to finish ALL deferred bits across the 9 slices + full live validation incl. GPU, THEN check in before pivoting to the **programs UX** phase. Plan approved (Everything incl. GPU).

## Phase A — code-doable deferred bits: DONE (dark, TDD, committed). Suites: backend 84 (79+5 skip), frontend 355.
- [x] A1 trivy CRITICAL gate in cloudbuild.yaml (`vulnerability-scan-runtime`, gates deploy). Commit `1013f2c5`.
- [x] A2 per-pod egress bandwidth cap — `RUNTIME_EGRESS_BANDWIDTH` → `kubernetes.io/egress-bandwidth` annotation (runtimePodSpec.js). Commit `a0775cbe`.
- [x] A3 `purgeRuntimeData(sessionId)` + `runtimeDockerDataDir` (permanent-delete docker-data cleanup primitive; cross-service wiring to Next.js `DELETE /api/workspace` is a documented follow-up). Commit `ac717828`.
- [x] A4 `runtimeLifecycleSnapshot(sessionId)` folded into GET /api/session/:id/lifecycle as a dark `runtime` field. Commit `161ca93a`.
- [x] A5 frontend: collabClient `runtime-ports` → portsSlice `setRuntimePorts` → PortsPanel `/runtime/<scope>/port/<n>/`; `getProgramSessionAppUrl(runtimeScope)`. Commit `42409139`.
- [skip] Slice-5 "tiered idle timeout by plan" — no plan-tier concept exists; premature, deferred-pending-product.

## Phase B–D — live validation: PARTIAL (cluster TORN DOWN at session pause; billing stopped)
LIVE-VALIDATED this session:
- ✅ Slice 1 + A1: scoped Cloud Build built the ROOTFUL `vectant-runtime:scratch` AND the trivy CRITICAL gate passed (build SUCCESS) → image-in-CI + vuln-gate proven live.
- ✅ Substrate: scratch cluster `synthi-sysbox-scratch` (Dataplane V2) + sysbox-pool; `kubectl apply -k k8s/sysbox/` → `sysbox-runtime=running`.
- ✅ S2 + A2 + S5-mount: real `buildRuntimeDeployment` pod Ready on sysbox-pool — `runtimeClassName=sysbox-runc`, `hostUsers=false`, not privileged, `egress-bandwidth=50M`, `/workspace` subPath `repos/smoke-validate/242593757`, `/var/lib/docker` subPath `docker-data/rt-…`. PVC bound (standard RWO).

REMAINING (next session):
- [ ] S3 exec: `docker run hello-world`, `docker ps`, `kind version`, `kubectl version`, `helm version` inside the runtime container.
- [ ] S4 ports: start a server in-pod; read /proc/net/tcp (what runtimeRunOnce parses) + `kubectl port-forward` curl → reachable.
- [ ] S5 hibernate: scale deploy 0→1, `/workspace` persists; pull alpine, scale 0→1, `docker images` still has it (warm); measure resume latency (Spike 2).
- [ ] S6 egress: apply `k8s/network-policies.yaml`; exec wget — metadata 169.254.169.254 BLOCKED, public OK, cluster-internal BLOCKED.
- [ ] C Slice 7: `gcloud artifacts repositories create … --mode=remote-repository` (Docker Hub upstream) + `RUNTIME_REGISTRY_MIRROR`; cold/warm pull delta. (Verify AR-remote-repo behaves as a transparent `--registry-mirror`.)
- [ ] D Slice 8 GPU: T4 quota AVAILABLE (NVIDIA_T4_GPUS=1, no request needed). GPU+sysbox node pool + nvidia plugin; pod `metadata.gpu=true` → `nvidia-smi`; does `docker run --gpus` NEST under sysbox? else pod-level GPU fallback. Metering/time-box hook. Tear GPU pool down immediately.
- [ ] Phase E: hardcoded-values audit; final teardown verify; suites; docs; recap; THEN check in before programs phase.

## RESUME (fast — runtime image already in AR):
1. `gcloud container clusters create synthi-sysbox-scratch --project vectant-proj --zone europe-west10-a --release-channel None --enable-shielded-nodes --enable-dataplane-v2 --machine-type e2-medium --num-nodes 1 --no-enable-autoupgrade --no-enable-autorepair --cluster-version 1.35.3-gke.2190000` then node-pool `sysbox-pool` (UBUNTU_CONTAINERD e2-standard-4, label sysbox-install=yes, taint workload=sysbox:NoSchedule). (Or run create-scratch-cluster.ps1 — now has --enable-dataplane-v2.)
2. VERIFY `kubectl config current-context` == `…synthi-sysbox-scratch` (NEVER prod) before any apply.
3. `kubectl apply -k k8s/sysbox/`; wait node label `sysbox-runtime=running`.
4. `kubectl apply -f %TEMP%\scratch-ns-pvc.yaml`; `node %TEMP%\gen-runtime.js | kubectl apply -f -`.
5. Run S3–S6, then C, D, E.
- Temp helpers (regenerate if gone): `%TEMP%\cb-runtime-scratch.yaml` (scoped image build), `scratch-ns-pvc.yaml`, `gen-runtime.js`.
- AR images persist: `vectant-runtime:scratch`, `sysbox-deploy-k8s@sha256:c7859de4…` (both verified resolvable).
- Commits A1–A5 NOT yet pushed to origin (awaiting user OK to push).
