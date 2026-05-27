# AI Chat Redesign — "The Living Orb"

Date: 2026-05-25
Surface: `synthi/src/components/chat/` (floating window, docked-right panel, mobile/narrow — one component system, three contexts)
Direction: **A — The Living Orb** (selected from 3 explored directions)

## Goal

Refactor and redesign the Vectant AI chat into something unique, original, and unmistakably Vectant, with clean and satisfying motion that is pleasant rather than distracting. Visual + information-architecture restructure (not a from-scratch logic rebuild): preserve every existing capability while replacing the look, layout, and motion.

## Identity: the orb

A single animated gradient orb is Vectant's "face" in the chat, echoing the status-island V's state language. It is the one piece of persistent personality.

State machine (driven by signals that already exist in `AIChatWindow.jsx`):

| State | Trigger | Motion |
|-------|---------|--------|
| `idle` | default | Slow breathe (scale 1 → 1.025, ~5.5s) + slow gradient drift (~12s) + soft glow breathing in sync. Restful. |
| `thinking` | `isThinking` / `showThinking` | Faster gradient drift (~4s) + one thin highlight ring orbiting (conic, ~2.4s). Reads as "working". |
| `answering` | `streamingMessage` non-empty | Orb steady; a soft ring pulses outward (~1.7s) in time with tokens. |
| `error` | `progressStatus === 'Failed'` (or request error) | One-shot tint toward red (#ff5757), settles to a calm red-edged rest. |
| `applied` | suggestion applied | One-shot brand-gradient bloom, then back to idle. |

Motion rules:
- Animate only `transform`, `opacity`, `background-position`, `box-shadow`. Never layout properties.
- Ease-out curves; no bounce/elastic.
- `prefers-reduced-motion: reduce` → static gradient, state shown by color/ring only, no looping motion.
- Orb animation pauses (`animation-play-state: paused`) when the chat is off-screen (`isVisible === false`) to avoid wasted compositing.

## Information architecture (top → bottom)

1. **Header** — small orb (state-driven) + "Vectant AI" wordmark + a single discreet status affordance (the live dot) that opens the diagnostics drawer. Dock/close actions on the right. Removes the three stacked panels currently crowding the top.
2. **Diagnostics drawer** (`DiagnosticsDrawer.jsx`, default closed) — consolidates the existing **Code Intel metrics**, **Shadow verify spend** (`ShadowCostPanel`), and **Regression findings** (`RegressionFindingsCard`) behind one expandable surface. Fixes the failing "Metrics fetch failed (500)" leaking into the empty state. Error/empty states are quiet, not alarming.
3. **Sessions** — kept, restyled as quiet tabs.
4. **Empty state** (`ChatEmptyState.jsx`) — large idle orb + "What can **Vectant** help with?" + suggestion chips (Explain this file / Find bugs / Add tests / Refactor) that prefill the composer.
5. **Message list** — AI messages get a small orb avatar + editorial typesetting (role rhythm, premium inline code), not heavy bubbles; user messages are quiet, right-aligned. Streaming uses a gradient caret. Existing cards (command approval, multiverse, diff/apply, regression) keep working.
6. **Composer** — rounded shell with a brand-gradient ring on focus (matching the SCM composer language), Agent/Ask toggle, model selector, attach, gradient send. All existing wiring preserved.

## Component plan (`synthi/src/components/chat/`)

New, focused, presentational:
- `VectantOrb.jsx` — props `state`, `size`, `paused`. The only animated identity element.
- `DiagnosticsDrawer.jsx` — wraps existing Code Intel metrics + `ShadowCostPanel` + `RegressionFindingsCard`.
- `ChatEmptyState.jsx` — orb + prompt + suggestion chips.
- `chat.css` — chat-scoped classes + keyframes + reduced-motion (imported once by `AIChatWindow.jsx`, mirroring the `scm-tokens.css` pattern).

`AIChatWindow.jsx` is recomposed to use these and to derive `orbState`; agent/suggestion/attachment/session hooks are untouched.

## Surfaces

Floating, docked, and mobile share the same components. Responsive rules: orb scales down on narrow widths; header collapses labels; composer stays reachable; diagnostics drawer becomes full-width.

## Non-goals

- No change to agent pipeline, suggestion engine, attachments, sessions, or backend contracts.
- Not a full monolith rewrite; extract presentational pieces only where it serves the redesign.

## Performance / accessibility

- GPU-only properties; orb is a single compositor layer; pauses off-screen.
- Must not regress Monaco's critical path (chat is lazy-loaded already).
- Honors reduced-motion; status conveyed by color + label, not motion alone; interactive controls keep focus rings.
