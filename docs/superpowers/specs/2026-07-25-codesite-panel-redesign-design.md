# CodeSite Panel Redesign — Design

Date: 2026-07-25
Status: approved, pending implementation plan
Target branch: `codesite-redesign` (from `dev`, at PR #664 merge)

## Problem

`synthi/src/components/codesite/CodeSitePanel.jsx` is 9,036 lines in one file. It renders
**21 `<Section>` blocks simultaneously** in a single scroll container. The 9-entry nav rail is
not a view switcher — `handleSelectSection` sets state and then scrolls the container to a
`[data-codesite-section]` anchor. Consequences:

1. **Crowding.** Everything is on screen at once. A first-time reader has no entry point and no
   sense of what matters.
2. **12+ sections are unreachable from the rail.** Agent Readiness, Filesystem Boundary Evidence,
   Conflict Forecast, Workstreams, Approvals, Transactions & Evidence, Inspections & Incidents,
   Artifact Export Preview, Audit Event Log, Required Actions, Agent Inbox, Inspections Queue,
   Work Scope Zones, and Policy Inputs have no nav entry at all. They are reachable only by
   scrolling past everything else.
3. **Layout breaks when narrow.** The panel uses *viewport* breakpoints to lay out a dock whose
   width is independent of the viewport. On a wide monitor a 380px sidebar still matches `xl:`,
   so it attempts two-column layouts with 430–460px minimums inside 380px of space.
4. **It churns.** `fetchCodeSiteRadarState` issues `5 + N` requests every 5s (N = distinct
   transaction ids) and re-renders all ~20 sections. Only 5 derived values are memoized.
5. **Slow first paint.** Nothing renders until the entire fan-out resolves, including artifact
   previews and quarantines the user may never open.
6. **Dead controls.** The `Active` / `Review` / `Evidence` buttons at line 1850 look like filters
   but have no `onClick`.

## Goals

- Reduce on-screen density without removing any functionality.
- Make the panel legible on first open.
- Work at four widths: narrow dock (320–420px), half-screen dock (600–900px), full-screen route,
  and mobile/tablet (<768px).
- Improve interaction latency, render churn, and time-to-first-paint.
- Make the panel look native alongside the other panels.

## Non-goals

- **The workspace graph is out of scope.** `ScopeTopology` and its helpers move file but their
  markup, layout, and behavior are unchanged pending a separate evaluation.
- No changes to `codesiteClient.js` endpoints or request/response shapes.
- No backend changes.
- No renaming of user-facing labels. The existing aviation vocabulary stays.

## The invariant

**Every user-facing action that exists today must exist after, and behave identically.**

This is enforced mechanically, not by review. Test ids are the contract. **The extraction must
match three forms**, because the panel's shared `IconButton` / `Section` / `OperatorPane`
primitives take a `testId` prop rather than writing `data-testid` inline, and several ids are
built from template literals:

- `data-testid="literal"`
- `testId="literal"` (prop form)
- ``data-testid={`codesite-tower-now-${card.key}`}`` (template form)

A `data-testid="..."`-only grep finds 76 ids and **misses all of the primary action buttons** —
`codesite-refresh`, `codesite-export`, `codesite-issue-permit-button`,
`codesite-route-propose-button`, `codesite-document-reject-button`,
`codesite-governance-review-confirm`, `codesite-quarantine-replay-button`,
`codesite-quarantine-apply-button`, `codesite-run-tower-simulator`. Every one of those could be
deleted without the check noticing. The correct pattern is:

```
(?:data-testid|testId)=(?:"([^"]*)"|\{`([^`]*)`\})
```

**Baseline: 103 distinct ids** at commit `e29b58b78`. Capture the list to
`tasks/codesite-testid-baseline.txt` as step 1 and assert the post-refactor set is a superset.
Any removal is a regression. This is a CI-checkable assertion, not a judgement call.

## Navigation structure

The rail becomes a real view switcher: **only the selected view mounts.** The 21 blocks collapse
into 10 views by adopting the orphans into the view they already belong to.

| View | Absorbs |
|---|---|
| **Overview** (new) | Attention digest, mission-control status rail, metric tiles, TowerNowStrip |
| **Graph** | ScopeTopology, Workstreams, Conflict Forecast, Work Scope Zones |
| **Activity** | Activity Feed (TowerStreamPanel), Agent Inbox, Audit Event Log |
| **Governance** | Governance Console, Required Actions |
| **Locks** | Path Locks, Approvals, Policy Inputs, Agent Readiness |
| **Quarantine** | Quarantine Review, Filesystem Boundary Evidence |
| **Evidence** | Success Metrics, Transactions & Evidence, Artifact Export Preview |
| **Inspections** | Inspections & Incidents, Inspections Queue |
| **Replay** | Replay Handover, Lineage Inspector |
| **Simulator** | Coordination Simulator |

**Overview is the landing view**, replacing `radar`. It is a digest — what needs attention, what
is in flight, current status — with drill-in to the other nine. It is the answer to "someone
opening it for the first time."

The existing `TowerNowStrip` cards and `CodeSiteOperatingModel` rows already call
`onSelect(section)`; they keep working, now as real view switches instead of scroll jumps.

## File architecture

```
components/codesite/
  CodeSitePanel.jsx            shell: header, rail, view router, provider
  codesiteClient.js            unchanged
  state/
    CodeSiteDataProvider.jsx   context: core data, per-view data, actions
    useCodeSiteCore.js         core fetch + SSE + fallback poll
    useCodeSiteActions.js      the 18 mutation handlers
  lib/
    format.js                  formatters/helpers (lines 1–1347)
    quarantine.js              record normalize/merge (lines 891–1221)
    graph.js                   path-overlap math (lines 5309–5461)
  ui/
    Pill, Metric, Section, OperatorPane, Row, PathList, TagList,
    JsonPreview, SignalBar, IconButton, StatusRailItem
  views/
    OverviewView, GraphView, ActivityView, GovernanceView, LocksView,
    QuarantineView, EvidenceView, InspectionsView, ReplayView, SimulatorView
```

The ~30 presentational sub-components (lines 1348–6868) move next to the view that owns them.
Components used by more than one view go in `ui/`.

## Data flow

State moves from 17 top-level `useState` + 35 derived locals into `CodeSiteDataProvider`. Views
consume context rather than receiving drilled props. With one view mounted at a time, context
re-render breadth is bounded by that view.

The single `fetchCodeSiteRadarState` fan-out splits:

- **Core** — projects, project, controlState, counts. Feeds the header, rail badges, and Overview.
  This is all first paint waits on.
- **Per-view** — metrics, artifact preview, quarantines, line provenance. Fetched when the owning
  view mounts.

`fetchCodeSiteRadarState` is retained as the composite entry point but is decomposed so the shell
can call the core slice alone.

### Liveness

**SSE-first.** `subscribeCodeSiteProjectEvents` already streams 36 named event types and is
already wired. It becomes the primary liveness mechanism. Polling drops from 5s to ~30s as a
safety net, and only the mounted view polls.

Risk: any data not covered by an SSE event type goes stale for up to 30s. Mitigation — the
implementation plan must map each view's data to the SSE event types that invalidate it, and any
view whose data has no corresponding event keeps a shorter poll.

## Responsiveness

Replace viewport breakpoints with **`@container` queries** on the panel root, so layout responds
to the panel's own width rather than the window's. This is the root-cause fix: it makes all four
width targets work from one code path instead of four sets of breakpoints.

Specific sites to convert (from the audit):

- Fixed-min two-column splits: lines 7979 (460px), 8086 (430px), 4111 (fixed 280px), 3477, 4663,
  2443, 6072, 5696, 5887.
- Unconditional multi-column grids that break first: 4074, 2954, 8971, 4438, 5902, 5775, 6174,
  1524, 3620, 3782, 6693, 4398.
- Content-agnostic fixed column counts: 2221 (`lg:grid-cols-4`), 2815, 1866/1884.
- `TowerNowStrip` (line 1679): six cards at `min-w-[9.25rem]` = ~888px minimum inside an
  `overflow-x-auto`. Must reflow, not scroll, in a narrow dock.
- `scroll-mt-32 md:scroll-mt-24` (1419, 1926) hardcodes an assumed sticky-rail height while
  `handleSelectSection` separately measures it at runtime. Both mechanisms disappear with view
  switching — there is nothing left to scroll to.

Native fit: the panel already inherits `--codesite-*` from `[data-panel-type="codesite"]` in
`globals.css` as of commit `e29b58b78`. Remaining one-off inline gradients and borders should
resolve to those tokens.

## Behavior changes required by view switching

### `handleRequiredActionReview` (line 7035)

Today it switches to `governance`, then `document.querySelector`s the matching approve / apply /
resume button and programmatically clicks it. This works only because every section is always
mounted. Under view switching the target is not in the DOM when Required Actions is visible.

Redesign as state: Required Actions sets a pending-target descriptor
(`{entity, entityId, kind}`) in context; `GovernanceView` mounts, reads it, scrolls the matching
row into view and opens `GovernanceReviewGate` on it. Same observable behavior, no DOM coupling.

### Saved views

The `Active` / `Review` / `Evidence` buttons become functional filters over the operating queue,
which is the natural remedy for density: showing only what needs action. Selection is local UI
state; no persistence.

## Error handling

- Core fetch failure keeps the existing global error banner (`codesite-error-state`) with retry.
- Per-view fetch failure renders inline within that view, following the pattern already used by
  `lineInspector.error`, `quarantineReview.error`, and `simulationRun.error`.
- A failing view does not blank the shell; the rail and header stay usable.
- The global `acting` mutex is retained so mutations remain serialized.

## Testing

`__tests__/CodeSitePanel.test.jsx` is 1,166 lines and queries testids directly. Under view
switching, a testid is only present when its view is mounted — so those queries need a
navigate-first helper (`await selectSection('governance')`) before asserting.

This is real work and the main cost of the redesign. Plan:

1. Add the testid-set assertion described under **The invariant**, and capture the baseline set
   from `HEAD` before any code moves.
2. Add a `renderPanelAt(section)` helper; migrate existing tests to it.
3. Add a per-view smoke test: each of the 10 views mounts and renders its expected actions.
4. Add a regression test for the `handleRequiredActionReview` rewrite — clicking Review from
   Required Actions must open the review gate on the correct Governance row.

Existing assertions on handler behavior should not change, only where the test navigates first.

## Risks

| Risk | Mitigation |
|---|---|
| An action is silently lost in the file split | Mechanical testid set diff, baseline captured first |
| SSE does not cover some data, causing staleness | Map data→event types per view; shorter poll where uncovered |
| Test suite churn is large enough to hide a real regression | Migrate tests in a separate commit from the refactor, so the diff is reviewable |
| Per-view fetch changes observed data shape | Keep `normalizeCodeSiteRadarState` as the single normalizer |
| Context re-renders become the new perf problem | Only one view mounts; split context if profiling shows it |

## Sequencing

The refactor and the redesign should not land as one commit. Suggested order, each independently
verifiable:

1. Capture the testid baseline; add the invariant assertion.
2. Extract `lib/` helpers and `ui/` primitives — pure moves, no behavior change, tests untouched.
3. Extract views as-is, still all rendered, still scroll-anchored — pure moves.
4. Flip the rail to view switching; migrate tests to navigate-first.
5. Rewrite `handleRequiredActionReview` as state.
6. Add the Overview view.
7. Split core vs per-view fetch; move to SSE-first.
8. Convert layout to container queries.
9. Wire the saved-view filters.

Steps 2 and 3 are mechanical and should produce no test changes at all — if they do, something
moved that should not have.

## Open questions

None blocking. Deferred by explicit decision: the workspace graph's own layout and interaction
model, pending evaluation.
