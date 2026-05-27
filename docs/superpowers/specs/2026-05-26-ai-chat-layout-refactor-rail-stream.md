# AI Chat Layout Refactor — "Rail + Stream"

Date: 2026-05-26
Surface: `synthi/src/components/chat/` — floating window, docked panel, mobile (ONE structure, scaled by width)
Builds on: the Living-Orb redesign (orb, editorial messages, reasoning card, diagnostics drawer).

## Goal

Today the floating / docked / mobile chats are the *same* top-stacked single column placed in different spots. Replace that with one bold, distinctive structure — a **collapsible rail beside a conversation stream**, with a **hero composer that docks** and a **single living orb** that travels with the conversation. Unique, professional, and still unmistakably Vectant.

## Locked decisions

### Structure — Rail + Stream
- A slim **rail** holds the session/chrome; the **stream** (conversation) stays clean; the **composer** is hero-on-empty then docked.

### Rail
- **Always starts collapsed. Never open by default** (not persisted-open; every load = collapsed).
- **Wide:** a thin collapsed handle (with the orb). **Click to expand + pin**; stays open until clicked closed. When open it always shows a **collapse control**.
- **Narrow:** no rail — it folds into a slim top bar: orb + **session dropdown** + Context icon + New-chat.
- **Contents (expanded):** orb + "Vectant AI", "＋ New chat", **Sessions** list (active = gradient dot), and a footer with **Context** (the diagnostics/context entry) + **Settings**.
- Breakpoint: container width ≥ ~440px → rail available (collapsed handle); below → narrow/top-bar mode. Detected via ResizeObserver on the chat container (works for docked panel resizing, not just viewport).

### Composer
- **Empty chat:** centered **hero** composer with the large orb above it + suggestion chips.
- **First send:** composer **glides smoothly** (transform translate, eased) from center to the **docked bottom bar**; stays docked thereafter.
- Keeps the gradient focus ring + all current wiring (Agent/model/attach/send).

### The living orb (single WebGL instance)
- Exactly **one** live WebGL orb (avoids the ~16-context limit). It is Vectant's current-answer presence.
- **Empty:** large centered hero orb.
- **First send:** shared-element (FLIP) transition — shrinks + glides to the **first assistant answer's mark slot** (next to "VECTANT"), keeping its WebGL render throughout.
- **Each new assistant turn:** the orb **re-anchors/resets** to the newest answer's mark (reset → thinking → answering → idle). Earlier answers keep a **static CSS** gradient mark.
- States preserved: idle / thinking / answering / error / applied.

### Motion
- transform / opacity only; ease-out curves; exit faster than enter.
- `prefers-reduced-motion`: no glide — composer snaps to docked, orb appears at target (no travel), orb still renders but without the morph loop.
- Clean, never twitchy.

## Architecture

- **`ChatShell`** (new layout wrapper) arranges rail + stream + composer; owns rail collapsed/expanded state (default collapsed) and the width mode (wide/narrow via ResizeObserver).
- **`ChatRail`** (new) — collapsed handle + expanded panel (sessions, context, settings); on narrow renders nothing (the top bar + dropdown take over).
- **`ChatSessionDropdown`** (new, narrow) — session switcher in the top bar.
- **Composer** gains a `placement` prop (`hero` | `docked`) and animates between them (FLIP/transform).
- **Single orb** hoisted to `ChatShell`; a small FLIP helper animates it between the hero anchor and the latest assistant message's mark anchor. Assistant messages render a mark **placeholder**; the live orb overlays the latest, others show static marks.
- Reuse as-is: `ReasoningCard`, editorial message rendering, `DiagnosticsDrawer` (moves into the rail's Context entry), `VectantOrb`.

## Surfaces
- **Floating window** — wide; rail collapsed handle, expands on click.
- **Docked panel** — wide or narrow depending on its dragged width (ResizeObserver).
- **Mobile** — narrow; top bar + session dropdown; rail content available via a slide-over if needed.

## Non-goals
- No change to agent/suggestion/session backend logic, attachments, or the message components' internals (only their placement + the orb anchoring).

## Risks
- `AIChatWindow.jsx` is large; this restructures its top-level layout — build incrementally (rail → composer placement → orb FLIP), rebuild + verify each.
- Orb FLIP across containers + scroll: keep the live orb **inside** the latest message's mark slot so it scrolls naturally; only the first hero→answer move is a cross-container FLIP.
