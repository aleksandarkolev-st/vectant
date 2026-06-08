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
