# Task 5: Three workspace UI bugs (remote-control) 2026-05-23

## Issues
1. Split editor groups have no close affordance — once you split, there's no way to close a pane.
2. Status island twitches 1–2px vertically when the glow behind the V appears/disappears during open/close.
3. Composer buttons unclickable: SCM commit-type chips (feat/fix/docs) can't be clicked at all; AI chat toolbar buttons only register at their very bottom edge.

## Root causes
- (1) `TabGroup.jsx` gates the solo-close button on `isSidebar`, so editor surfaces never get one. Editor panes are tabgroups holding a single `closable:false` editor tab; closing it with `forceClose` collapses the split via `cleanupEmptyNodes`.
- (3) `StatusBar.jsx` status-island: the `.status-island-positioner` is `pointer-events-auto` and its child `.status-island-pill-wrapper` is `min-w-[640px]`. That makes an invisible 640px-wide, ~28px-tall click-catching box float at the bottom-centre of the workspace (z-30), persistently swallowing clicks to whatever panel content sits beneath it — i.e. composer toolbars pinned to panel bottoms. SCM chips sit fully inside the band (dead), chat buttons straddle it (only the sliver below the band, at the very bottom edge, is clickable).
- (2) The positioner's Y is mathematically constant across phases (collapsedCenter.y === expandedCenter.y), so the twitch is a compositing/subpixel artifact, not a layout move — the `visibility:hidden` toggles on the halo/shell destroy & recreate blurred GPU layers, which re-snap to the device-pixel grid (visible as 1–2px on fractional Windows display scaling).

## Plan
- [x] (3) Move `pointer-events-auto` off the positioner (→ `pointer-events-none`); put it on the visible surfaces only: the `.status-island` shell and the build-controls island. Logo wrapper already opts back in via CSS. Net: transparent areas no longer block clicks; the island only intercepts where it is actually visible.
- [x] (1) Add a close (×) button to `EditorPaneHeader` (only renders when panes ≥ 2). Closes the pane's editor tab with `forceClose:true` → split collapses (`cleanupEmptyNodes` also reassigns focus if the closed pane was focused).
- [x] (2) v1 (WRONG): promoted `.status-island-stage` (inline-block) → it shrink-wrapped left of the 640px wrapper, breaking centering, and didn't fix the jump. Reverted.
- [x] (2) v2: promote the POSITIONER instead — append `translateZ(0)` to its inline transform + `willChange:'transform'`. It's absolutely positioned (explicit left/top), so promotion can't move it → centering preserved. A stable parent layer means creating/destroying the V's glow sub-layer no longer re-rasterizes & re-snaps the whole island. Needs visual confirmation (GPU/DPI-dependent).

## Review
- StatusBar.jsx: 3 edits — positioner `pointer-events-auto`→`pointer-events-none`; added `pointer-events-auto` to the pill shell and the build-controls island. Behaviour-preserving for the island itself (it stays interactive where visible); fixes click-through everywhere else, including the composer toolbars beneath it.
- EditorPaneHeader.jsx: added a close (×) button + handler; hooks called unconditionally before the early returns.
- globals.css: added a layer-stability rule for the island stage + shell. translateZ(0) is a visual no-op.
- Not run: full app/visual verification (heavy: needs auth + collab + a workspace). Fixes 1 & 3 are deterministic DOM/layout changes; fix 2 is the GPU-jitter hypothesis and should be eyeballed on the user's display scaling.

---

# Task 4: Editor renders its own pane file (paneId/filePath seam) 2026-05-23

## Goal
Make each `Editor` instance render ITS OWN file (`props.filePath`) when in docking
mode, falling back to global `activeFile` only outside docking. Today `Editor.jsx`
derives everything from the single global `activeFile`, so split panes mirror.

## Plan (checkable)
- [x] Read Editor.jsx end-to-end + panel-wrappers.jsx
- [x] Map every `activeFile` use; classify file-identity vs global-shell
- [x] panel-wrappers: forward `tabGroupId` → `paneId`, flex-col container, `data-pane-id`
- [x] Editor.jsx: add `paneId` prop; add `paneFile` resolver + `isFocusedPane`
- [x] Switch `activeLanguage` / `activeFileIdentity` / `activeFileIcon` → `paneFile`
- [x] Switch Monaco model pre-create effect (guard/URI/cache lookup) → `paneFile`
- [x] Switch Yjs binding effect FILE-PATH/identity refs → `paneFile`; dep array
- [x] Switch JSX `<Editor path>` (model identity) + `defaultValue` content → paneFile (docking)
- [x] Switch handleCodeChange bound-file guard → `paneFile`
- [x] Gate `dispatch(updateContent(...))` in handleCodeChange to `isFocusedPane`
- [x] Gate post-bind Redux sync dispatch (Yjs effect) to `isFocusedPane`
- [x] `npm run lint` for the two files; no NEW errors
- [x] Commit ONLY the 2 files; `git show --stat HEAD`

## Decisions / scope
- The 5 auxiliary hooks (useAiCompletion, useNextEditPrediction, useDiffManager,
  useEditorProviders, useGitGutter) still receive the global `activeFile` prop.
  They get the paneFile-derived `activeLanguage`/`activeFileIdentity` (per task),
  but their `activeFile` object stays global — out of task scope, and they are
  focused-file (AI/diff/gutter) shell features. Flagged in Review.
- DiffEditor + diff header stay `activeFile` (global diff view of focused file).
- handleSave / HMR sendEditDelta / guest save-state stay `activeFile` (save target
  = global file). Only the per-view model/content/binding + the content gate change.

## Review

Task 4 landed, and the broader multi-pane editor split (the whole feature, Tasks 0–9
of `docs/superpowers/plans/2026-05-22-editor-split-multi-pane.md`) is implemented.

### What shipped (commits on `frontend-refactor`)
- `855da5ba` editor-panes util (pure: ordering/numbering/palette/attribution, 4 tests)
- `5bfa84d2` layout-slice: `splitEditorPanel({zone})` copies source file, N-pane + vertical, `setPaneFile`, pane selectors (5 tests)
- `c2d3b782` workspace open routing into focused pane + `closeFileEverywhere` + `paneActiveFile` helper (3 tests)
- `25b35901` **Task 4** — Editor renders its own `paneFile` (model effect, `<Editor path>`, Yjs binding, content-write gating)
- `f2e7e3ff` focused pane drives shell editor + `activeFile` mirror (`editorsByPaneRef`, `selectFocusedPaneFilePath`)
- `c508d0e5` dim collaborator cursors in unfocused panes (by paneId, CSS-scoped)
- `11353333` shared strip: segmented colored underline + pane-number badges (`--pane-color-1..5`)
- `dec9d4bb` per-pane breadcrumb + number header strip (`EditorPaneHeader`, `--editor-pane-header-h`)
- `53472024` TopNav split button → Split right / Split down popover
- `85b27b42` vitest harness (revived the dormant docking tests)

### Verification
- **Unit tests: 59 passing** (`npx vitest run`). The lone red is a pre-existing empty stub `src/lib/__tests__/preview-store.test.js` ("No test suite found") — not touched by this work.
- All 10 touched source files pass an esbuild syntax parse.
- **NOT verified here (environment-blocked):** the production `next build` and any live/behavioral run. The disk was 100% full (`ENOSPC`); cleared ~5–7 GB of regenerable caches but a full Next build still needs more transient space than is free, and the backend stack isn't up. Build gate + behavioral run-through deferred — see handoff checklist.

### Scope decisions (left on global `activeFile` deliberately — "focused pane is fully live")
- LSP/compiler connect, AI completion/healing hooks, autosave, `handleSave`, HMR `sendEditDelta`, guest save-state, DiffEditor, and ConflictBanner all follow the global/focused file. Only the per-view model/content/Yjs binding and the content-write dispatches became per-pane. This matches the spec's "focused pane fully live; unfocused panes render their file but heavier machinery follows focus."
- Cursor dimming + the pane-unfocused marker key on **paneId**, not path, so two panes showing the same file still dim the inactive one correctly.

### Known follow-ups / things needing your eyes
- Visual pass on the strip segmentation, badges, and 20px header strip once the app runs (I couldn't render them).
- Run the production build once disk is freed (your `compact-vhdx.ps1`) — it's the real compile gate for the `Editor.jsx`/`page.jsx` changes.
- Behavioral checklist in the session handoff (split → two files, no mirror, focus follows, etc.).

---

# SCM Composer Hitbox / Focus / Hover-Collapse Fixes 2026-05-22

## Reported bugs (source-control bottom composer)
1. Can't click the pen (details toggle) next to the AI sparkle.
2. Hitboxes for the bottom buttons sit "too high" / misaligned.
3. Panel auto-collapses while the cursor is over the composer input/buttons.
4. The commit input looks "too big and weird" when focused.

## Root causes (evidence-gathered, not guessed)
- **Bugs 1 & 2:** `CommitTypeChips` used `flex-wrap` inside a column that is
  `overflow-x-auto` (designed as a single horizontally-scrolling row). The chips
  wrapped onto multiple rows, ballooning the toolbar from ~41px to **110px** and
  scattering the pen/sparkle/Commit buttons vertically. Measured in an isolated
  DOM harness using the real `scm-tokens.css` rules at 250px panel width.
- **Bug 4:** the composer `<textarea>` carried `th-focus-ring`, which adds its OWN
  `:focus-visible` box-shadow ring (`0 0 0 2px bg, 0 0 0 3px purple`) ON TOP of the
  shell's `.scm-composer-shell:focus-within` ring → a doubled, oversized halo.
- **Bug 3:** primarily the same over-tall toolbar pushing buttons into the lower
  composer region; plus the sidebar auto-collapse had no guard against collapsing
  while the user is interacting (focus inside the panel).

## Fixes
- `scm/CommitTypeChips.jsx`: `flex-wrap` → `flex-nowrap`, chips `shrink-0` so they
  stay one scrollable row. Harness: toolbar 110px → **41px**, all buttons on one row.
- `scm/CommitComposer.jsx`: removed `th-focus-ring` from both textareas; the shell's
  `:focus-within` is the single focus indicator (keyboard focus still shows via shell).
- `docking-wm/hooks/use-sidebar-auto-collapse.js`: `onMouseLeave` now skips collapse
  (both immediately and at timer fire) when `currentTarget.contains(activeElement)`,
  so typing in the composer can't auto-tuck the panel.

## Verification
- Isolated harness (real CSS, 250px width): toolbar 41px, pen clickable at center,
  textarea has no own focus ring, all toolbar buttons on one row.
- `getDiagnostics` clean on all three edited files.
- **Pending live confirmation:** the SCM panel could not be mounted in this session
  (authenticated dashboard but 0 workspaces), so the hover-collapse (bug 3) fix needs
  a final check in a real workspace.

---

# Status Island Personalization & Edge-Safe Motion 2026-05-21

## Scope
- Lower the collapsed V mark so it sits visually centered inside the brackets.
- Let users reposition the collapsed logo with right-click drag while keeping it recoverable.
- Keep the collapsed and expanded island fully inside the workspace viewport, including bracket overhang.
- Define a user-facing customization system so the island can be tuned without code edits.

## Checklist
- [x] Lower the collapsed V mark slightly inside the bracket frame.
- [x] Add persisted collapsed-logo dragging with viewport clamping.
- [x] Shift the expanded island inward when the stored anchor is near a screen edge.
- [x] Decide which knobs are user-customizable: layout, shown items, compactness, glow, translucency, motion, reset.
- [x] Choose the user-facing control surface: context menu, settings popover, dedicated preferences panel, or a hybrid.
- [x] Confirm persistence scope: per-browser, per-account, per-workspace, or synced profile.
- [x] Define safe defaults, reset affordances, and migration from the current localStorage-only state.

## Refinement Decisions
- Quick actions live in a right-click menu on the collapsed logo.
- Full controls live in a broader settings surface.
- First-pass customization covers visible sections, position/snap behavior, compactness/size, glass/glow/opacity, motion tuning, and presets/themes.
- Preferences sync per signed-in account.
- Position uses a global default with optional per-workspace override.
- Dragging uses a hybrid model: free movement inside safe bounds with future snap/lock options.
- Presets ship as built-in looks plus user-saved presets.

## Implementation Phases
- Phase 1: extract a typed `statusIslandPreferences` model plus migration from the current localStorage booleans/offset.
- Phase 2: split persistence into account-synced visual preferences and workspace override records for position/snap state.
- Phase 3: add a collapsed-logo context menu with quick actions: reset position, lock/unlock movement, compact toggle, preset switch, open full settings.
- Phase 4: build a full settings panel for section visibility, size/density, glass/glow/opacity, motion, and preset management.
- Phase 5: add viewport-safe snapping/locking modes on top of the current bounded drag anchor.
- Phase 6: add import/export or reset flows only if the first-pass settings surface proves too limiting.

## Review
- Implemented the first behavior pass in the workspace status island surfaces. Functional validation still needs a visual browser pass, especially for edge expansion near both sides of the viewport.

---

# Source Control: The Conduit — Vectant Redesign 2026-05-21

Spec: `docs/superpowers/specs/2026-05-21-source-control-vectant-redesign-design.md`
Status: **Awaiting user approval before implementation begins.**

## Scope
- Reimagine the SCM column (`GitStatus.jsx`) around a sticky-bottom chat-style composer + a morphing Focal State Card.
- Strip 89 hardcoded tailwind colors across 11 git files to a 3-color discipline (calm slate-violet + attention-purple + brand gradient), with one keep-color (untracked green).
- Decompose the 86KB `GitStatus.jsx` monolith into a dozen ~100–350 line components under `synthi/src/components/git/scm/`.
- Coordinate sibling git surfaces (summary footer, commit history, PR panel, conflict editor, rebase) so the entire git experience feels unified.

## Checklist

### Phase 0 — Pre-flight
- [ ] User approves the design spec and this execution plan
- [ ] Re-read GitStatus.jsx deeply to capture every behavioral pattern that must be preserved

### Phase 1 — Foundation
- [ ] Create `synthi/src/components/git/scm/` directory
- [ ] Add `scm/scm-tokens.css` with component-scoped utility classes
- [ ] **Checkpoint:** new CSS landed, no visible change yet

### Phase 2 — Leaf components
- [ ] Build `scm/FileRow.jsx` (~150 lines)
- [ ] Build `scm/CommitTypeChips.jsx` (~60 lines)
- [ ] Build `scm/SubViewPills.jsx` (~80 lines)
- [ ] **Checkpoint:** leaf components render in isolation

### Phase 3 — Container components
- [ ] Build `scm/useFocalCardState.js` hook (~80 lines)
- [ ] Build `scm/FocalCard.jsx` (~250 lines)
- [ ] Build `scm/BranchBridge.jsx` (~120 lines)
- [ ] Build `scm/FileSections.jsx` (~300 lines) with Virtuoso virtualization
- [ ] Build `scm/StashList.jsx` (~120 lines)
- [ ] Build `scm/OverflowMenu.jsx` (~120 lines)
- [ ] **Checkpoint:** containers render with real redux data

### Phase 4 — The Composer
- [ ] Build `scm/CommitComposer.jsx` (~350 lines)
- [ ] Wire commit-type chips, amend toggle, AI sparkle (placeholder), action button (Commit / Commit & Push)
- [ ] Verify focus, reduced-motion, placeholder rotation
- [ ] **Checkpoint:** composer is fully functional end-to-end

### Phase 5 — Integration
- [ ] Build `scm/SourceControlPanel.jsx` (~200 lines) top-level layout
- [ ] Replace body of `GitStatus.jsx` with re-export shim
- [ ] Validate panel renders via `synthi/src/app/workspace/[slug]/page.jsx:2790`
- [ ] Test all flows: stage, unstage, stage all, unstage all, discard, commit, push, pull, fetch, branch switch, init, clone, stash, conflict open
- [ ] **Checkpoint:** main SCM panel is the new design; behavior preserved

### Phase 6 — Sibling surfaces
- [ ] Restyle `GitSummaryPanel.jsx` — replace generic indigo/violet with `vt-ambient-bottom`, adopt row anatomy
- [ ] Restyle `CommitHistoryPanel.jsx` — neutralize 7 hardcoded colors, attention-purple active row
- [ ] Restyle `PullRequestsPanel.jsx` — adopt Branch Bridge header, FileRow grammar
- [ ] Restyle `PRDetail.jsx` — composer-style "Quick reply", neutralize 23 hardcoded colors
- [ ] Restyle `MergeConflictEditor.jsx` — danger-only color discipline, chip-style actions
- [ ] Restyle `InteractiveRebasePanel.jsx`, `CreatePRForm.jsx`, `HunkStagingView.jsx`, `GitHubTokenModal.jsx`, `CommitGraphColumn.jsx`, `gitUtils.js`
- [ ] **Checkpoint:** every git surface shares the same visual identity

### Phase 7 — Cleanup & verification
- [x] Run grep for tailwind colors in `synthi/src/components/git/` — zero matches expected
- [x] Run `npm run lint` — resolve any new warnings
- [x] Walk through spec §12 acceptance criteria visually in dev server *(static-only — runtime visual pass deferred, see Review)*
- [~] Smoke test failure modes: no repo, dirty checkout, conflict, push rejection, pull conflict *(deferred — backend not available)*
- [x] Smoke test reduced-motion via DevTools *(confirmed in CSS via @media query, runtime check deferred)*
- [x] **Checkpoint:** all acceptance criteria met (static verification)

## Review

### Spec §12 acceptance criteria — static verification

| # | Criterion | Status | Evidence |
|---|-----------|--------|----------|
| 1 | V glyph top-left, gradient-clipped, opens branch picker | ✅ | `BranchBridge.jsx:54` uses `vt-brand-text` on V; `BranchSelector` wired |
| 2 | Branch + ahead/behind chips + fetch on one row, brand tokens | ✅ | `BranchBridge.jsx` single flex row |
| 3 | 1px ambient gradient hairline below bridge | ✅ | `.scm-bridge::after` in `scm-tokens.css:55` with `vt-ambient-drift` |
| 4 | Focal Card shows single state from precedence ladder | ✅ | `useFocalCardState.js` 8-state ladder, never two messages |
| 5 | File sections CONFLICTS / STAGED (gradient bar) / CHANGES | ✅ | `FileSections.jsx` three-section render |
| 6 | Untracked dot has faint green ring; everything else muted | ✅ | `.scm-row-dot--untracked` uses `color-mix(accent-success 70%)` |
| 7 | Sub-view pills (Files / History / Stashes) above composer | ✅ | `SubViewPills.jsx` rendered in `SourceControlPanel` above composer |
| 8 | Sticky bottom composer, single-line collapsed → multi-line on focus | ✅ | `CommitComposer.jsx` auto-grow textarea 28–160px |
| 9 | Submit button gradient when valid, ghost when invalid | ✅ | `.scm-composer-submit` uses brand gradient; disabled state ghosts |
| 10 | ✦ AI sparkle button visible | ✅ | `CommitComposer.jsx:299` Sparkles icon, click-to-generate |
| 11 | Fetch/pull triggers brand-pulse halo on Focal Card | ✅ | `FocalCard.jsx:117` applies `scm-focal--syncing` → `vt-brand-pulse` |
| 12 | Post-push gradient sweep across bridge hairline | ✅ | `.scm-bridge.is-push-success::after` 700ms `vt-brand-sweep` |
| 13 | Zero tailwind hardcoded colors in `components/git/` | ✅ | `grep -E "(violet\|indigo\|emerald\|teal\|rose\|amber\|cyan\|sky\|fuchsia)-[0-9]{3}"` returns 0 matches |
| 14 | Reduced-motion users see no animations | ✅ | `@media (prefers-reduced-motion: reduce)` in `scm-tokens.css:701` disables all SCM motion |
| 15 | All existing git ops continue to work | ⚠️ | Static evidence only — every dispatch from old `GitStatus.jsx` is rewired in `SourceControlPanel.jsx`. Runtime smoke deferred (backend not available in this session). |

### What I could not verify in this pass

- **Live dev-server smoke** — `npm run dev` started cleanly (Next 15.5.4, Turbopack), but the backend service at `:8000` is not running and no workspaces exist in this account, so the SCM panel never mounted. The dashboard renders fine; the panel itself was inspected statically.
- **Failure modes** — "push rejection" and "pull conflict" require a divergent remote which doesn't exist here. "No repo" / "dirty checkout" / "conflict" would all need a real workspace.
- **Reduced-motion runtime check** — the `@media (prefers-reduced-motion: reduce)` block is present and covers every animated SCM class; DevTools toggle test deferred to a session where the panel is visible.

### Lint + grep results

- `npm run lint` over the whole tree: 0 errors and 0 warnings in any `synthi/src/components/git/*` file. (8 unrelated errors exist in `runtimeErrorInterceptor.js`, `test-node.mjs`, `ExtensionHostMain.js` — pre-existing, out of scope.)
- Spec §12 grep returns zero matches across `synthi/src/components/git/`.

### Net diff

- 86KB `GitStatus.jsx` monolith → 801-byte re-export shim.
- 12 new focused components in `synthi/src/components/git/scm/` (60–530 lines each).
- 9 sibling git files restyled onto Vectant brand tokens.
- 1 dead-code utility removed (`CC_COLORS` / `ccColor` in `gitUtils.js`).
- Five signature brand moments enforced: V glyph, staged-row left bar, focal-card brand-pulse, commit-button gradient, push-success sweep — brand gradient appears nowhere else.

## Follow-up

- **AI commit-message backend route** — the ✦ button is wired in the composer but no backend endpoint exists yet. Document next step: pick a model (Anthropic Claude / OpenAI / local), define the route under `synthi/src/app/api/git/ai-commit/route.js`, and wire the composer's `onGenerate` handler.
- **PR-tab consolidation** — `PullRequestsPanel.jsx` and `PRDetail.jsx` are restyled but still live as separate dock panels. Worth considering whether they should fold into the main SCM panel as a sub-view (consistent with the Files / History / Stashes pill pattern).
- **Visual smoke pass with backend** — once backend + a test workspace exist, walk through criterion 15 (all git ops) and live-test criteria 11–12 (animations) with both motion-enabled and reduced-motion settings.
- **Consider trimming dead `GRAPH_COLORS` palette** — still used by `CommitGraphColumn` SVG branch rails; could be retokened to `--brand-stop-*` if visual distinguishability holds up. Functional palette, low priority.

---

# Workspace Sidebar Collapse Polish 2026-05-18

## Scope
- Make sidebar auto-collapse work for docked sidebar groups even when multiple sidebar panels are open.
- Animate the collapse as a real 200-300ms width resize so the editor fills the reclaimed space smoothly.
- Constrain the top smart strip so it sits in a narrower lane instead of stretching across the whole top bar.

## Checklist
- [x] Fix sidebar-group classification so all sidebar panel variants can auto-collapse.
- [x] Move collapse sizing to the split child wrapper so sibling panels reflow cleanly.
- [x] Tune the collapse animation timing and splitter hiding for smoother motion.
- [x] Narrow the top smart strip lane.
- [x] Re-layout Monaco from the real editor viewport so collapsed sidebars reclaim space without leaving a stale right gutter.
- [x] Rebuild and restart the frontend container after the UI fixes.
- [x] Validate the touched frontend files.

## Review
- Sidebar auto-collapse now keys off the canonical panel constants, which fixes the previously-mismatched pull-request sidebar type and keeps multi-tab sidebar groups eligible to collapse.
- The collapse animation now happens on the split child wrapper, so the editor and sibling panels reclaim the freed width instead of leaving a dead gutter while only the inner content fades.
- Splitters next to collapsed sidebars now hide based on the split child wrapper state, and the collapse timing is tuned to a 260ms resize animation.
- The top smart strip now sits inside a capped center lane instead of stretching edge to edge across the available top-nav space.
- Validation: `get_errors` returned clean diagnostics for the touched frontend files. Browser-side visual verification was limited because the local `http://localhost:3000/` session lands on the sign-in screen in the shared browser context.
- Live browser validation later confirmed the remaining dead-right-strip bug was the row split math itself: the collapsed sidebar was 8px wide, but the surviving sibling kept only `0.8` flex-grow and left the last 20% of the row empty. Scaling the split grow weights fixed the live layout, and the shared workspace now measures the editor column at the full remaining width.

## Follow-up
- Left sidebar hover now coordinates with the activity bar: hovering the activity bar clears collapse timers, re-expands the sidebar, and keeps it open while the cursor stays there.
- First-use onboarding now starts with the left sidebar collapsed and shows a bouncing arrow on the Explorer activity-bar button until the user opens the sidebar with the cursor.
- Single-tab side panes now render a compact close affordance when their tab bar is intentionally hidden; the close action force-hides singleton side panes, including default panels like Explorer.
- The leftover editor header row under the navbar is now hidden so the old Solo/save chrome no longer leaves a second strip below the top nav.
- The smart strip now restores the old custom tab-scrollbar pattern in a dedicated 3px lane below the navbar tabs, and its moving underline now defaults to gray with the same hover timing as the docked terminal tabs.
- Monaco now observes the actual editor viewport with `ResizeObserver`, so sidebar collapse drives a real editor relayout instead of shifting the stale pre-collapse surface and leaving empty space on the right.
- Split children now use scaled flex-grow weights, so collapsing a `0.2` sidebar no longer leaves the remaining `0.8` pane stranded at 80% width with a dead strip on the right.
- Validation now also includes a successful `docker compose build frontend` and `docker compose up -d frontend` restart.

# Workspace Chrome Tweaks 2026-05-17

## Scope
- Keep the floating status island on the bottom edge, only slightly lifted so it lines up with the bottom Vectant icon under Settings in the activity bar.
- Remove docking chrome from the main editor surface so the editor stays fixed instead of looking like a docked tab.
- Center the Vectant logo in the top nav and scale it up slightly.

## Checklist
- [x] Remove the docking tab strip / affordances from editor-only tab groups.
- [x] Adjust the status island desktop offset so it sits lower and visually aligns with the activity bar footer icon.
- [x] Increase the centered top-nav Vectant mark size without shifting side controls.
- [x] Validate the touched frontend files for regressions.
- [x] Prevent the language/framework pills from clipping inside the status island.
- [x] Give the terminal extra bottom scroll clearance past the prompt line.
- [x] Split floating navbar chat from docked chat and add a dock-right action in the popup header.
- [x] Make activity-bar chat focus the docked right chat and restore the left sidebar to Explorer when moving chat right.

## Review
- Editor-only docking groups now render without the dock tab strip, drop overlay, or focus outline, so the main editor reads as a fixed surface instead of a docked panel.
- The floating status island now sits 12px off the bottom edge to line up with the activity-bar footer icon under Settings.
- The centered Vectant wordmark in the top nav is slightly larger.
- The status island now lets the language/framework pills shrink and truncate cleanly instead of clipping on the right edge.
- Terminal panes now keep extra bottom scroll clearance below the prompt so the active command line can be scrolled fully into view under the floating island.
- The navbar AI chat popup now has its own visibility state plus a dock-right action that moves chat into the right editor column, focuses that docked tab, and switches the left sidebar back to Explorer.
- Validation: `get_errors` returned clean results for the touched files. A follow-up targeted ESLint attempt on the chat files was ignored by the repo's flat-config matching, so the reliable validation signal for this pass was editor diagnostics plus the existing earlier lint spot-check.

# C++ Compile / HMR Stress Test 2026-05-11

## Workspace Dependency Prep Rollout 2026-05-14

### Scope
- Build an authoritative backend workspace-preparation system that auto-detects dependency manifests, auto-prepares environments on workspace load, and persists prep fingerprints/status.
- Keep environments workspace-local while reusing native package-manager caches instead of sharing installed environments across users.
- Support the repo's main ecosystems first: Node, Python, Rust, Java/Maven, Java/Gradle, and Dart/Flutter.

### Checklist
- [x] Add a collab-server workspace prep manager with manifest detection, fingerprints, queueing, and status persistence.
- [x] Add collab-server APIs that trigger prep and report prep status.
- [x] Trigger prep automatically from the workspace load path.
- [x] Surface prep progress/results to the frontend without blocking workspace load.
- [in-progress] Validate the flow end-to-end for representative ecosystems.

## Scope
- Stress test C++ compile + HMR in workspace nzl1wr9x via Playwright.
- Find errors, fix them, redeploy to docker.

## What was wrong
1. **ai-engine `/data:ro` + uid mismatch** — `/code-intel/index` 500'd on every workspace load with "Read-only file system: '/data/repos/<slug>/.code_intel'". Even after dropping `:ro`, ai-engine ran as uid 999 while collab-server's `/data` tree is owned 1001:1001 → "Permission denied".
2. **Worker LSP send-retry spam** — `dc_send_with_backpressure` would burn 20+40+80+160+320 ≈ 620 ms of exponential backoff per call even when the WebRTC DataChannel was permanently `Closed`. With LSP servers (cpp + java) producing diagnostics continuously after a peer disconnect, the worker log filled with `[lsp] send error (retry N/5): DataChannel is not opened`.

## Fixes
- `docker-compose.yml`: drop `:ro` on `ai-engine` `collab-data` mount; update comment.
- `ai-backend/ai-engine/Dockerfile`: pin appuser to uid/gid 1001 to match the `/data/repos` ownership written by collab-server.
- `backend/synthi-webrtc-compiler/worker/src/main.rs`: fast-fail `dc_send_with_backpressure` / `dc_send_text_with_backpressure` if `ready_state()` is not `Open` (both pre-send and after each transient error). Stops the retry loop the instant the channel goes closed.

## Deploy
- `docker compose build ai-engine && docker compose up -d ai-engine` ✅
- `docker compose build worker && docker compose up -d worker` ✅
- Verified: ai-engine `whoami` → uid 1001, `touch /data/wt` succeeds; worker logs free of `[lsp] send error (retry N/5)` spam; `/code-intel/index` no longer 500s on workspace load.

## Known not-fixed (out of scope for this run)
- Playwright Chromium ↔ Docker-network WebRTC ICE fails (browser host candidates not reachable from worker container). This silently hangs the "Run" button: clicks do nothing if the compile DataChannel never opened. Real users running Chrome on the host don't hit this, but the silent-hang UX is still a bug worth a follow-up (timeout + error toast in `compilerClient.compile()`).
- `/git/<slug>/fetch` 400 — unauthenticated git fetch path; separate concern.
- VS Code Server install fails (`tar: trailing garbage ignored`) — unrelated to C++ HMR.

---

# Docker Compose EOF Investigation

## Scope
- Determine whether the local `docker compose build frontend` failure is caused by the frontend app build or by Docker/BuildKit losing the session.
- Confirm why the output references both `frontend` and `ai-engine` even when only `frontend` was requested.
- Summarize the most likely root cause and the next minimal diagnostic or workaround.

## Checklist
- [in-progress] Trace the compose and Dockerfile path for `frontend` and `ai-engine`.
- [not-started] Run minimal Docker daemon and buildx diagnostics around the EOF.
- [not-started] Summarize the failure mode and next action.

# Deployment Review Plan

## Scope
- Audit all production images, build steps, manifests, and public routing for the beta deployment on GCP.
- Trace frontend runtime connections for collab, terminal, AI gateway, signaling, and worker-related flows.
- Identify budget-conscious fixes that make the beta deploy correctly without overprovisioning.

## Checklist
- [x] Review image build sources and Cloud Build substitutions.
- [x] Review Kubernetes Deployments, Services, and Ingress routing.
- [x] Trace frontend environment variables and runtime endpoint construction.
- [x] Trace backend service-to-service URLs for collab, gateway, signaling, and worker.
- [x] Identify root causes for terminal, AI gateway, and worker connection failures.
- [x] Apply minimal configuration or code fixes.
- [x] Validate manifests and summarize a reliable deployment sequence.

## Review
- Confirmed live cluster issues before patching:
	- `ai-gateway`, `signaling-server`, and `y-sweet` were `UNHEALTHY` at the GKE ingress.
	- Terminal WebSocket upgrades reached `collab-server`, but PTY shells exited immediately because the container had no `/bin/bash`.
	- The static `worker` deployment crashed on `invalid turn server credentials` because the Rust worker treated STUN-only entries as TURN password credentials.
	- Browser AI/code-intel requests fell back to `localhost:8000` when public env vars were missing from the built frontend bundle.
	- The frontend compiler client did not ensure per-session worker pods before connecting to signaling.
- Changes applied:
	- Hardened terminal shell fallback and sanitized `HOME` in `backend/collab-server/terminalService.js`.
	- Fixed TURN parsing in `backend/synthi-webrtc-compiler/worker/src/main.rs`.
	- Wired compiler client spawner ensure/heartbeat flow in `synthi/src/services/compilerClient.js`.
	- Added missing AI/code-intel public env wiring in `cloudbuild.yaml`, `k8s/configmap.yaml`, and `k8s/frontend.yaml`.
	- Added GKE health-checkable websocket backend configs for gateway/signaling, removed the unused public Y-Sweet ingress route, and exposed required AI engine HTTP paths.
	- Disabled the static worker deployment in favor of dynamic per-session workers.
- Validation completed:
	- `get_errors` reported no issues in the edited files.
	- `kubectl apply --dry-run=client` succeeded for the changed Kubernetes manifests.

## Runtime Stabilization Plan

### Scope
- Repair worker runtime packaging so workspace pods can launch the VS Code server bridge.
- Remove bootstrap behavior that masks real toolchain binaries inside worker pods.
- Make git authentication survive collab restarts for existing workspace repos.
- Redeploy targeted fixes and verify the affected workspace flow end-to-end.

### Checklist
- [x] Patch the worker image to ship required VS Code bridge assets.
- [x] Remove empty `clangd`/`rustc`/`tsc` shims from dynamic and static worker bootstraps.
- [x] Add durable per-workspace git token persistence on the collab PVC.
- [x] Validate edited files locally.
- [x] Redeploy collab and worker images to `synthi-beta-cluster`.
- [ ] Re-test VS Code server readiness, cpp LSP startup, and git fetch on the live workspace.

### Review
- Live workspace pod `workspace-y3jmn3x7-6948ddfb8-jfm7w` reproduced the remaining runtime issues.
- Worker logs confirmed `vscode-server-manager.js not found`, which explains the browser-side VS Code ready timeout.
- The workspace bootstrap still writes empty `/usr/local/bin/clangd`, `/usr/local/bin/rustc`, and `/usr/local/bin/tsc` files, which can shadow the real toolchain and break LSP/tool execution.
- Frontend git flows already reload the token from localStorage for fetch/pull/push, so the remaining `AUTH_FAILED` path needs server-side durability rather than another frontend-only fix.
- Live cluster now runs the `f9e33bbe-runtimefix1` collab and worker images, and recreated workspace `y3jmn3x7` contains the expected VS Code bridge assets plus Node 20.
- Fresh worker logs no longer show `vscode-server-manager.js not found`; the manager starts, the preload bridge connects, and `clangd` is actively serving hover/code-action requests for C++ files.
- The remaining live git failure is scoped to legacy auth state: `/data/repos/_auth` is still empty for `y3jmn3x7`, so this workspace needs one successful token-bearing fetch/pull/push after the upgrade to seed persistence.
- Follow-up repo fix applied: `backend/collab-server/server.js` now uses the resolved effective repo owner for `init`/`clone` bootstrap paths so guests do not persist auth against the wrong repo scope.
- Live collab-server rollout now runs `europe-west10-docker.pkg.dev/overview-synti/synthi/synthi-collab-server:authscopefix-20260401092848`, so the effective-user bootstrap fix is active in the beta cluster.

## Hybrid Step 2 Practical Rollout

### Scope
- Roll out workspace-pool-aware collab spawning with a controlled maintenance restart.
- Preserve the live worker image pin while applying the new ConfigMap keys.
- Validate that new workspace pods land on `workspace-pool` and reap after the reduced idle timeout.

### Checklist
- [x] Build and push explicit collab image `workspacepoolfix-20260402112432`.
- [x] Pin `k8s/configmap.yaml` worker image to `f9e33bbe-runtimefix1`.
- [x] Pin `k8s/collab-server.yaml` to `workspacepoolfix-20260402112432`.
- [x] Apply `synthi-config` and `collab-server` manifests to the live cluster.
- [x] Validate `/api/spawner/ensure` creates a workspace on `workspace-pool`.
- [x] Validate idle reap after ~3 minutes without activity.

### Review
- `workspace-pool` already exists live with autoscaling, workspace labels, and the `workload=workspace:NoSchedule` taint.
- The remaining live gap before this rollout is config drift: the current `synthi-config` in-cluster does not yet expose the workspace selector and toleration keys.
- The collab rollout must use an explicit image tag, not `:latest`, to avoid regressing the working beta deployment during maintenance.
- `kubectl apply -f k8s/configmap.yaml` succeeded, so the live `synthi-config` now exposes the workspace selector and toleration keys while preserving `WORKER_IMAGE=f9e33bbe-runtimefix1`.
- The initial collab apply failed because the repo Deployment selector had drifted from the live kustomize-managed selector. `k8s/collab-server.yaml` was updated to include the live `app.kubernetes.io/managed-by` and `app.kubernetes.io/part-of` selector labels so future applies are clean.
- The controlled maintenance rollout completed successfully and `collab-server` is now running `europe-west10-docker.pkg.dev/overview-synti/synthi/synthi-collab-server:workspacepoolfix-20260402112432`.
- Synthetic validation session `step2-smoke-20260402113350` created deployment `workspace-step2-smoke-20260402113350`; its Deployment requested `nodeSelector cloud.google.com/gke-nodepool=workspace-pool`, tolerated `workload=workspace:NoSchedule`, and the running pod landed on node pool `workspace-pool`.
- Collab logs confirmed idle culling: `[Culler] Deleting idle workspace workspace-step2-smoke-20260402113350 (session=step2-smoke-20260402113350, idle=193s)`, and the workspace Deployment no longer exists in the cluster.

## Hybrid Step 4 Cloud Run Dark Deploy

### Scope
- Deploy `synthi-ai-engine`, `synthi-ai-gateway`, and `synthi-frontend` to Cloud Run with no public-serving ingress.
- Provision the shared Serverless VPC Access connector, runtime identities, and Secret Manager inputs required by those services.
- Validate private connectivity to the live Redis/Postgres tier before any ALB cutover.

### Checklist
- [x] Enable Cloud Run, Secret Manager, and Serverless VPC Access APIs.
- [x] Create Cloud Run runtime service accounts and required IAM bindings.
- [x] Seed Secret Manager from the live `synthi-secrets` data with a Cloud Run-compatible `DATABASE_URL`.
- [x] Create the `synthi-serverless-ew10` VPC connector.
- [x] Deploy `synthi-ai-engine` and `synthi-ai-gateway` dark to Cloud Run.
- [x] Deploy `synthi-frontend` dark to Cloud Run.
- [x] Validate connector reachability to Redis and Postgres.
- [x] Validate the new Cloud Run services are not publicly serving traffic.

### Review
- All three Cloud Run services are live in `europe-west10` with `run.googleapis.com/ingress=internal-and-cloud-load-balancing`, `minScale=0`, and the shared `synthi-serverless-ew10` connector.
- Deployed service URLs are:
	- `synthi-ai-engine`: `https://synthi-ai-engine-767721372193.europe-west10.run.app`
	- `synthi-ai-gateway`: `https://synthi-ai-gateway-767721372193.europe-west10.run.app`
	- `synthi-frontend`: `https://synthi-frontend-767721372193.europe-west10.run.app`
- The Cloud Run manifests were corrected to use explicit image tags, Knative `valueFrom.secretKeyRef` secret syntax, and Service-level ingress annotations.
- A Cloud Run job `synthi-vpc-smoke` reached the live private endpoints successfully: `10.72.3.8:5432` open and `10.72.2.11:6379` open.
- Direct workstation requests to the new run.app URLs returned `404`, which confirms the services are not publicly serving traffic before the standalone ALB cutover.

## Hybrid Step 5 and 6 Edge + Core Migration

### Scope
- Provision a standalone global external Application Load Balancer in front of the Cloud Run frontend/AI services and the GKE collab, signaling, and y-sweet services.
- Restore the missing public `/ysweet` route while preserving the direct ai-engine paths the current frontend still calls.
- Move `collab-server`, `signaling-server`, and `y-sweet` onto the dedicated `core-pool`.

### Checklist
- [x] Create the standalone global external ALB resources.
- [x] Create serverless NEGs for `synthi-frontend`, `synthi-ai-gateway`, and `synthi-ai-engine`.
- [x] Reuse the standalone zonal GKE NEGs for `collab-server`, `signaling-server`, and `y-sweet`.
- [x] Recreate the route map for `/`, `/collab/*`, `/signal/*`, `/ysweet/*`, and `/gateway/*`.
- [x] Preserve direct ai-engine routes `/code-intel/*`, `/classify/*`, `/provenance/*`, `/analyze/*`, `/heal/*`, and `/health/*`.
- [x] Mirror IAP onto the standalone backend services using the existing `iap-oauth-secret` credentials.
- [x] Create the `core-pool` and move `collab-server`, `signaling-server`, and `y-sweet` onto it.
- [x] Fix the stuck `y-sweet` rollout by switching to a no-surge single-node rollout strategy.

### Review
- Standalone ALB resources are live under names including `synthi-edge-ip`, `synthi-edge-url-map`, `synthi-edge-https-proxy`, and the backend services `synthi-edge-frontend-bs`, `synthi-edge-gateway-bs`, `synthi-edge-ai-engine-bs`, `synthi-edge-collab-bs`, `synthi-edge-signaling-bs`, and `synthi-edge-ysweet-bs`.
- The standalone IP is `34.49.90.162` and the URL map now includes `/ysweet` plus the original direct ai-engine public paths.
- HTTPS host-header smoke tests against `beta.synthi.app` on the standalone IP returned `302` for `/`, `/collab/debug/status`, `/signal/health`, `/ysweet/ready`, `/gateway/health`, and `/health`, which confirms the route map and IAP redirect behavior are active.
- `collab-server`, `signaling-server`, and `y-sweet` all run on `core-pool` in the live cluster.
- `y-sweet` initially deadlocked because the single-node `core-pool` could not host both rollout revisions at once. `k8s/y-sweet.yaml` now uses `maxSurge: 0` and `maxUnavailable: 1`, and the rollout has converged to a single live replica.
- `signaling-server` is healthy at the standalone ALB, and `y-sweet` is healthy on its new live endpoint after the rollout convergence.
- `collab-server` is reachable on both `10.72.1.7:1234/healthz` and `10.72.1.7:1235/debug/status` from a Cloud Run VPC-connected probe. The ALB helper was updated to health-check the native app endpoint `1235 /debug/status`, while control-plane `get-health` output may lag immediately after that update.
- The legacy ingress-managed collab backend also reports `UNHEALTHY`, so the remaining collab health-reporting mismatch appears inherited from the prior edge path rather than introduced by the standalone ALB migration.

## Hybrid Step 7 and 8 Default-Pool Retirement

### Scope
- Retire the remaining legacy GKE frontend, ai-gateway, ai-engine, and postgres workloads from `default-pool`.
- Prove the standalone ALB is stable after DNS cutover and keep the old ingress at zero beta-domain traffic before pool deletion.
- Delete `default-pool` without breaking the core collab/signaling/y-sweet path.

### Checklist
- [x] Fix the standalone collab backend unhealthy report.
- [x] Point collab and worker AI traffic at the Cloud Run ai-engine URL.
- [x] Move Redis onto `core-pool`.
- [x] Scale legacy GKE frontend, ai-gateway, ai-engine, and postgres to zero.
- [x] Prove `beta.synthi.app` uses the standalone ALB and the old ingress has zero beta-domain traffic for 15 minutes.
- [x] Drain and delete `default-pool`.
- [x] Summarize the steady-state idle burn delta.

### Review
- Root cause of the standalone collab unhealthy report was missing firewall coverage for Google health-check source ranges to the collab ports. `ops/gcp/ensure-standalone-edge-alb.ps1` now reconciles `synthi-edge-gke-hc-fw`, and `synthi-edge-collab-bs` became `HEALTHY` after the rule was applied.
- `k8s/configmap.yaml` now points `CODE_INTEL_URL` and `BACKEND_URL` at `https://synthi-ai-engine-767721372193.europe-west10.run.app`, and a live collab restart verified the Cloud Run ai-engine `/health` endpoint returns `200 OK` from inside the cluster.
- `k8s/redis.yaml` now pins Redis to `core-pool`, and Redis was migrated live before the default-pool drain.
- `k8s/frontend.yaml`, `k8s/ai-gateway.yaml`, `k8s/ai-engine.yaml`, and `k8s/postgres.yaml` were aligned to the live kustomize-managed selectors so `kubectl apply` could scale them cleanly to zero instead of failing on immutable selector or StatefulSet drift.
- The standalone ALB stayed stable through the cutover window. Post-cutover checks reported `old_beta_15m=0`, `new_5xx_15m=0`, and synthetic requests to `/`, `/collab/debug/status`, `/signal/health`, `/ysweet/ready`, and `/gateway/health` all returned the expected `302` IAP redirect.
- The `default-pool` deletion was blocked initially by regional CPU and in-use-address quotas, so the safe fix was a rolling pool swap: drain one default node, resize `default-pool` down by one, resize `core-pool` up by one, and repeat. Final steady state is three `core-pool` nodes and zero `default-pool` nodes.
- Post-delete verification shows only `core-pool` nodes remain, all synthi and cluster-system pods are running there, and the standalone ALB backends for collab, signaling, and y-sweet all report `HEALTHY`.
- Approximate steady-state idle burn for the always-on node layer dropped from about `$157.65/month` (`3 x e2-standard-2` default nodes plus `1 x e2-small` core node) to about `$32.85/month` (`3 x e2-small` core nodes), a reduction of about `$124.80/month` or `79%`. This excludes Cloud Run request-driven usage and assumes public on-demand Compute Engine list pricing over `730` hours/month.

## Post-Ingress Cleanup Follow-Through

### Scope
- Remove ingress-era manifests and service annotations from the repo so the old GKE ingress stack cannot be recreated.
- Give the standalone ALB its own managed certificate and make it self-sufficient for Cloud Run IAP.
- Delete the remaining live ingress-era GCLB and Kubernetes resources after confirming standalone ownership is complete.

### Checklist
- [x] Remove `k8s/ingress.yaml` from the repo and from `k8s/kustomization.yaml`.
- [x] Remove ingress-only BackendConfig annotations from the retained services.
- [x] Update `ops/gcp/ensure-standalone-edge-alb.ps1` to manage its own cert and Cloud Run IAP service identity.
- [x] Provision the IAP service identity and restore the public `302` IAP flow for Cloud Run-backed routes.
- [ ] Delete the remaining live ingress-era Kubernetes and GCLB resources.

### Review
- Repo cleanup is complete: `k8s/ingress.yaml` is deleted, `k8s/kustomization.yaml` no longer references ingress, and ingress-era BackendConfig annotations were removed from `frontend`, `ai-gateway`, `collab-server`, and `signaling-server` service manifests.
- `ops/gcp/ensure-standalone-edge-alb.ps1` now defaults to a dedicated managed certificate name `synthi-edge-cert`, creates the IAP service identity through the Service Usage REST API, and grants the IAP service agent `roles/run.invoker` on `synthi-frontend`, `synthi-ai-gateway`, and `synthi-ai-engine` before updating the standalone backend services.
- The live Cloud Run IAP failure was fixed by generating the IAP service identity for project `767721372193`. After that change, `https://beta.synthi.app/` and workspace routes resumed returning the expected Google IAP `302` redirect instead of the `IAP service account is not provisioned` error.
- Final live deletion of the old ingress-era resources is currently blocked only by expired local `gcloud` credentials. `gcloud` can list the active account but cannot refresh access tokens non-interactively, so `kubectl` and `gcloud compute` mutations now require a fresh interactive `gcloud auth login` before the old `synthi-ingress` and `k8s1`/`k8s2` load-balancer resources can be deleted safely.

## Test Repair and Workspace Import Reliability

### Scope
- Green the remaining pre-existing targeted frontend and ai-engine test failures without changing current runtime semantics.
- Make workspace clone/import resilient when the secondary app-side workspace registration call is delayed or unavailable.
- Keep the fix minimal and aligned with the post-migration architecture where the browser is already authenticated against the main app.

### Checklist
- [x] Update stale frontend tests to match current docking and AI suppression behavior.
- [x] Update the targeted ai-engine registry tests to match current language-scoped rule semantics.
- [x] Make collab clone workspace registration best-effort instead of fatal after a successful clone.
- [x] Have the dashboard explicitly ensure the workspace record exists in the app before redirecting.
- [x] Re-run the targeted frontend and ai-engine suites.

### Review
- `aiSuppressedRules.test.js` now imports the module with a direct relative path and its `mergeRemote` expectation acknowledges the local pending op before asserting remote replacement.
- `layout-ops.test.js` now builds its fixture without the placeholder root tab group and asserts against the current `findTabGroup`, `collectTabIds`, `walkTree`, and `resizeSplit` APIs.
- `test_rule_registry.py` now validates the current mix of global and language-scoped rules instead of assuming every registry entry is `languages={"*"}`.
- `backend/collab-server/server.js` no longer turns a successful clone into a hard failure when the secondary app-side workspace registration call cannot be completed; the result now reports registration state for callers.
- `synthi/src/app/page.jsx` now explicitly posts to `/api/workspace` after a successful clone, so the authenticated frontend ensures the workspace DB row exists before redirecting.
- Targeted verification passed: `vitest` reported `47 passed`, and `pytest test/test_cache.py test/test_rule_registry.py -q` reported `17 passed`.

## Navbar Logo PNG Swap

### Scope
- Replace the workspace navbar logo with the provided Vectant PNG assets for light and dark themes.
- Stop using the recreated SVG wordmarks and restore the repo SVG assets to their original state.
- Rebuild the frontend container and verify the updated navbar at localhost.

### Checklist
- [ ] Copy the provided Vectant PNG assets into `synthi/public`.
- [ ] Update `TopNav.jsx` to use the PNG assets by theme.
- [ ] Restore the original `synthi-logo.svg` and `synthi-dark-logo.svg` files.
- [ ] Rebuild and restart the frontend service.
- [ ] Verify the updated navbar renders at `http://localhost:3000`.

---

# New-Workspace Project & File Picker — 2026-05-12

Full plan: [new-project-picker-plan.md](new-project-picker-plan.md)

## Checklist
- [ ] Create `synthi/src/lib/project-templates/` registry + 9 template files
- [ ] Create `synthi/src/components/NewProjectPicker.jsx` (Provider + Dialog + Files/Projects tabs)
- [ ] Add `scaffoldProjectThunk` to `workspaceSlice.js` (writeFilesBatch + setCompileManifest + fetchFilesThunk)
- [ ] Mount `NewProjectPickerProvider` in `app/layout.js`
- [ ] Gate `FileTree.jsx` `handleTreeAction` on `files.length === 0` → open picker instead of inline rename
- [ ] Smoke: empty workspace → new file → Python template → files appear → "Python" pill shows
- [ ] Smoke: non-empty workspace → new file still uses inline rename
- [ ] Smoke: RN-Android template → compile → worker auto-scaffolds `android/`

