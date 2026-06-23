# Programs Panel UI/UX Overhaul — design

**Date:** 2026-06-23
**Branch:** `feat/docker-sysbox-engine`
**Status:** approved design, ready for implementation plan

## Problem

The Programs panel (`synthi/src/components/programs/ProgramsPanel.jsx`) is the flattest and most overloaded surface in the IDE:

- It renders as one dense scrolling column doing **three jobs at equal weight** — launch/author, marketplace/discover, and session management — as a stack of identical `bg-surface` + `border-subtle` cards with no hierarchy.
- It uses **none** of the vectant depth language (gradient shells, depth shadows, rim-glows, brand-tinted borders) that the chat / git / file-versions panels use, so it reads as unfinished next to them.
- Its framing is stale ("Phase 1 runs ad hoc commands only. Marketplace and installs stay out of this panel," sitting directly above the marketplace and installs).

## Goals

1. A full **layout + visual overhaul** that feels native to the vectant design language.
2. Cleanly **separate the two jobs** — a **Library** (programs you own + what's running) and a **Store** (discover + install) — both living **inside the narrow sidebar panel**.
3. Design the Store/Library around the model that **community-published apps are first-class hosted runnable programs** (used like DBeaver/Docker), not source/code drops. (The hosting platform itself is a separate workstream — see Out of scope.)
4. Keep every current capability reachable, re-homed sensibly.

Non-goals: the Ports panel and the Connected Tools panel are out of scope and untouched.

## The vectant design language (extracted from `globals.css` + the polished panels)

The overhaul must match this. It is not documented elsewhere (no `DESIGN.md`); it lives in `synthi/src/app/globals.css` and in the file-versions / chat / git panels.

**Background tiers (depth by stacking near-blacks, all tinted toward brand, never `#000`):**
`--bg-app #06060a` · `--bg-editor #0a0b11` · `--bg-panel #0d0e15` · `--bg-surface #131420` · `--bg-elevated #1a1c2a`.

**Text tiers:** `--text-primary #f4f5f8` › `--text-secondary #9ba2b8` › `--text-muted #5a6178` › `--text-dim #3d4256`.

**Borders (escalating):** `--border-subtle #1a1c2a` · `--border-medium #2b2d3e` · `--border-focus #3a3d55` · `--border-strong #45485f`. Polished panels **tint borders toward brand** (e.g. `color-mix(border-medium 84%, accent-primary 16%)`).

**Signature gradient (used sparingly, primary moments only):** `--brand-gradient-horizontal` = `#ff3d8a → #ff3737 (40%) → #a23dff (71%) → #3d6dff`.

**Accents:** `--accent-primary #6c6885` (desaturated, everyday), `--attention-purple #b545ff` (emphasis) with rim-glow. Semantic: success `#4ade80`, danger `#ff5757`, warning `#fbbf24`.

**Depth / effects:** gradient panel shells (`linear-gradient(180deg, bg-elevated → bg-panel)`), depth shadows with an inset white hairline (`0 18px 44px rgba(0,0,0,.42), 0 0 0 1px rgba(255,255,255,.025)`), rim-glow on active/attention (`0 0 0 1px rgba(181,69,255,.16), 0 0 18px rgba(181,69,255,.08)`).

**Radius:** `--radius 0.625rem` (10px); `-lg` = 10px, `-xl` = 14px. **Fonts:** Geist sans/mono. **Header idiom:** muted, UPPERCASE, `tracking-wider`, ~10–11px, icon + label, optional count chip.

## Chosen direction: Library-first sidebar + in-sidebar Store view

The panel is **one IDE sidebar panel** with **two internal views**:

- **Library** (default) — the programs you own + what's running. Behaves like a focused launcher/dock.
- **Store** (pushed when the `Store` affordance is tapped; a back arrow returns) — discover/install, rendered **inside the same narrow sidebar**, not as a main-area surface.

Navigation is client-side push/back within the panel; it is **not** a new docked panel and never opens above the editor.

## Components & layout

### Panel shell (both views)

Vectant shell: `linear-gradient(180deg, #0e0f17, #0b0c12)` background, `1px solid var(--border-subtle)` (brand-tinted) border, depth shadow, 12px radius. Header row: muted uppercase title + icon, ~36px tall, `border-bottom: 1px solid var(--border-subtle)`.

### Library view (default)

- **Header:** `[command icon] Programs` … `[Store ↗]` (pushes the Store view) · `[refresh]`.
- **Detected banner (contextual):** appears **only** when a runnable project is detected in the repo — "Detected in this repo · Run". Not a permanent row.
- **Running** section (`muted uppercase header + count`): each running program is a **rich card** — gradient shell, **attention-purple rim-glow**, a **success glow status dot**, the program icon + name, a status pill, ports, and Open / Stop (Restart when applicable). For `webGui` programs the card shows a **live snapshot thumbnail** of the running desktop (sourced from the existing `/wsport` KasmVNC stream — a direct payoff of the stream auto-login work).
- **Installed** section (`header + count`): a **2-column tile grid** of idle programs — tinted per-program icon plate, name, idle meta; tap a tile to launch. A dashed/gradient **"Browse store"** tile also opens the Store view.
- **Removed:** the ad-hoc "Run a command" (`npm run dev`) launcher. Running/building the user's own project is covered by the integrated terminal and the Detected banner; it is not a "program" and does not belong in the Library.
- **Recent:** folds into the idle tiles (a stopped program is just an idle launcher) plus per-program history; there is no separate "Recent" section competing for space.

### Store view (inside the sidebar; pushed from Library)

Vertical order, **Store logo pinned above everything**:

1. **Store logo / header** — `[← back to Library] [store icon] Store`. Pinned (stays visible).
2. **Search bar** — full-width, `bg-app` field.
3. **Actions row** — `[Install from manifest]` and `[Publish]` (secondary, brand-restrained).
4. **Filter strip** — category chips (`All`, `Databases`, `API tools`, `Dev servers`, `Desktop GUIs`, `Community`). **Horizontally scrollable** with a short **fade-out on both ends**; **mouse wheel up/down scrolls the strip left/right**. Reuse the existing navbar/editor tab-strip horizontal-scroll-with-fade pattern (do not reinvent). The strip is **sticky** — it stays while the tiles scroll.
5. **Tile grid** — **2 tiles per row**. Each tile: tinted icon plate, name, **Verified badge** (brand-gradient — official Vectant only), installs / `community` meta, and Install. The grid mixes **verified (official)** and **community** apps.

Tapping a tile opens the **detail view**.

### Program detail + consent

Reuse the existing `ConsentPrompt`. The detail view shows: full description, **requested permission scopes (prominent — community apps are untrusted)**, version, a preview/screenshot, install count, and publisher (verified vs community). Install → records consent → installs → the program appears in the **Library** as an idle, launchable tile (running it launches a **hosted** program; GUI apps stream like DBeaver).

## Hosted-app model (design assumption; platform is a separate workstream)

The UI is designed around this model and must communicate it:

- **Publishing an app produces a hosted, runnable program** — not a code/recipe drop. **Installing it runs that hosted app** (containerized, streamed for GUIs) exactly as the user runs DBeaver / Postman / Portainer. Community apps are the same tier as official ones.
- The Store and detail views must read as "install + run a hosted app," never "download the code."

The actual `publish → build → image/host → run` pipeline, and the **sandboxing / permission-enforcement / review** required to run untrusted community apps in other users' workspaces, are **out of scope for this spec** and get their own brainstorm + spec next. The Sysbox/hybrid runtime and the existing permission-scope/consent system are the foundation that work will build on.

## Information architecture — where today's surface goes

| Today (one dense scroll) | Overhaul |
|---|---|
| Ad-hoc "Launch Command" box | **Removed** (terminal + Detected banner cover it) |
| "Install from manifest" | Store view → actions row |
| "Publish" | Store view → actions row |
| "Detected in this repo" | Library → contextual banner (only when detected) |
| Marketplace (search + list) | Store view (search + filters + 2-up tiles) |
| Installed | Library → idle tile grid |
| Running | Library → rich running cards (with live thumbnail for webGui) |
| Recent | Library → idle tiles + per-program history |
| Consent prompt | Reused in the detail/install flow |

## Visual specification

- **Panel shell:** `linear-gradient(180deg,#0e0f17,#0b0c12)`, 1px brand-tinted border, depth shadow, 12px radius.
- **Section headers:** `var(--text-muted)`, uppercase, `letter-spacing ~.08em`, ~10–11px, + a count chip (`var(--text-dim)` on `var(--bg-elevated)`).
- **Running card:** gradient shell `linear-gradient(180deg,#1b1d2b,#14151f)`, `1px var(--border-medium)`, rim-glow `0 0 0 1px rgba(181,69,255,.16), 0 0 18px rgba(181,69,255,.08)`, 11px radius, ~9px padding; status dot `#4ade80` with `0 0 7px` glow; live thumbnail ~54px tall, 7px radius.
- **Idle tile / store tile:** `var(--bg-surface)`, `1px var(--border-subtle)`, 10px radius; icon plate ~30–32px, 8–9px radius, `var(--bg-elevated)` bg, per-program tinted glyph.
- **Filter chips:** inactive = ghost (`text-secondary`, `border-subtle`); active = brand-tinted (`linear-gradient(90deg, rgba(162,61,255,.22), rgba(61,109,255,.22))`, `text` `#e8e6ff`).
- **Brand gradient is reserved** for the Verified badge and the single primary CTA per context (Launch, Browse store). Everyday actions use restrained ghost/tinted buttons. No more than one gradient element competing per card.
- **Spacing rhythm:** body padding ~11px, inter-item gap 8–11px, card padding 9–12px — varied, not the uniform card padding of today.

## Behavior

- **Navigation:** Library ↔ Store within the panel (push/back); view state preserved on return.
- **Pinning:** the Store logo stays above everything; the filter strip is sticky; only the tile grid scrolls vertically.
- **Filter strip:** horizontal scroll, edge fades, wheel-vertical → horizontal — reuse the existing tab-strip component/behavior.
- **Live thumbnail:** for `webGui` running programs, render a snapshot/preview from the `/wsport` proxy. Snapshot-vs-live-iframe is an implementation choice (decide in the plan); respect `prefers-reduced-motion`.
- **Roles:** preserve the current `canManage` gating — members get a read-only view (no launch/install/publish).

## Files likely touched

- `synthi/src/components/programs/ProgramsPanel.jsx` — major rework; split into focused sub-components (e.g. `LibraryView`, `StoreView`, `RunningCard`, `ProgramTile`, `StoreTile`, `FilterStrip`, `ProgramDetail`). Today's file is a single ~840-line component doing everything; splitting is part of the work.
- `synthi/src/components/programs/programsClient.js` — no API-shape change required for the UI overhaul (community-hosted install is platform-side, later).
- Reuse the existing horizontal tab-strip scroll/fade component (`EditorTabStrip` or the navbar strip) for the Store filter strip — extract/share it rather than duplicating.
- Docking panel registry (`ide-panels.js` / `panel-wrappers.jsx`) — the panel stays one IDE panel; the Store is an **internal view**, not a new docked panel.
- Possibly a small live-thumbnail component for `webGui` running cards.

## Testing

- Component tests mirroring the existing `synthi/src/components/programs/__tests__/*` patterns: Library (running cards, idle tiles, detected banner, role gating, removed command box), Store (filter strip scroll/fade, 2-up grid, search, verified vs community), Library↔Store navigation, and the consent/install flow.
- Visual: assert the vectant tokens are used (no flat `bg-surface`-only cards), brand gradient only on Verified + primary CTA, and `prefers-reduced-motion` honored for the thumbnail.

## Out of scope

- The `publish → build → host → run` platform and the sandboxing/security model for untrusted community apps (separate brainstorm + spec — the next workstream).
- The Ports panel and the Connected Tools panel (untouched).
- Any data-model / API changes beyond what the UI overhaul needs.

## Open questions / follow-ups

- Live-thumbnail source: periodic snapshot vs throttled live iframe (decide in the plan).
- The hosting-platform brainstorm is the immediate follow-up once this panel ships.
