# CodeSite Panel Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `CodeSitePanel.jsx` — 9,036 lines rendering 23 sections at once — into a shell plus ten mountable views, without losing a single user-facing action.

**Architecture:** Three parts, each landing working software. **Part A** is pure decomposition: helpers and presentational components move out of the god-file into `lib/`, `ui/`, and `views/`, with zero behavior change and zero test edits. **Part B** flips the nav rail from a scroll-spy into a real view switcher, replaces the DOM-clicking `handleRequiredActionReview` with state, and adds an Overview landing view. **Part C** splits the 5+N-request fan-out into core vs per-view, moves liveness to SSE-first, and converts viewport breakpoints to container queries so the panel lays out against its own width.

**Tech Stack:** Next.js 15.5, React 19, Tailwind CSS v4 (native container queries — no plugin), framer-motion 12, lucide-react, Radix Select, vitest + jsdom.

---

## Before you start

**Branch:** `codesite-redesign`, cut from `dev` at the PR #664 merge.

**The one command you will run constantly:**

```bash
cd synthi && npx vitest run src/components/codesite
```

Expected at every commit boundary in this plan: `Test Files 2 passed (2)`, `Tests 8 passed (8)`. If you see fewer tests than the previous task, you deleted one — that is a regression, not progress.

**Two things are already done** (do not redo them):

- `tasks/codesite-testid-baseline.txt` holds the 103 test ids present before any code moved.
- `synthi/src/components/codesite/__tests__/testIdInvariant.test.js` asserts the ids in source stay a superset of that baseline. It is the guardrail for "keep every functionality." It has been verified to actually fail when an id disappears.

**What that guardrail does and does not catch.** It catches a *deleted or renamed* action. It does **not** catch an action that still renders but is wired to the wrong handler. So for every component you move, the rule is: **move the code, do not retype it.** Cut and paste the exact lines. Do not "clean up while you're in there." Every prop that went in must still go in.

**Why Part A must produce no test changes.** Parts A's tasks are mechanical moves. If a test starts failing during Part A, you did not discover a latent bug — you made a mistake in the move. Revert the step and redo it. Test edits are legitimate only in Part B, where view switching genuinely changes where a testid lives.

**Do not touch the graph.** `ScopeTopology` (6283–6848), `WorkGraphNode` (5535–5584), `WorkGraphConnector` (5491–5533) and the overlap math (5309–5461) **change file but not a single character of content.** The user has explicitly deferred the graph's layout and interaction model pending their own evaluation. Moving it is in scope. Restyling it, reflowing it, or "fixing" its `hidden md:flex` connectors is not.

---

## File structure

All paths relative to `synthi/src/components/codesite/`.

| File | Responsibility | Source lines |
|---|---|---|
| `lib/format.js` | Value formatting, array/tone/time helpers, transaction shaping | 93–566, 757–800, 1222–1346 |
| `lib/governance.js` | Governance predicates + required-action accessors | 568–749 |
| `lib/quarantine.js` | Quarantine record normalize / merge / lifecycle | 801–1221 |
| `lib/graph.js` | Path-overlap math and zone helpers | 5289–5490 |
| `lib/governanceActions.js` | **New in Part B.** Shared `queueGovernanceAction` payload builders + review-target resolution | — |
| `ui/Pill.jsx` … `ui/JsonPreview.jsx` | Primitives used by more than one view | see Task 3 |
| `state/CodeSiteDataProvider.jsx` | **New in Part B/C.** Context: data, actions, active view, pending review target | — |
| `views/<area>/*.jsx` | The 22 presentational components, each next to the view that owns it | see Task 5 |
| `views/OverviewView.jsx` … `views/SimulatorView.jsx` | The ten mountable views | see Task 8 |
| `CodeSitePanel.jsx` | Shell only: header, project select, rail, view router | — |

`codesiteClient.js` is **not modified** in this plan. Endpoints and payload shapes are unchanged throughout.

### The 23 blocks and where each one goes

This mapping is the contract for Task 8. It follows the approved spec table.

**Line numbers below are as of commit `854829632` (end of Part A), in the
2,277-line `CodeSitePanel.jsx`.** They shift as soon as you start moving blocks —
after the first extraction, find the rest by their `title=` / `sectionKey=`
string, not by line.

| View | Blocks it absorbs (line at 854829632) |
|---|---|
| **Overview** (new) | mission-control header, status rail, `TowerNowStrip`, `CodeSiteOperatingModel` — all above line 1333 |
| **Graph** | Workspace Graph 1333, Conflict Forecast 1595, Workstreams 1670, Work Scope Zones 2200 |
| **Activity** | Activity Feed 1418, Audit Event Log 1993, Agent Inbox 2083 |
| **Governance** | Governance Console 1444, Required Actions 2001 |
| **Locks** | Path Locks 1507, Agent Readiness 1520, Approvals 1712, Policy Inputs 2239 |
| **Quarantine** | Filesystem Boundary Evidence 1540, Quarantine Review 1564 |
| **Evidence** | Success Metrics 1487, Transactions & Evidence 1777, Artifact Export Preview 1929 |
| **Inspections** | Inspections & Incidents 1795, Inspections Queue 2154 |
| **Replay** | Replay Handover 1908, Lineage Inspector 2180 |
| **Simulator** | Coordination Simulator 1640 |

Twelve of those blocks have no nav entry today and are reachable only by scrolling: Agent Readiness, Filesystem Boundary Evidence, Conflict Forecast, Workstreams, Approvals, Transactions & Evidence, Inspections & Incidents, Artifact Export Preview, Audit Event Log, Required Actions, Agent Inbox, Inspections Queue, Work Scope Zones, Policy Inputs. Adopting them is the whole point of the view table.

---

# Part A — Decomposition — ✅ COMPLETE

Landed in `89c1b67f2`, `c078acfbb`, `8d682c925`, `854829632`. Outcome:

- **`CodeSitePanel.jsx`: 9,045 → 2,277 lines.** 96 helpers to `lib/`, 13 primitives
  to `ui/`, 22 components to `views/` and `nav/`, `CodeSiteIcons` to `icons.js`,
  the easing curves to `lib/motion.js`.
- **All 135 extracted declarations verified byte-identical** to their pre-refactor
  originals at `79ef2e48b`. Nothing was retyped.
- **Zero test file changes**, as required. 8 tests still pass.

Three findings worth carrying forward:

1. **`MetricRow`, `SignalBar` and `AssumptionInvalidatorPanel` are dead code** —
   render count zero both before and after Part A. Left in place (removing
   pre-existing dead code is out of scope). `AssumptionInvalidatorPanel` owns
   `codesite-assumption-invalidator`, so the id baseline contains an id that never
   renders.
2. **20 test failures elsewhere in `synthi` are pre-existing** — `agent-workflows`,
   `programs`, `preview-store`, `terminal-preview-links`, `src/lib/codesite`.
   Confirmed by restoring the pre-refactor `components/codesite` and re-running:
   identical failures. Note `src/lib/codesite` is a different directory from
   `src/components/codesite` and is not touched by this plan.
3. **The whole-panel test takes 20.5s under full-suite load** (4s alone) and times
   out in CI-like conditions. Do not raise the timeout again — Task 8 Step 10
   splits it per view, which is the actual fix.

No behavior change. No test file edits. If a test changes, you made a mistake.

## Task 1: Prove the baseline is stable

**Files:** none modified.

- [x] **Step 1: Run the suite three times**

```bash
cd synthi && for i in 1 2 3; do npx vitest run src/components/codesite 2>&1 | grep -E "Tests |Test Files"; done
```

Expected, all three times:

```
 Test Files  2 passed (2)
      Tests  8 passed (8)
```

If any run fails, stop and fix the flake before moving code. A red or flaky suite cannot serve as the safety net for a 9,000-line refactor — you will not be able to tell your mistakes from pre-existing noise.

- [x] **Step 2: Record the module's line count**

```bash
cd synthi && wc -l src/components/codesite/CodeSitePanel.jsx
```

Expected: `9044`. Write this number down. At the end of Part A the shell should be under ~700 lines and the sum across all new files plus the shell should be within a few dozen lines of 9044 — a large discrepancy means content was dropped or duplicated.

## Task 2: Extract `lib/` helpers

These are pure functions: no JSX, no hooks, no React import. They move first because everything else depends on them.

**Files:**
- Create: `synthi/src/components/codesite/lib/format.js`
- Create: `synthi/src/components/codesite/lib/governance.js`
- Create: `synthi/src/components/codesite/lib/quarantine.js`
- Create: `synthi/src/components/codesite/lib/graph.js`
- Modify: `synthi/src/components/codesite/CodeSitePanel.jsx`

- [x] **Step 1: Create `lib/format.js`**

Move lines **93–566**, **757–800**, and **1222–1346** verbatim. Add `export` before each `function` and before `const TOWER_EVENT_LABELS`.

The exported names, in source order — 62 functions plus one constant:

```
asArray, uniqueValues, uniqueByEvent, compact, productCopy, formatPercent,
formatDurationMs, formatMetricValue, clampRatio, formatCompactNumber, metricTone,
metricProgress, metricTargetLabel, metricAttentionScore, metricSectionEntries,
universeHealthScore, eventDisplayType, eventPathLabel, countBy,
transactionIdentity, mergeTransactionSources, transactionProofBundle,
transactionEvents, transactionReason, transactionTowerAction,
transactionDigestLabel, invalidatedAssumptionRows, parseLineRange, lineRange,
lineRangeLabel, lineProvenanceKey, pathCoversFile, inspectionRunRefs,
latestCounterfactualSimulation, towerInstructionText, TOWER_EVENT_LABELS,
towerEventKind, formatTime, toneColor, statusTone, riskTone, indicatorTone,
toneLabel
```

`towerEventKind` reads `TOWER_EVENT_LABELS`, and `towerInstructionText` reads it too — keep all three together in this file so neither crosses a module boundary.

- [x] **Step 2: Create `lib/governance.js`**

Move lines **568–749** verbatim, adding `export` to each. Exported names:

```
documentLabel, documentNeedsReview, routeRevisionCanReview, routeRevisionCanApply,
firstRoutePattern, incidentNeedsResume, inspectionRunRelatesToIncident,
maydayResumeInspectionRefs, actionSeverity, actionOwner, actionEntity,
actionEntityId, actionKind, actionHasGovernanceReviewTarget, actionEvidenceRefs,
actionLabel, actionReviewSummary
```

Add at the top:

```js
import { asArray, compact, productCopy, uniqueValues } from "./format";
```

**Deliberately excluded: `findGovernanceEntityRow` (750–755).** It is a `document.querySelector` helper that exists only to serve `handleRequiredActionReview`, and Task 9 deletes that coupling. Leave it in `CodeSitePanel.jsx` for now; Task 9 removes it. Do not move DOM-reaching code into a module named `governance`.

- [x] **Step 3: Create `lib/quarantine.js`**

Move lines **801–1221** verbatim, adding `export` to each. Exported names:

```
hasEntries, quarantinePath, quarantineDigest, quarantineEvidenceRef,
selectedPathKey, quarantineAppliedPaths, quarantineRemainingPaths,
quarantineDisplayStatus, quarantineEventId, quarantineRecordsFromEvents,
normalizeQuarantineRecord, mergeQuarantineRecords, quarantineReplayAttemptFromEvent,
isSuccessfulQuarantineReplay, isReplayAttemptBeforeApply, appendUniqueObjects,
mergeLifecycle, quarantineReviewMessage
```

Add at the top:

```js
import { asArray, compact, uniqueValues } from "./format";
```

- [x] **Step 4: Create `lib/graph.js`**

Move lines **5289–5490** verbatim, adding `export` to each. This is graph *math*, which is safe to relocate — the deferral covers the graph's rendering and interaction, not the pure geometry helpers. Exported names:

```
zoneClass, zoneName, displayZoneName, zonePaths, pathPatternSegments,
remainingPatternCanBeEmpty, globSegmentRegex, pathSegmentsMayOverlap,
pathPatternsMayOverlap, pathsLikelyOverlap, normalizedZoneToken, zoneHasFlight,
riskTouchesFlight, riskTouchesZone, statusColor, replayTailFromNewestFirst,
zoneTierLabel, graphNodeStyle
```

Add at the top:

```js
import { asArray, toneColor } from "./format";
```

Check `graphNodeStyle` and `statusColor` for what they actually call before finalizing this import line — add whatever else they reference from `format`.

- [x] **Step 5: Delete the moved lines from `CodeSitePanel.jsx` and import them back**

Delete the four ranges. Add near the top of the file, after the existing imports:

```js
import * as fmt from "./lib/format";
import * as gov from "./lib/governance";
import * as qtn from "./lib/quarantine";
import * as graph from "./lib/graph";
```

**Do not rewrite ~1,500 call sites into `fmt.asArray(...)`.** That is a huge diff with a large chance of a typo, and it destroys reviewability. Instead re-bind the names locally, immediately below the imports:

```js
const {
  asArray, uniqueValues, uniqueByEvent, compact, productCopy, formatPercent,
  formatDurationMs, formatMetricValue, clampRatio, formatCompactNumber,
  metricTone, metricProgress, metricTargetLabel, metricAttentionScore,
  metricSectionEntries, universeHealthScore, eventDisplayType, eventPathLabel,
  countBy, transactionIdentity, mergeTransactionSources, transactionProofBundle,
  transactionEvents, transactionReason, transactionTowerAction,
  transactionDigestLabel, invalidatedAssumptionRows, parseLineRange, lineRange,
  lineRangeLabel, lineProvenanceKey, pathCoversFile, inspectionRunRefs,
  latestCounterfactualSimulation, towerInstructionText, TOWER_EVENT_LABELS,
  towerEventKind, formatTime, toneColor, statusTone, riskTone, indicatorTone,
  toneLabel,
} = fmt;
const {
  documentLabel, documentNeedsReview, routeRevisionCanReview,
  routeRevisionCanApply, firstRoutePattern, incidentNeedsResume,
  inspectionRunRelatesToIncident, maydayResumeInspectionRefs, actionSeverity,
  actionOwner, actionEntity, actionEntityId, actionKind,
  actionHasGovernanceReviewTarget, actionEvidenceRefs, actionLabel,
  actionReviewSummary,
} = gov;
const {
  hasEntries, quarantinePath, quarantineDigest, quarantineEvidenceRef,
  selectedPathKey, quarantineAppliedPaths, quarantineRemainingPaths,
  quarantineDisplayStatus, quarantineEventId, quarantineRecordsFromEvents,
  normalizeQuarantineRecord, mergeQuarantineRecords,
  quarantineReplayAttemptFromEvent, isSuccessfulQuarantineReplay,
  isReplayAttemptBeforeApply, appendUniqueObjects, mergeLifecycle,
  quarantineReviewMessage,
} = qtn;
const {
  zoneClass, zoneName, displayZoneName, zonePaths, pathPatternSegments,
  remainingPatternCanBeEmpty, globSegmentRegex, pathSegmentsMayOverlap,
  pathPatternsMayOverlap, pathsLikelyOverlap, normalizedZoneToken, zoneHasFlight,
  riskTouchesFlight, riskTouchesZone, statusColor, replayTailFromNewestFirst,
  zoneTierLabel, graphNodeStyle,
} = graph;
```

These re-bindings are scaffolding. Each one disappears as Tasks 3–5 move its consumers out, and Task 6 asserts none are left.

- [x] **Step 6: Verify nothing broke**

```bash
cd synthi && npx vitest run src/components/codesite
```

Expected: `Tests 8 passed (8)`. Zero changes to any test file.

If you get `X is not defined`, a name is missing from a destructuring list above or from an `export` in the new module. If you get a circular-import warning, a `lib/` file is importing from `CodeSitePanel.jsx` — it must not; `lib/` only ever imports from other `lib/` files.

- [x] **Step 7: Confirm no content was lost**

```bash
cd synthi && wc -l src/components/codesite/CodeSitePanel.jsx src/components/codesite/lib/*.js
```

The total should be close to 9044 plus ~60 lines of new import/export boilerplate.

- [x] **Step 8: Commit**

```bash
git add synthi/src/components/codesite/lib synthi/src/components/codesite/CodeSitePanel.jsx
git commit -m "refactor(codesite): extract pure helpers into lib/

Moves 97 pure functions out of the 9,000-line panel into lib/format,
lib/governance, lib/quarantine and lib/graph. Verbatim moves — call sites are
unchanged, with names re-bound locally so the diff stays reviewable. The local
re-bindings are scaffolding and come out as their consumers move.

findGovernanceEntityRow stays behind deliberately: it is a querySelector helper
serving only handleRequiredActionReview, which a later commit deletes."
```

## Task 3: Extract `ui/` primitives

Components used by more than one view.

**Files:**
- Create one file per component under `synthi/src/components/codesite/ui/`
- Create: `synthi/src/components/codesite/ui/index.js`
- Modify: `synthi/src/components/codesite/CodeSitePanel.jsx`

| Component | Source lines | Owns testid |
|---|---|---|
| `Pill` | 1348–1370 | via `testId` prop |
| `IconButton` | 1372–1412 | via `testId` prop |
| `Section` | 1414–1461 | `sectionKey` → `data-codesite-section` |
| `Metric` | 1463–1512 | via `testId` prop |
| `StatusRailItem` | 1514–1570 | via `testId` prop |
| `OperatorPane` | 1907–1966 | via `testId` prop |
| `SignalBar` | 2035–2057 | — |
| `PathList` | 4004–4035 | — |
| `TagList` | 4037–4068 | — |
| `Row` | 4070–4080 | via `testId` prop |
| `EmptyLine` | 4082–4094 | — |
| `LoadingSkeleton` | 5271–5287 | `codesite-loading` |
| `JsonPreview` | 6850–6868 | — |

`IconButton`, `Section`, `OperatorPane`, `Metric`, `Row` and `StatusRailItem` are exactly the primitives that take a **`testId` prop** rather than writing `data-testid` inline. That is why the invariant regex in `testIdInvariant.test.js` matches `testId=` as well — do not "simplify" these props away.

- [x] **Step 1: Create the files**

One component per file, default-exported, with its own imports from `../lib/format`. For example, `ui/Pill.jsx`:

```jsx
import { statusTone, toneLabel } from "../lib/format";

export default function Pill({ children, tone = "idle", className = "", testId }) {
  // ...body moved verbatim from CodeSitePanel.jsx:1349-1369
}
```

Read each component's body before writing its import line and import exactly what it references. `Section` and `OperatorPane` also import `motion` / `useReducedMotion` from `framer-motion`.

- [x] **Step 2: Create `ui/index.js`**

```js
export { default as Pill } from "./Pill";
export { default as IconButton } from "./IconButton";
export { default as Section } from "./Section";
export { default as Metric } from "./Metric";
export { default as StatusRailItem } from "./StatusRailItem";
export { default as OperatorPane } from "./OperatorPane";
export { default as SignalBar } from "./SignalBar";
export { default as PathList } from "./PathList";
export { default as TagList } from "./TagList";
export { default as Row } from "./Row";
export { default as EmptyLine } from "./EmptyLine";
export { default as LoadingSkeleton } from "./LoadingSkeleton";
export { default as JsonPreview } from "./JsonPreview";
```

- [x] **Step 3: Delete the moved components and import them back**

Delete the 13 ranges from `CodeSitePanel.jsx`. Add:

```js
import {
  EmptyLine, IconButton, JsonPreview, LoadingSkeleton, Metric, OperatorPane,
  PathList, Pill, Row, Section, SignalBar, StatusRailItem, TagList,
} from "./ui";
```

- [x] **Step 4: Verify**

```bash
cd synthi && npx vitest run src/components/codesite
```

Expected: `Tests 8 passed (8)`, no test file edits.

- [x] **Step 5: Commit**

```bash
git add synthi/src/components/codesite/ui synthi/src/components/codesite/CodeSitePanel.jsx
git commit -m "refactor(codesite): extract shared UI primitives into ui/

Thirteen primitives used by more than one view, moved verbatim. The testId prop
on IconButton/Section/OperatorPane/Metric/Row/StatusRailItem is load-bearing:
it is how most action buttons get their test id, and the invariant check matches
that prop form specifically."
```

## Task 4: Extract the graph, unchanged

Isolated from Task 5 so that the one part of the panel the user wants untouched has its own reviewable commit, provably content-identical.

**Files:**
- Create: `synthi/src/components/codesite/views/graph/ScopeTopology.jsx`
- Create: `synthi/src/components/codesite/views/graph/WorkGraphNode.jsx`
- Create: `synthi/src/components/codesite/views/graph/WorkGraphConnector.jsx`
- Modify: `synthi/src/components/codesite/CodeSitePanel.jsx`

- [x] **Step 1: Move the three components**

`WorkGraphConnector` 5491–5533, `WorkGraphNode` 5535–5584, `ScopeTopology` 6283–6848. Verbatim. Imports come from `../../ui`, `../../lib/format` and `../../lib/graph`.

`ScopeTopology` renders `WorkGraphNode` and `WorkGraphConnector`, so it imports both.

- [x] **Step 2: Prove the move changed nothing**

```bash
cd synthi && git show HEAD:src/components/codesite/CodeSitePanel.jsx | sed -n '6283,6848p' > /tmp/topology-before.txt
sed -n '/^export default function ScopeTopology/,/^}/p' src/components/codesite/views/graph/ScopeTopology.jsx > /tmp/topology-after.txt
diff <(sed 's/^[[:space:]]*//' /tmp/topology-before.txt) <(sed 's/^[[:space:]]*//' /tmp/topology-after.txt)
```

Expected: differences confined to the `function ScopeTopology` → `export default function ScopeTopology` line. Any other difference means you edited the graph, which is out of scope — revert it.

- [x] **Step 3: Verify and commit**

```bash
cd synthi && npx vitest run src/components/codesite
```

Expected: `Tests 8 passed (8)`.

```bash
git add synthi/src/components/codesite/views/graph synthi/src/components/codesite/CodeSitePanel.jsx
git commit -m "refactor(codesite): move the workspace graph to views/graph/ untouched

Content-identical relocation of ScopeTopology, WorkGraphNode and
WorkGraphConnector, in its own commit so it is trivially auditable. The graph's
layout and interaction model are deferred pending the user's own evaluation, so
nothing here changes except the file it lives in — including the md: breakpoint
on the connectors, which stays as-is for now."
```

## Task 5: Extract the remaining view components

Sixteen presentational components, each moving next to the view that owns it. Do these **one component per commit** — sixteen small verified commits, not one big one. A bad 400-line paste is trivial to find in a 400-line commit and miserable to find in a 6,000-line one.

**Files:** create under `synthi/src/components/codesite/views/`; modify `CodeSitePanel.jsx` each time.

| Component | Lines | Destination |
|---|---|---|
| `TowerNowStrip` | 1572–1774 | `views/overview/TowerNowStrip.jsx` |
| `CodeSiteOperatingModel` | 1776–1905 | `views/overview/CodeSiteOperatingModel.jsx` |
| `MetricRow` | 1968–2012 | `views/overview/MetricRow.jsx` |
| `MetricsGroup` | 2014–2033 | `views/overview/MetricsGroup.jsx` |
| `MetricScorecard` | 2059–2110 | `views/evidence/MetricScorecard.jsx` |
| `SuccessMetricsDeck` | 2112–2237 | `views/evidence/SuccessMetricsDeck.jsx` |
| `SerializableIsolationDeck` | 2724–3020 | `views/evidence/SerializableIsolationDeck.jsx` |
| `RunwayOccupancyBoard` | 2239–2325 | `views/locks/RunwayOccupancyBoard.jsx` |
| `PilotLicenseHealthPanel` | 3022–3166 | `views/locks/PilotLicenseHealthPanel.jsx` |
| `TowerSimulatorDeck` | 2327–2601 | `views/simulator/TowerSimulatorDeck.jsx` |
| `AssumptionInvalidatorPanel` | 2603–2722 | `views/simulator/AssumptionInvalidatorPanel.jsx` |
| `FilesystemBoundaryProofPanel` | 3168–3328 | `views/quarantine/FilesystemBoundaryProofPanel.jsx` |
| `ProofValueList` | 3330–3363 | `views/quarantine/ProofValueList.jsx` |
| `QuarantineReviewPanel` | 3365–4002 | `views/quarantine/QuarantineReviewPanel.jsx` |
| `TowerStreamPanel` | 4326–4506 | `views/activity/TowerStreamPanel.jsx` |
| `BlackBoxFlightRecorder` | 5850–5970 | `views/activity/BlackBoxFlightRecorder.jsx` |
| `GovernanceReviewGate` | 4508–4608 | `views/governance/GovernanceReviewGate.jsx` |
| `GovernanceConsole` | 4610–5269 | `views/governance/GovernanceConsole.jsx` |
| `CausalReplayDeck` | 5644–5848 | `views/replay/CausalReplayDeck.jsx` |
| `LineProvenanceDeck` | 5972–6281 | `views/replay/LineProvenanceDeck.jsx` |
| `DesktopSectionRail` | 4096–4195 | `nav/DesktopSectionRail.jsx` |
| `MobileSectionTabs` | 4197–4324 | `nav/MobileSectionTabs.jsx` |

Two helpers travel with `CausalReplayDeck` into `views/replay/CausalReplayDeck.jsx`, since nothing else uses them: `causalReplayHandovers` (5586–5634) and `replayCompletenessTone` (5636–5642).

`ProofValueList` is used by `FilesystemBoundaryProofPanel` **and** `QuarantineReviewPanel` — both live in `views/quarantine/`, so it stays local rather than going to `ui/`. Confirm with a grep before deciding:

```bash
cd synthi && grep -rn "<ProofValueList" src/components/codesite/
```

If it turns up outside `views/quarantine/`, move it to `ui/` instead.

- [x] **Step 1: For each component, in the table's order**

Move the body verbatim. Add `export default`. Write the import lines by reading what the body actually references. Then delete the original range and import it into `CodeSitePanel.jsx`.

- [x] **Step 2: After each component, verify**

```bash
cd synthi && npx vitest run src/components/codesite
```

Expected: `Tests 8 passed (8)`. Fix before moving to the next component — do not stack unverified moves.

- [x] **Step 3: After each component, commit**

```bash
git add synthi/src/components/codesite
git commit -m "refactor(codesite): move <ComponentName> to views/<area>/"
```

## Task 6: Clean up the scaffolding

**Files:** Modify `synthi/src/components/codesite/CodeSitePanel.jsx`

- [x] **Step 1: Replace the wildcard imports with explicit ones**

The big destructuring blocks from Task 2 Step 5 exist only so call sites did not have to change. Most of their consumers have now moved out of the file. Delete the four `const { … } = fmt/gov/qtn/graph;` blocks and the four `import * as` lines, then let the test run tell you exactly which names the shell still needs:

```bash
cd synthi && npx vitest run src/components/codesite 2>&1 | grep "is not defined"
```

Add each reported name to a normal named import and re-run until clean:

```js
import { asArray, compact, formatTime, uniqueValues } from "./lib/format";
import { actionEntityId, actionKind } from "./lib/governance";
import { mergeQuarantineRecords, quarantineRecordsFromEvents } from "./lib/quarantine";
```

The exact lists depend on what the shell retained; the loop above is the mechanism, not a prediction.

- [x] **Step 2: Confirm the shell shrank as expected**

```bash
cd synthi && wc -l src/components/codesite/CodeSitePanel.jsx
```

Expected: roughly 2,300–2,600 lines — the exported `CodeSitePanel` function plus imports. It is not under 700 yet; the render tree still inlines all 23 blocks. Part B extracts those.

- [x] **Step 3: Check for orphans your changes created**

```bash
cd synthi && npx next lint --file src/components/codesite/CodeSitePanel.jsx 2>&1 | head -30
```

Remove imports and variables that *your* moves made unused. Do not remove pre-existing dead code — if you spot some, note it and leave it.

- [x] **Step 4: Verify and commit**

```bash
cd synthi && npx vitest run src/components/codesite
```

Expected: `Tests 8 passed (8)`.

```bash
git add synthi/src/components/codesite/CodeSitePanel.jsx
git commit -m "refactor(codesite): replace re-binding scaffolding with explicit imports

Drops the wildcard namespace imports and local re-bindings added when lib/ was
extracted, now that their consumers live in their own files."
```

## Task 7: Assert the decomposition preserved everything

**Files:** none modified. This is a checkpoint, not a change.

- [x] **Step 1: Confirm the test id set is intact**

```bash
cd synthi && npx vitest run src/components/codesite/__tests__/testIdInvariant.test.js
```

Expected: `Tests 1 passed (1)`. The invariant test walks the whole `components/codesite/` tree, so it follows ids into their new files automatically.

- [x] **Step 2: Confirm no test file was touched during Part A**

```bash
git diff --stat 79ef2e48b..HEAD -- synthi/src/components/codesite/__tests__/
```

Expected: **no output** for `CodeSitePanel.test.jsx`. Part A is mechanical; a changed test means behavior moved when it should not have. Investigate before continuing.

- [x] **Step 3: Confirm nothing was silently dropped**

```bash
cd synthi && find src/components/codesite -name '*.jsx' -o -name '*.js' | grep -v __tests__ | xargs wc -l | tail -1
```

Total should be within ~200 lines of the original 9,044 (new import/export boilerplate accounts for the increase). A shortfall of several hundred lines means a component body was lost.

---

# Part B — View switching

This is where behavior changes. Test edits are expected and legitimate here.

## Task 8: Turn the rail into a view switcher

The rail is currently a scroll-spy: `handleSelectSection` (7035 before Part A) sets `activeSection` and then scrolls the container to a `[data-codesite-section]` anchor. Only 9 of 23 blocks have an anchor. This task makes `activeSection` decide what *mounts*.

**Files:**
- Create: `synthi/src/components/codesite/views/index.js`
- Create ten view files under `synthi/src/components/codesite/views/`
- Modify: `synthi/src/components/codesite/CodeSitePanel.jsx`
- Modify: `synthi/src/components/codesite/nav/DesktopSectionRail.jsx`, `nav/MobileSectionTabs.jsx`
- Modify: `synthi/src/components/codesite/__tests__/CodeSitePanel.test.jsx`

- [ ] **Step 1: Write the failing test for view switching**

Add to `CodeSitePanel.test.jsx`:

```jsx
it('mounts only the selected view', async () => {
  h.fetchCodeSiteRadarState.mockResolvedValue(radarState());
  renderPanel();
  await flush();

  // Overview is the landing view: no governance console in the DOM yet.
  expect(container.querySelector('[data-testid="codesite-governance-console"]')).toBeNull();

  await selectSection('governance');
  expect(container.querySelector('[data-testid="codesite-governance-console"]')).toBeTruthy();
  // And switching away unmounts it.
  await selectSection('quarantine');
  expect(container.querySelector('[data-testid="codesite-governance-console"]')).toBeNull();
  expect(container.querySelector('[data-testid="codesite-quarantine-review"]')).toBeTruthy();
});
```

- [ ] **Step 2: Add the `selectSection` test helper**

Put it next to the existing `confirmGovernanceReview` helper in `CodeSitePanel.test.jsx`:

```jsx
async function selectSection(key) {
  const tab = container.querySelector(
    `[data-testid="codesite-desktop-section-tab"][data-codesite-section-key="${key}"]`,
  );
  if (!tab) throw new Error(`no rail tab for section "${key}"`);
  await act(async () => {
    tab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
}
```

This requires the rail tabs to carry their key. In `nav/DesktopSectionRail.jsx` and `nav/MobileSectionTabs.jsx`, add `data-codesite-section-key={section.key}` to each tab button. Both already render `testId="codesite-desktop-section-tab"` / `"codesite-mobile-section-tab"`, so the invariant is unaffected.

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd synthi && npx vitest run src/components/codesite -t "mounts only the selected view"
```

Expected: FAIL — the governance console is present on first paint, because every block currently mounts at once. That failure is the proof the test is real.

- [ ] **Step 4: Extract the ten views**

Using the mapping table under **File structure**, move each block's JSX out of the `CodeSitePanel` return into its own view component. Each view takes the props it needs from the shell. Signature pattern:

```jsx
// views/GovernanceView.jsx
export default function GovernanceView({
  project, activeFlights, activeLeases, incidents, inspectionRuns,
  permitDraft, routeDraft, onPermitDraft, onRouteDraft,
  onIssuePermit, onReviewDocument, onProposeRouteRevision,
  onReviewRouteRevision, onApplyRouteRevision, onResumeMayday,
  actionState, disabled, requiredActions, onRequiredActionReview,
}) {
  return (
    <div className="grid min-w-0 content-start gap-3">
      {/* Governance Console pane, moved from CodeSitePanel.jsx:8209 */}
      {/* Required Actions section, moved from CodeSitePanel.jsx:8768 */}
    </div>
  );
}
```

Move the JSX verbatim, including every prop. The `OperatorPane`'s `sectionKey` prop and the `Section`'s `sectionKey` prop become inert once nothing scrolls to anchors — leave them in place for this task and remove them in Step 7, so that a mistake here is isolated from a mistake there.

- [ ] **Step 5: Create `views/index.js`**

```js
export { default as OverviewView } from "./OverviewView";
export { default as GraphView } from "./GraphView";
export { default as ActivityView } from "./ActivityView";
export { default as GovernanceView } from "./GovernanceView";
export { default as LocksView } from "./LocksView";
export { default as QuarantineView } from "./QuarantineView";
export { default as EvidenceView } from "./EvidenceView";
export { default as InspectionsView } from "./InspectionsView";
export { default as ReplayView } from "./ReplayView";
export { default as SimulatorView } from "./SimulatorView";
```

- [ ] **Step 6: Replace `handleSelectSection` with plain state**

Delete the scroll logic. The whole handler becomes:

```jsx
const handleSelectSection = useCallback((key) => {
  setActiveSection(key);
}, []);
```

Delete the `scroll-mt-32 md:scroll-mt-24` classes (formerly lines 1419, 1926) and the runtime rail-height measurement inside the old handler. Both existed to position a scroll target under a sticky rail; with view switching there is nothing to scroll to. Leaving them would mean two competing mechanisms for a problem that no longer exists.

- [ ] **Step 7: Update the section list and render the router**

Rename the `mobileSections` memo to `sections` — it now drives both rails and the router, so its old name is misleading. Ten entries, replacing `radar` with `overview` as the default and adding `inspections`:

```jsx
const sections = useMemo(
  () => [
    { key: "overview", label: "Overview", icon: CodeSiteIcons.activity },
    { key: "radar", label: "Graph", icon: CodeSiteIcons.workspaceGraph },
    { key: "tower", label: "Activity", icon: CodeSiteIcons.activity },
    { key: "governance", label: "Governance", icon: CodeSiteIcons.governance },
    { key: "runway", label: "Locks", icon: CodeSiteIcons.pathLocks },
    { key: "quarantine", label: "Quarantine", icon: CodeSiteIcons.quarantine },
    { key: "evidence", label: "Evidence", icon: CodeSiteIcons.evidence },
    { key: "inspections", label: "Inspections", icon: CodeSiteIcons.evidence },
    { key: "replay", label: "Replay", icon: CodeSiteIcons.replay },
    { key: "simulator", label: "Simulator", icon: CodeSiteIcons.simulator },
  ],
  [],
);
```

The keys `radar`, `tower`, `governance`, `runway`, `quarantine`, `evidence`, `replay`, `simulator` are **kept exactly as they are**. `TowerNowStrip` and `CodeSiteOperatingModel` call `onSelect("governance")`, `onSelect("quarantine")` and friends today; reusing the keys means those drill-ins keep working as view switches with no changes. `lineage` is dropped as a separate key because Lineage Inspector now lives inside Replay — grep for it before deleting:

```bash
cd synthi && grep -rn '"lineage"' src/components/codesite/
```

Any `onSelect("lineage")` call site must be repointed to `"replay"`.

Change the default:

```jsx
const [activeSection, setActiveSection] = useState("overview");
```

Then render exactly one view:

```jsx
const VIEWS = {
  overview: OverviewView,
  radar: GraphView,
  tower: ActivityView,
  governance: GovernanceView,
  runway: LocksView,
  quarantine: QuarantineView,
  evidence: EvidenceView,
  inspections: InspectionsView,
  replay: ReplayView,
  simulator: SimulatorView,
};
```

In the return, replacing the former `codesite-responsive-proof-target` two-column block and everything after it:

```jsx
{(() => {
  const ActiveView = VIEWS[activeSection] ?? OverviewView;
  return <ActiveView {...viewProps} />;
})()}
```

Keep `data-testid="codesite-responsive-proof-target"` on the wrapper that holds the active view — it is in the baseline, and it is still the element whose width the responsiveness work targets.

- [ ] **Step 8: Run the new test**

```bash
cd synthi && npx vitest run src/components/codesite -t "mounts only the selected view"
```

Expected: PASS.

- [ ] **Step 9: Migrate the existing tests to navigate first**

The other tests will now fail, because they query testids that are no longer mounted on first paint. That is expected and is the real cost of this redesign.

For each failure, insert the right `await selectSection(...)` before the assertions. Mapping:

| Test | Needs |
|---|---|
| `renders the coordination state and exports artifact projection` | Split its assertions by view — see Step 10 |
| `exposes show-all controls for capped governance queues` | `await selectSection('governance')` |
| `routes structured required actions into the governance review gate` | none — starts from Overview, the handler navigates |
| `routes a required action for a proposed plan change into the review gate` | none — same |
| `shows active workstreams in the workspace graph without radar markers` | `await selectSection('radar')` |
| `summarizes the latest activity tail in the graph evidence guardrail` | `await selectSection('radar')` |
| `opens the first project from the empty state` | none — empty state precedes any view |

**Change only where the test navigates. Do not weaken an assertion to make it pass.** If an assertion cannot be satisfied by navigating, you have lost functionality — fix the code, not the test.

- [ ] **Step 10: Split the whole-panel test**

`renders the coordination state and exports artifact projection` asserts across all 23 blocks at once. Under view switching that is no longer one test. Split it by view, keeping every existing assertion — reassigned, never dropped:

```jsx
it('renders overview status on first paint', async () => {
  h.fetchCodeSiteRadarState.mockResolvedValue(radarState());
  renderPanel();
  await flush();
  expect(container.querySelector('[data-testid="codesite-panel"]')).toBeTruthy();
  expect(container.textContent).toContain('Checkout coordination');
  expect(container.textContent).toContain('ATLAS-1');
  expect(container.querySelector('[data-testid="codesite-tower-now"]')).toBeTruthy();
});

it('renders locks evidence under the locks view', async () => {
  h.fetchCodeSiteRadarState.mockResolvedValue(radarState());
  renderPanel();
  await flush();
  await selectSection('runway');
  expect(container.textContent).toContain('Path Locks');
  expect(container.textContent).toContain('Agent Readiness');
  expect(container.querySelector('[data-testid="codesite-pilot-license-health"]').textContent)
    .toContain('IFR');
  expect(container.textContent).toContain('min:IFR');
});

it('renders replay handover under the replay view', async () => {
  h.fetchCodeSiteRadarState.mockResolvedValue(radarState());
  renderPanel();
  await flush();
  await selectSection('replay');
  const replayHandover = container.querySelector('[data-testid="codesite-causal-replay-handover"]');
  expect(replayHandover).toBeTruthy();
  expect(replayHandover.textContent).toContain('txn-1');
});

it('exports the artifact projection from the evidence view', async () => {
  h.fetchCodeSiteRadarState.mockResolvedValue(radarState());
  renderPanel();
  await flush();
  await selectSection('evidence');
  expect(container.textContent).toContain('pcap-checkout-schema');
  expect(container.textContent).toContain('schema.level_2@2026-06-25');
  expect(container.textContent).toContain('dojo:evidence:checkride-1');
  await act(async () => {
    container.querySelector('[data-testid="codesite-export"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
  expect(h.exportCodeSiteArtifacts).toHaveBeenCalledWith('acme', 'proj-1');
});
```

`codesite-export` lives in the shell header, not inside Evidence — check where it renders before assuming the navigation above is needed. If it is in the header, drop the `selectSection` call from that last test.

Once split, the 20000ms timeout added to the original test is no longer needed; each of the smaller tests mounts one view and should finish well inside the 5s default. Remove the timeout argument and its explanatory comment.

- [ ] **Step 11: Verify the whole suite**

```bash
cd synthi && npx vitest run src/components/codesite
```

Expected: all green, with **more** tests than the 8 you started with. Confirm the count went up, not down.

- [ ] **Step 12: Commit**

```bash
git add synthi/src/components/codesite
git commit -m "feat(codesite): make the nav rail a real view switcher

The rail was a scroll-spy: it set activeSection and scrolled to a
[data-codesite-section] anchor. Only 9 of 23 blocks had an anchor, so 14 were
reachable only by scrolling past everything else — the direct cause of the
crowding. Now activeSection decides what mounts, and the 23 blocks are grouped
into 10 views that adopt the orphans.

Section keys are unchanged, so the existing onSelect() drill-ins from
TowerNowStrip and CodeSiteOperatingModel keep working as view switches.

Removes the scroll-anchor machinery: the runtime rail-height measurement and the
competing scroll-mt-32/md:scroll-mt-24 magic numbers both existed to place a
scroll target under a sticky rail, and there is no longer anything to scroll to.

Tests now navigate before asserting. The whole-panel test is split per view with
every assertion preserved."
```

## Task 9: Rewrite `handleRequiredActionReview` as state

**Files:**
- Create: `synthi/src/components/codesite/lib/governanceActions.js`
- Create: `synthi/src/components/codesite/lib/__tests__/governanceActions.test.js`
- Modify: `synthi/src/components/codesite/CodeSitePanel.jsx`
- Modify: `synthi/src/components/codesite/views/GovernanceView.jsx`
- Modify: `synthi/src/components/codesite/views/governance/GovernanceConsole.jsx`

**Why this must change.** The current handler switches to governance, waits a tick, then `document.querySelector`s the matching approve / apply / resume button and programmatically `.click()`s it. That only works because every section is always mounted. After Task 8 the target is not in the DOM when Required Actions is on screen, so the handler silently falls through to its scroll-to-console fallback for every action.

**The elegant constraint.** The payload passed to `queueGovernanceAction` is currently built inline in `GovernanceConsole`'s JSX — a distinct literal per button. If the pending-target path builds its own copy, the two will drift, and "behaves identically" becomes unverifiable by inspection. So extract the payload builders first and have **both** paths call the same builder. That is what makes this a rewrite rather than a reimplementation.

- [ ] **Step 1: Write the failing test for the resolver**

Create `synthi/src/components/codesite/lib/__tests__/governanceActions.test.js`:

```js
import { describe, expect, it } from 'vitest';
import { resolveGovernanceReviewTarget } from '../governanceActions';

const DATA = {
  documents: [
    { id: 'doc-open', status: 'open' },
    { id: 'doc-done', status: 'approved' },
  ],
  routeRevisions: [
    { id: 'route-proposed', status: 'proposed' },
    { id: 'route-approved', status: 'approved' },
  ],
  openMaydays: [{ id: 'inc-1', category: 'mayday', status: 'open' }],
  inspectionRuns: [
    { id: 'run-1', incidentId: 'inc-1', status: 'passed' },
  ],
};

describe('resolveGovernanceReviewTarget', () => {
  it('targets a document that still needs review', () => {
    expect(resolveGovernanceReviewTarget({ kind: 'review_document', documentId: 'doc-open' }, DATA))
      .toEqual({ entity: 'document', entityId: 'doc-open', intent: 'approve' });
  });

  it('ignores a document that is already approved', () => {
    expect(resolveGovernanceReviewTarget({ kind: 'review_document', documentId: 'doc-done' }, DATA))
      .toBeNull();
  });

  it('targets review for a proposed plan change, not apply', () => {
    expect(resolveGovernanceReviewTarget({ kind: 'review_route', routeRevisionId: 'route-proposed' }, DATA))
      .toEqual({ entity: 'routeRevision', entityId: 'route-proposed', intent: 'review' });
  });

  it('targets apply for an approved plan change', () => {
    expect(resolveGovernanceReviewTarget({ kind: 'review_route', routeRevisionId: 'route-approved' }, DATA))
      .toEqual({ entity: 'routeRevision', entityId: 'route-approved', intent: 'apply' });
  });

  it('targets a mayday resume only when inspection evidence exists', () => {
    expect(resolveGovernanceReviewTarget({ kind: 'mayday_resume', incidentId: 'inc-1' }, DATA))
      .toEqual({ entity: 'incident', entityId: 'inc-1', intent: 'resume' });
    expect(resolveGovernanceReviewTarget(
      { kind: 'mayday_resume', incidentId: 'inc-1' },
      { ...DATA, inspectionRuns: [] },
    )).toBeNull();
  });

  it('returns null for an action with no governance target', () => {
    expect(resolveGovernanceReviewTarget({ kind: 'something_else' }, DATA)).toBeNull();
  });
});
```

The apply-vs-review pair encodes the bug fixed in commit `53ae02a9d`: apply is preferred, but a `proposed` revision resolves to `review` rather than falling through to nothing.

- [ ] **Step 2: Run it to verify it fails**

```bash
cd synthi && npx vitest run src/components/codesite/lib/__tests__/governanceActions.test.js
```

Expected: FAIL — `Failed to resolve import "../governanceActions"`.

- [ ] **Step 3: Write `lib/governanceActions.js`**

```js
import { asArray, compact, productCopy, uniqueValues } from "./format";
import {
  documentLabel,
  documentNeedsReview,
  incidentNeedsResume,
  maydayResumeInspectionRefs,
  routeRevisionCanApply,
  routeRevisionCanReview,
} from "./governance";

/**
 * Payload builders for queueGovernanceAction.
 *
 * Both the console's buttons and the required-action pending-target path call
 * these, so the two cannot drift. Every field here is byte-identical to the
 * inline literal it replaced in GovernanceConsole.
 */

export function documentReviewAction(document, decision, { onReviewDocument }) {
  const verb = decision === "approved" ? "Approve" : "Reject";
  return {
    kind: "document_review",
    title: `${verb} ${documentLabel(document)}`,
    entity: document.id,
    owner: document.fromSessionId || document.fromSession || "coordinator",
    severity: decision === "approved" ? (document.blocking ? "high" : "medium") : "high",
    evidenceRefs: uniqueValues([
      ...asArray(document.evidenceRefs),
      `codesite:ui:document-review:${document.id}`,
    ]),
    execute: (rationale) => onReviewDocument(document, decision, rationale),
  };
}

export function routeReviewAction(revision, { onReviewRouteRevision }) {
  return {
    kind: "route_revision_review",
    title: "Approve plan change",
    entity: revision.id,
    owner: revision.displayCallsign || revision.executionPlanId,
    severity: "high",
    scope: revision.proposedRoute,
    evidenceRefs: uniqueValues([
      ...asArray(revision.evidenceRefs),
      `codesite:ui:route-review:${revision.id}`,
    ]),
    execute: (rationale) => onReviewRouteRevision(revision, "approved", rationale),
  };
}

export function routeApplyAction(revision, { onApplyRouteRevision }) {
  return {
    kind: "route_revision_apply",
    title: "Apply plan change",
    entity: revision.id,
    owner: revision.displayCallsign || revision.executionPlanId,
    severity: "critical",
    scope: revision.proposedRoute,
    evidenceRefs: uniqueValues([
      ...asArray(revision.evidenceRefs),
      `codesite:ui:route-apply:${revision.id}`,
    ]),
    execute: (rationale) => onApplyRouteRevision(revision, rationale),
  };
}

export function maydayResumeAction(incident, inspectionRunIds, { onResumeMayday }) {
  return {
    kind: "mayday_resume",
    title: `Resume ${productCopy(incident.category, "paused incident")}`,
    entity: incident.id,
    owner: asArray(incident.participants)[0] || "coordinator",
    severity: "critical",
    scope: incident.affectedZones,
    evidenceRefs: uniqueValues([
      ...asArray(incident.evidenceRefs),
      incident.replayDigest,
      `codesite:ui:mayday-resume:${incident.id}`,
    ]),
    execute: (rationale) => onResumeMayday(incident, inspectionRunIds, rationale),
  };
}

/**
 * Ordered candidate descriptors for a required action, mirroring the branch order
 * of the handler this replaces: document, then route, then mayday.
 */
export function governanceReviewCandidates(action = {}) {
  const kind = String(action.kind || "");
  const entityId = action.entity || action.entityId || null;
  const candidates = [];

  if (action.documentId || /document|rfi|change_order/.test(kind)) {
    candidates.push({
      entity: "document",
      entityId: action.documentId || entityId,
      intent: "approve",
    });
  }
  if (action.routeRevisionId || /route|reroute/.test(kind)) {
    const id = action.routeRevisionId || entityId;
    // Apply first, matching the original preference; review is the fallback.
    candidates.push({ entity: "routeRevision", entityId: id, intent: "apply" });
    candidates.push({ entity: "routeRevision", entityId: id, intent: "review" });
  }
  if (action.incidentId || /mayday|ground|resume/.test(kind)) {
    candidates.push({
      entity: "incident",
      entityId: action.incidentId || entityId,
      intent: "resume",
    });
  }
  return candidates;
}

function candidateIsActionable(candidate, data) {
  const { documents = [], routeRevisions = [], openMaydays = [], inspectionRuns = [] } = data;
  if (!candidate.entityId) return false;

  if (candidate.entity === "document") {
    const document = documents.find((row) => row.id === candidate.entityId);
    return Boolean(document) && documentNeedsReview(document);
  }
  if (candidate.entity === "routeRevision") {
    const revision = routeRevisions.find((row) => row.id === candidate.entityId);
    if (!revision) return false;
    return candidate.intent === "apply"
      ? routeRevisionCanApply(revision)
      : routeRevisionCanReview(revision);
  }
  if (candidate.entity === "incident") {
    const incident = openMaydays.find((row) => row.id === candidate.entityId);
    if (!incident || !incidentNeedsResume(incident)) return false;
    return maydayResumeInspectionRefs(incident, inspectionRuns).length > 0;
  }
  return false;
}

/**
 * The data-driven replacement for the old DOM walk: pick the first candidate
 * that is actually actionable given current state. Returns null when nothing is,
 * which the caller treats the same way the old fallback did.
 */
export function resolveGovernanceReviewTarget(action, data = {}) {
  const target = governanceReviewCandidates(action).find((candidate) =>
    candidateIsActionable(candidate, data),
  );
  return target || null;
}
```

Note the deliberate divergence from the original, which must be recorded in the commit message: the old code treated the global `acting`/`disabled` mutex as making every candidate unactionable, because it read the buttons' `disabled` attribute — so mid-mutation the Review button scrolled instead of opening the gate. The resolver above ignores `acting`, because the gate's own confirm button is independently disabled while a mutation is in flight. The gate opening during a mutation is correct; silently scrolling was not.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd synthi && npx vitest run src/components/codesite/lib/__tests__/governanceActions.test.js
```

Expected: `Tests 6 passed (6)`.

- [ ] **Step 5: Point `GovernanceConsole`'s buttons at the builders**

Replace each inline `queueGovernanceAction({...})` literal with a builder call. The five sites, at their post-Task-5 locations in `views/governance/GovernanceConsole.jsx`:

```jsx
// document approve (was CodeSitePanel.jsx:4843)
onClick={() => queueGovernanceAction(
  documentReviewAction(document, "approved", { onReviewDocument }),
)}

// document reject (was 4866)
onClick={() => queueGovernanceAction(
  documentReviewAction(document, "rejected", { onReviewDocument }),
)}

// route review (was 5022)
onClick={() => queueGovernanceAction(
  routeReviewAction(revision, { onReviewRouteRevision }),
)}

// route apply (was 5050)
onClick={() => queueGovernanceAction(
  routeApplyAction(revision, { onApplyRouteRevision }),
)}

// mayday resume (was 5182)
onClick={() => queueGovernanceAction(
  maydayResumeAction(incident, inspectionRunIds, { onResumeMayday }),
)}
```

Leave every `disabled` expression, `title`, `testId` and child exactly as-is. Only the `onClick` payload construction moves.

Before trusting this, diff the reject builder against the original literal at 4866–4880 — the plan's `documentReviewAction` folds approve and reject into one function using the `decision` argument, and its `severity` ternary must reproduce both cases exactly (`approved` → `blocking ? high : medium`; `rejected` → always `high`). Verify the original reject payload's `title` really is `Reject ${documentLabel(document)}` before relying on it.

- [ ] **Step 6: Verify the console still behaves identically**

```bash
cd synthi && npx vitest run src/components/codesite
```

Expected: all green. The existing tests already assert the resulting client calls (`reviewCodeSiteDocument`, `reviewCodeSiteRouteRevision` with `route-rev-1`, `applyCodeSiteRouteRevision` with `route-rev-2`), so a drifted payload shows up here.

- [ ] **Step 7: Commit the extraction separately**

```bash
git add synthi/src/components/codesite/lib/governanceActions.js \
        synthi/src/components/codesite/lib/__tests__/governanceActions.test.js \
        synthi/src/components/codesite/views/governance/GovernanceConsole.jsx
git commit -m "refactor(codesite): extract governance action payload builders

Pulls the five inline queueGovernanceAction literals out of GovernanceConsole's
JSX into lib/governanceActions. Behavior is unchanged; the point is that the next
commit needs a second caller for these payloads, and two hand-maintained copies
would drift.

Also adds resolveGovernanceReviewTarget: the data-driven answer to 'which row
should the review gate open on', replacing a DOM walk. Unit-tested including the
proposed-vs-approved route case that commit 53ae02a9d fixed."
```

- [ ] **Step 8: Replace the handler with a pending target**

In `CodeSitePanel.jsx`, delete `handleRequiredActionReview` (the `window.setTimeout` + `querySelector` + `.click()` block) and `findGovernanceEntityRow`, which was left behind by Task 2 Step 2 for exactly this moment. Replace with:

```jsx
const [pendingReviewTarget, setPendingReviewTarget] = useState(null);

const handleRequiredActionReview = useCallback(
  (action) => {
    setActiveSection("governance");
    setPendingReviewTarget(
      resolveGovernanceReviewTarget(action, {
        documents,
        routeRevisions,
        openMaydays,
        inspectionRuns,
      }),
    );
  },
  [documents, routeRevisions, openMaydays, inspectionRuns],
);
```

Pass `pendingReviewTarget` and `onPendingReviewTargetConsumed={() => setPendingReviewTarget(null)}` into `GovernanceView`, and through to `GovernanceConsole`.

- [ ] **Step 9: Consume the target in `GovernanceConsole`**

`pendingReview` state already lives inside `GovernanceConsole` (formerly line 4642) and drives `GovernanceReviewGate`. Open it from the descriptor on mount:

```jsx
useEffect(() => {
  if (!pendingReviewTarget) return;
  const { entity, entityId, intent } = pendingReviewTarget;
  let action = null;

  if (entity === "document") {
    const document = documents.find((row) => row.id === entityId);
    if (document) action = documentReviewAction(document, "approved", { onReviewDocument });
  } else if (entity === "routeRevision") {
    const revision = routeRevisions.find((row) => row.id === entityId);
    if (revision) {
      action = intent === "apply"
        ? routeApplyAction(revision, { onApplyRouteRevision })
        : routeReviewAction(revision, { onReviewRouteRevision });
    }
  } else if (entity === "incident") {
    const incident = maydayIncidents.find((row) => row.id === entityId);
    if (incident) {
      action = maydayResumeAction(
        incident,
        maydayResumeInspectionRefs(incident, inspectionRuns),
        { onResumeMayday },
      );
    }
  }

  if (action) queueGovernanceAction(action);
  onPendingReviewTargetConsumed();
}, [pendingReviewTarget]);
```

The dependency array is deliberately just `[pendingReviewTarget]`. Including `documents`/`routeRevisions` would re-fire the effect on every poll tick and reopen a gate the user had cancelled. `onPendingReviewTargetConsumed()` runs unconditionally so a stale descriptor cannot wedge the effect.

Scroll the row into view — the one piece of DOM interaction that is genuinely presentational and belongs here rather than in the resolver:

```jsx
useEffect(() => {
  if (!pendingReview?.entity) return;
  document
    .querySelector(`[data-codesite-governance-entity="${pendingReview.entity}"]`)
    ?.scrollIntoView?.({ behavior: "auto", block: "nearest" });
}, [pendingReview?.entity]);
```

That requires the rows to carry the attribute. The row elements already have `data-codesite-document-id`, `data-codesite-route-revision-id` and `data-codesite-mayday-id`; add `data-codesite-governance-entity={document.id}` (respectively `revision.id`, `incident.id`) alongside them rather than replacing them — the existing attributes may be queried elsewhere.

```bash
cd synthi && grep -rn "data-codesite-document-id\|data-codesite-route-revision-id\|data-codesite-mayday-id" src/
```

- [ ] **Step 10: Verify both required-action tests pass unchanged**

```bash
cd synthi && npx vitest run src/components/codesite
```

Expected: all green, **including the two required-action tests with no edits to them.** Those tests assert observable behavior — gate opens, correct client call on confirm — so passing them without modification is the evidence that the rewrite preserved behavior. If you find yourself editing them, stop: the rewrite changed behavior.

- [ ] **Step 11: Commit**

```bash
git add synthi/src/components/codesite
git commit -m "feat(codesite): drive required-action review from state, not the DOM

handleRequiredActionReview switched to governance, waited a tick, then
querySelector'd the matching approve/apply/resume button and .click()ed it. That
only worked because every section was mounted at once; after view switching the
target is not in the DOM when Required Actions is on screen.

Now it resolves a {entity, entityId, intent} descriptor from state via
resolveGovernanceReviewTarget and hands it to GovernanceConsole, which opens the
review gate on that row using the same payload builders its own buttons use.
Deletes findGovernanceEntityRow, the last querySelector helper.

One intentional divergence: the old code read the buttons' disabled attribute, so
while a mutation was in flight every candidate looked unactionable and Review
silently scrolled to the console instead of opening the gate. The resolver ignores
the acting mutex — the gate's confirm button is independently disabled — so the
gate opens and confirmation waits, which is what the control was always for.

Both required-action tests pass without modification."
```

## Task 10: Add the Overview view

The landing view, and the answer to "someone opening it for the first time has no entry point."

**Files:**
- Modify: `synthi/src/components/codesite/views/OverviewView.jsx`
- Modify: `synthi/src/components/codesite/__tests__/CodeSitePanel.test.jsx`

Task 8 already created `OverviewView` holding the mission-control header, status rail, `TowerNowStrip` and `CodeSiteOperatingModel`. This task makes it a digest rather than the old top-of-page furniture.

- [ ] **Step 1: Write the failing test**

```jsx
it('surfaces required actions on the overview with a drill-in to governance', async () => {
  const state = radarState();
  state.controlState.requiredActions = [{
    kind: 'review_document',
    title: 'Review checkout schema RFI',
    owner: 'ATLAS-1',
    documentId: 'doc-1',
    severity: 'high',
  }];
  h.fetchCodeSiteRadarState.mockResolvedValue(state);
  renderPanel();
  await flush();

  const digest = container.querySelector('[data-testid="codesite-overview-attention"]');
  expect(digest).toBeTruthy();
  expect(digest.textContent).toContain('Review checkout schema RFI');

  await act(async () => {
    digest.querySelector('[data-testid="codesite-overview-attention-drill"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();
  expect(container.querySelector('[data-testid="codesite-governance-console"]')).toBeTruthy();
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd synthi && npx vitest run src/components/codesite -t "surfaces required actions on the overview"
```

Expected: FAIL — `codesite-overview-attention` does not exist.

- [ ] **Step 3: Add the attention digest**

In `views/OverviewView.jsx`, above the existing `TowerNowStrip`:

```jsx
<Section title="Needs Attention" icon={CodeSiteIcons.governance}>
  <div className="grid gap-1" data-testid="codesite-overview-attention">
    {attentionItems.length === 0 ? (
      <EmptyLine>Nothing is waiting on you.</EmptyLine>
    ) : (
      attentionItems.slice(0, 5).map((item) => (
        <Row key={item.id}>
          <span className="min-w-0 break-words">{item.label}</span>
          <div className="flex items-center gap-1">
            <Pill tone={item.severity}>{compact(item.severity, "medium")}</Pill>
            <IconButton
              title={`Open ${item.label} in ${item.viewLabel}`}
              onClick={() => onSelect(item.viewKey)}
              testId="codesite-overview-attention-drill"
            >
              Open
            </IconButton>
          </div>
        </Row>
      ))
    )}
  </div>
</Section>
```

Build `attentionItems` from data the shell already derives — no new fetches:

```jsx
const attentionItems = useMemo(() => [
  ...requiredActions.map((action, index) => ({
    id: `action-${actionEntityId(action) || index}`,
    label: actionLabel(action),
    severity: actionSeverity(action),
    viewKey: "governance",
    viewLabel: "Governance",
  })),
  ...openMaydays.map((incident) => ({
    id: `mayday-${incident.id}`,
    label: `Paused: ${productCopy(incident.category, "incident")}`,
    severity: "critical",
    viewKey: "governance",
    viewLabel: "Governance",
  })),
  ...actionableQuarantineRecords.map((record) => ({
    id: `quarantine-${record.id}`,
    label: `Quarantined change: ${compact(record.id, "record")}`,
    severity: "high",
    viewKey: "quarantine",
    viewLabel: "Quarantine",
  })),
], [requiredActions, openMaydays, actionableQuarantineRecords]);
```

`requiredActions`, `openMaydays` and `actionableQuarantineRecords` are all existing derived values in the shell — pass them into `OverviewView` rather than recomputing.

- [ ] **Step 4: Verify, audit, commit**

```bash
cd synthi && npx vitest run src/components/codesite
```

Expected: all green.

Per the standing instruction, audit this slice for improperly hardcoded values before committing — the `slice(0, 5)` cap and the severity strings are the candidates. The severities are domain vocabulary matching `actionSeverity`'s output and belong inline; the cap should be a named constant if any other view caps a list, and inline if it is the only one.

```bash
git add synthi/src/components/codesite
git commit -m "feat(codesite): add a Needs Attention digest to the overview

Overview is the landing view, so it should answer 'what is waiting on me' before
anything else. Aggregates required actions, paused incidents and actionable
quarantines from data the shell already derives — no new requests — each with a
drill-in that switches to the owning view."
```

---

# Part C — Data flow and responsiveness

## Task 11: Split core from per-view fetching

**Files:**
- Modify: `synthi/src/components/codesite/codesiteClient.js` (decompose only — no endpoint or shape changes)
- Create: `synthi/src/components/codesite/state/useCodeSiteCore.js`
- Modify: `synthi/src/components/codesite/CodeSitePanel.jsx`

`fetchCodeSiteRadarState` (codesiteClient.js:344–400) fans out `5 + N` requests where N is the number of distinct transaction ids, every `POLL_MS = 5000`, and nothing paints until all of them resolve — including artifact previews and quarantines the user may never open.

- [ ] **Step 1: Read the fan-out before changing it**

```bash
cd synthi && sed -n '344,400p' src/components/codesite/codesiteClient.js
```

Classify each request as **core** (needed by the header, rail badges, or Overview) or **per-view**. Expect core to be projects + project + controlState + counts, and per-view to be metrics, artifact preview, quarantines and line provenance. Write the actual classification down before writing code — the plan's expectation is a starting point, not a substitute for reading.

- [ ] **Step 2: Add `fetchCodeSiteCoreState` alongside the existing function**

Export a new function that performs only the core requests and returns the same normalized shape with per-view slices empty. **Keep `fetchCodeSiteRadarState` exported and working** — the test suite mocks it by name in `vi.hoisted`, and every existing test depends on it:

```bash
cd synthi && grep -n "fetchCodeSiteRadarState" src/components/codesite/__tests__/CodeSitePanel.test.jsx | head
```

Run both through `normalizeCodeSiteRadarState` (codesiteClient.js:72) so there is exactly one normalizer and per-view data cannot arrive in a different shape than the composite path produced.

- [ ] **Step 3: Keep the tests passing by keeping the composite path**

```bash
cd synthi && npx vitest run src/components/codesite
```

Expected: all green with no test edits. If the shell now calls `fetchCodeSiteCoreState` on mount, the existing mocks of `fetchCodeSiteRadarState` will return `undefined` and everything will fail — so either have the shell fall back to the composite call when the core call is not mocked, or add the new mock to `vi.hoisted` in the same commit. Prefer adding the mock; a production fallback that exists only to satisfy tests is the wrong shape.

- [ ] **Step 4: Move liveness to SSE-first**

`subscribeCodeSiteProjectEvents` already streams 36 named event types and is already wired (the effect formerly at 6961–6986). Make it primary and slow the poll:

```jsx
const POLL_MS = 30000;
```

Only the mounted view polls. Before committing to 30s, map each view's data to the event types that invalidate it:

```bash
cd synthi && grep -n "addEventListener\|EVENT_TYPES\|eventTypes" src/components/codesite/codesiteClient.js
```

Any view whose data has **no** corresponding event type keeps a shorter poll — otherwise it silently goes stale for up to 30 seconds, which is worse than the churn this task is removing. Record the mapping in a comment next to `POLL_MS` so the next person can tell which views are covered by the stream and which are not.

- [ ] **Step 5: Verify and commit**

```bash
cd synthi && npx vitest run src/components/codesite
```

```bash
git add synthi/src/components/codesite
git commit -m "perf(codesite): split core from per-view fetching, SSE-first liveness

fetchCodeSiteRadarState issued 5+N requests every 5s and first paint waited on
all of them, including artifact previews and quarantines the user may never open.
Core (projects, project, controlState, counts) now feeds first paint; per-view
data loads when its view mounts.

Liveness moves to the already-wired SSE stream, with the poll dropped to 30s as a
safety net and only the mounted view polling. Views whose data has no
corresponding event type keep a shorter poll — mapping recorded next to POLL_MS.

Endpoints and payload shapes are unchanged, and both fetch paths share
normalizeCodeSiteRadarState so per-view data cannot arrive in a different shape."
```

## Task 12: Convert layout to container queries

The root cause of "not as responsive as it should be": the panel uses **viewport** breakpoints to lay out a **dock** whose width is independent of the viewport. On a wide monitor a 380px sidebar still matches `xl:`, so it attempts two-column layouts with 430–460px minimums inside 380px of space.

Tailwind v4 has container queries built in — no plugin, no config. Mark the container with `@container`, then use `@md:` / `@min-[460px]:` variants which resolve against the *container's* width.

**Files:** Modify the panel root plus the sites listed below.

- [ ] **Step 1: Make the panel root a container**

On the element carrying `data-testid="codesite-panel"` in `CodeSitePanel.jsx`, add `@container/panel`. The name lets nested containers coexist without ambiguity.

- [ ] **Step 2: Convert the fixed-min two-column splits**

These are the sites that break hardest, because their pixel minimums exceed a narrow dock's entire width. Line numbers are pre-refactor; find them by their class strings after Parts A and B moved them.

| Was at | Current | Becomes |
|---|---|---|
| 7987 | `xl:grid-cols-[minmax(0,1fr)_minmax(460px,0.82fr)] xl:items-center` | `@min-[52rem]/panel:grid-cols-[minmax(0,1fr)_minmax(0,0.82fr)] @min-[52rem]/panel:items-center` |
| 8086 | `xl:grid-cols-[minmax(0,1.08fr)_minmax(430px,0.92fr)] xl:items-start` | `@min-[48rem]/panel:grid-cols-[minmax(0,1.08fr)_minmax(0,0.92fr)] @min-[48rem]/panel:items-start` |
| 4663 | `xl:grid-cols-[minmax(260px,0.82fr)_minmax(0,1.18fr)]` | `@min-[44rem]/panel:grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)]` |

The pattern in every case: **drop the pixel minimum from the track and put the threshold in the query instead.** A `minmax(460px,…)` track inside a 380px container overflows no matter what breakpoint gates it; the container query is what actually prevents the two-column attempt.

Then do the same at the remaining audited sites: 3477, 2443, 6072, 5696, 5887.

- [ ] **Step 3: Convert the fixed-width rail card**

`DesktopSectionRail` (formerly 4111) uses a hardcoded 280px card. In a 320px dock that leaves 40px for content. Replace the fixed width with a container-query-gated one so the rail collapses to icons-only when the panel is narrow. `MobileSectionTabs` already handles the collapsed presentation — reuse it by choosing between the two on container width rather than viewport width, which is the actual bug: a 380px dock on a 2560px monitor currently gets the desktop rail.

- [ ] **Step 4: Convert the unconditional multi-column grids**

Sites: 4074, 2954, 8971, 4438, 5902, 5775, 6174, 1524, 3620, 3782, 6693, 4398. Each declares columns with no breakpoint at all, so it is multi-column even at 320px. Give each a single-column base and an `@min-[…]/panel:` multi-column variant.

Also: 2221 (`lg:grid-cols-4` — content-agnostic fixed count), 2815, 1866/1884.

- [ ] **Step 5: Make `TowerNowStrip` reflow instead of scroll**

Formerly line 1679: six cards at `min-w-[9.25rem]` inside an `overflow-x-auto` — about 888px of minimum content. In a narrow dock the user gets a horizontal scrollbar over their primary status display. Replace the horizontal scroll with a wrapping grid that goes to one column at narrow container widths and back to six when there is room.

- [ ] **Step 6: Verify at all four target widths**

The tests cannot catch layout regressions, so check this in the browser. `codesite-responsive-proof-target` exists to be measured.

```bash
cd synthi && npm run dev
```

Then check the panel at a narrow dock (320–420px), a half-screen dock (600–900px), the full-screen route, and a <768px viewport. At every width, confirm: no horizontal scrollbar on the panel body, no clipped text, no overlapping controls, and every rail entry reachable.

- [ ] **Step 7: Confirm the panel inherits theme tokens**

The panel already inherits `--codesite-*` from `[data-panel-type="codesite"]` in `globals.css` as of `e29b58b78`. Find remaining one-off inline gradients and borders and resolve them to those tokens, so the panel does not look out of place next to the other panels:

```bash
cd synthi && grep -rn 'oklch(' src/components/codesite/ | grep -v lib/
```

Any literal `oklch()` in a component is a hardcoded color that should be a token. This is the hardcoded-values audit for this slice.

- [ ] **Step 8: Commit**

```bash
git add synthi/src/components/codesite synthi/src/app/globals.css
git commit -m "fix(codesite): lay out against panel width, not viewport width

The panel is a dock whose width is independent of the viewport, but it used
viewport breakpoints: a 380px sidebar on a wide monitor still matches xl:, so it
attempted two-column layouts with 430-460px minimums inside 380px. Hence 'not as
responsive as it should be'.

Converts to Tailwind v4 container queries against a named @container/panel root,
and drops the pixel minimums from grid tracks — a minmax(460px,...) track
overflows a 380px container regardless of which breakpoint gates it.

Also picks the rail-vs-tabs presentation on container width instead of viewport
width, and makes TowerNowStrip reflow rather than putting a horizontal scrollbar
over the primary status display."
```

## Task 13: Wire the saved-view filters

The `Active` / `Review` / `Evidence` buttons (formerly 1850–1863) look like filters but have no `onClick`. Making them real is the natural remedy for density: show only what needs action.

**Files:**
- Modify: `synthi/src/components/codesite/views/overview/CodeSiteOperatingModel.jsx`
- Modify: `synthi/src/components/codesite/__tests__/CodeSitePanel.test.jsx`

- [ ] **Step 1: Write the failing test**

```jsx
it('filters the operating queue by saved view', async () => {
  h.fetchCodeSiteRadarState.mockResolvedValue(radarState());
  renderPanel();
  await flush();

  const queue = () => container.querySelector('[data-testid="codesite-operating-model"]');
  const before = queue().textContent;

  await act(async () => {
    container.querySelector('[data-testid="codesite-saved-view-review"]')
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();

  expect(container.querySelector('[data-testid="codesite-saved-view-review"]')
    .getAttribute('aria-pressed')).toBe('true');
  expect(queue().textContent).not.toBe(before);
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd synthi && npx vitest run src/components/codesite -t "filters the operating queue"
```

Expected: FAIL — `codesite-saved-view-review` does not exist.

- [ ] **Step 3: Implement**

Add local state (`useState("active")`) — no persistence was requested, so do not add any. Give each button `onClick`, `aria-pressed`, and a `testId` of `codesite-saved-view-active` / `-review` / `-evidence`. Filter the rows the component already renders: `active` shows in-flight work, `review` shows only rows needing a decision, `evidence` shows rows with proof refs.

Adding three test ids raises the invariant baseline. That is expected — the check asserts a superset, so additions pass. Do **not** regenerate `tasks/codesite-testid-baseline.txt`; it is a historical record of what existed before the redesign, and rewriting it would destroy the guarantee.

- [ ] **Step 4: Verify and commit**

```bash
cd synthi && npx vitest run src/components/codesite
```

```bash
git add synthi/src/components/codesite
git commit -m "feat(codesite): make the Active/Review/Evidence saved views functional

These three buttons have looked like filters since they were added but had no
onClick. Filtering the operating queue to just what needs a decision is the
natural remedy for density. Selection is local UI state; no persistence."
```

## Task 14: Final verification

**Files:** none modified.

- [ ] **Step 1: Confirm every baseline test id survived**

```bash
cd synthi && npx vitest run src/components/codesite/__tests__/testIdInvariant.test.js
```

Expected: `Tests 1 passed (1)`. This is the mechanical proof of "kept EVERY single functionality."

- [ ] **Step 2: Confirm the full suite is green and grew**

```bash
cd synthi && npx vitest run src/components/codesite
```

Test count must be **higher** than the 8 you started with. A lower count means a test was deleted rather than migrated.

- [ ] **Step 3: Check nothing outside codesite broke**

```bash
cd synthi && npx vitest run 2>&1 | tail -20
```

Compare against the pre-refactor result for the same command. `lib/` extraction changed no public API, so any new failure elsewhere means something imported from `CodeSitePanel.jsx` that no longer exports it:

```bash
cd synthi && grep -rn "from.*codesite/CodeSitePanel" src/ --include=*.jsx --include=*.js | grep -v __tests__
```

- [ ] **Step 4: Full hardcoded-values audit**

Per the standing instruction, a full audit runs at the end of all slices, not just per-slice. This is a production-bound app.

```bash
cd synthi && grep -rn 'oklch(\|#[0-9a-fA-F]\{6\}\|localhost\|http://' src/components/codesite/ | grep -v __tests__
```

Every literal color should be a `--codesite-*` or global token. Any URL or port is a bug. Timing constants (`POLL_MS`, animation durations) should be named, not inline.

- [ ] **Step 5: Manual walkthrough**

Open the panel and visit all ten views. For each: it renders, its actions are present and enabled/disabled as expected, and its data matches what the old panel showed. Then specifically re-test:

- Required Actions → Review, for a document, a **proposed** route revision, an **approved** route revision, and a paused incident with and without inspection evidence. The proposed-route case is the one that was broken before `53ae02a9d`.
- `TowerNowStrip` and `CodeSiteOperatingModel` drill-ins — each should switch views.
- The quarantine path toggles, replay, and apply.
- Export, refresh, and project switching from the shell header.

- [ ] **Step 6: Report the graph is untouched**

```bash
git diff 79ef2e48b..HEAD -- synthi/src/components/codesite/views/graph/
```

Expected: additions only, from the file move — no content changes. The user deferred the graph's layout and interaction model pending their own evaluation, and this is the evidence that deferral was honored.

---

## Self-review notes

Checked against `docs/superpowers/specs/2026-07-25-codesite-panel-redesign-design.md`:

- Spec steps 1–9 map to Tasks 1–13; spec step 1 (baseline + invariant) is already committed as `a0a0900c8`.
- All six numbered problems in the spec are addressed: crowding (Task 8), 12+ unreachable sections (Task 8's view table), narrow-width breakage (Task 12), churn (Task 11), slow first paint (Task 11), dead controls (Task 13).
- All four width targets are verified in Task 12 Step 6.
- The graph deferral is enforced three times: Task 4 diffs it for content identity, Task 4's commit message records why, and Task 14 Step 6 proves it at the end.
- Naming is consistent across tasks: `resolveGovernanceReviewTarget`, `governanceReviewCandidates`, `documentReviewAction`, `routeReviewAction`, `routeApplyAction`, `maydayResumeAction` are defined in Task 9 Step 3 and used with those exact signatures in Steps 5, 8 and 9.
- `sections` (Task 8 Step 7) replaces `mobileSections` and is referenced by that name in the router and both rails.

Known gap, deliberate: Task 11 Step 1 requires reading the actual fan-out before classifying requests as core vs per-view, rather than the plan asserting the classification. The spec flags the same thing for the SSE event mapping in Step 4. Both depend on facts in `codesiteClient.js` that must be read at implementation time rather than guessed here — writing a confident-looking classification would be fiction.
