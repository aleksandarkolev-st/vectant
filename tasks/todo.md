> ⚠️⚠️ **RECURRING REMINDER — READ WHENEVER TOUCHING "PROGRAMS" / GUI DEV TOOLS** ⚠️⚠️
> The current programs work (KasmVNC GUI dev-tool streaming, real-programs **Slice 3**) ships
> **command/CLI** AI control ONLY. The **NEXT STEP is VISUAL GUI DRIVING** — the AI seeing +
> clicking/typing inside the streamed GUI. Any time programs are designed, extended, or discussed,
> raise this planned follow-up. Spec §10: `docs/superpowers/specs/2026-06-20-gui-dev-tool-streaming-design.md`.
>
> **NEXT SLICE — Visual GUI driving (MCP):**
> - **Observe:** capture frames from the KasmVNC stream (or the container's X display) → feed the vision
>   model (the MCP already uses Gemini vision for the worker preview; adapt the frame source to KasmVNC).
> - **Drive:** inject pointer/keyboard via the KasmVNC input protocol or XTest in the container's X
>   display; reuse the MCP input-lease/broker concepts.
> - **Loop:** vision → plan action → inject → re-observe (computer-use style); bounded + cancellable.
> - **MCP tools:** `gui_screenshot`, `gui_click`, `gui_type`, `gui_key` scoped to a program session.
> - **Security:** same Sysbox isolation; AI input is a controlled channel separate from the user's kiosk
>   stream; rate/scope limits; never re-enables a desktop/launcher.
> - **Sequencing:** ship after the command-level loop + the streaming surface (Slice 3) are solid.
>
> ---

## Slice 3 / Group E — MCP command control (status 2026-06-20)

Command/CLI AI control over the program domain, over the PAT-gated `/api/integrations/mcp/*` boundary
(SYNTHI_API_URL + SYNTHI_PAT [+ SYNTHI_WORKSPACE_SLUG]). All tools registered in `mcp/synthi-mcp/src/server.ts`.

- [x] **`synthi_exec_in_runtime`** — run a command **inside the workspace's Sysbox runtime pod** (its own
      dockerd lives there, so `docker ...` works). Backend `POST /api/integrations/mcp/runtime-exec` →
      collab-server `POST /program-runtime/:slug/exec` → `runtimeExecOnce` (k8s-exec into the `runtime`
      container). Routed by **workspaceSlug → runtimeScope** (never a user id). Owner/admin + `program.launch`
      consent. Returns `{runtimeScope,stdout,stderr,exitCode,timedOut}`.
      NOTE: the first cut wrongly used the managed-program `/exec-terminal` path → headless PTY (DOCKER_HOST
      scrubbed, userId-keyed cwd); fixed in `fix(mcp): exec_in_runtime runs in the Sysbox runtime pod`.
- [x] **`synthi_list_programs`** — member-read inventory: merged sessions + installed catalog (`GET .../programs`).
- [x] **`synthi_read_session`** — member-read single session + redacted events (`GET .../programs/[sessionId]`).
- [x] **`synthi_launch_program`** — launch an installed **container** program by installId (`POST .../programs/launch`).
      Container programs route by **workspaceSlug → runtimeScope** into the Sysbox pod (slug-routed, never a
      user id) — so a PAT launches them safely; the earlier `workspaceUserId` blocker only affects the
      headless/hybrid (userId-routed) paths, so **non-container programs are refused** (`unsupported_program_type`)
      and must be launched from the workspace UI. Owner/admin + `program.launch` consent.
      RESIDUAL: faithful per-user-filesystem launch for non-container (cli/web) programs still needs the
      PAT→workspaceUserId resolution (persist the OAuth provider id) — deferred.

### Group A — GUI images (done, built+validated locally)
- [x] `@vectant/gui-base` (`backend/gui-images/gui-base`) — debian-slim + KasmVNC 1.4.0 + matchbox (no
      menu/panel); no DE/terminal/file-manager/browser; per-session credential; plain HTTP+WS. 409MB.
- [x] `@vectant/dbeaver` (`backend/gui-images/dbeaver`) — gui-base + DBeaver CE (bundled JRE 21). 668MB.
      Verified: KasmVNC serves (401→200), DBeaver GUI launches under matchbox fullscreen, no escape binaries.

### Group F — recipe (done)
- [x] `@vectant/dbeaver` in `defaultPrograms.js` (runtimeType container, webGui, port 6901, env-driven image).

### Group G — verification + wrap
- [x] Local: images build+run+kiosk-validated; backend/synthi/mcp suites green; node --check clean.
- [x] **G1 live GKE gate — PASSED (2026-06-21), cluster torn down.** Scratch Sysbox cluster
      (`synthi-sysbox-scratch`, 1.35.3) + sysbox-pool; Sysbox v0.7.0 installed (`sysbox-runtime=running`);
      ran `vectant-dbeaver` (from AR) in a `sysbox-runc` pod's dockerd. Validated: **non-privileged**
      (`privileged=false`) + **root-in-userns** (`uid_map 0→2348417024`) + own docker.sock; **KasmVNC streams**
      (no-auth 401 → per-session-cred 200 on `/vnc.html`); **DBeaver GUI process alive**; **kiosk-clean**
      (no terminal/browser/file-manager/desktop binaries); **exec into the runtime works** (exec_in_runtime
      capability). Teardown: cluster deleted (async), gate AR images deleted, prod untouched.
      - FOLLOW-UP (pre-existing): the committed `sysbox-install.yaml` digest `c7859de…` was deleted from AR by
        the LG4/G1 teardown; a `docker pull`+push re-host yields a *different* (single-arch) digest. To restore
        the exact committed (multi-arch index) digest for the next run/prod, re-host with **`crane copy`**
        (daemon-free, preserves the index digest) per lesson #27 — don't `docker push` (re-pins to a new digest).

### Hardcoded-values audit (Slice 3, A+F)
- DBeaver .deb pinned to **`latest`** (`dbeaver-ce_latest_amd64.deb`) — NOT reproducible. **Pin a version for
  prod** (DBEAVER_URL is an ARG, so override at build). Acceptable for dev.
- `debian:bookworm-slim` base + KasmVNC `1.4.0` (KASMVNC_VERSION ARG) — KasmVNC pinned ✓; base image not
  digest-pinned (minor; digest-pin + trivy-gate for prod, like backend/runtime-image).
- Recipe image/port are env-driven (VECTANT_DBEAVER_IMAGE / VECTANT_DBEAVER_PORT) ✓; KASM_PASSWORD generated ✓;
  KASM_PORT/GEOMETRY/user all env-overridable ✓. No improper hardcoding in the runtime path.

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

## Phase B–C — live validation: DONE ✅ (commits A1–A5 + S6 fix PUSHED to origin)
- ✅ Slice 1 + A1: scoped Cloud Build built ROOTFUL `vectant-runtime:scratch` AND the trivy CRITICAL gate passed (SUCCESS) → image-in-CI + vuln-gate live.
- ✅ Substrate: scratch cluster (Dataplane V2) + sysbox-pool → `sysbox-runtime=running`.
- ✅ S2 + A2 + S5-mount: real `buildRuntimeDeployment` pod Ready — `sysbox-runc`, `hostUsers=false`, non-privileged, `egress-bandwidth=50M`, `/workspace` + `/var/lib/docker` subPaths. PVC bound.
- ✅ S3 terminal exec: `docker run hello-world` OK; `uid_map 0 3047817216 65536` (root-in-userns); docker/kind/kubectl/helm all run in-pod.
- ✅ S4 ports: REAL `parseListeningPorts` on the pod's REAL `/proc/net/tcp` → `[2376,8000]`; :8000 reachable via port-forward (**HTTP 200**).
- ✅ S5 hibernate: scale 0→1 — `/workspace` marker + `alpine:3.20` image BOTH survived; **resume latency 20s** (Spike 2 SLO); overlay2-on-PVC works.
- ✅ S6 egress (Dataplane V2): metadata 169.254 BLOCKED, kube-api ClusterIP BLOCKED, other-pod IP BLOCKED, public (IP+DNS) ALLOWED. **FOUND+FIXED a real bug**: the kube-dns `podSelector` DNS rule blocked DNS entirely (GKE NodeLocal DNSCache is hostNetwork → node identity) → changed to allow UDP/TCP :53 to all. Committed + re-validated.
- ✅ Slice 7 (Phase C): AR remote repo `docker-hub-cache` created; runtime pod pulled `library/busybox:1.36` THROUGH it. CAVEAT resolved: `--registry-mirror` needs DAEMON-level AR creds (cred-helper in the runtime image) — prod follow-up.
- ✅ Slice 8 hook (spec, live-confirmed): `metadata.gpu=true` → `nvidia.com/gpu:1` + GPU toleration + GPU-pool nodeSelector.
- europe-west10 scratch cluster TORN DOWN after C (billing stopped).

## Phase D — Slice 8 live GPU Spike 1: DEFERRED (GPU capacity unavailable, user-approved)
- ✅ S8 hook spec-validated live: `metadata.gpu=true` → `nvidia.com/gpu:1` + GPU toleration + GPU-pool nodeSelector.
- ⛔ Live CUDA spike blocked by GPU AVAILABILITY, not the sysbox design:
  - europe-west10 has NO GPU hardware in any zone (regional quota is phantom — only RTX-PRO-6000 in one zone).
  - europe-west1-b T4 → **GCE_STOCKOUT** ("zone does not have enough resources", no VM after 35 min). Cluster torn down.
- Slice-8 forward list (do when capacity exists):
  1. Pick a zone that actually HAS the GPU (`gcloud compute accelerator-types list --filter=name=<type>`, not just quota) + deep capacity (us-central1).
  2. **Nested `docker run --gpus` needs nvidia-container-toolkit baked into the runtime image** (not present today) — likely THE real blocker, capacity aside.
  3. Verify pod-level GPU injection under `runtimeClassName=sysbox-runc` (sysbox replaces the nvidia container runtime → device-plugin mounts must still apply).
  4. Prod GPU pool needs autoscaling `min=0` for the scale-to-zero cost model.

## Phase E — wrap: DONE ✅
- ✅ Hardcoded-values audit: all new values are env-driven (`RUNTIME_EGRESS_BANDWIDTH`, `RUNTIME_GPU_*`, …) or universal standards (RFC1918/link-local CIDRs, k8s annotation keys, digest-pinned trivy image, port 53, `/var/lib/docker`). Service CIDR deliberately NOT hardcoded (Dataplane V2 polices by backend identity). No env-specific values/secrets in committed code.
- ✅ Teardown: both scratch clusters deleted (europe-west10 + europe-west1); `docker-hub-cache` AR repo deleted; `clusters list` → prod only (billing stopped). AR `vectant-runtime:scratch` + `sysbox-deploy-k8s` kept for fast re-spin.
- ✅ Suites: backend `node --test` 79 pass + 5 skip / 0 fail; frontend ports vitest 13 pass.
- ✅ Docs: lessons #33–35 (phantom GPU quota/stockout; NodeLocal-DNSCache egress break+fix; Dataplane-V2 backend-identity egress).
- NEXT: pivot to the **programs UX** phase (real program UIs — Docker etc. — rendering inside the workspace).

---

# Real programs in the workspace — Slice 1 Implementation Plan (2026-06-16)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Route `container`-type programs (marketplace recipe + repo auto-detect) into the validated per-workspace Sysbox runtime pod, surfacing their published web UI in the program App tab via `/runtime/<scope>/port/N`.

**Architecture:** A pure launch-target decision picks sysbox-pod / hybrid / headless / unavailable. The sysbox path execs the composed command inside the runtime pod's `runtime` container (inheriting its pod-level `DOCKER_HOST`), streams output as session logs, stamps the session with its `runtimeScope`, and feeds pod-detected ports into a scoped port-attribution method so the App tab lights up. Repo-detect (compose/devcontainer/Dockerfile) maps to the same `container` config behind a server-truthful capability flag. Spec: `docs/superpowers/specs/2026-06-16-real-programs-in-workspace-design.md`.

**Tech stack:** collab-server (CommonJS, `node:test`), Next.js frontend (ESM, vitest), `@kubernetes/client-node` exec.

**Conventions:** TDD red→green per task; commit per task; every commit message ends with the trailer
`Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` (shown in Task 1, abbreviated as `(+ trailer)` after).
Backend tests run from repo root: `node --test --test-timeout=20000 backend/collab-server/__tests__/<file>` (lesson #21 — always scope).
Frontend: `cd synthi && npx vitest run <pattern>`. Branch: `feat/docker-sysbox-engine` (commit only; no push/PR without approval).

**Resolved at plan time:** no `yaml` dep in `synthi/` → compose uses a minimal text probe + best-effort `ports:` scrape (live port monitor is authoritative). `mergeProgramSession` does NOT carry `runtimeScope` today (Task 5 fixes it). The capability flag is reported BY the collab-server (it owns `RUNTIME_BACKEND`/`ENABLE_CONTAINER_RUNTIME`).

## Phase 1 — core Sysbox execution path (backend + frontend threading). Demoable via a `container` recipe after Task 6.

### Task 1: Pure launch-target decision

**Files:**
- Modify: `backend/collab-server/runtimePodTerminal.js` (add `programRuntimeTarget`, export it)
- Test: `backend/collab-server/__tests__/terminalRouting.test.js`

- [ ] **Step 1: Write the failing tests** (append to `terminalRouting.test.js`)
```js
const { programRuntimeTarget } = require('../runtimePodTerminal');

test('programRuntimeTarget: non-container is always headless', () => {
  assert.equal(programRuntimeTarget({ runtimeType: 'web', sysboxEnabled: true, hasHybrid: true }).target, 'headless');
});
test('programRuntimeTarget: container + sysbox → sysbox-pod (precedence over hybrid)', () => {
  assert.equal(programRuntimeTarget({ runtimeType: 'container', sysboxEnabled: true, hasHybrid: true }).target, 'sysbox-pod');
});
test('programRuntimeTarget: container + hybrid only → hybrid', () => {
  assert.equal(programRuntimeTarget({ runtimeType: 'container', sysboxEnabled: false, hasHybrid: true }).target, 'hybrid');
});
test('programRuntimeTarget: container + neither → unavailable', () => {
  assert.equal(programRuntimeTarget({ runtimeType: 'container', sysboxEnabled: false, hasHybrid: false }).target, 'unavailable');
});
```
- [ ] **Step 2: Run, expect FAIL** — `node --test --test-timeout=20000 backend/collab-server/__tests__/terminalRouting.test.js` → "programRuntimeTarget is not a function".
- [ ] **Step 3: Implement** (in `runtimePodTerminal.js`, near `runtimeTerminalTarget`)
```js
/**
 * Pure launch-target decision for a managed program. `container` programs go to
 * the Sysbox runtime pod when the backend is on (precedence), else the dev-hybrid
 * runtime container, else `unavailable` (fail loud — never the docker-less PTY).
 * Non-container programs always use the headless PTY.
 */
function programRuntimeTarget({ runtimeType, sysboxEnabled, hasHybrid } = {}) {
  if (runtimeType !== 'container') return { target: 'headless' };
  if (sysboxEnabled) return { target: 'sysbox-pod' };
  if (hasHybrid) return { target: 'hybrid' };
  return { target: 'unavailable' };
}
```
Add `programRuntimeTarget` to `module.exports`.
- [ ] **Step 4: Run, expect PASS** — same command.
- [ ] **Step 5: Commit**
```bash
git add backend/collab-server/runtimePodTerminal.js backend/collab-server/__tests__/terminalRouting.test.js
git commit -m "feat(programs): pure programRuntimeTarget launch decision

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

### Task 2: Runtime-pod program exec (`createRuntimePodProgram`)

**Files:**
- Modify: `backend/collab-server/runtimePodTerminal.js` (extract `buildRuntimeShellScript`; add `createRuntimePodProgram`)
- Test: `backend/collab-server/__tests__/terminalRouting.test.js`

- [ ] **Step 1: Write the failing test** (the pure script builder is the unit; the k8s exec is integration-verified in Phase 1's live gate)
```js
const { buildRuntimeShellScript } = require('../runtimePodTerminal');

test('buildRuntimeShellScript: runs the program command in /workspace with env exports, no DOCKER_HOST injected', () => {
  const s = buildRuntimeShellScript({ env: { FOO: 'bar' }, cwd: '/workspace', finalCommand: 'docker compose up' });
  assert.match(s, /export FOO='bar'/);
  assert.match(s, /export WORKSPACE_DIR='\/workspace'/);
  assert.match(s, /cd "\$WORKSPACE_DIR"/);
  assert.match(s, /docker compose up$/);
  assert.equal(/DOCKER_HOST/.test(s), false); // inherited from the container, never injected by us
});
```
- [ ] **Step 2: Run, expect FAIL** — `node --test --test-timeout=20000 backend/collab-server/__tests__/terminalRouting.test.js` → "buildRuntimeShellScript is not a function".
- [ ] **Step 3: Implement.** Extract the script construction currently inline in `createRuntimePodPty` (lines ~160-171) into a shared builder, then add the program exec.
```js
function buildRuntimeShellScript({ env = {}, cwd, finalCommand }) {
  const exports = Object.entries(env)
    .filter(([key, value]) => key && value !== undefined && value !== null)
    .map(([key, value]) => `export ${key}=${shellQuote(value)}`)
    .join('; ');
  return [
    exports,
    `export WORKSPACE_DIR=${shellQuote(cwd)}`,
    'mkdir -p "$WORKSPACE_DIR"',
    'cd "$WORKSPACE_DIR"',
    finalCommand,
  ].filter(Boolean).join('; ');
}
```
Refactor `createRuntimePodPty` to call it with `finalCommand: 'stty rows <rows> cols <cols> 2>/dev/null || true; exec /bin/bash --login -i'` (preserve the existing `stty` line by folding it into `finalCommand`) — verify the existing terminal tests still pass. Then add:
```js
/**
 * Non-interactive program exec into the ready Sysbox runtime pod's `runtime`
 * container. Streams stdout/stderr via RuntimePodPty (onData/onExit/kill) so it
 * plugs into the managed-session listeners. DOCKER_HOST is inherited from the
 * container's pod-level env — never injected here.
 */
async function createRuntimePodProgram({ runtimeScope, workspaceSlug, userId, command, env = {}, cols = 120, rows = 30 }) {
  if (!runtimeScope) throw new Error('runtimeScope is required for runtime pod program');
  const actor = userId || runtimeScope;
  await spawner.spawnRuntimePod(runtimeScope, actor, { workspaceSlug, runtimeKind: 'program', filesystemUserId: userId });
  const ready = await waitForReadyRuntimePod(runtimeScope); // poll getReadyRuntimePodForSession
  if (!ready?.podName) throw new Error('runtime_pod_not_ready');

  const safeCols = sanitizeDimension(cols, 120, 500);
  const safeRows = sanitizeDimension(rows, 30, 200);
  const script = buildRuntimeShellScript({
    env: { ...env, TERM: env.TERM || 'xterm-256color', COLUMNS: String(safeCols), LINES: String(safeRows) },
    cwd: RUNTIME_POD_WORKSPACE_MOUNT,
    finalCommand: command,
  });
  const stdout = new ResizablePassThrough({ cols: safeCols, rows: safeRows });
  const stderr = new PassThrough();
  const stdin = new PassThrough();
  const exec = new k8s.Exec(kubeConfig());
  const ws = await exec.exec(NAMESPACE, ready.podName, RUNTIME_POD_CONTAINER, ['/bin/bash', '-lc', script], stdout, stderr, stdin, true, () => {});
  return { ptyProcess: new RuntimePodPty({ ws, stdin, stdout, stderr, pid: ready.podName }), runtimeScope, podName: ready.podName };
}

async function waitForReadyRuntimePod(runtimeScope, { attempts = 40, intervalMs = 1500 } = {}) {
  for (let i = 0; i < attempts; i += 1) {
    const ready = typeof spawner.getReadyRuntimePodForSession === 'function'
      ? await spawner.getReadyRuntimePodForSession(runtimeScope) : null;
    if (ready?.podName) return ready;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { podName: null };
}
```
Add `buildRuntimeShellScript` and `createRuntimePodProgram` to `module.exports`. (`spawner` is already required at top of file.)
- [ ] **Step 4: Run, expect PASS** — `node --test --test-timeout=20000 backend/collab-server/__tests__/terminalRouting.test.js` (also confirms the refactor didn't break existing terminal-routing tests).
- [ ] **Step 5: Commit** — `feat(programs): createRuntimePodProgram — non-interactive program exec into the runtime pod (+ trailer)`

### Task 3: Stamp `runtimeScope` + scoped port attribution (manager)

**Files:**
- Modify: `backend/collab-server/programRuntimeManager.js`
- Test: `backend/collab-server/__tests__/programRuntimeManager.test.js`

- [ ] **Step 1: Write the failing tests**
```js
function makeFakePty() {
  const h = { data: [], exit: [] };
  return { onData: (f) => { h.data.push(f); return { dispose() {} }; },
           onExit: (f) => { h.exit.push(f); return { dispose() {} }; }, kill() {} };
}
test('launchManagedSession stamps runtimeScope from the runtime handle', async () => {
  const mgr = createProgramRuntimeManager({ activeSessions: new Map(),
    launchRuntime: async () => ({ ptyProcess: makeFakePty(), runtimeScope: 'scope-1' }) });
  const s = await mgr.launchManagedSession({ sessionId: 'p1', workspaceSlug: 'w', command: 'docker compose up', runtimeType: 'container' });
  assert.equal(s.runtimeScope, 'scope-1');
});
test('recomputeRuntimeScopePorts only touches sessions of that scope', async () => {
  const mgr = createProgramRuntimeManager({ activeSessions: new Map(),
    launchRuntime: async ({ sessionId }) => ({ ptyProcess: makeFakePty(), runtimeScope: sessionId === 'p1' ? 'scope-1' : 'scope-2' }) });
  await mgr.launchManagedSession({ sessionId: 'p1', workspaceSlug: 'w', command: 'x', runtimeType: 'container', ports: [3000] });
  await mgr.launchManagedSession({ sessionId: 'p2', workspaceSlug: 'w', command: 'x', runtimeType: 'container', ports: [4000] });
  mgr.recomputeRuntimeScopePorts('scope-1', [3000]);
  assert.deepEqual(mgr.getManagedSession('p1').activePorts, [3000]);
  assert.deepEqual(mgr.getManagedSession('p2').activePorts, [4000]); // unchanged (declared, not live in scope-1)
});
```
- [ ] **Step 2: Run, expect FAIL** — `node --test --test-timeout=20000 backend/collab-server/__tests__/programRuntimeManager.test.js` → `runtimeScope` undefined / `recomputeRuntimeScopePorts is not a function`.
- [ ] **Step 3: Implement.** In `launchManagedSession`, after `const runtime = await launchRuntime(...)`, add `runtimeScope: runtime?.runtimeScope || null,` to the `record` object literal. Then add the scoped method (mirrors `recomputeManagedPorts`, filtered):
```js
function recomputeRuntimeScopePorts(runtimeScope, detectedPorts) {
  if (!runtimeScope) return [];
  const scoped = [...managedSessions.values()].filter((r) => r.runtimeScope === runtimeScope);
  const attribution = attributeSessionPorts({
    sessions: scoped.map((r) => ({ sessionId: r.sessionId, state: r.state, declaredPorts: r.declaredPorts || [] })),
    detectedPorts,
  });
  const updated = [];
  for (const [sessionId, ports] of attribution) {
    const record = managedSessions.get(sessionId);
    if (!record) continue;
    const nextWebPort = selectWebPort({ declaredPorts: record.declaredPorts || [] }, ports);
    if (samePorts(record.activePorts, ports) && record.webPort === nextWebPort) continue;
    record.activePorts = ports;
    record.webPort = nextWebPort;
    record.lastActivityAt = now();
    appendManagedSessionEvent(record, 'ports_updated', { activePorts: [...ports], webPort: nextWebPort });
    updated.push(toPublicManagedSession(record));
  }
  return updated;
}
```
Add `recomputeRuntimeScopePorts` to the object returned by `createProgramRuntimeManager`. (`runtimeScope` is auto-exposed by `toPublicManagedSession`'s spread — confirm it is NOT in the destructured-out private list at the top of that function; it is not.)
- [ ] **Step 4: Run, expect PASS** — same command.
- [ ] **Step 5: Commit** — `feat(programs): stamp runtimeScope + recomputeRuntimeScopePorts (+ trailer)`

### Task 4: Wire the three-way branch + scope resolution + port feed (server.js)

**Files:**
- Modify: `backend/collab-server/runtimePodTerminal.js` (add `pickRuntimeScopeForSlug`, export)
- Modify: `backend/collab-server/server.js` (`launchRuntime` injection `:180`; runtime port monitor `onPortsChanged` `:171`; imports `:18`)
- Test: `backend/collab-server/__tests__/terminalRouting.test.js` (for `pickRuntimeScopeForSlug`)

- [ ] **Step 1: Write the failing test**
```js
const { pickRuntimeScopeForSlug } = require('../runtimePodTerminal');
test('pickRuntimeScopeForSlug matches slug → runtimeScope, else null', () => {
  const sessions = [{ slug: 'a', runtimeScope: 's-a' }, { slug: 'b', runtimeScope: 's-b' }];
  assert.equal(pickRuntimeScopeForSlug(sessions, 'b'), 's-b');
  assert.equal(pickRuntimeScopeForSlug(sessions, 'z'), null);
  assert.equal(pickRuntimeScopeForSlug(null, 'b'), null);
});
```
- [ ] **Step 2: Run, expect FAIL** — `node --test --test-timeout=20000 backend/collab-server/__tests__/terminalRouting.test.js`.
- [ ] **Step 3a: Implement `pickRuntimeScopeForSlug`** (runtimePodTerminal.js, export it)
```js
function pickRuntimeScopeForSlug(sessions, slug) {
  const list = Array.isArray(sessions) ? sessions : [];
  const match = list.find((s) => s && s.slug === slug && s.runtimeScope);
  return match ? match.runtimeScope : null;
}
```
- [ ] **Step 3b: Wire server.js.** Extend the import at `:18`:
```js
const { runtimeRunOnce, createRuntimePodProgram, programRuntimeTarget, pickRuntimeScopeForSlug } = require('./runtimePodTerminal');
```
Replace the `launchRuntime` body (`:180-197`) with the three-way branch:
```js
launchRuntime: async ({ sessionId, workspaceSlug, userId, env, title, command, runtimeType }) => {
  const { target } = programRuntimeTarget({ runtimeType, sysboxEnabled: isSysboxRuntimeEnabled(), hasHybrid: Boolean(workspaceRuntime) });
  if (target === 'sysbox-pod') {
    const sessions = typeof spawner.listActiveRuntimeSessions === 'function' ? await spawner.listActiveRuntimeSessions() : [];
    const runtimeScope = pickRuntimeScopeForSlug(sessions, workspaceSlug);
    if (!runtimeScope) throw new Error('runtime_pod_not_ready');
    return createRuntimePodProgram({ runtimeScope, workspaceSlug, userId, command, env });
  }
  if (target === 'hybrid') {
    await workspaceRuntime.ensureRuntimeContainer(workspaceSlug, userId);
    await workspaceRuntime.waitForRuntimeReady(workspaceSlug, userId);
    return workspaceRuntime.execInRuntime(workspaceSlug, userId, { command, env, tty: true });
  }
  if (target === 'unavailable') throw new Error('container_runtime_unavailable');
  const runtime = await createHeadlessSession(sessionId, workspaceSlug, userId, 120, 30, title, { env });
  const { commandStartedPromise } = queueHeadlessCommandStart(runtime.ptyProcess, command);
  return { ...runtime, commandStartedPromise };
},
```
Then feed scoped ports — extend the runtime port monitor `onPortsChanged` (`:171`):
```js
onPortsChanged: (slug, runtimeScope, ports) => {
  broadcastRuntimePorts(slug, runtimeScope, ports);
  try { managedProgramRuntime.recomputeRuntimeScopePorts(runtimeScope, ports); }
  catch (err) { logger.warn({ err }, 'recomputeRuntimeScopePorts failed'); }
},
```
(`managedProgramRuntime` is declared just below at `:176`; `onPortsChanged` only fires after `runtimePortMonitor.start()` at `:5015`, so the closure is safe — no TDZ at call time.)
- [ ] **Step 4: Verify** — pure helper: `node --test --test-timeout=20000 backend/collab-server/__tests__/terminalRouting.test.js` PASS. Syntax/boot check: `node --check backend/collab-server/server.js` → no output (OK). (Full path is exercised by the live gate after Task 6.)
- [ ] **Step 5: Commit** — `feat(programs): route container programs into the sysbox runtime pod (+ trailer)`

### Task 5: `mergeProgramSession` carries `runtimeScope`

**Files:**
- Modify: `synthi/src/lib/programs/routeHelpers.js:8-25`
- Test: `synthi/src/lib/programs/__tests__/routeHelpers.test.js`

- [ ] **Step 1: Write the failing test**
```js
test('mergeProgramSession carries runtimeScope from the runtime session', () => {
  const merged = mergeProgramSession({ workspaceSlug: 'w' }, { runtimeScope: 'scope-1', activePorts: [3000], webPort: 3000 });
  expect(merged.runtimeScope).toBe('scope-1');
});
test('mergeProgramSession runtimeScope is null without a runtime session', () => {
  expect(mergeProgramSession({ workspaceSlug: 'w' }, null).runtimeScope).toBeNull();
});
```
- [ ] **Step 2: Run, expect FAIL** — `cd synthi && npx vitest run routeHelpers`.
- [ ] **Step 3: Implement** — add to the `merged` object in `mergeProgramSession`:
```js
runtimeScope: runtimeSession?.runtimeScope ?? null,
```
- [ ] **Step 4: Run, expect PASS** — `cd synthi && npx vitest run routeHelpers`.
- [ ] **Step 5: Commit** — `feat(programs): mergeProgramSession surfaces runtimeScope to the frontend (+ trailer)`

### Task 6: Frontend panel threads `runtimeScope` into the App URL

**Files:**
- Modify: `synthi/src/components/programs/ProgramSessionPanel.jsx:118-121` and `:300`
- Test: `synthi/src/components/programs/__tests__/ProgramSessionPanel.test.jsx`

- [ ] **Step 1: Write the failing test** (mock `programSessionClient.fetchProgramSession` to return a sysbox container session; assert the App iframe `src` uses the runtime-scope path)
```jsx
// session: { state:'running', runtimeType:'container', webPort:3000, activePorts:[3000], runtimeScope:'scope-1' }
const iframe = await screen.findByTitle(/app/i);
expect(iframe.getAttribute('src')).toContain('/runtime/scope-1/port/3000/');
```
- [ ] **Step 2: Run, expect FAIL** — `cd synthi && npx vitest run ProgramSessionPanel` (src lacks the scope segment).
- [ ] **Step 3: Implement** — add `runtimeScope: session?.runtimeScope` to the `getProgramSessionAppUrl` opts in the `appUrl` `useMemo` (and to its dependency array), and to the Ports "Open" link call at `:300`:
```jsx
const appUrl = useMemo(
  () => getProgramSessionAppUrl(effectiveWebPort, { slug: workspaceSlug, runtimeType: session?.runtimeType, runtimeScope: session?.runtimeScope }),
  [effectiveWebPort, workspaceSlug, session?.runtimeType, session?.runtimeScope],
);
// …and at the Ports "Open" anchor:
href={getProgramSessionAppUrl(port, { slug: workspaceSlug, runtimeType, runtimeScope: session?.runtimeScope }) || '#'}
```
- [ ] **Step 4: Run, expect PASS** — `cd synthi && npx vitest run ProgramSessionPanel`.
- [ ] **Step 5: Commit** — `feat(programs): App tab renders sysbox container web UI via /runtime/<scope>/port/N (+ trailer)`

> **Checkpoint after Task 6:** the core path is complete. A `container`-type recipe launched with `RUNTIME_BACKEND=sysbox-pod` runs `docker compose up` in the runtime pod and its web UI renders in the App tab. This is the first thing to live-demo on a scratch cluster.

## Phase 2 — repo auto-detection (compose + devcontainer + Dockerfile)

### Task 7: compose mapper (text-based, no YAML dep)

**Files:**
- Create: `synthi/src/lib/programs/compose.js`
- Test: `synthi/src/lib/programs/__tests__/compose.test.js`

- [ ] **Step 1: Write the failing tests**
```js
import { importComposeFile } from '../compose';
const RAW = `services:\n  web:\n    image: nginx\n    ports:\n      - "8080:80"\n`;
it('maps a compose file to a container program (docker compose up + scraped ports)', () => {
  const { config } = importComposeFile(RAW, { containerRuntime: true });
  expect(config.runtimeType).toBe('container');
  expect(config.launch).toBe('docker compose up');
  expect(config.ports).toContain(8080);
});
it('returns null config when containerRuntime is unavailable', () => {
  expect(importComposeFile(RAW, { containerRuntime: false }).config).toBeNull();
});
it('rejects a compose file that mounts the docker socket', () => {
  const bad = `services:\n  x:\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n`;
  expect(() => importComposeFile(bad, { containerRuntime: true })).toThrow(/host_escape|docker\.sock/i);
});
```
- [ ] **Step 2: Run, expect FAIL** — `cd synthi && npx vitest run compose`.
- [ ] **Step 3: Implement**
```js
import { parseProgramManifest, ProgramManifestError } from './manifest';

const HOST_ESCAPE_RE = /docker\.sock|^\s*privileged:\s*true|-\s*\/(?:[^:\n]*):|\/var\/run/im;

/** Best-effort host-port scrape from `ports:` list items (live monitor is authoritative). */
function scrapeComposePorts(raw) {
  const out = [];
  const re = /^\s*-\s*"?(?:\d{1,3}(?:\.\d{1,3}){3}:)?(\d{1,5}):\d{1,5}"?\s*$/gm;
  let m;
  while ((m = re.exec(raw))) { const p = parseInt(m[1], 10); if (p >= 1 && p <= 65535 && !out.includes(p)) out.push(p); }
  return out;
}

export function importComposeFile(raw, { containerRuntime = false } = {}) {
  const text = String(raw || '');
  if (!/^\s*services:/m.test(text)) {
    throw new ProgramManifestError('invalid_manifest', 'Not a recognizable compose file', 'services');
  }
  if (HOST_ESCAPE_RE.test(text)) {
    throw new ProgramManifestError('host_escape', 'compose requests host access', 'volumes');
  }
  if (!containerRuntime) return { config: null, source: 'docker-compose.yml' };
  const ports = scrapeComposePorts(text);
  const config = parseProgramManifest({
    packageId: 'compose-project', version: '0.0.0', displayName: 'Compose project',
    runtimeType: 'container', launch: 'docker compose up', ports,
    permissions: ports.length ? ['program.launch', 'ports.expose', 'network.outbound'] : ['program.launch'],
  });
  config.source = 'docker-compose.yml';
  return { config, source: 'docker-compose.yml' };
}
```
- [ ] **Step 4: Run, expect PASS** — `cd synthi && npx vitest run compose`.
- [ ] **Step 5: Commit** — `feat(programs): compose→container mapper (text probe, host-escape guard) (+ trailer)`

### Task 8: Dockerfile mapper

**Files:**
- Create: `synthi/src/lib/programs/dockerfile.js`
- Test: `synthi/src/lib/programs/__tests__/dockerfile.test.js`

- [ ] **Step 1: Write the failing tests**
```js
import { importDockerfile } from '../dockerfile';
it('maps a Dockerfile to a build+run container program with EXPOSE ports', () => {
  const { config } = importDockerfile('FROM node:20\nEXPOSE 3000\n', { name: 'myapp', containerRuntime: true });
  expect(config.runtimeType).toBe('container');
  expect(config.install[0]).toMatch(/docker build -t/);
  expect(config.launch).toMatch(/docker run/);
  expect(config.ports).toContain(3000);
});
it('returns null config when containerRuntime is unavailable', () => {
  expect(importDockerfile('FROM scratch\n', { name: 'x', containerRuntime: false }).config).toBeNull();
});
```
- [ ] **Step 2: Run, expect FAIL** — `cd synthi && npx vitest run dockerfile`.
- [ ] **Step 3: Implement**
```js
import { parseProgramManifest } from './manifest';

function scrapeExposePorts(raw) {
  const out = [];
  const re = /^\s*EXPOSE\s+(.+)$/gim;
  let m;
  while ((m = re.exec(raw))) {
    for (const tok of m[1].split(/\s+/)) {
      const p = parseInt(tok, 10);
      if (p >= 1 && p <= 65535 && !out.includes(p)) out.push(p);
    }
  }
  return out;
}

function slugifyTag(name) {
  const s = String(name || 'app').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64);
  return /^[a-z0-9]/.test(s) ? s : 'app';
}

export function importDockerfile(raw, { name = 'app', containerRuntime = false } = {}) {
  const text = String(raw || '');
  if (!/^\s*FROM\s+/im.test(text)) {
    return { config: null, source: 'Dockerfile' };
  }
  if (!containerRuntime) return { config: null, source: 'Dockerfile' };
  const ports = scrapeExposePorts(text);
  const tag = slugifyTag(name);
  const portFlags = ports.map((p) => `-p ${p}:${p}`).join(' ');
  const config = parseProgramManifest({
    packageId: slugifyTag(name), version: '0.0.0', displayName: name,
    runtimeType: 'container',
    install: [`docker build -t ${tag} .`],
    launch: `docker run --rm ${portFlags ? portFlags + ' ' : ''}${tag}`.trim(),
    ports,
    permissions: ports.length ? ['program.launch', 'ports.expose', 'network.outbound'] : ['program.launch'],
  });
  config.source = 'Dockerfile';
  return { config, source: 'Dockerfile' };
}
```
- [ ] **Step 4: Run, expect PASS** — `cd synthi && npx vitest run dockerfile`.
- [ ] **Step 5: Commit** — `feat(programs): Dockerfile→container mapper (build+run, EXPOSE ports) (+ trailer)`

### Task 9: `repoDetect` orchestrator (precedence + capability gate)

**Files:**
- Create: `synthi/src/lib/programs/repoDetect.js`
- Test: `synthi/src/lib/programs/__tests__/repoDetect.test.js`

- [ ] **Step 1: Write the failing tests**
```js
import { detectRepoProgram } from '../repoDetect';
const compose = `services:\n  web:\n    image: nginx\n    ports:\n      - "8080:80"\n`;
it('prefers compose over devcontainer over Dockerfile', () => {
  const r = detectRepoProgram({ files: { 'docker-compose.yml': compose, 'Dockerfile': 'FROM x\n' }, containerRuntime: true });
  expect(r.source).toBe('docker-compose.yml');
  expect(r.config.launch).toBe('docker compose up');
});
it('falls to Dockerfile when no compose/devcontainer', () => {
  const r = detectRepoProgram({ files: { 'Dockerfile': 'FROM node:20\nEXPOSE 3000\n' }, containerRuntime: true });
  expect(r.source).toBe('Dockerfile');
});
it('returns null when capability is off', () => {
  expect(detectRepoProgram({ files: { 'docker-compose.yml': compose }, containerRuntime: false })).toBeNull();
});
it('returns null when nothing is detected', () => {
  expect(detectRepoProgram({ files: { 'README.md': 'hi' }, containerRuntime: true })).toBeNull();
});
```
- [ ] **Step 2: Run, expect FAIL** — `cd synthi && npx vitest run repoDetect`.
- [ ] **Step 3: Implement**
```js
import { importComposeFile } from './compose';
import { importDockerfile } from './dockerfile';
import { importDevcontainer } from './devcontainer';

/**
 * Map the highest-precedence container artifact in a repo to a NormalizedProgramConfig.
 * @param {{ files: Record<string,string>, containerRuntime?: boolean, name?: string }} args
 * @returns {{ config: object, source: string } | null}
 */
export function detectRepoProgram({ files = {}, containerRuntime = false, name = 'repo' } = {}) {
  if (!containerRuntime) return null;
  const compose = files['docker-compose.yml'] || files['compose.yaml'] || files['compose.yml'];
  if (compose) { const { config } = importComposeFile(compose, { containerRuntime }); if (config) return { config, source: 'docker-compose.yml' }; }
  const dc = files['.devcontainer/devcontainer.json'] || files['.devcontainer.json'] || files['devcontainer.json'];
  if (dc) { const { config } = importDevcontainer(dc, { containerRuntime }); if (config?.runtimeType === 'container') return { config, source: 'devcontainer.json' }; }
  const dockerfile = files['Dockerfile'];
  if (dockerfile) { const { config } = importDockerfile(dockerfile, { name, containerRuntime }); if (config) return { config, source: 'Dockerfile' }; }
  return null;
}
```
- [ ] **Step 4: Run, expect PASS** — `cd synthi && npx vitest run repoDetect`.
- [ ] **Step 5: Commit** — `feat(programs): repoDetect orchestrator (compose>devcontainer>Dockerfile) (+ trailer)`

### Task 10: collab-server `/detect` endpoint + capability on `/manifest`

**Files:**
- Modify: `backend/collab-server/server.js` (new `/program-runtime/:slug/detect` handler; add `containerRuntimeAvailable` to the `/manifest` response `:1974-1980`)
- Modify: `synthi/src/lib/programs/runtimeClient.js` (`loadWorkspaceRecipe` `:87-97`: pass `{ containerRuntime: data.containerRuntimeAvailable }` into `importDevcontainer`; add `fetchDetectedRepoProgram`)
- Test: `synthi/src/lib/programs/__tests__/runtimeClient.test.js`

- [ ] **Step 1: Write the failing test** (the collab fetch is mocked; assert the client maps a detect response → config)
```js
// mock requestJson → { found:true, files:{ 'docker-compose.yml': 'services:\n  w:\n    ports:\n      - "8080:80"\n' }, containerRuntimeAvailable:true }
const r = await fetchDetectedRepoProgram('slug', 'user');
expect(r.source).toBe('docker-compose.yml');
expect(r.config.launch).toBe('docker compose up');
```
- [ ] **Step 2: Run, expect FAIL** — `cd synthi && npx vitest run runtimeClient`.
- [ ] **Step 3a: collab-server `/detect`** — add a handler modeled on the `/manifest` handler (`server.js:1955`), probing more candidates and returning their raw contents + capability:
```js
const detectMatch = /^\/program-runtime\/([^/]+)\/detect$/.exec(programRuntimeUrl.pathname);
if (detectMatch && req.method === 'GET') {
  const slug = decodeURIComponent(detectMatch[1]);
  const userId = programRuntimeUrl.searchParams.get('userId') || undefined;
  try {
    const fs = require('fs'); const path = require('path');
    const { resolveWorkspaceCwd } = require('./terminalService');
    const cwd = await resolveWorkspaceCwd(slug, userId);
    const names = ['docker-compose.yml', 'compose.yaml', 'compose.yml', '.devcontainer/devcontainer.json', '.devcontainer.json', 'devcontainer.json', 'Dockerfile'];
    const files = {};
    for (const n of names) { const f = path.join(cwd, n); if (fs.existsSync(f)) files[n] = fs.readFileSync(f, 'utf8'); }
    const containerRuntimeAvailable = isSysboxRuntimeEnabled() || process.env.ENABLE_CONTAINER_RUNTIME === '1';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ found: Object.keys(files).length > 0, files, containerRuntimeAvailable }));
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message || 'detect failed' }));
  }
  return;
}
```
Also add `containerRuntimeAvailable: isSysboxRuntimeEnabled() || process.env.ENABLE_CONTAINER_RUNTIME === '1'` to the `/manifest` result object (`:1974`, `:1977`).
- [ ] **Step 3b: runtimeClient.js** — fix the devcontainer gate and add the detect fetch:
```js
import { detectRepoProgram } from './repoDetect';
// in loadWorkspaceRecipe, replace the devcontainer branch:
if (data.source === 'devcontainer.json') {
  const { config } = importDevcontainer(data.raw, { containerRuntime: data.containerRuntimeAvailable === true });
  return { config, source: 'devcontainer.json' };
}
// new export:
export async function fetchDetectedRepoProgram(workspaceSlug, userId) {
  const q = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  const data = await requestJson(`/program-runtime/${encodeURIComponent(workspaceSlug)}/detect${q}`);
  if (!data || !data.found) return null;
  return detectRepoProgram({ files: data.files || {}, containerRuntime: data.containerRuntimeAvailable === true, name: workspaceSlug });
}
```
- [ ] **Step 4: Verify** — `cd synthi && npx vitest run runtimeClient` PASS; `node --check backend/collab-server/server.js`.
- [ ] **Step 5: Commit** — `feat(programs): /detect endpoint + server-truthful containerRuntimeAvailable gate (+ trailer)`

### Task 11: Next.js `/programs/detect` route + ProgramsPanel "Detected in this repo"

**Files:**
- Create: `synthi/src/app/api/workspace/[slug]/programs/detect/route.js`
- Modify: `synthi/src/components/programs/ProgramsPanel.jsx` (+ `programsClient.js` helper)
- Test: `synthi/src/app/api/workspace/[slug]/programs/__tests__/programRoutes.test.js` (route); `synthi/src/components/programs/__tests__/programsPanelInstall.test.jsx` (panel)

- [ ] **Step 1: Write the failing route test** — mock `fetchDetectedRepoProgram` → a compose config; GET the route → 200 with `{ detected: { config, source } }`; unauthenticated → 401; forbidden scope → 403 (mirror the existing program-route tests' auth setup).
- [ ] **Step 2: Run, expect FAIL** — `cd synthi && npx vitest run programRoutes`.
- [ ] **Step 3a: Route** (model on `program-sessions/[sessionId]/route.js` auth):
```js
import { NextResponse } from 'next/server';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope } from '@/lib/integrations/scope';
import { fetchDetectedRepoProgram } from '@/lib/programs/runtimeClient';
export const runtime = 'nodejs';
export async function GET(_req, { params }) {
  const { slug } = await params;
  const actor = await resolveActor();
  if (!actor) return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  if (!(await canReadScope(actor, { scope: 'workspace', workspaceSlug: slug }))) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const detected = await fetchDetectedRepoProgram(slug, actor.workspaceUserId || actor.id).catch(() => null);
  return NextResponse.json({ detected });
}
```
- [ ] **Step 3b: Panel** — add a `programsClient.fetchDetectedProgram(slug)` calling `GET /programs/detect`; in `ProgramsPanel.jsx`, on mount fetch it and, when `detected`, render a "Detected in this repo: <source>" row with a Launch button that calls the existing launch flow with `detected.config`. Add a panel test asserting the row renders when the client returns a detected program.
- [ ] **Step 4: Verify** — `cd synthi && npx vitest run programRoutes programsPanelInstall`.
- [ ] **Step 5: Commit** — `feat(programs): repo-detect surfaced in the Programs panel (+ trailer)`

## Phase 3 — cleanup, audit, verification

### Task 12: Stale "rootless" comment cleanup (lesson #31)

**Files:** `backend/collab-server/runtimePodSpec.js:9`; `backend/collab-server/programRuntimeManager.js:23`

- [ ] **Step 1:** In `runtimePodSpec.js` header (`:9`), change "rootless dockerd under Sysbox" → "rootful dockerd under Sysbox" (matches `RUNTIME_DOCKER_HOST=/var/run/docker.sock` and lesson #31).
- [ ] **Step 2:** In `programRuntimeManager.js:23`, change the "docker:dind-rootless sets it" phrasing to reflect the rootful in-pod socket inherited from the runtime container's pod-level `DOCKER_HOST`.
- [ ] **Step 3: Verify no behavior change** — `node --test --test-timeout=20000 backend/collab-server/__tests__/runtimePodSpec.test.js` PASS.
- [ ] **Step 4: Commit** — `docs(runtime): correct stale rootless→rootful comments (lesson #31) (+ trailer)`

### Task 13: Full-suite green, hardcoded-values audit, live demo, wrap

- [ ] **Step 1: Backend suite** — `node --test --test-timeout=20000 backend/collab-server/__tests__/*.test.js` → 0 fail (note pass/skip counts).
- [ ] **Step 2: Frontend suite** — `cd synthi && npx vitest run src/lib/programs src/components/programs` → 0 fail.
- [ ] **Step 3: Hardcoded-values audit** (per `hardcoded-values-audit` memory) — confirm every new value is env-driven or a universal standard: `/workspace` + `runtime` container (already centralized), `containerRuntimeAvailable` derived from `RUNTIME_BACKEND`/`ENABLE_CONTAINER_RUNTIME` (no new literal), the `@vectant/*` example image digest-pinned in AR + passes trivy. No env-specific/secret values committed.
- [ ] **Step 4: Live e2e gate (scratch cluster only).** VERIFY `kubectl config current-context` is the scratch cluster, NOT prod. With `RUNTIME_BACKEND=sysbox-pod`: launch a real compose program (a) via recipe and (b) via repo-detect → web UI renders in the App tab via `/runtime/<scope>/port/N`; Terminal execs into the runtime pod; logs stream. Capture evidence. Tear down: `--quiet --async`; confirm `clusters list` shows prod only.
- [ ] **Step 5: Wrap** — append a Review section here; update `tasks/lessons.md` if any correction surfaced; give the plain-words recap (per `end-of-implementation-summary` memory). Commit docs.

## Self-review (writing-plans)
- **Spec coverage:** §5.1 launch branch → T1+T4; §5.2 exec → T2; §5.3 stamp → T3; §5.4 scoped ports → T3 (method) + T4 (wiring); §5.5 frontend → T5 (merge) + T6 (panel); §5.6 recipe → existing parser (works after T4) + capability T10; repo-detect compose/devcontainer/Dockerfile → T7/T8/T9; detect endpoint + UI → T10/T11; §11 cleanup → T12; §12 audit + live gate → T13. No uncovered section.
- **Placeholders:** none — every code step carries real code; the only deferred item is the live demo (explicit gate, not a code step).
- **Type/name consistency:** `programRuntimeTarget`→`{target}`, `createRuntimePodProgram`→`{ptyProcess,runtimeScope,podName}`, `recomputeRuntimeScopePorts(scope,ports)`, `pickRuntimeScopeForSlug(sessions,slug)`, `detectRepoProgram({files,containerRuntime,name})`, `fetchDetectedRepoProgram(slug,userId)`, `mergeProgramSession(...).runtimeScope` — used consistently across tasks.

## Review — code complete + tested (2026-06-16)

All 12 code tasks done via TDD (red→green→commit). Commits on `feat/docker-sysbox-engine`:
`afb4de5f` T1 · `9f51fef0` T2 · `705b346e` T3 · `4ecfefc3` T4 · `b6385779` T5 · `a0ab61fc` T6 · `7a6d739b` T7 · `e21b6773` T8 · `73d4041b` T9 · `5521db89` T10 · `f6093cb9` T11 · `a1173cd8` T12.

- **Backend suite:** `node --test` → 92 tests, **87 pass / 0 fail / 5 skip** (the 5 skips are pre-existing deferred integration tests). +8 new unit tests this slice.
- **Frontend programs suite:** `vitest src/lib/programs src/components/programs [slug]/programs` → 14 files, **149 pass / 0 fail**. +21 new tests this slice.
- **Hardcoded-values audit (clean):** every new value is a universal standard or env-derived, none env-specific/secret:
  - `containerRuntimeAvailable` = `RUNTIME_BACKEND==='sysbox-pod' || ENABLE_CONTAINER_RUNTIME==='1'` — derived from existing env, no new literal.
  - Docker verbs (`docker compose up`, `docker build -t … .`, `docker run --rm …`), candidate filenames (`docker-compose.yml`, `.devcontainer/devcontainer.json`, `Dockerfile`, …), and machine codes (`runtime_pod_not_ready`, `container_runtime_unavailable`, `not_detected`) are universal standards.
  - `/workspace` mount + `runtime` container name reuse the existing centralized consts in `runtimePodTerminal.js` (not new).
  - Synthetic `compose-project` / `0.0.0` placeholders for a detected project's packageId/version are universal defaults, not env-specific.
  - `waitForReadyRuntimePod` 40×1500ms (~60s) dockerd-ready poll is a deliberate universal default (mirrors the readinessProbe failureThreshold:12); env-gating it is a noted future option, not a violation.

### Live e2e gate — PASSED ✅ (2026-06-16; scratch cluster synthi-sysbox-scratch: created → validated → torn down)
Validated the slice's substrate-dependent path on a throwaway Dataplane-V2 scratch cluster, using the REAL `buildRuntimeDeployment` runtime pod (sysbox-runc, hostUsers:false, non-privileged, AR digest-pinned `vectant-runtime`):
- **compose-in-sysbox:** `docker compose up` (the exact command the compose-detect mapper emits) ran inside the per-workspace sysbox pod via the **inherited** `DOCKER_HOST=unix:///var/run/docker.sock` (never injected); pulled `python:3.12-alpine` from Docker Hub (egress OK); started `workspace-web-1` → `0.0.0.0:8080->8080`.
- **port detection:** `/proc/net/tcp …:1F90 … 0A` = 8080 LISTENING in the pod netns — exactly what the Slice-4 monitor reads → `recomputeRuntimeScopePorts` → session `activePorts`.
- **web UI reachability:** in-pod `http://localhost:8080` → **HTTP 200** (the preview-proxy → `/runtime/<scope>/port/8080` data path); `docker compose logs` showed the GET 200.
- **terminal-into-runtime:** `docker ps` via k8s-exec listed the container. **isolation:** `uid_map 0 3848536064 65536` (root-in-userns, non-privileged) = Sysbox confirmed.
- The collab-server session→port→URL wiring + recipe/detect config production are the unit-tested layers (87 backend + 149 frontend); the live gate covered what units can't.
- **Teardown:** scratch cluster deleted; `clusters list` → `synthi-beta-cluster` (prod) ONLY, billing stopped. AR `vectant-runtime:scratch` + `sysbox-deploy-k8s:v0.7.0-0` kept for re-spin. See lesson #36 (regional SSD_TOTAL_GB wall → pd-standard for scratch pool + PVC).

**Slice 1 = DONE: code-complete · unit-tested · audit-clean · live-validated.**

---

# Slice 2 — Cloud-deploy Integration Merge Implementation Plan (2026-06-18)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline) or subagent-driven-development. Steps use `- [ ]`.

**Goal:** Merge `origin/main` (the cloud-deploy trunk, 51 commits: preview discovery + workspace browser viewer + terminal OAuth relay) into `feat/docker-sysbox-engine` with both full test suites green and both preview surfaces intact, plus an infra-port filter so the program App tab never surfaces dockerd (2376).

**Architecture:** ONE merge commit (not rebase); resolve 6 conflicts by additive union + lockfile regen; then a small TDD'd infra-port filter; full-suite + live re-validation. Spec: `docs/superpowers/specs/2026-06-18-cloud-deploy-integration-merge-design.md`.

**Tech stack:** `git merge`, collab-server (CommonJS, `node:test`), Next.js (vitest), GKE/Sysbox scratch cluster.

**Conventions:** The merge is ONE commit, finalized only after ALL 6 conflicts are resolved (Tasks 2–5). **Read every conflict hunk — union, never blind-accept.** Rollback: `git merge --abort` (pre-commit) or `git reset --hard $PRE_MERGE_SHA` (post-commit, pre-push). Commits end with `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`. No push until Task 8 (pre-approved). Run from repo root; backend tests scoped (lesson #21).

## Task 1: Pre-merge prep + green baseline
**Files:** working tree only.
- [ ] **Step 1: Record rollback point.** `git rev-parse --abbrev-ref HEAD` (expect `feat/docker-sysbox-engine`); `git rev-parse HEAD` → note as `$PRE_MERGE_SHA` (expect `33515abe…` or the spec commit `ec9ddc91…`).
- [ ] **Step 2: Clean the tree (revert docker-detour artifacts).** `git checkout -- synthi/Dockerfile package-lock.json`. Then `git status --short` must show ONLY `?? memory/` and `?? tasks/handoff-real-programs-in-workspace.md`.
- [ ] **Step 3: Baseline backend suite.** `node --test --test-timeout=20000 backend/collab-server/__tests__/*.test.js` → record `# pass/fail/skip` (expect 87 / 0 / 5).
- [ ] **Step 4: Baseline frontend suite.** `cd synthi && npx vitest run src/lib/programs src/components/programs` → record (expect 149 / 0). No commit (prep only).

## Task 2: Begin merge; resolve `workspacePodSpawner.js`
**Files:** Modify (conflict): `backend/collab-server/workspacePodSpawner.js`
- [ ] **Step 1: Start the merge.** `git merge origin/main --no-commit --no-edit`. Expect CONFLICTs in 6 files; `git status` lists them. (Do NOT commit anywhere in Tasks 2–4.)
- [ ] **Step 2: Resolve `workspacePodSpawner.js` — union every hunk, keep BOTH sides:**
  - OURS (HEAD): `spawnRuntimePod`, `ensureRuntimeService`/`deleteRuntimeService`, `buildRuntimePreviewSidecar` (runtime-pod sidecar), `runtimeLifecycleSnapshot`, `listActiveRuntimeSessions`, `getReadyRuntimePodForSession`, `runtimeSessionsFromDeployments`, `purgeRuntimeData`/`runtimeDockerDataDir`, runtime pin helpers, the `RUNTIME_*` consts.
  - THEIRS (origin/main): enhanced `previewSidecarScript()` (in-pod `/proc/net/tcp` discovery + `INFRA_PORTS` + HTTP-app filtering + `SYNTHI_PREVIEW_SCAN_PORTS`), `workflowBridgeContainers` (browser-viewer/CDP/bridge envs), runtime-persistence hooks, prod-eviction durability, the `PREVIEW_PUBLIC_*`/`WORKFLOW_*` consts.
  - Shared top-of-file constants block: keep every const from BOTH sides (no duplicates). These are disjoint functions; union preserves both.
- [ ] **Step 3: Parse check.** `node --check backend/collab-server/workspacePodSpawner.js` → no output.

## Task 3: Resolve `runtimePodTerminal.js` + `terminalService.js`
**Files:** Modify (conflict): `backend/collab-server/runtimePodTerminal.js`, `backend/collab-server/terminalService.js`
- [ ] **Step 1: `runtimePodTerminal.js` — union.** OURS: `programRuntimeTarget`, `pickRuntimeScopeForSlug`, `buildRuntimeShellScript`, `createRuntimePodProgram`, `waitForReadyRuntimePod` (plus existing `runtimeTerminalTarget`/`createRuntimePodPty`/`runtimeRunOnce`). THEIRS: runtime-persistence + OAuth-relay hooks. Merge `module.exports` to include BOTH sides' symbols.
- [ ] **Step 2:** `node --check backend/collab-server/runtimePodTerminal.js`.
- [ ] **Step 3: `terminalService.js` — union** both sides' edits (ours: runtime-pod terminal routing; theirs: OAuth-relay/loopback + persistence). `node --check backend/collab-server/terminalService.js`.

## Task 4: Resolve `synthi/package-lock.json` (regenerate) + the 2 panel files
**Files:** Modify (conflict): `synthi/package-lock.json`, `synthi/src/app/workspace/ActivityBar.jsx`, `synthi/src/components/docking-wm/components/DockingActivityBar.jsx`
- [ ] **Step 1: Regenerate the lock** (never hand-merge). `git checkout --ours synthi/package-lock.json`; then `cd synthi && npm install --package-lock-only --no-audit --no-fund --cache D:/npm-cache-tmp && cd ..` (cache on D: — C: ENOSPC'd during the local rebuild); then `git add synthi/package-lock.json`.
- [ ] **Step 2: `ActivityBar.jsx` — union** both activity-bar entries (ours: Programs; main's: workspace browser) — keep both imports + buttons.
- [ ] **Step 3: `DockingActivityBar.jsx` — union** both panel registrations.
- [ ] **Step 4: Stage resolved files.** `git add backend/collab-server/workspacePodSpawner.js backend/collab-server/runtimePodTerminal.js backend/collab-server/terminalService.js synthi/src/app/workspace/ActivityBar.jsx synthi/src/components/docking-wm/components/DockingActivityBar.jsx`.

## Task 5: Reconcile auto-merged `server.js` + finalize the merge commit
**Files:** `backend/collab-server/server.js` (auto-merged — verify intent), all merged modules.
- [ ] **Step 1: Verify both lines survived in `server.js`.** `grep -nE "programRuntimeTarget|createRuntimePodProgram|recomputeRuntimeScopePorts" backend/collab-server/server.js` (our launch branch + port feed) AND grep the OAuth-relay/loopback routes (main's). Both present.
- [ ] **Step 2: No remaining conflicts.** `git status` shows no "both modified". `node --check backend/collab-server/server.js`.
- [ ] **Step 3: Full backend suite.** `node --test --test-timeout=20000 backend/collab-server/__tests__/*.test.js` → 0 fail (≥ baseline + main's new tests, e.g. `runtimePersistence.test.js`).
- [ ] **Step 4: Full frontend suite.** `cd synthi && npx vitest run src/lib/programs src/components/programs` → 0 fail.
- [ ] **Step 5: Finalize the merge commit.** `git commit --no-edit` (single merge commit; default message lists the merged branch).

## Task 6: Infra-port filter in runtime attribution (TDD)
**Files:** Modify: `backend/collab-server/programRuntimeManager.js`; Test: `backend/collab-server/__tests__/programRuntimeManager.test.js`
- [ ] **Step 1: Write the failing test.**
```js
test('recomputeRuntimeScopePorts drops infra ports (dockerd 2376)', async () => {
  const mgr = makeManager({ launchRuntime: async () => ({ ...createManagedRuntimeHandle(), runtimeScope: 'scope-1' }) });
  await mgr.launchManagedSession({ sessionId: 'p1', workspaceSlug: 'w', command: 'x', runtimeType: 'container' });
  mgr.recomputeRuntimeScopePorts('scope-1', [2376, 8080]);
  assert.deepEqual(mgr.getManagedSession('p1').activePorts, [8080]);
});
```
- [ ] **Step 2: Run → FAIL** (`activePorts` would be `[2376, 8080]`). `node --test --test-timeout=20000 backend/collab-server/__tests__/programRuntimeManager.test.js`.
- [ ] **Step 3: Implement.** Add a parser near the other helpers:
```js
function parseInfraPorts(value) {
  const out = new Set();
  for (const part of String(value || '').split(',')) {
    const p = parseInt(part.trim(), 10);
    if (Number.isInteger(p) && p > 0 && p <= 65535) out.add(p);
  }
  return out;
}
```
In `createProgramRuntimeManager`'s options destructure add: `infraPorts = parseInfraPorts(process.env.RUNTIME_INFRA_PORTS || '2376,18080'),`. In `recomputeRuntimeScopePorts`, filter before attribution:
```js
const detected = normalizePorts(detectedPorts).filter((p) => !infraPorts.has(p));
const attribution = attributeSessionPorts({
  sessions: scoped.map((r) => ({ sessionId: r.sessionId, state: r.state, declaredPorts: r.declaredPorts || [] })),
  detectedPorts: detected,
});
```
- [ ] **Step 4: Run → PASS**; full backend suite 0 fail.
- [ ] **Step 5: Commit.** `feat(integration): filter infra ports (dockerd/sidecar) from runtime App-tab attribution (+ trailer)`.

## Task 7: Live re-validation on a scratch cluster (the merged runtime)
- [ ] **Step 1: Verify auth.** `gcloud auth print-access-token | cut -c1-12` (errors → ask the user to `gcloud auth login`). `gcloud container clusters list` → prod only.
- [ ] **Step 2: Spin scratch.** `powershell -ExecutionPolicy Bypass -File k8s/sysbox/create-scratch-cluster.ps1`; if the sysbox-pool fails on `SSD_TOTAL_GB` (lesson #36): `gcloud container node-pools delete sysbox-pool …` then recreate with `--disk-type pd-standard --disk-size 50`.
- [ ] **Step 3: Install Sysbox.** `kubectl apply -k k8s/sysbox/`; wait `sysbox-runtime=running`. Apply `%TEMP%/scratch-ns-pvc.yaml` (storageClassName `standard`); regenerate `%TEMP%/runtime.json` from the MERGED spec (`node %TEMP%/gen-runtime.js > %TEMP%/runtime.json`); `kubectl apply -f`; wait runtime pod Ready. **Verify `kubectl config current-context` = `…synthi-sysbox-scratch` before every apply.**
- [ ] **Step 4: Re-run the slice-1 gate on merged code.** Write `/workspace/docker-compose.yml` (python http.server :8080) into the pod; `bash -lc 'cd /workspace && docker compose up -d'`; confirm: 8080 LISTEN (`/proc/net/tcp` `1F90`), HTTP 200 via in-pod `localhost:8080`, **2376 NOT in the surfaced set**, `docker compose logs`, `docker ps`. Capture evidence.
- [ ] **Step 5: Tear down.** `gcloud container clusters delete synthi-sysbox-scratch --zone europe-west10-a --project vectant-proj --quiet --async`; poll `clusters list` → prod only.

## Task 8: Wrap
- [ ] **Step 1: Hardcoded-values audit.** `RUNTIME_INFRA_PORTS` env-driven (default `2376,18080` = universal infra ports — dockerd + preview sidecar — not env-specific/secret). No other new literals.
- [ ] **Step 2: Docs.** Append a Review section here (merge SHA, suite deltas, live result); update `tasks/lessons.md` if the merge surfaced anything; give the plain-words recap.
- [ ] **Step 3: Push (pre-approved).** `git push origin feat/docker-sysbox-engine`.

## Self-review (writing-plans)
- **Spec coverage:** §2 mechanism → T1+T5; §3 6-file conflicts → T2/T3/T4; §4 pre-merge cleanup → T1; §5 infra-port filter → T6; §6 verify (suites + live) → T5 + T7; §7 rollback → T1 + Conventions; §8 audit → T8. No gap.
- **Placeholders:** none — conflict tasks name the exact symbols each side must keep; the filter task carries real test + impl.
- **Type consistency:** `parseInfraPorts`/`infraPorts`/`RUNTIME_INFRA_PORTS`, `recomputeRuntimeScopePorts(scope, ports)`, `$PRE_MERGE_SHA` used consistently across tasks.

---

# Task: Programs panel — post-overhaul refinement round (2026-06-24, feat/docker-sysbox-engine)

Live-review feedback after the Library/Store overhaul. Corrective slices on the existing design (no new spec). TDD from `synthi/`; commit per slice.

## Done this round
- [x] R0 Panel background = `var(--bg-sidebar)` (#06060a — matches every docked panel; dropped the custom gray gradient + the clipped outer border/drop-shadow). Store search field re-tiered to `var(--bg-panel)` so it doesn't vanish into the now-darker base. `programTokens.test.js` updated to assert the token (not the old gradient). 53/53 programs tests green. Lesson recorded.

## Sensible defaults (proceeding unless told otherwise)
- Removing a session = HARD-DELETE the `ProgramSession` row; for a *running* session, stop the runtime first (after the confirm), then delete. (User: "removing and deleting the session".)
- Orphaned active session (DB state active, no live runtime) → present as **stopped**. Show **crashed** only when the DB state is explicitly `crashed` (or `lastHealthState` = unhealthy). We don't fabricate a crash we never recorded.

## Slices (TDD, commit per slice)
- [x] R1 State reconciliation + 3-way separation. `mergeProgramSession`: no live runtime + active state → `stopped` (kills zombie "all-running"). `buildProgramSessionSections` → `{running, stopped, crashed}`. `LibraryView` renders Running/Stopped/Crashed sections; only running cards use the glow shell + a live thumbnail (stopped = muted surface, crashed = red), which also removes most of the scroll-lag. TDD: routeHelpers +3, programSessionSections rewritten, libraryView +5; 166 programs+lib tests green.
- [x] R2 (folded into R1) Program name as card title, session id as subtitle. `programLabelFromPackageId` + `LibraryView.nameFor` join `installId → packageId` (fallback `session.title`/"Program").
- [x] R3 X-to-remove + confirm dialog. Backend: `DELETE /program-sessions/[sessionId]` (owner/admin; stop-if-running, then delete row; events cascade) + `store.deleteProgramSession` + `routeHelpers.isActiveSessionState` + `programsClient.deleteProgramSession` (commit `ed7eb0f08`; 4 route tests). Frontend: standalone `ConfirmDialog` mirroring the terminal paste-modal chrome (brand hairline, icon plate, title/subtitle, Cancel/Confirm footer) MINUS the `<pre>` preview box + trust checkbox (framer-motion dropped — vitest transform snag; animation is cosmetic). Every card gains an X (`session-remove-<id>`); `ProgramsPanel.handleRemove` → running session opens the confirm ("Stop & remove") then DELETEs; stopped/crashed delete immediately. TDD: ConfirmDialog +2, libraryView +2, programsPanelInstall +2; 64 programs-component tests green.
- [x] R4 Perf polish. `content-visibility:auto` + `contain-intrinsic-size` on session cards so the browser skips painting offscreen cards (cheap scrolling for long stopped/crashed lists). The bulk of the lag was already gone after R1 (only genuinely-running cards glow). Also fixed a latent gap: the live thumbnail never rendered in prod because `mergeProgramSession` dropped the runtime's `webGui` flag (DB rows don't store it) — now surfaced, so running KasmVNC cards show their snapshot. 173 programs+lib tests green.

## Round status — R0–R4 all landed (commits 31457a5e4, 6c1b71b06, ed7eb0f08, adf2512cd, + R4). Covers user points #1 (names), #2 (X-remove), #3 (running-remove confirm), #4 (perf), #5 (state separation). #6 (scale-to-zero) answered. Env note: C: drive at ~0.1 GB free — vitest workers OOM/crash; ran single-fork with TEMP redirected to D:\synthi-tmp. Surface to user.

## Follow-up asks (same round)
- [x] R5 One session per program: `handleLaunchInstall` reuses the live session instead of spawning a duplicate; the tile reads "Open" vs "Launch". Zombie-safe (uses reconciled session state). Commit `7c592f264`.
- [x] R6 Real program logos: `ProgramIcon` + generated `programLogos.js` (inline single-path brand SVGs from simple-icons/CC0 for the 9 built-ins — Next.js, Vite, Flask, Node, Git, DBeaver, Postman, Portainer, Docker — keyed by the @vectant slug) replace the empty icon plates in Installed + marketplace tiles; deterministic colored monogram fallback for community programs. Inlined → no external requests under COEP/CSP.

## Already answered (no code)
- Scale-to-zero: prod Sysbox runtime is a per-workspace Deployment (`replicas:1`), app-managed **idle-cull → on-demand respawn** (not k8s HPA-to-zero); optional warm image cache via `RUNTIME_PERSIST_DOCKER_DATA`.

---

# Task: Tool-UI redesign — color & consistency fixes (2026-07-08, `Codex/tool-UI-redesign-20260706`)

Fix 7 UI issues from the redesign while keeping consistency. Full context gathered via 4 recon subagents + direct verification. Decisions confirmed with user (2026-07-08). Color pipeline is centralized: `theme-engine.js` derives accent/glow/gradient CSS vars from theme-JSON tokens; `synthi-dark.json` = "Vectant Dark" = default theme.

## Confirmed decisions
1. Colors → **accent-only swap** (cyan→dev-purple for accents + blue-tinted borders; KEEP branch's darker neutrals).
2. Output empty state → **faint console scanlines/dots** (drop diagonal hatch + dashed border).
3. Tabs → **square tops + stronger active state**.
4+7. Panels → **uniform brand-radial surface + subtle per-group tint** (Workspace/Agents/Platform); Search+SCM get chat/ports gradient; Search/PR/Healing no longer lighter. Tints from `--brand-stop-*`/surface tokens, NO hardcoded hex (lesson #43), NO blue.
5. Navbar → remove top light highlight (scoped override).
6. Chat → all entry points open the RIGHT floating popup; kill left-dock overlap (lesson #12: keep popup state separate, unify controls).

## Plan (checkable)

### 1 — Blue→purple (accent-only)  [do FIRST; foundational]
Files: `synthi/src/themes/builtin/synthi-dark.json`, `synthi/src/app/globals.css`
- [ ] synthi-dark.json: replace_all `#5dd6e4`→`#b545ff` (all cyan accents incl. alpha suffixes)
- [ ] synthi-dark.json: swap non-#5dd6e4 accents/blue-borders → dev values: accentPrimary #6f7e8f→#6c6885 · accentSecondary #7dd3fc→#8a85a8 · accentTertiary #415d6a→#4d4870 · chart3 #8a85a8→#a23dff · borderFocus #375566→#3a3d55 · borderStrong #4b5d70→#45485f · editorLineNumber.activeForeground #8fb9c4→#b545ff · shadowGlow rgba(93,214,228,.16)→rgba(162,61,255,.18) · terminal.selection rgba(93,214,228,.28/.14)→rgba(138,124,217,.3/.15) · primaryForeground & sidebarPrimaryForeground #031014→#ffffff
- [ ] KEEP branch neutrals (bg*, text*, most editor/terminal bg, ANSI). Do NOT touch midnight.json.
- [ ] globals.css: replace_all `#5dd6e4`→`#b545ff` (10×); paired `--primary-foreground`/`--sidebar-primary-foreground` #031014→#ffffff; 2 cyan oklch fallbacks (`--attention-purple`, `--accent-secondary`)→purple.
- [ ] VERIFY: grep both files for `5dd6e4|7dd3fc|8fb9c4|375566|4b5d70|93, 214, 228|oklch(82% 0.118 215` → 0.

### 5 — Navbar top light gradient  [small, isolated]
File: `globals.css`
- [ ] Add scoped `.topnav-root.vt-workbench-chrome { box-shadow: inset 0 -1px 0 color-mix(in srgb, black 24%, transparent); }` (drop top white line, keep bottom). Do NOT edit shared `--vt-bezel`.

### 3 — Tabs: square + stronger active  [CSS]
Files: `globals.css` (`.vt-editor-tab` 1351-1372), `docking.css` (`.dock-tab` 201-252), `EditorTabStrip.jsx` (underline 424/441)
- [ ] `.vt-editor-tab` radius `7px 7px 0 0`→`0` (1353); `.dock-tab` `7px 7px 0 0 !important`→`0 !important` (204)
- [ ] Strengthen active tab: prominent brand underline + subtle fill; drop `.dock-tab:hover translateY(-1px)` lift; square underline ends if needed.

### 2 — Output empty state: console scanlines  [CSS]
Files: `globals.css` (`.vt-empty-state` 1155-1166), `scm-tokens.css` (sibling 168-176)
- [ ] Remove diagonal hatch + dashed border; add faint horizontal scanline/dotted texture (low-alpha, theme vars); keep centered icon + text. Apply same to SCM sibling (or dedupe to `.vt-empty-state`).

### 4+7 — Panel surfaces: uniform base + per-group tint  [cross-cutting; after item 1]
Files: `globals.css` (`.vt-panel-frame` 1223-1228, `.vt-app-surface` 1063-1069), `panel-wrappers.jsx`, `DockingActivityBar.jsx` (ACTIVITY_GROUPS 70-104), inner panels (`.vt-file-tree`, `.scm-panel`, `.vx-chat-shell`, `PortsPanel`, Search/PR/Healing roots), `HealingSettingsPanel.jsx`
- [ ] Make `.vt-panel-frame` the shared dark brand-radial surface (fixes light Search/PR/Healing + gives everyone the gradient)
- [ ] Add `data-panel-group="workspace|agents|platform"` per wrapper (map panel type→group)
- [ ] 3 subtle per-group tint modifiers `[data-panel-group=…]` (vary radial stop/position; purple/pink brand-stops only)
- [ ] Neutralize inner ad-hoc backgrounds so the wrapper surface shows uniformly
- [ ] Fix undefined `--bg-base` in HealingSettingsPanel (:121,:639)→defined surface var
- [ ] VERIFY: Search+SCM show gradient; no lighter panels; groups subtly distinct.

### 6 — Chat: navbar=right popup, activity-bar=right full panel  [logic]  (user-clarified)
Files: `use-activity-bar-docking.js` (221), `page.jsx` (`ensureDockedChatRight` 3223-3281), `DockingActivityBar.jsx`
- [ ] Navbar button: keep as-is (floating right popup, `docked=false`, `fixed top-12 right-4`) — verify it lands right.
- [ ] Activity-bar `chat`: dock chat as a FULL PANEL on the RIGHT rail (NOT the left sidebar group). Reuse existing `ensureDockedChatRight()` (opens chat → splits to `DROP_ZONE.RIGHT`, ratio 0.34, pins). Bridge activity-bar→page via a `synthi:dock-chat-right` event; keep `ensureDockedChatRight`'s internal low-level open separate to avoid recursion.
- [ ] VERIFY: navbar→right popup; activity-bar→right docked panel (right of editor), never left over Healing.

## Verification (overall)
- [ ] Lint touched files; run frontend; screenshot each fixed surface; diff vs dev where relevant.

## Review — COMPLETE (all 7 items, static-verified 2026-07-08)
Implemented in order 1 → 5 → 3 → 2 → 4/7 → 6. CSS validated with PostCSS (globals/docking/chat/scm all parse), synthi-dark.json valid JSON, JSX parses (only pre-existing unused-var/`await` lint nits remain — left untouched). No residual cyan accent; only intentional syntax/ANSI cyan kept (same as dev).

1. Colors (accent-only): synthi-dark.json accents cyan→dev purple (#b545ff family) incl. editor + terminal cursor, selection, minimap/scrollbar sliders, bracket/word-highlight; accentPrimary/Secondary/Tertiary + blue-tinted borderFocus/Strong → dev; primary/sidebar foregrounds #031014→#ffffff. Syntax `function`/`method`/`support.*` + ANSI `cyan` kept (identical on dev). globals.css: 10× #5dd6e4→#b545ff, 4× #031014→#ffffff, 2 cyan `oklch` fallbacks→purple. Branch neutrals kept per user. midnight.json untouched.
2. Output empty state: `.vt-empty-state` (globals.css) + copy-paste sibling `.scm-focal--empty` (scm-tokens.css) → faint horizontal scanlines + soft brand glow; removed diagonal hatch + dashed border (the drop-zone read).
3. Tabs: `.vt-editor-tab` + `.dock-tab` radius `7px 7px 0 0`→`0`; active fill 8%→14%; squared active underlines (`999px`→0, `rounded-t-full`→`rounded-none`); dropped `.dock-tab:hover` translateY lift for a flat feel.
4+7. Panels: `.vt-panel-frame`→one shared dark surface; 3 per-group tints via `[data-panel-type]` (Workspace purple top-left / Agents pink→purple / Platform lavender top-right) — brand tokens only, no blue. Neutralized inner opaque bgs so the wrapper shows: `.scm-panel`→transparent (+ removed `vt-app-surface` from SCM root), docked `.vx-chat-shell`→transparent (floating keeps its gradient), Ports root removed `vt-app-surface`, PR inner root removed `vt-panel-frame`. Explorer needs no edit (its `.vt-file-tree` is on the wrapper element, so the higher-specificity group tint wins). Fixed undefined `--bg-base` in HealingSettingsPanel → `--bg-elevated`/`--bg-surface`.
5. Navbar: scoped `.topnav-root.vt-workbench-chrome` drops the top bezel highlight + the background's white top-lift; bottom edge kept; shared `--vt-bezel` untouched.
6. Chat: navbar button unchanged (floating right popup). Activity-bar chat now dispatches `synthi:dock-chat-right` → page.jsx `useEffect` listener → `ensureDockedChatRight()` (full panel on the right rail, pinned). Added low-level `openChatPanel` so `ensureDockedChatRight`'s internal open doesn't recurse on the new `chat` handler.

Files changed (12): themes/builtin/synthi-dark.json, app/globals.css, docking-wm/styles/docking.css, chat/chat.css, git/scm/scm-tokens.css, EditorTabStrip.jsx, git/scm/SourceControlPanel.jsx, git/PullRequestsPanel.jsx, ports/PortsPanel.jsx, healing/HealingSettingsPanel.jsx, docking-wm/hooks/use-activity-bar-docking.js, workspace/[slug]/page.jsx.

Self-caught during verify: the line-range sed for Item 1 skipped `terminal.cursor` (outside the ui/editor range) — fixed to purple. Remaining: live visual pass in a running workspace (needs backend stack); all static checks green.

---

# Bring beta.vectant.dev up to date with dev (2026-07-28)

## Context

`main` is the only branch that deploys to beta.vectant.dev (`.github/workflows/deploy-prod.yml`
→ Cloud Build → GKE `synthi-beta-cluster`, europe-west10-a, project `vectant-proj`).
`main` and `dev` diverged at merge base 2026-07-07:

- `main` +476 commits `dev` lacks: the `local-support` desktop app (PR #653) and
  Jupyter/notebook support (PR #665, 41 commits).
- `dev` +115 commits `main` lacks: the CodeSite panel + tool UI redesign, including the
  visual redesign merged via PR #666.

Deploying `dev` directly would strip local-support and Jupyter off production, so the
CodeSite work has to be merged onto `main`, not swapped in.

Chosen path: merge `main` into `dev`, verify the combined app, then merge to `main` and
let the pipeline deploy.

## Plan

- [x] 1. Switch to `dev`, fast-forward to `origin/dev` → HEAD == c38e7a0f3, clean
- [x] 2. Merge `origin/main` into `dev` → stopped on exactly the 4 predicted conflicts
- [x] 3. Resolve `docker-compose.yml` → `docker compose config` exits 0
- [x] 4. Resolve `synthi/src/lib/codesite/routeHelpers.js` → internalAuth test passes
- [x] 5. Resolve `synthi/src/components/dojo/DojoShell.jsx` → main's DojoShell.test.jsx asserts 'Tomography' and passes
- [x] 6. Resolve `DockingActivityBar.jsx` → docking-wm suite passes; Local Support kept
- [x] 7. CodeSite release gate → exit 0
- [x] 8. Test suites → 1213 passed / 19 failed; all 19 proven pre-existing on dev
- [x] 9. Production build → compiled in 103s; local-support, Jupyter and CodeSite routes all present
- [x] 10a. Pushed `dev` → origin (`c38e7a0f3..462a036c4`, then `0921c42cf`)
- [x] 10b. Fast-forwarded `main` → `0921c42cf` (`3e814d983..0921c42cf`, 118 commits, no history rewritten).
      Done by direct push, not a PR: the org flag hides the PR list, so the user could neither
      see nor merge the existing dev→main PR. Push triggers `deploy-prod.yml`.
- [x] 11. Inspected the live cluster. Every synthi service runs image tag
      `prod-202606211530-588967bd85d3`, built **2026-06-21**. Production was therefore
      already missing local-support (merged Jul 18) and Jupyter (merged Jul 28) before this
      work started — the merge was necessary but never the real blocker. `worker` sits at
      0 replicas.

## The deploy pipeline was broken in four independent ways

All four pre-date this session's merge. None was caused by it. The common thread: GitHub
Actions stopped submitting builds after 2026-06-21, so nothing that landed afterwards was
ever exercised.

1. **GitHub Actions is not firing.** No Cloud Build submitted since 2026-06-21 — not even a
   failed one, so `gcloud builds submit` is never reached. Almost certainly the flagged-org
   state disabling Actions. NOT fixable from this repo; needs GitHub support.
2. **`codesite-mature-proof-suite`** (added 2026-07-05) required playwright at module scope,
   so `--no-screenshot` could not help — the module failed to load before any flag was read.
   FIXED: require moved inside `screenshotHtml`, matching `codesite-release-gate.mjs`.
3. **`codesite-release-gate`** (added 2026-07-03) validates proof provenance via git, but a
   Cloud Build upload is a tarball with no `.git`, so it hard-fails on `unable to validate
   proof git provenance`. Not fixable by installing anything — the gate itself says
   provenance "must be validated by the host release gate". FIXED by removing the
   unworkable in-container copies; `deploy-prod.yml` already runs the authoritative gate on
   the runner.
4. **The Rust worker does not compile.** `69879eee4` (2026-07-04, "Disable legacy VS Code
   websocket tunnel") dropped `AsyncReadExt` from the `tokio::io` import while leaving a
   `read_exact` call at `main.rs:3913`. Broken on `main` and `dev` alike since Jul 4.
   FIXED: import restored.

Also fixed: `.gcloudignore` now excludes `.claude/`, whose untracked worktrees carry mutable
`:latest` refs that trip the `reject-mutable-images` guard on any local submit.

## Deploy log

- Build 1 `9a366f71` — CANCELLED. Would have failed the mutable-image guard on `.claude/`.
- Build 2 `4c3229ed` — FAILURE at `codesite-mature-proof-suite` (playwright).
- Build 3 `41bc0262` — FAILURE at `build-worker` (the Rust error above). 11 of 12 image
  builds succeeded, including the frontend.
- Build 4 `d53d7cd2` — FAILURE at `deploy-to-gke`. All 12 images built, Trivy passed, worker
  fix confirmed good. Died on `timed out waiting for the condition on
  externalsecrets/synthi-dojo-release-secrets` — breakage #5 below.
- Build 5 `f7786cdc` — **SUCCESS**, tag `prod-0a28dca27-20260728`.

5. **The dojo-release-gate overlay referenced 16 unprovisioned secrets.** All
   `synthi-therapeutic-prod-*`, wired in 2026-07-01 (`a6eefa6aa`), never created in
   `vectant-proj`. External Secrets could not sync `synthi-dojo-release-secrets`
   (`SecretSyncedError`), and since the deploy waits on that ExternalSecret as a
   prerequisite, one unprovisioned feature blocked every unrelated service. FIXED: entries
   removed, `SYNTHI_THERAPEUTIC_PROD_ENDPOINTS_ENABLED` set to "0" (it was already
   flag-gated and could not have been live).

## Outcome — production is current

`main` and `dev` are both at `0a28dca27`. Deployed and verified 2026-07-28:

- ai-engine 2/2, ai-gateway 2/2, collab-server 1/1, dojo-mcp-host 1/1, frontend 2/2,
  signaling-server 1/1 — all on `prod-0a28dca27-20260728`, all Running with 0 restarts.
- `prisma-migrate` and `dojo-postgres-migrate` jobs both Completed.
- Both ExternalSecrets `SecretSynced/True` — the one that blocked builds 4 and 5 now syncs.
- beta.vectant.dev returns 302 to IAP, i.e. serving.

Production moved from the 2026-06-21 image to current `main`, gaining local-support (#653),
Jupyter (#665) and the CodeSite redesign (#666) — the first two had been merged but
undeployed for weeks.

### Still open

- **GitHub Actions is not firing** (breakage #1) — the root cause that let the other four
  reach `main` unnoticed. Not fixable from this repo; needs GitHub support to clear the org
  flag. Until then every deploy must be submitted by hand.
- **`worker` runs 0 replicas.** Pre-existing — it was 0 before this session too, and the
  image now updates correctly. Worth confirming whether that is intentional.
- **The 16 therapeutic secrets** remain unprovisioned; the feature is off.
- **355 Dependabot vulnerabilities** on the default branch (17 critical).

## Conflict resolutions (what was decided and why)

1. **docker-compose.yml** — kept dev's `SYNTHI_CODESITE_TOKEN` (working default) *and* main's
   two `JUPYTER_ALLOW_*` vars. Trap avoided: the merge base had no frontend token, dev added one
   near the top with a real default and main added one lower with an *empty* default. Keeping both
   sides verbatim would have left a duplicate YAML key where the empty one wins, silently
   re-breaking dev's git-write 503 fix. Collapsed to a single declaration; collab-server matched.
2. **routeHelpers.js** — both branches independently implemented internal-service auth. Took dev's
   (`internalServiceActor`): it is test-covered, hash-compares so it cannot leak secret length,
   accepts main's `Bearer` form plus `x-synthi-internal-token`, and its call site was already
   present in the unconflicted region — main's version would have left it undefined at runtime.
   Removed the now-orphaned `import { timingSafeEqual } from 'node:crypto'` that main's version used.
   Result is byte-identical to dev's file.
3. **DojoShell.jsx** — kept dev's rich `useMemo` nav (the JSX destructures
   `{ label, href, icon: Icon, detail }`, so main's tuple shape would break rendering) and folded
   main's new **Tomography** entry into it (`ScanLine` icon, 'Authority trace'), preserving main's
   position after Practice. Without this the shipped `therapeutic-trace/` route is unreachable.
4. **DockingActivityBar.jsx** — kept dev's three-group `ACTIVITY_GROUPS` and added main's
   **Local Support** item to the Platform group. `renderButton` merged both signatures: dev's
   `groupLabel` plus main's `externalPath` and its `Boolean(panelType) &&` guard (required — Local
   Support has `panelType: null` and would otherwise render spuriously active). Kept dev's
   `aria-current`/`data-active` and main's `data-testid`.

## Blockers

- `gcloud auth` expired → live cluster inspection needs a user-side `gcloud auth login`.
- `git fetch`/`push` to origin time out from this sandbox → user runs the pushes.

## Review

Merge commit `ed1328ec6` on `dev`. 239 files staged from main; 4 conflicts, all resolved
to preserve both branches' features rather than picking a side.

Verification:
- `docker compose config` exit 0; exactly 2 matching token declarations.
- CodeSite release gate (the gate `deploy-prod.yml` runs) exit 0.
- `next build` compiled in 103s, standalone assets prepared. Route manifest carries all
  three feature sets: 8 `/api/jupyter/*` routes, the `/api/local-support/*` surface, plus
  `/workspace/[slug]/codesite` and `/dojo/therapeutic-trace`.
- Tests: 1213 passed, 19 failed across 6 files. All 19 proven pre-existing on `dev` — each
  failing test file *and its subject modules* are byte-identical between this tree and
  `origin/dev`, and none of the 100 merge-changed `synthi/src` files overlap them.
  (Failing files: proofVerifierCli, AgentWorkflowPanel, programsPanelInstall,
  programsPanelTerminalRouting, preview-store, terminal-preview-links.)

Two environment notes, not code problems:
- `vitest run` at full parallelism crashes workers on this machine (107 "failed" files,
  fork exhaustion). `--maxWorkers=2` gives the real result.
- The first `next build` segfaulted (exit 139) under memory pressure with ~4 GB free.
  Re-running with `NODE_OPTIONS=--max-old-space-size=6144` succeeded.

Because main was merged *into* dev, main is now an ancestor of dev, so `dev` -> `main` is a
pure fast-forward — no second conflict resolution is possible.

Not done (blocked, user-side): pushing `dev`, fast-forwarding `main`, and verifying the GKE
rollout. `gcloud auth login` is still required before any cluster inspection.

## Collab guests get real workspace file access (2026-08-25)

Branch `fix/collab-guest-workspace-access` off `main` (fast-forwarded to `origin/main` first —
local `main` was 369 commits stale).

**Bug report:** hard to get a collaborator "inside" a workspace on hosted beta; host's
permission toggles in the Share modal seem to do nothing; a guest can't see workspace files
even after being granted permission; invite-link sharing doesn't work — only room-code entry
or the direct email invite actually gets someone in.

**Root cause (traced, not inferred):** two authorization layers that never talked to each
other. `SessionManager.js` (collab-server) correctly tracks room codes, knock/admit, and the
four guest permission toggles (`canEdit`/`canFileOps`/`canTerminal`/`canGit`) — all fine, WS
broadcast and permission-merge logic verified correct. But every route that actually serves
file content — `workspaceAccess.js`'s `requireWorkspaceAccess()` (gates the file-tree endpoint
and `item/route.js`'s GET/POST/PUT/DELETE) and `routeHelpers.js`'s `requireCodesiteAccess()` →
`scope.js`'s `canReadScope`/`canWriteScope` — checks **only** Prisma `WorkspaceMembership`,
with zero knowledge a collab session exists. A guest admitted via room code or invite link
never gets a membership row, so those routes 404 "Workspace not found" regardless of what the
host granted — hence the toggles feeling broken (nothing downstream ever reads them) and files
never loading. The only path that fully works is the direct email invite, because
`WorkspaceUsersPanel.handleInviteUser` explicitly creates a real membership via
`POST /api/workspace/[slug]/members` before sending the collab invite; every other join path
skips that step. Did not find a code bug in the invite-link chain itself (`makeInviteLink` →
`/[slug]?collab=&token=` → `/collab/[sessionId]` → `validateToken` → knock) — best read is that
symptom collapses into the same root cause once a guest is admitted but still walled off.

**Fix:** give collab guests real, permission-scoped access without a persisted membership row —
checked live against collab-server session state on every request (auto-revoked the instant a
guest is kicked / session ends).
- collab-server: new internal-only `GET /session/workspace-access/:userId?slug=` (`server.js`),
  gated by the existing `hasTrustedInternalToken`/`COLLAB_INTERNAL_TOKEN` mechanism (already
  provisioned to the frontend deployment — no new secret). Thin wrapper around
  `SessionManager.getSessionsForSlug()`.
- `synthi/src/lib/collabGuestAccess.js` (new): server-side helper the frontend calls to hit
  that endpoint.
- `workspaceAccess.js`'s `requireWorkspaceAccess()` and `scope.js`'s
  `canReadScope`/`canWriteScope`: fall back to it only when Prisma membership is absent — real
  members are completely unaffected (verified via existing test suites, zero regressions).
- `item/route.js`: threads the specific permission per verb for a `collab-guest` role (base
  read for GET; `canEdit` for content writes; `canFileOps` for create/rename/delete) — matches
  the ShareModal's own `PERM_CONFIG` semantics exactly.
- Left the terminal-exec gateway and `collab:git:*` action scopes alone — already correctly
  wired to `SessionManager.checkPermission` on the collab-server's own direct endpoints.

Verification:
- New `backend/collab-server/__tests__/sessionWorkspaceAccess.test.js` (7 tests, `node --test`):
  host/guest recognition, live permission-update reflection, stranger denied, kick revokes
  access immediately, terminated session revokes both host and guest, cross-slug isolation.
  Added to `.github/workflows/codesite-tests.yml`'s collab-server job.
- Extended `workspaceAccess.test.js` (+5), `scope.test.js` (+5), `item/route.test.js` (+7) for
  the new fallback/gating paths.
- Ran the full touched-and-downstream batch: 94 vitest tests across 6 files pass, plus the
  collab-server `node --test` CI batch (127/133 pass — the 6 failures are pre-existing,
  Windows-only symlink/procfs tests in `codesiteFs.test.js`, untouched by this change, that the
  CI comment itself notes only genuinely execute on the `ubuntu-latest` runner).

**Not verified:** no live cluster access this session (`gcloud auth login` needs interactive
reauth), so the actual hosted `beta.vectant.dev` guest flow wasn't exercised end-to-end. Needs
a real deploy + a two-account manual pass (host shares via room code with an account that has
no prior workspace membership; confirm files load; confirm toggling `canEdit` live-gates
saving) before calling this fully closed.
