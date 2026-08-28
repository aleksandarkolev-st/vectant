# Spec: CLI/TUI programs open in the integrated terminal

- **Date:** 2026-06-22
- **Status:** Approved (brainstorming) — ready for implementation plan
- **Branch:** `feat/docker-sysbox-engine`
- **Sub-project 1 of 3** in the "Docker + dev tools in programs" effort. The other two
  (GUI catalog expansion; first-class Docker presence) are separate specs.

## Problem

Launching a `cli`/`tui` program (e.g. lazygit) routes through
`ProgramsPanel.openProgramSession`, which — for any non-`webGui` session — opens a **docked
`ProgramSessionPanel`** (the App/Logs/Terminal/Ports/Health/Settings panel). To actually use the
tool the user must then dig into that panel's **Terminal** sub-tab. For a terminal program that
is pure overhead: a whole panel wrapping "just a new terminal."

## Goal

Clicking **Launch** on a `cli`/`tui` program opens a **tab in the real integrated terminal**
(`TerminalManager`) running that program — no `ProgramSessionPanel`. The managed program-session
lifecycle (consent gating, the Programs panel's Running list, stop/restart) is **preserved
unchanged**; the terminal tab is simply the live view of the session's PTY.

## Existing mechanism (reused, not rebuilt)

`TerminalManager.jsx` already listens for two `window` events and finds-or-creates a terminal tab
bound to a program session's PTY via `TerminalPane`'s `fixedSessionId`:

- `ai-terminal-open` → the AI's dedicated terminal tab (`isAi`).
- `terminal-session-open` → a non-AI tab bound to `detail.sessionId` (today labelled `Task: …`).

Making the bottom terminal panel visible is `dispatch(setShowTerminal(true))`. This exact pair —
`setShowTerminal(true)` + a `*-terminal-open` / `terminal-session-open` event — is already used in
`AIChatWindow.jsx`, `chat/hooks/useAISuggestions.js`, `app/workspace/[slug]/page.jsx`, and
`redux/workspaceSlice.js`. The PTY attach model is identical to the `ProgramSessionPanel` Terminal
sub-tab (same `TerminalPane`, same `fixedSessionId={session.id}`).

So this feature is a **wiring change in one function**, not new infrastructure.

## Design

Add a routing branch at the top of `ProgramsPanel.openProgramSession` — the single function every
launch path (`handleLaunch` ad-hoc, `handleLaunchInstall`, `handleLaunchDetected`) and the
session-card **Open** button already funnel through. Give it an optional second arg carrying the
label/command hint (launch handlers pass it; the **Open** button omits it):

```
function openProgramSession(session, { label = null, command = null } = {}) {
  const rt = String(session.runtimeType || '').toLowerCase();
  if (rt === 'cli' || rt === 'tui') {
    dispatch(setShowTerminal(true));
    window.dispatchEvent(new CustomEvent('terminal-session-open', {
      detail: { sessionId: session.id, command, label: label || sessionLabel(session) },
    }));
    return; // skip the panel / floating-window paths
  }
  // …existing webGui → floating, else → docked panel behavior…
}
```

Callers: `handleLaunch` passes `{ command: trimmed, label: trimmed }`; `handleLaunchInstall` passes
`{ label: install.packageId }`; `handleLaunchDetected` passes `{ label: detected.source }`; the
session-card **Open** button calls `openProgramSession(session)` (no hint → `sessionLabel` fallback).

Because launch **and** re-open both call `openProgramSession`, the routing covers both uniformly.
`TerminalManager` dedups by `fixedSessionId`, so re-launching or clicking **Open** on a running
`cli`/`tui` session re-focuses the existing tab instead of stacking duplicates.

### Routing table

| `runtimeType`        | Surface                                   | Change   |
| -------------------- | ----------------------------------------- | -------- |
| `cli`                | Integrated terminal tab                   | **NEW**  |
| `tui`                | Integrated terminal tab                   | **NEW**  |
| `web`                | Docked `ProgramSessionPanel` (App preview)| unchanged|
| `container` / webGui | Floating window (e.g. DBeaver/KasmVNC)    | unchanged|
| `background`         | Docked `ProgramSessionPanel` (Logs)       | unchanged|

### Tab label

The tab is labelled with the program/command name (e.g. `lazygit`) rather than `Task: …`. Launch
handlers pass an explicit `label` (ad-hoc: the typed command; installed: the program's display
name / `packageId`) which `openProgramSession` threads into the event `detail`. For re-open via the
**Open** button (no explicit label), fall back to a session-derived label.
(`TerminalManager.openSessionTab` already honors an explicit `label`, else builds `Task: <command>`.)

## Decisions (confirmed with user)

1. **Ad-hoc "Launch Command" box also goes to the terminal.** It hardcodes `runtimeType: 'cli'`, so
   the `cli` routing covers it automatically — any ad-hoc command opens as a live terminal tab. Web
   servers started ad-hoc still get web-port auto-detection (Ports panel / preview) as today.
2. **Closing the terminal tab detaches only.** The managed session keeps running; the user stops it
   from the Programs panel's **Stop** button. No new tab↔session lifecycle wiring (matches existing
   AI-terminal behavior). Auto-stop-on-close is explicitly out of scope (YAGNI).

## Out of scope / non-goals

- No change to the managed-runtime PTY lifecycle, consent flow, or stop/restart semantics.
- No auto-stop when the terminal tab closes.
- No change to `web` / `container` / `webGui` / `background` surfacing.
- GUI catalog expansion and Docker presence are separate sub-projects/specs.

## Testing (TDD)

- **Unit (pure):** `isTerminalRuntimeType(rt)` → `true` for `cli`/`tui`, `false` otherwise. red→green.
- **Component (jsdom, ProgramsPanel):**
  - Launching/opening a `cli` (and `tui`) session → `setShowTerminal(true)` dispatched **and** a
    `terminal-session-open` event fired with the session id (spy on `window.dispatchEvent`); **no**
    `program-session` tab/float opened.
  - A `web` session → still opens the docked `ProgramSessionPanel` (regression guard).
  - A `webGui` session → still opens a floating window (regression guard).
- **Regression:** existing `ProgramsPanel` / `ProgramSessionPanel` / docking-wm suites stay green.

## Risks

Low. Reuses a battle-tested event path. The only real wiring is the label thread-through and
ensuring the panel becomes visible via `setShowTerminal(true)` — both established patterns. The
managed session and its PTY are untouched, so stop/restart and consent keep working.
