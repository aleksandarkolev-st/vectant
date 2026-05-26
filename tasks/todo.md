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
