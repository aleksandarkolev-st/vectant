# Multi-Pane Editor Split — Design

**Date:** 2026-05-22
**Branch context:** `frontend-refactor`
**Status:** Approved design, pre-implementation

## Problem

The TopNav "Split editor" button (`TopNav.jsx` → `splitEditorPanel`) is supposed to split the
editor into two side-by-side editors, each able to show a *different* file. Today it does not work:

- `splitEditorPanel` (`docking-wm/state/layout-slice.js`) creates a second editor tabgroup with a
  new editor tab that has **no `filePath`** in its `data`.
- `Editor.jsx` ignores its `filePath` prop and derives everything (Monaco model, content, Yjs
  binding, healing target) from the **single global** `workspaceSlice.activeFile`.

Result: both panes render the same file and edits mirror across them. The split is cosmetic.

## Goal

Make each editor pane a real, independent editor showing its own file, with N-pane and vertical
splits, while keeping a **single shared tab strip** in the TopNav that visually attributes each
open file to the pane(s) displaying it via a color + pane-number system.

## Key architectural facts (verified in code)

- An editor pane is a docking-wm **editor tabgroup** holding one editor tab. `PanelContentArea`
  (`PanelContainer.jsx`) renders one `EditorPanel` instance per editor tab; inactive tabs stay
  mounted but `display:none`. Multiple editor tabgroups ⇒ multiple live `Editor` instances.
- `PanelContainer` passes `data: tab.data || {}` to the panel; `EditorPanelWrapper`
  (`panel-wrappers.jsx`) already forwards `data?.filePath` and `dockingMode` to `Editor.jsx`.
  **The per-pane file pointer is therefore `tab.data.filePath` — no new slice is required.**
- Editor tabgroups **already suppress their own docking TabBar** (`TabGroup.jsx:240`,
  *"Editor groups: hidden (their file tabs live in the TopNav strip)"*). The shared TopNav strip
  (`EditorTabStrip.jsx`) is the only file-tab UI and remains so.
- `focusedTabGroupId` already exists in `layout-slice`. The focused **editor** pane is
  `focusedTabGroupId` when it points at an editor group.
- Monaco models are keyed by file URI (one model per path). Two editor *views* can attach the same
  model; Monaco supports this natively.

## Chosen approach: C (hybrid)

docking-wm owns **geometry** (N panes, vertical/horizontal splits, resize, persistence — already
implemented). The **file each pane shows** lives in that pane's editor-tab `data.filePath`. The
single shared strip and the per-pane header strips both *project* from the set of editor tabgroups.
Global `workspaceSlice.activeFile` is retained as a **mirror of the focused pane's file** so every
existing consumer (file tree highlight, breadcrumb, git gutter context, AI chat/healing target,
problems panel) keeps working unchanged.

Rejected: (A) making docking tab semantics the source of the open-files list — entangles file-open
with docking and demotes `openFiles`. (B) a brand-new pane model with its own split rendering —
rebuilds geometry the docking-wm already provides and risks a *fourth* docking system (the codebase
already has three docking families).

## Design

### 1. State & data model

- **Per-pane file pointer:** the editor tab's `data.filePath` in `layout-slice`. One editor tab per
  editor tabgroup.
- **Focused pane:** existing `focusedTabGroupId` (when it is an editor group).
- **Open files (shared strip contents):** unchanged — `workspaceSlice.openFiles` (union of all files
  open across all panes).
- **Global active file:** `workspaceSlice.activeFile` is kept in sync with the focused pane's
  `filePath`. Changing focus, or changing the focused pane's file, updates `activeFile`.

No new slice. New/changed reducers and a thunk wire the two slices together (see §3).

### 2. Editor rendering — one model, many views

`Editor.jsx` is refactored so its file identity comes from **`props.filePath` when in docking mode**,
falling back to global `activeFile` only when not docked. Concretely:

- A resolved `paneFile` = (dockingMode && filePath) ? lookup(filePath) : activeFile. All internal
  uses of `activeFile` that pertain to *which file this editor shows* (Monaco model creation,
  `activeFileIdentity` remount key, content selection, Yjs binding path, language) switch to
  `paneFile`.
- When the same file is open in multiple panes, each pane's editor view attaches the **same Monaco
  model** (keyed by URI). Edits and Yjs deltas reflect in all views automatically; Yjs binds once
  per file. This is what makes "same file on both sides by default" correct rather than mirrored
  state.
- The focused pane's `Editor` instance registers its Monaco editor as the **active editor** for the
  shell (the existing `setEditor`/`editorRef` path in `page.jsx`). On focus change, that registration
  moves to the newly focused instance.

This is the largest and highest-risk change (the file is ~3000 lines, currently coupled to
`selectActiveFile`). It is implemented and verified **first**, behind the existing
`filePath`/`dockingMode` seam, before any cosmetic work.

### 3. Focus, file-open, and split routing

- **Pane focus:** clicking inside a pane sets `focusedTabGroupId` (docking already does this on
  interaction; we ensure editor mousedown/focus dispatches it) and mirrors that pane's `filePath`
  into `activeFile`.
- **Opening a file** (file tree click, shared-strip tab click, command palette, etc.) routes to the
  **focused** editor pane: set that pane's editor-tab `data.filePath`, add the file to `openFiles`
  if new, and mirror to `activeFile`. This is centralized in the existing `selectFileThunk` /
  open-file path so all open entry points behave consistently.
- **Split:** `splitEditorPanel` is fixed to copy the **source (focused) pane's `filePath`** into the
  new editor tab's `data`, then focus the new pane. Vertical splits and 3+ panes are allowed (the
  current "≥2 ⇒ just refocus" cap is relaxed; geometry already supported by `splitNode`).

### 4. Shared strip — color + number grading (`EditorTabStrip.jsx`)

For each open file, compute the ordered list of panes currently showing it by scanning editor
tabgroups (`filePath` match). Then:

- The active/attribution underline becomes **N equal segments**, one per pane displaying the file,
  each segment in that pane's color (solid for one pane, half-and-half for two, thirds for three…).
  The focused pane's segment renders brightest.
- A small **pane-number badge** (the pane's number, in the pane's color) sits next to the filename
  for each pane showing the file.
- The existing hover brand-gradient animation is preserved, layered above the attribution underline.

This replaces the single moving indicator with per-tab attribution while keeping hover feedback.

### 5. Per-pane header strip (breadcrumb + number)

A thin strip rendered between the navbar and each pane's editor content (inside `EditorPanelWrapper`
/ the editor pane chrome) showing **that pane's breadcrumb + a colored pane-number badge**.

Height: the requested ~8px cannot fit readable text; the strip is sized to **~20px** via a CSS
custom property (e.g. `--editor-pane-header-h`) so the breadcrumb is legible and tunable. Final
value to be confirmed visually after first render.

### 6. Collab / healing liveness

- **AI healing + inline completions** attach to the **focused pane only** — the `page.jsx`-level
  hooks (`useAIHealing`, `useProactiveAnalysis`, completion providers) operate on the focused
  instance's editor via the active-editor registration in §2.
- **Text + awareness binding** runs per pane so either side stays editable and syncs (one Yjs
  binding per file; shared model handles the same-file-in-two-panes case).
- Collaborator **cursors render in unfocused panes too, but dimmed**, to signal they are not the
  active pane. Awareness rendering reads an `isFocusedPane` flag to choose normal vs. dimmed styling.

### 7. Pane colors / numbering + edge cases

- **Palette:** pane 1 = gray (the current active-tab color), 2 = blue, then teal, amber, purple…
  defined as a capped ordered list; cycled if pane count exceeds the list.
- **Numbering:** stable layout order — left→right, top→bottom traversal of the layout tree.
- **Closing a strip tab:** closes the file everywhere (`closeFile`); any pane showing it falls back
  to a neighbor open file, or empty if none.
- **Closing / unsplitting a pane:** uses existing docking close; surviving panes are re-numbered and
  focus moves to a surviving editor pane (with `activeFile` re-mirrored).
- **Always ≥1 editor pane:** the last editor pane cannot be closed into a state with no editor.

## Components touched

- `docking-wm/state/layout-slice.js` — `splitEditorPanel` copies source `filePath`, relax cap, allow
  vertical/N; helper to set a pane's `filePath`; selectors for editor panes + their files + numbering.
- `redux/workspaceSlice.js` — open-file/`selectFileThunk` routes to focused pane; `activeFile`
  mirrors focused pane; `closeFile` pane fallback.
- `app/workspace/[slug]/Editor/Editor.jsx` — file identity from `props.filePath` in docking mode;
  shared-model attach; focused-instance active-editor registration; dimmed awareness when unfocused.
- `components/EditorTabStrip.jsx` — per-tab segmented colored underline + pane-number badges.
- `components/docking-wm/panels/panel-wrappers.jsx` (`EditorPanelWrapper`) + pane chrome — per-pane
  header strip (breadcrumb + number), pane color/number plumbing.
- `app/workspace/[slug]/page.jsx` — focused-pane editor registration feeding existing shell hooks.
- A small shared util for the pane palette + numbering (consumed by strip, header, editor chrome).

## Risks & mitigations

- **`Editor.jsx` decoupling (highest risk):** done first, behind the existing prop seam, verified
  with a real second pane before cosmetic work. Non-docking mode keeps the `activeFile` fallback so
  nothing regresses if a consumer renders the editor outside docking.
- **Same-file double Yjs binding:** avoided by sharing one Monaco model across views and binding Yjs
  once per file (do **not** introduce a second model/binding for the same path).
- **Monaco / Yjs single-instance constraints:** unchanged — we add editor *views*, not a second
  Monaco API module or a second Yjs.

## Out of scope

- Per-pane independent *open-file lists* (the strip stays a single global union).
- Drag-tearing tabs from the TopNav strip into panes (existing limitation, unchanged).
- Persisting which file each pane shows across reloads beyond what docking serialization already
  stores (revisit only if it falls out for free).

## Success criteria

1. Clicking Split produces a second editor pane showing the same file by default; typing in one pane
   does **not** mirror into the other unless they share a file (where it's the same model by design).
2. Opening a different file in the focused pane leaves the other pane's file unchanged.
3. The shared strip shows segmented colored underlines + pane-number badges that correctly attribute
   each file to its pane(s); a file in two panes shows half-and-half.
4. Each pane shows a legible breadcrumb + pane number in its header strip.
5. Healing/completions act on the focused pane; collaborator cursors appear dimmed in unfocused
   panes.
6. Vertical and 3+ panes work; closing/unsplitting re-numbers and re-focuses correctly.
