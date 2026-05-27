# Source Control: The Conduit — Vectant Redesign

**Status:** Spec — awaiting user approval
**Date:** 2026-05-21
**Branch:** frontend-refactor
**Scope:** All git-related surfaces in `synthi/src/components/git/` plus the explorer-footer summary, the activity-bar entry point, and the merge conflict editor.

---

## 1. Goal

Apply the Vectant design language — already mature in the StatusBar island, healing system, and chat surface — to the source-control experience. Today's git UI uses 89 hardcoded tailwind colors (violet / indigo / emerald / teal / rose / amber) and a stacked-column layout with 8+ sections. The result feels like generic VS Code, not Vectant.

This redesign:

1. Strips the rainbow to a 3-color discipline (calm slate-violet · attention-purple · brand gradient · danger red, plus one keep-color for untracked).
2. Restructures the column so the user always sees "what to do next" without scanning.
3. Adopts the chat-style sticky-bottom composer metaphor, mirroring AI chat.
4. Reserves the brand gradient for five intentional signature moments.
5. Decomposes the 86KB `GitStatus.jsx` monolith into focused components.

**Out of scope:** Redux slice changes, gitClient API changes, file-state semantics, or any behavioral change. Pure restyle + restructure. Existing tests and flows continue to pass.

## 2. Design language reference

All tokens already exist in `globals.css`. The redesign reuses them — it does not introduce new ones.

**Colors:**
- `--brand-gradient` (pink → red → purple → blue) — signature moments only
- `--attention-purple` (#b545ff) — "this is the focal thing right now"
- `--accent-tertiary` (#4d4870) — calm slate-violet, the everyday border
- `--accent-danger` (#ff5757) — conflicts and destructive actions only
- `--text-primary` / `--text-secondary` / `--text-muted` / `--text-dim` — typography
- `--bg-app` / `--bg-panel` / `--bg-surface` / `--bg-elevated` — surfaces
- `--accent-success` (#4ade80) — the one keep-color, for untracked (`??`) files only

**Utilities:**
- `vt-brand-bar` — 2px vertical gradient stripe (active rows)
- `vt-brand-text` — gradient-clipped text (the V glyph)
- `vt-brand-fill` — gradient background (committed buttons)
- `vt-brand-pulse` — 2.2s slow halo (AI / fetching states)
- `vt-brand-sweep` — moving gradient sweep (streaming, push success)
- `vt-ambient-bottom` / `vt-ambient-top` — 1px ambient gradient hairline (chrome trim)
- `vt-rim` / `vt-rim-active` — soft brand halo on focused surfaces
- `synthi-card` / `synthi-pill` / `synthi-label` — surface and typography classes
- `heal-row-enter` / `heal-applied-flash` / `heal-line-sweep` — motion patterns
- `th-input` / `th-btn-ghost` / `th-action` / `th-focus-ring` — themed widget classes

**Typography:** `--font-ui` (SF Pro Display). Section headers `synthi-label` (11px, uppercase, tracked). File names 12px primary. Tabular nums on all counts.

## 3. Layout — the Conduit column

The SCM panel (rendered when `sidebarView === 'scm'` in `synthi/src/app/workspace/[slug]/page.jsx:2789`) is a single vertical column. The new structure top-to-bottom:

```
┌── SOURCE CONTROL ─────────────────────────┐
│ [V] frontend-refactor          ↑3  ↓0  ⟳  │  Branch Bridge (36px)
│ ··········· vt-ambient-bottom ············│
│ ┌────────────────────────────────────────┐│
│ │ ✦ 3 commits ready to push              ││  Focal State Card (morphs)
│ │                            [Push  →]   ││  (sticky, 80–120px)
│ └────────────────────────────────────────┘│
│                                            │
│ ⚠ CONFLICTS (1)                           │  if present
│  ┃ ! MergeFile.jsx          [resolve]     │
│                                            │
│ STAGED (2)               [unstage all]    │  vt-brand-bar (gradient)
│  ┃ ● StatusBar.jsx                  M     │
│  ┃ ● globals.css                    M     │
│                                            │
│ CHANGES (3)              [stage all]      │  calm slate-violet edge
│  ╎ ○ VectantLogo.jsx                M     │
│  ╎ ○ compact-vhdx.ps1               U·    │  green tint (untracked)
│  ╎ ○ settings.local.json            M     │
│                                            │
│   ┌─ Files · History · Stashes ─┐         │  sub-view pills (28px)
│   └─────────────────────────────┘         │
│═══════════════════════════════════════════│  vt-ambient-top
│  ┌──────────────────────────────────────┐ │  Composer (sticky bottom)
│  │ feat: ...                            │ │  44px collapsed → 180px open
│  │                            ✦   ⏎     │ │  gradient ring on focus
│  └──────────────────────────────────────┘ │
└───────────────────────────────────────────┘
```

### 3.1 Branch Bridge (top, 36px)

`<BranchBridge>` — new component, ~120 lines. Replaces today's section header.

Contents (left → right):
- The V glyph (`vt-brand-text` gradient-clipped). Click → branch picker (existing `BranchSelector` dropdown). The V is the brand's signature; it lives on the panel header just like it lives at the Status Island center.
- Branch name in `--text-primary`, 13px medium.
- Ahead/behind chips: `↑3` and `↓0` in tabular nums, muted when zero, calm slate-violet when nonzero. No tailwind colors.
- Fetch (refresh) icon button, `th-btn-ghost`. Clicking triggers `vt-brand-pulse` on the focal card.
- Overflow menu (gear) for: manage remotes, stash list, init repo, clone, GitHub token modal.

Bottom border is a 1px `vt-ambient-bottom` line — same ambient haze the StatusBar uses at its top edge. Subliminal but present.

### 3.2 Focal State Card (`<FocalCard>`)

`<FocalCard>` — new component, ~250 lines. The heart of the noise-reduction design.

A single morphing card. Its content & rim treatment reflect the single most important state. State precedence (highest first):

| Precedence | State | Title | Action | Rim |
|---|---|---|---|---|
| 1 | No repo | "No git repository" | "Initialize" gradient button | none |
| 2 | Conflicts | "N files need resolution" | "Resolve →" pill | `--accent-danger` rim |
| 3 | Fetching / pulling / cloning | "Syncing…" / "Pulling…" | (spinner) | `vt-brand-pulse` |
| 4 | Diverged (ahead AND behind) | "Diverged — N up, N down" | "Sync" split-button menu | `--attention-purple` rim |
| 5 | Behind only | "⇣ N incoming commits" | "Pull" pill | faint `vt-rim` |
| 6 | Ahead only | "✦ N commits ready to push" | "Push →" gradient pill | faint `vt-rim` |
| 7 | Has changes | (hidden — files take lead) | — | none |
| 8 | Clean & in sync | (hidden) | — | none |

Transitions: 220ms `cubic-bezier(0.16, 1, 0.3, 1)`. Card mount/unmount uses `heal-row-enter`.

The card is sticky-relative to the scrollable middle — if you scroll the file list, the card stays pinned below the Branch Bridge.

### 3.3 File sections (scrollable middle)

`<FileSections>` — new component, ~300 lines. Replaces the existing changes/staged/conflicts blocks in GitStatus.jsx.

Three sections, rendered in this order if present: Conflicts, Staged, Changes.

**Section header**: `synthi-label` (uppercase, tracked), count chip in tabular nums, and a single ghost-button overflow action (`stage all` / `unstage all` / `discard all` confirm-required) on hover.

**Row anatomy** (32px tall, 12px gutter, 4px gap):
- Left edge: 2px vertical bar.
  - Conflicts: `--accent-danger`
  - Staged: `vt-brand-bar` (gradient stripe — the only place in the file list where the brand surfaces)
  - Changes: `--accent-tertiary` calm slate-violet hairline (1px)
- Status dot (4px filled circle, dimmed):
  - Conflict: red filled circle (subtle pulse)
  - Staged: muted filled circle
  - Modified: muted ring
  - Untracked: `--accent-success` ring (the one keep-color — universal "new" signal)
  - Deleted: muted X
- File name (`--text-primary`, 12px medium)
- Dir path (`--text-muted`, 10px, ellipsis-left if path is long)
- Status badge (right-aligned, `synthi-label` style, 10px): `M`, `A`, `D`, `??`, `U`, `R`
- Hover-revealed icon row (3 icons, no labels): diff (Edit3), stage/unstage (Plus/Minus), discard (Trash2). All `th-btn-ghost`.

**Active selection**: clicking a row opens the diff in the editor area; the active row gets a `--attention-purple` left bar (overrides the 2px gradient or hairline) and `--bg-elevated` background. Same focus treatment as the file tree.

**Row mount/unmount**: `heal-row-enter` for stage/unstage transitions. When a file moves between sections (e.g., user stages it), the row slides up into Staged with `heal-line-sweep` — the same gradient ripple used after a healed line — leaving a brief brand-tinted trail.

**Empty states** (per section):
- Conflicts: not rendered when empty
- Staged: not rendered when empty
- Changes: not rendered when empty
- All three empty: `<FileSections>` itself renders `<CleanState>` (see §3.5)

### 3.4 Sub-view pills (`<SubViewPills>`, 28px)

`<SubViewPills>` — new component, ~80 lines. A 3-tab pill row replacing today's separate stacked sections.

Tabs: `Files` (default) · `History` · `Stashes`

Each tab is a pill (`synthi-pill` style). Active tab uses `[data-state="active"]` styling already defined in globals.css (attention-purple bg + border). Inactive tabs use the calm muted treatment.

- `Files` → renders `<FileSections>` above
- `History` → renders `<CommitHistoryPanel>` (existing, restyled)
- `Stashes` → renders a new compact stash list (current `stashList` selector)

Switching tabs swaps the middle scroll region content. Pull Requests stay in their own sidebar tab (`sidebarView === 'pullrequests'`) — the redesign coordinates it visually but does not consolidate. This preserves the activity-bar's existing pull-request entry and avoids breaking muscle memory.

### 3.5 The Composer (`<CommitComposer>`, sticky bottom)

`<CommitComposer>` — new component, ~350 lines. The chat-style sticky-bottom input.

**Anatomy**:
- Outer container: `vt-ambient-top` 1px hairline above, `--bg-panel` background, `synthi-card` corners.
- Textarea: `th-input` with `th-focus-ring-inset`. Auto-grow from 1 line (~44px) to max 6 lines (~180px). When focused, the border ring goes attention-purple via the existing inset focus-ring class.
- Placeholder rotates based on context (re-mounts every 5s): `Summarize 3 changes…`, `Describe what you fixed…`, `feat: …`, `Why does this matter?`
- Below the textarea (only when expanded/focused):
  - Commit-type chips: a row of compact pills for `feat`, `fix`, `docs`, `refactor`, `chore`. Click prepends `feat: ` to the textarea (and replaces an existing type prefix if present). Selected chip = `attention-purple` per data-state pattern. Replaces today's emoji buttons.
  - Optional "extended description" — a second smaller textarea that appears under a small "+ details" ghost button. Maps to `commitBody` in `GitStatus.jsx:194`.
  - "Amend last commit" toggle — appears only when the last commit is unpushed (`unpushedCommits.length > 0` AND no merge in progress).

**Action button** (right side of textarea row):
- **Disabled** (`!message || nothingStaged`): `synthi-dim` ghost ⏎ icon
- **Ready** (message + staged): `vt-brand-fill` pill labeled "Commit"
- **Ready & ahead** (after commit will produce a push opportunity): pill becomes a split button "Commit & Push" with a chevron split that surfaces "Commit only"
- **Submitting**: button text replaced with a heal-check-morph spinner-to-check transition
- **Submitted**: button briefly shows `heal-applied-flash`, then the composer clears and the staged files animate out via `heal-line-sweep` as they shift to history

**AI sparkle (✦)** — left of the action button:
- Click triggers AI commit-message generation.
- While streaming, the textarea border shows `vt-brand-sweep` and the message text appears token-by-token. Same treatment as the AI chat.
- Generation is opt-in only — never auto-triggers. (Per design decision: click-to-generate.)
- Source: existing `/api/completion` route can be adapted, or we add a `/api/commit-message` route that takes the diff. Implementation detail for the plan phase — for now the button is wired to a placeholder action that no-ops, so the visual lands without backend changes blocking the UI redesign.

### 3.6 Clean / empty / loading states

- **No repo** (`status === null`): Focal Card shows the Vectant V centered with an "Initialize" gradient button. File sections and composer are hidden. Same V treatment used in the Status Island first-mount.
- **Clean & in sync**: All file sections hidden. Focal Card hidden. Composer shows a passive placeholder: "Branch up to date — nothing to commit." Action button is permanently disabled in this state.
- **Loading**: skeleton rows with the existing `synthi-pulse` animation. Three skeleton rows per visible section.
- **Action error**: shown as a thin red strip just above the composer (matches today's `actionError` placement) but restyled with `--accent-danger-soft` background and a single-line dismiss control.

## 4. Coordinated sibling surfaces

### 4.1 `GitSummaryPanel` (explorer footer)

Becomes a smaller mirror of the Focal State Card. Today (`synthi/src/components/git/GitSummaryPanel.jsx`) it uses `#6366f1, #8b5cf6, #a78bfa` (generic indigo/violet) for its accent line and `emerald/teal/amber/rose` for file states.

Changes:
- Replace gradient accent line with `vt-ambient-bottom` using the real brand stops.
- Header pill chip uses `vt-brand-text` for the V if `totalChanges > 0`, else dim.
- Expanded file rows adopt the same row anatomy as `<FileSections>` (left bar by section, status badge, no rainbow).
- "Open full view →" footer link uses `th-action`.

### 4.2 `CommitHistoryPanel`

Today (`synthi/src/components/git/CommitHistoryPanel.jsx`) has 7 hardcoded tailwind colors. Replace with calm slate-violet baseline. Conventional-commit type prefix (`feat:`, `fix:`) becomes a small `synthi-label` chip in the muted style — not a colored block. Active commit row uses `--attention-purple` left bar.

### 4.3 `PullRequestsPanel`

Stays in its own sidebar tab. Restyled to share:
- The same `<BranchBridge>` header (or a PR-list variant of it)
- The same row treatment (status pill, attention-purple for active PR)
- A composer-style "Quick reply" box at the bottom on `<PRDetail>` (`synthi/src/components/git/PRDetail.jsx`).

Result: switching between the SCM tab and the PR tab feels like rooms in the same building.

### 4.4 `MergeConflictEditor`

Adopts the danger-only color discipline. The conflict markers in the diff use `--accent-danger` ambient. "Ours / Theirs / Both / Cancel" action buttons become chips matching the composer's commit-type chips. AI suggestion (signature moment) appears as a faint `vt-rim` ghost card above the conflict block — same component pattern as `AIFixCard` in the healing system. Reuse the existing healing UI primitives where possible.

### 4.5 `InteractiveRebasePanel`

Rows adopt the same anatomy as `<FileSections>` rows. Drag handle uses the same grip glyph as the Status Island. Action chips (pick / squash / drop / reword / edit) match composer-chip style.

### 4.6 `BranchSelector`

Already uses Vectant tokens (good citizen). Minor touch-ups: ensure the V glyph appears in the trigger when used inside the Branch Bridge; keep its existing Status-Island integration unchanged.

### 4.7 `CreatePRForm`, `GitHubTokenModal`, `HunkStagingView`

Restyle for token consistency. No structural changes.

## 5. File decomposition

`GitStatus.jsx` is 86KB / ~2000 lines today. The skill notes explicitly warn it is enormous and brittle. The redesign is the natural moment to split it.

New file layout under `synthi/src/components/git/scm/`:

| File | ~Lines | Purpose |
|---|---|---|
| `SourceControlPanel.jsx` | 200 | Top-level container; wires redux selectors; renders the children below. Replaces the body of `GitStatus.jsx`. |
| `BranchBridge.jsx` | 120 | Branch header with V glyph, name, ahead/behind, fetch, overflow menu. |
| `FocalCard.jsx` | 250 | Morphing state card with state precedence logic. |
| `FileSections.jsx` | 300 | Conflicts/Staged/Changes sections + Virtuoso virtualization for long lists. |
| `FileRow.jsx` | 150 | Single row component (extracted so it can be virtualized cleanly). |
| `SubViewPills.jsx` | 80 | 3-tab pill switcher. |
| `CommitComposer.jsx` | 350 | Textarea + chips + amend + action button + AI sparkle. |
| `CommitTypeChips.jsx` | 60 | Type pill row component. |
| `StashList.jsx` | 120 | Stash sub-view content (extracted from GitStatus). |
| `OverflowMenu.jsx` | 120 | Remotes manager + init + clone + token modal trigger (replaces today's scattered add-remote / clone UI). |
| `useFocalCardState.js` | 80 | Hook that derives the focal card's current state from redux. |
| `scm-tokens.css` | 80 | Component-scoped utility classes used only by SCM (e.g. `.scm-row`, `.scm-section`, `.scm-composer-ring`). |

`GitStatus.jsx` stays as a thin re-export shim during the migration so existing imports (`@/components/git/GitStatus`) continue to work without touching `synthi/src/app/workspace/[slug]/page.jsx`.

Total: ~1900 lines spread across 12 files. Each file is under the 250-line "thin slice" target except `CommitComposer.jsx` (~350 lines — the most logic-dense piece) and `FileSections.jsx` (~300 lines).

## 6. Five signature moments — exact placements

The brand gradient touches surfaces in these locations only. Any new gradient use outside these is a regression of the design intent.

1. **The V** — `<BranchBridge>` glyph, `vt-brand-text` gradient-clipped.
2. **Staged left-edge bar** — every staged file row's 2px left edge uses `vt-brand-bar`.
3. **Focal Card pulse** — `vt-brand-pulse` only during fetch/pull/clone. Removed once the operation completes.
4. **Commit button** — `vt-brand-fill` when valid; `vt-brand-sweep` on the textarea border while AI is streaming.
5. **Push success ripple** — single `vt-brand-sweep` pass across the `vt-ambient-bottom` hairline of `<BranchBridge>` for ~700ms after a successful push.

## 7. Motion grammar

All motion uses existing keyframes — no new ones added.

| Trigger | Animation | Duration |
|---|---|---|
| Row mount (file appears) | `heal-row-enter` | 220ms |
| Row state change (stage → staged) | `heal-line-sweep` ripple | 2400ms (fades) |
| Focal card state morph | content fade + scale transition | 220ms cubic-bezier(0.16, 1, 0.3, 1) |
| Fetch / pull active | `vt-brand-pulse` on Focal Card | 2.2s loop |
| AI message streaming | `vt-brand-sweep` on composer border | 3.5s loop while streaming |
| Commit submit | `heal-applied-flash` on action button | 720ms |
| Push success | `vt-brand-sweep` on Branch Bridge hairline | one pass, ~700ms |
| Reduced motion | All above disabled via existing `@media (prefers-reduced-motion: reduce)` blocks | — |

## 8. State contract — what the components consume

To preserve the "no behavioral change" constraint, every new component reads from the same redux selectors and dispatches the same thunks as today.

- `state.git.status` → file list (staged, changes, conflicts)
- `state.git.currentBranch`, `state.git.branches` → BranchBridge
- `state.git.unpushedCommits`, `state.git.incomingCommits` → FocalCard ahead/behind
- `state.git.actionLoading`, `state.git.actionError` → composer + error strip
- `state.git.statusLoading` → skeleton loading state
- `state.git.stashList` → StashList sub-view
- `state.git.commitHistory` → CommitHistoryPanel (existing)
- `state.git.conflictResolverFile` → opens MergeConflictEditor (existing flow)

Dispatched thunks: `fetchGitStatus`, `stageFile`, `unstageFile`, `stageAll`, `unstageAll`, `commitChanges`, `pushChanges`, `pullChanges`, `discardChange`, `discardAll`, `fetchRemote`, `stashPush`, `stashPop`, `stashApply`, `stashDrop`, `initRepo`, `cloneRepo`, `addRemote`, `setRemoteUrl`, `removeRemote`, `clearError`, `openConflictResolver`. All exist in `synthi/src/redux/gitSlice.js` unchanged.

## 9. Accessibility

- All interactive elements: `th-focus-ring` (existing keyboard-focus class).
- Status badges: `aria-label` describing the state ("modified", "staged", "untracked", "conflict").
- Color is never the only signal: every status uses both a left bar AND a text badge.
- Reduced motion: respected via existing `@media (prefers-reduced-motion: reduce)` blocks in globals.css.
- File rows are keyboard-navigable (`tabIndex`, Arrow up/down to move selection, Enter to open diff, Space to stage/unstage). Same shortcuts the file tree uses.

## 10. Migration & risk

**Risk**: `GitStatus.jsx` is large and load-bearing. The skill's gotcha #5 says any edit risks regressions across the whole git UI. Mitigation:

1. The new components live in a new `scm/` sub-directory. The existing `GitStatus.jsx` stays in place during the migration and gets replaced last.
2. We ship behind a runtime flag if needed (`localStorage.synthi:scm-redesign === '1'`) — initially the new panel is the default, the old GitStatus is reachable for a quick comparison while validating. Flag is removed once stabilized.
3. Each new component is a pure presentational shell over the existing redux selectors/dispatchers — no thunk changes, so all redux-level behavior is unchanged by definition.
4. The PR panel, commit history panel, and merge conflict editor get *visual* updates only (color tokens, row anatomy). Their internal logic is untouched.

**Rollback**: removing the `scm/` directory and restoring the original `GitStatus.jsx` reverts the redesign cleanly. Redux remains untouched.

## 11. What is explicitly NOT in scope

- No changes to redux slice, thunks, or gitClient.
- No changes to `synthi/src/app/api/github/**` routes.
- No changes to MergeConflictEditor's resolution semantics — just its color/chip styling.
- No new gradient utilities — reuse existing `vt-*` tokens.
- No AI commit-message backend route in this redesign — the ✦ button is wired but the backend can be a follow-up task. The visual must land without it.
- No consolidation of the PR tab into SCM — they stay separate.
- No changes to terminal, editor, file tree, status island.

## 12. Acceptance criteria

A user opening the SCM panel after this lands should see:

- [ ] The V glyph at the top-left, gradient-clipped. Clicking it opens the branch picker.
- [ ] Branch name, ahead/behind chips, fetch button on the same row, all using brand tokens.
- [ ] A 1px ambient gradient hairline below the branch bridge.
- [ ] The Focal State Card shows "ready to push" / "incoming" / "conflicts" / etc. based on real state — never two focal messages at once.
- [ ] File sections show CONFLICTS (if any), STAGED (gradient left bar), CHANGES (calm hairline).
- [ ] Untracked files have a faint green ring on their status dot. All other states use neutral muted colors.
- [ ] Sub-view pills (Files / History / Stashes) sit just above the composer.
- [ ] Composer is sticky at the bottom, single-line collapsed, expanding to multi-line on focus.
- [ ] Composer's commit button is gradient-filled when valid, ghost when invalid.
- [ ] The ✦ AI sparkle button is visible (functional or placeholder per backend availability).
- [ ] Fetching/pulling wraps the Focal Card in a slow brand-pulse halo.
- [ ] After a successful push, a brief gradient sweep crosses the branch bridge hairline.
- [ ] No tailwind hardcoded colors remain in any SCM-related file. `grep -E "(violet|indigo|emerald|teal|rose|amber|cyan|sky|fuchsia)-[0-9]{3}" synthi/src/components/git/` returns zero matches.
- [ ] Reduced-motion users see no animations.
- [ ] All existing git operations continue to work (commit, push, pull, stage, unstage, discard, stash, branch switch, conflict resolve, clone, init).

## 13. Execution sequence (high-level)

See `tasks/todo.md` for the file-by-file checklist. The sequence:

1. Add `scm-tokens.css` and any small classes used by the new components (composer ring, section spacing, row anatomy).
2. Build the new components in `synthi/src/components/git/scm/` bottom-up: `FileRow` → `FileSections` → `BranchBridge` → `FocalCard` → `SubViewPills` → `CommitComposer` → `OverflowMenu` → `StashList` → `SourceControlPanel`.
3. Replace the body of `GitStatus.jsx` with a re-export of `SourceControlPanel`.
4. Restyle `GitSummaryPanel.jsx` to mirror the Focal Card aesthetic.
5. Restyle `CommitHistoryPanel.jsx`, `PullRequestsPanel.jsx`, `PRDetail.jsx`, `MergeConflictEditor.jsx`, `InteractiveRebasePanel.jsx`, `CreatePRForm.jsx`, `HunkStagingView.jsx`, `GitHubTokenModal.jsx` for token consistency.
6. Verify via the acceptance criteria checklist above.
7. Remove any remaining hardcoded tailwind color usages in the git/ directory.
