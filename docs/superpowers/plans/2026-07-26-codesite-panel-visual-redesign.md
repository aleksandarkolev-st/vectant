# CodeSite Panel Visual Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the CodeSite panel look like it belongs beside the Workflows panel, and cut its perceived density, without losing a single function.

**Architecture:** Three independent slices, ordered lowest-risk first. (A) Stop the panel painting its own shell over the dock frame and fold `--codesite-*` into the shared token vocabulary. (B) Strip the section chrome down to the label-plus-count pattern the sibling panels use, and stop rendering sections that have nothing in them. (C) Replace the flat 10-tab rail with the two-level navigation Workflows already ships: a four-tile command strip over a sub-view strip.

**Tech Stack:** Next.js 15 App Router, React 19, Tailwind CSS v4 (container queries, no plugin), framer-motion 12, lucide-react, vitest 4 + jsdom.

---

## Why Workflows is the reference

Not a taste call. The activity bar puts CodeSite in the **Agents** group with AI Chat, Workflows, and AI Healing (`components/docking-wm/components/DockingActivityBar.jsx:81-90`), and `app/globals.css:1261-1269` already mirrors that grouping in CSS, giving all four the same frame background. Programs sits in the **Platform** group with a different frame treatment (`globals.css:1286-1290`).

That matters for one specific reason: Programs sets `background: var(--bg-sidebar)` and deliberately drops its outer border and shadow. `components/programs/programTokens.js:7-12` says why:

> "no outer border or drop-shadow (those made this panel read as a lighter 'gray' slab against its black siblings)"

Copying Programs' *values* would be wrong, because Programs goes flush to let the **Platform** frame show. Copying its *principle* is right: go flush and let your own group's frame show. For CodeSite that means `vt-app-surface` + `vt-toolbar`, exactly as `AgentWorkflowPanel.jsx:1793-1797` does.

Today CodeSite does the opposite — it repaints over the frame with `--codesite-panel-surface` and a header carrying `shadow-[0_12px_28px_rgba(0,0,0,0.16)]`. That shadow is the single biggest contributor to "looks out of place."

## Invariants — do not break these

1. **All 103 baseline test ids must survive.** `synthi/src/components/codesite/__tests__/testIdInvariant.test.js` asserts a superset of `tasks/codesite-testid-baseline.txt`. Additions are fine; removals fail. **Never regenerate the baseline** — it is a historical record.
2. **Four nav ids are in that baseline** and must keep existing on *something*: `codesite-desktop-section-rail`, `codesite-desktop-section-tab`, `codesite-mobile-section-tabs`, `codesite-mobile-section-tab`. Task 8 re-homes them.
3. **35 tests must stay green**, with no assertion weakened or deleted. Task 8 changes the `selectSection` *helper*; it must not change any `expect(...)`.
4. **`synthi/src/components/codesite/views/graph/` stays untouched.** The user deferred the map pending their own evaluation. `git diff dev..HEAD -- .../views/graph/` must stay empty. Its *surrounding* panes restyle via the shared primitives; the topology itself does not.
5. **No literal colors.** No `oklch(`, no 6-digit hex, no URLs. Every colour resolves to a token.
6. **Container queries only.** No `sm:`/`md:`/`lg:`/`xl:` variants — the panel is a dock and lays out against `@min-[…]/panel:`. Note Tailwind's container t-shirt scale is *not* the viewport scale (`@md` is 28rem, not 48rem), so always use explicit `@min-[…]`.

## File Structure

**Modify:**
- `synthi/src/components/codesite/CodeSitePanel.jsx` — shell classes, group model, nav wiring
- `synthi/src/components/codesite/ui/Section.jsx` — flatten to label + count
- `synthi/src/components/codesite/ui/OperatorPane.jsx` — remove the nested card
- `synthi/src/components/codesite/nav/DesktopSectionRail.jsx` — becomes the command strip host
- `synthi/src/components/codesite/nav/MobileSectionTabs.jsx` — keeps its two baseline ids, restyled
- `synthi/src/components/codesite/__tests__/CodeSitePanel.test.jsx` — `selectSection` helper only
- `synthi/src/components/codesite/views/GraphView.jsx` and the other nine views — `hideWhenEmpty` flags

**Create:**
- `synthi/src/components/codesite/lib/sectionGroups.js` — the group model, one source of truth
- `synthi/src/components/codesite/nav/CommandStrip.jsx` — four group tiles
- `synthi/src/components/codesite/nav/ViewStrip.jsx` — sub-views of the active group

---

# Part A — Shell and tokens

## Task 1: Stop the panel painting over its own frame

**Files:**
- Modify: `synthi/src/components/codesite/CodeSitePanel.jsx:1060-1075`

- [ ] **Step 1: Confirm the reference markup before copying it**

```bash
cd synthi && sed -n '1792,1800p' src/components/agent-workflows/AgentWorkflowPanel.jsx
```

Expected: a root `<section className="vt-app-surface flex h-full min-h-0 w-full flex-col overflow-hidden">` followed by `<header className="vt-toolbar px-4 py-3">`. If that is not what you see, stop and re-read before continuing — the rest of this task copies it.

- [ ] **Step 2: Swap the root and header classes**

Replace the root element and the header opening tag:

```jsx
    <div
      data-testid="codesite-panel"
      className="vt-app-surface @container/panel flex h-full min-h-0 w-full flex-col overflow-hidden"
      style={{
        "--text-muted":
          "color-mix(in srgb, var(--text-secondary) 78%, var(--text-primary) 22%)",
        color: "var(--text-primary)",
      }}
    >
      <div className="vt-toolbar shrink-0 px-3 py-2">
```

`vt-toolbar` already supplies `min-height: 36px`, `border-bottom: 1px solid var(--border-subtle)`, and the panel gradient (`globals.css:1138-1144`), so the old `border-b`, the `shadow-[0_12px_28px_rgba(0,0,0,0.16)]`, the `borderColor`, and the `background` gradient all go. Keep `@container/panel` — every layout rule in the panel depends on it.

- [ ] **Step 3: Verify the shadow is gone repo-wide in this panel**

```bash
cd synthi && grep -rn "shadow-\[0_1" src/components/codesite/ | grep -v __tests__
```

Expected: the two `nav/` files still match (Task 8 handles those), nothing else. If a view still carries a heavy drop shadow, it will read as a raised slab against the flat frame; remove it.

- [ ] **Step 4: Run the tests**

```bash
cd synthi && npx vitest run src/components/codesite
```

Expected: `Tests  35 passed (35)`.

- [ ] **Step 5: Commit**

```bash
git add synthi/src/components/codesite
git commit -m "fix(codesite): let the Agents panel frame show through

The panel repainted its own shell over the dock frame -- a gradient header with
a 28px drop shadow plus --codesite-panel-surface -- which is precisely the thing
programTokens.js records removing from the Programs panel because it 'made this
panel read as a lighter gray slab against its black siblings'.

globals.css:1261 already gives chat, agent-workflows, codesite and ai-healing a
shared frame background, matching the Agents group in the activity bar. Adopting
vt-app-surface and vt-toolbar, as AgentWorkflowPanel does, lets that frame show."
```

## Task 2: Fold `--codesite-*` into the shared vocabulary

**Files:**
- Modify: `synthi/src/app/globals.css:1274-1283`
- Modify: whichever codesite components reference the two structural tokens

- [ ] **Step 1: Find every use of the two structural tokens**

```bash
cd synthi && grep -rn "codesite-panel-surface\|codesite-panel-line" src/ | grep -v __tests__
```

Write the list down. These two are structural (a surface and a border) and are what make the panel diverge; the status tokens (`--codesite-success`, `--codesite-warning`, `--codesite-danger`, `--codesite-accent-secondary`, `--codesite-muted-accent`) are semantic and **stay**, because they let a theme re-tint status meaning.

- [ ] **Step 2: Replace the structural two at their use sites**

- `var(--codesite-panel-line)` becomes `var(--border-subtle)`.
- `var(--codesite-panel-surface)` becomes `color-mix(in srgb, var(--bg-panel) 72%, transparent)` — the value `PROGRAM_STYLE.header` and `WorkflowCommandStrip` both already use, so all three panels land on one surface value.

- [ ] **Step 3: Delete the two declarations from globals.css**

Remove these two lines from the `[data-panel-type="codesite"]` block, leaving the five semantic tokens and `color`:

```css
  --codesite-panel-line: color-mix(in srgb, var(--border-subtle) 88%, var(--accent-primary) 12%);
  --codesite-panel-surface: color-mix(in srgb, var(--bg-sidebar) 94%, var(--bg-editor) 6%);
```

Update the comment above the block so it still tells the truth: the panel derives *status* colours from the theme, and takes structure from the shared tokens.

- [ ] **Step 4: Prove no dangling references**

```bash
cd synthi && grep -rn "codesite-panel-surface\|codesite-panel-line" src/
```

Expected: no output. A dangling `var(--codesite-panel-line)` resolves to nothing and silently renders a transparent border.

- [ ] **Step 5: Verify and commit**

```bash
cd synthi && npx vitest run src/components/codesite
```

```bash
git add synthi/src/components/codesite synthi/src/app/globals.css
git commit -m "refactor(codesite): take structure from shared tokens, keep status local

--codesite-panel-line and --codesite-panel-surface were a third structural
vocabulary alongside vt-* and PROGRAM_STYLE. Both now resolve to the shared
values every sibling panel uses. The five semantic status tokens stay, since
they are what lets a theme re-tint what warning and danger mean."
```

---

# Part B — Section chrome

## Task 3: Flatten `Section` to a label and a count

Today `Section` renders an accent-tinted top border, a 48px header bar with its own gradient background *and* a bottom border, and a 28x28 bordered icon plate with an inset highlight, to display one title. `LibraryView.jsx:9-16` renders the same information as a 10px uppercase label and a number.

**Files:**
- Modify: `synthi/src/components/codesite/ui/Section.jsx`

- [ ] **Step 1: Replace the component body**

The `title` / `icon` / `right` / `children` API is unchanged, so no call site needs editing. `hideWhenEmpty` and `count` are new and optional; Task 5 uses them.

```jsx
// A section is a label over its content, not a framed box. The panel has up to
// nine of these stacked, so every pixel of chrome here is multiplied by nine.
// Matches the label-and-count pattern the sibling panels use.
export default function Section({
  title,
  icon: Icon,
  children,
  right,
  count,
  hideWhenEmpty = false,
}) {
  if (hideWhenEmpty && !count) return null;

  return (
    <section className="flex min-w-0 flex-col gap-2 px-3 pb-4 pt-3">
      <div className="flex min-h-5 items-center justify-between gap-2">
        <span
          className="flex min-w-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: "var(--text-muted)" }}
        >
          {Icon ? <Icon className="h-3 w-3 shrink-0" strokeWidth={2} /> : null}
          <span className="truncate">{title}</span>
        </span>
        {right}
      </div>
      {children}
    </section>
  );
}
```

- [ ] **Step 2: Run the tests**

```bash
cd synthi && npx vitest run src/components/codesite
```

Expected: `Tests  35 passed (35)`. Section carries no test id, and every assertion targets ids inside `children`, so this should pass untouched. If something fails, an assertion was matching on the header chrome — read it before changing anything.

- [ ] **Step 3: Commit**

```bash
git add synthi/src/components/codesite/ui/Section.jsx
git commit -m "refactor(codesite): reduce Section to a label and a count

Section rendered an accent top border, a 48px gradient header bar with its own
bottom border, and a bordered icon plate with an inset highlight -- to show one
title. Up to nine of these stack in a view, so the chrome was multiplied nine
times over. Now a 10px uppercase label and a count, as the sibling panels do."
```

## Task 4: Remove `OperatorPane`'s nested card

`OperatorPane` renders a bordered rounded card, containing a bordered rounded header bar, containing an icon plate. Three surfaces for one title. Nested cards are never the right answer.

**Files:**
- Modify: `synthi/src/components/codesite/ui/OperatorPane.jsx`

- [ ] **Step 1: Replace the component body**

Keeps the entry animation and the `testId` prop, both of which tests and the baseline depend on.

```jsx
import { MOTION_EASE } from "../lib/motion";
import { motion, useReducedMotion } from "framer-motion";

// One surface, not three. This used to be a bordered card wrapping a bordered
// header bar wrapping an icon plate.
export default function OperatorPane({
  title,
  icon: Icon,
  right,
  testId,
  children,
  className = "",
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.section
      data-testid={testId}
      layout={!reduceMotion}
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.22, ease: MOTION_EASE }}
      className={`min-w-0 overflow-hidden rounded-[var(--radius-panel)] border ${className}`}
      style={{
        borderColor: "var(--border-subtle)",
        background: "color-mix(in srgb, var(--bg-panel) 72%, transparent)",
      }}
    >
      <div
        className="flex min-h-9 items-center justify-between gap-3 border-b px-3 py-2"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <span
          className="flex min-w-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: "var(--text-muted)" }}
        >
          {Icon ? <Icon className="h-3 w-3 shrink-0" strokeWidth={2} /> : null}
          <span className="truncate">{title}</span>
        </span>
        {right}
      </div>
      <div className="p-2.5 @min-[28rem]/panel:p-3">{children}</div>
    </motion.section>
  );
}
```

- [ ] **Step 2: Verify and commit**

```bash
cd synthi && npx vitest run src/components/codesite
```

```bash
git add synthi/src/components/codesite/ui/OperatorPane.jsx
git commit -m "refactor(codesite): collapse OperatorPane's nested cards into one surface

A bordered card wrapping a bordered header bar wrapping an icon plate: three
surfaces to present a single title. One bordered surface with a divider row."
```

## Task 5: Stop rendering sections that have nothing in them

`LibraryView.jsx:82-94` does not mount its Stopped or Crashed sections when they are empty; only the primary section gets an explicit empty state. CodeSite renders every section always, each with its own "No X yet" line.

**Files:**
- Modify: each file under `synthi/src/components/codesite/views/` **except** `views/graph/`

- [ ] **Step 1: List the candidate sections**

```bash
cd synthi && grep -rn "<Section" src/components/codesite/views/ | grep -v "views/graph/"
```

- [ ] **Step 2: Apply the rule**

For each view: the **first** section keeps its empty state, because a view that renders nothing at all looks broken. Every **subsequent** section gets `hideWhenEmpty` plus the count it already computes for its `right` pill.

Worked example, `views/GraphView.jsx`. "Conflict Forecast" is the first section in that file and keeps its `EmptyLine`. The two after it change from:

```jsx
      <Section
        title="Workstreams"
        icon={CodeSiteIcons.agents}
        right={<Pill>{activeFlights.length}</Pill>}
      >
```

to:

```jsx
      <Section
        title="Workstreams"
        icon={CodeSiteIcons.agents}
        count={activeFlights.length}
        hideWhenEmpty
        right={<Pill>{activeFlights.length}</Pill>}
      >
```

and likewise "Work Scope Zones" with `count={zones.length}`.

`views/GraphView.jsx` is *not* inside `views/graph/` and is in scope. The topology component it renders, `views/graph/ScopeTopology.jsx`, is not.

- [ ] **Step 3: Confirm no view can render completely empty**

```bash
cd synthi && npx vitest run src/components/codesite
```

Expected: `Tests  35 passed (35)`. Several tests assert on empty-state text; if one fails, you applied `hideWhenEmpty` to a view's first section. Move it to the next one rather than deleting the assertion.

- [ ] **Step 4: Commit**

```bash
git add synthi/src/components/codesite/views
git commit -m "feat(codesite): stop rendering sections with nothing in them

Every section rendered unconditionally, each with its own 'No X yet' placeholder,
so a quiet project still filled the panel with headings for things that do not
exist. Secondary sections now unmount when empty, as the Programs library does;
each view's first section keeps its empty state so no view renders blank."
```

---

# Part C — Navigation

## Task 6: Add the group model

**Files:**
- Create: `synthi/src/components/codesite/lib/sectionGroups.js`

- [ ] **Step 1: Create the file**

```js
import { CodeSiteIcons } from "../icons";

/**
 * Ten sections is more than a panel this size can present flat, which is why the
 * old rail needed a horizontal scroller. Workflows solves the same problem with
 * two levels: a four-tile command strip over a sub-view strip. These four groups
 * are that first level.
 *
 * Order matters — it is the order of the tiles, and `live` is the landing group.
 */
export const SECTION_GROUPS = [
  {
    key: "live",
    label: "Live",
    icon: CodeSiteIcons.liveState,
    sections: ["overview", "radar", "tower"],
  },
  {
    key: "decisions",
    label: "Decisions",
    icon: CodeSiteIcons.governance,
    sections: ["governance", "runway", "quarantine"],
  },
  {
    key: "proof",
    label: "Proof",
    icon: CodeSiteIcons.evidence,
    sections: ["evidence", "inspections"],
  },
  {
    key: "analysis",
    label: "Analysis",
    icon: CodeSiteIcons.replay,
    sections: ["replay", "simulator"],
  },
];

export const DEFAULT_GROUP_KEY = "live";

/** Which group owns a section key. Falls back to the landing group. */
export function groupForSection(sectionKey) {
  const group = SECTION_GROUPS.find((entry) => entry.sections.includes(sectionKey));
  return group?.key || DEFAULT_GROUP_KEY;
}

/**
 * Tile detail line and count, mirroring WorkflowCommandStrip's `detail`/`count`.
 * This is what makes the panel legible to someone opening it for the first time:
 * "Decisions · Needs review · 4" explains the panel without a click.
 */
export function groupSummary(groupKey, counts, extra = {}) {
  const {
    requiredActions = 0,
    activeFlights = 0,
    proofBundles = 0,
    inspectionRuns = 0,
  } = counts || {};
  const { actionableQuarantines = 0, counterfactualRuns = 0 } = extra;

  if (groupKey === "live") {
    return {
      detail: activeFlights ? "In flight" : "Idle",
      count: activeFlights,
      tone: activeFlights ? "active" : "idle",
    };
  }
  if (groupKey === "decisions") {
    const pending = requiredActions + actionableQuarantines;
    return {
      detail: pending ? "Needs review" : "Clear",
      count: pending,
      tone: pending ? "high" : "low",
    };
  }
  if (groupKey === "proof") {
    return {
      detail: proofBundles ? "Captured" : "Waiting",
      count: proofBundles + inspectionRuns,
      tone: proofBundles ? "active" : "idle",
    };
  }
  return {
    detail: counterfactualRuns ? "Runs recorded" : "No runs",
    count: counterfactualRuns,
    tone: "idle",
  };
}
```

- [ ] **Step 2: Write the failing test**

Create `synthi/src/components/codesite/lib/__tests__/sectionGroups.test.js`:

```js
import { describe, expect, it } from 'vitest';
import { SECTION_GROUPS, groupForSection, groupSummary } from '../sectionGroups';

const ALL_SECTIONS = [
  'overview', 'radar', 'tower', 'governance', 'runway',
  'quarantine', 'evidence', 'inspections', 'replay', 'simulator',
];

describe('section groups', () => {
  it('covers all ten sections exactly once', () => {
    const covered = SECTION_GROUPS.flatMap((group) => group.sections);
    expect(covered.slice().sort()).toEqual(ALL_SECTIONS.slice().sort());
    expect(new Set(covered).size).toBe(ALL_SECTIONS.length);
  });

  it('maps every section to an existing group', () => {
    for (const section of ALL_SECTIONS) {
      const key = groupForSection(section);
      expect(SECTION_GROUPS.some((group) => group.key === key)).toBe(true);
    }
  });

  it('flags decisions as needing review when actions are pending', () => {
    const summary = groupSummary('decisions', { requiredActions: 3 }, { actionableQuarantines: 1 });
    expect(summary).toMatchObject({ detail: 'Needs review', count: 4, tone: 'high' });
  });

  it('reports decisions clear when nothing is pending', () => {
    expect(groupSummary('decisions', { requiredActions: 0 }, {})).toMatchObject({
      detail: 'Clear',
      count: 0,
    });
  });
});
```

- [ ] **Step 3: Run it**

```bash
cd synthi && npx vitest run src/components/codesite/lib/__tests__/sectionGroups.test.js
```

Expected: `Tests  4 passed (4)`.

- [ ] **Step 4: Commit**

```bash
git add synthi/src/components/codesite/lib
git commit -m "feat(codesite): add the four-group section model

Ten flat sections is why the rail needed a horizontal scroller. Groups them the
way Workflows groups its four, with a detail line and count per group so a tile
reads 'Decisions - Needs review - 4' without being clicked.

Test pins the invariant that matters: every section belongs to exactly one group."
```

## Task 7: Build the command strip

Mirrors `AgentWorkflowPanel.jsx:847-895`, converted from `sm:grid-cols-4` to container queries.

**Files:**
- Create: `synthi/src/components/codesite/nav/CommandStrip.jsx`

- [ ] **Step 1: Create the component**

```jsx
import { CodeSiteIcons } from "../icons";

/**
 * The panel's first navigation level. Deliberately close to Workflows'
 * WorkflowCommandStrip, because CodeSite sits beside it in the Agents group.
 * Container queries rather than sm: — this is a dock, not a page.
 */
export default function CommandStrip({ groups, activeGroup, onSelect }) {
  return (
    <div
      data-testid="codesite-command-strip"
      className="grid gap-1 rounded-md border p-1 @min-[26rem]/panel:grid-cols-2 @min-[44rem]/panel:grid-cols-4"
      style={{
        borderColor: "var(--border-subtle)",
        background: "color-mix(in srgb, var(--bg-panel) 72%, transparent)",
      }}
      role="tablist"
      aria-label="CodeSite section groups"
    >
      {groups.map((group) => {
        const active = activeGroup === group.key;
        const Icon = group.icon || CodeSiteIcons.liveState;
        return (
          <button
            key={group.key}
            type="button"
            role="tab"
            aria-selected={active}
            data-testid="codesite-command-tile"
            data-codesite-group-key={group.key}
            onClick={() => onSelect?.(group.key)}
            className="th-focus-ring grid min-h-11 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 rounded-[var(--radius-control)] border px-2 text-left text-[11px] transition-[background,border-color,transform] hover:-translate-y-px"
            style={{
              borderColor: active
                ? "color-mix(in srgb, var(--accent-primary) 42%, var(--border-subtle))"
                : "color-mix(in srgb, var(--border-subtle) 74%, transparent)",
              background: active
                ? "color-mix(in srgb, var(--accent-primary) 10%, var(--bg-panel))"
                : "color-mix(in srgb, var(--bg-app) 34%, transparent)",
              color: active ? "var(--text-primary)" : "var(--text-secondary)",
            }}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
            <span className="min-w-0">
              <span className="block truncate font-semibold">{group.label}</span>
              <span
                className="block truncate font-mono text-[10px]"
                style={{ color: "var(--text-muted)" }}
              >
                {group.detail}
              </span>
            </span>
            <span
              className="font-mono text-[10px]"
              style={{ color: active ? "var(--accent-primary)" : "var(--text-muted)" }}
            >
              {group.count}
            </span>
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add synthi/src/components/codesite/nav/CommandStrip.jsx
git commit -m "feat(codesite): add the group command strip

Modelled on WorkflowCommandStrip, which CodeSite sits beside in the Agents
group, with sm:grid-cols-4 converted to container queries since this is a dock."
```

## Task 8: Build the view strip and rewire the panel

**Files:**
- Create: `synthi/src/components/codesite/nav/ViewStrip.jsx`
- Modify: `synthi/src/components/codesite/nav/DesktopSectionRail.jsx`
- Modify: `synthi/src/components/codesite/nav/MobileSectionTabs.jsx`
- Modify: `synthi/src/components/codesite/CodeSitePanel.jsx`
- Modify: `synthi/src/components/codesite/__tests__/CodeSitePanel.test.jsx`

- [ ] **Step 1: Create `ViewStrip.jsx`**

The second level. `codesite-desktop-section-tab` and `data-codesite-section-key` **must** appear here — the baseline requires the id and 18 tests select by that attribute pair.

```jsx
import { CodeSiteIcons } from "../icons";

/** Second navigation level: the sections inside the active group. */
export default function ViewStrip({ sections, activeSection, onSelect }) {
  if (sections.length < 2) return null;
  return (
    <div
      data-testid="codesite-view-strip"
      className="flex min-w-0 flex-wrap gap-1"
      role="tablist"
      aria-label="CodeSite sections"
    >
      {sections.map((section) => {
        const active = activeSection === section.key;
        const Icon = section.icon || CodeSiteIcons.liveState;
        return (
          <button
            key={section.key}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={`codesite-section-${section.key}`}
            data-testid="codesite-desktop-section-tab"
            data-codesite-section-key={section.key}
            onClick={() => onSelect?.(section.key)}
            className="th-focus-ring inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-control)] border px-2.5 text-[11px] transition-[background,border-color]"
            style={{
              borderColor: active
                ? "color-mix(in srgb, var(--accent-primary) 42%, var(--border-subtle))"
                : "color-mix(in srgb, var(--border-subtle) 74%, transparent)",
              background: active
                ? "color-mix(in srgb, var(--accent-primary) 10%, var(--bg-panel))"
                : "transparent",
              color: active ? "var(--text-primary)" : "var(--text-secondary)",
            }}
          >
            <Icon className="h-3 w-3 shrink-0" strokeWidth={2} />
            <span className="truncate">{section.label}</span>
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 2: Rewrite `DesktopSectionRail.jsx` as the host**

It keeps `codesite-desktop-section-rail` (baseline) and now hosts both levels. Delete the old 280px status card, the tab list, and the framer-motion `layoutId` highlight.

```jsx
import CommandStrip from "./CommandStrip";
import ViewStrip from "./ViewStrip";

export default function DesktopSectionRail({
  groups,
  activeGroup,
  onSelectGroup,
  sections,
  activeSection,
  onSelectSection,
}) {
  return (
    <div
      data-testid="codesite-desktop-section-rail"
      className="sticky top-0 z-20 hidden flex-col gap-2 border-b px-3 py-2 @min-[34rem]/panel:flex"
      style={{ borderColor: "var(--border-subtle)" }}
    >
      <CommandStrip groups={groups} activeGroup={activeGroup} onSelect={onSelectGroup} />
      <ViewStrip sections={sections} activeSection={activeSection} onSelect={onSelectSection} />
    </div>
  );
}
```

- [ ] **Step 3: Simplify `MobileSectionTabs.jsx`**

Keep `codesite-mobile-section-tabs` and `codesite-mobile-section-tab` (both baseline). Show the **groups** here, not all ten sections, and drop the drop shadow so it matches the flat shell. Below 34rem the ViewStrip renders under it, so both levels remain reachable.

Change the wrapper to:

```jsx
    <div
      data-testid="codesite-mobile-section-tabs"
      className="sticky top-0 z-20 border-b px-3 py-1.5 @min-[34rem]/panel:hidden"
      style={{ borderColor: "var(--border-subtle)" }}
    >
```

and have each button carry `data-testid="codesite-mobile-section-tab"` and `data-codesite-group-key={group.key}`.

- [ ] **Step 4: Wire the panel**

In `CodeSitePanel.jsx`, add the group state beside `activeSection` and derive the tiles:

```jsx
  const [activeGroup, setActiveGroup] = useState(DEFAULT_GROUP_KEY);

  const groupTiles = useMemo(
    () =>
      SECTION_GROUPS.map((group) => ({
        ...group,
        ...groupSummary(group.key, counts, {
          actionableQuarantines: actionableQuarantineRecords.length,
          counterfactualRuns: counterfactualRuns.length,
        }),
      })),
    [counts, actionableQuarantineRecords.length, counterfactualRuns.length],
  );

  const groupSections = useMemo(
    () => {
      const group = SECTION_GROUPS.find((entry) => entry.key === activeGroup);
      return sections.filter((section) => group?.sections.includes(section.key));
    },
    [activeGroup, sections],
  );

  // Selecting a group lands on its first section.
  const handleSelectGroup = useCallback((groupKey) => {
    setActiveGroup(groupKey);
    const group = SECTION_GROUPS.find((entry) => entry.key === groupKey);
    if (group?.sections.length) setActiveSection(group.sections[0]);
  }, []);
```

`handleSelectSection` must also move the group, so the existing drill-in links from `TowerNowStrip` and `CodeSiteOperatingModel` keep working:

```jsx
  const handleSelectSection = useCallback((sectionKey) => {
    setActiveSection(sectionKey);
    setActiveGroup(groupForSection(sectionKey));
  }, []);
```

Import from `./lib/sectionGroups`, and pass `groups={groupTiles}`, `activeGroup`, `onSelectGroup={handleSelectGroup}`, `sections={groupSections}`, `activeSection`, `onSelectSection={handleSelectSection}` to both nav components.

- [ ] **Step 5: Update the `selectSection` test helper**

This is a **helper** change. Do not touch any `expect(...)`.

```jsx
async function selectSection(key) {
  const groupKey = groupForSection(key);
  const tile = container.querySelector(
    `[data-testid="codesite-command-tile"][data-codesite-group-key="${groupKey}"]`,
  );
  if (!tile) throw new Error(`no command tile for group "${groupKey}"`);
  await act(async () => {
    tile.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await flush();

  const tab = container.querySelector(
    `[data-testid="codesite-desktop-section-tab"][data-codesite-section-key="${key}"]`,
  );
  // A group with a single section renders no ViewStrip; the tile alone selects it.
  if (tab) {
    await act(async () => {
      tab.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
  }
}
```

Add `import { groupForSection } from '../lib/sectionGroups';` to the test file.

- [ ] **Step 6: Run the tests**

```bash
cd synthi && npx vitest run src/components/codesite
```

Expected: `Tests  39 passed (39)` — 35 existing plus Task 6's 4.

- [ ] **Step 7: Prove the baseline still holds**

```bash
cd synthi && npx vitest run src/components/codesite/__tests__/testIdInvariant.test.js
```

Expected: `Tests  1 passed (1)`. If it fails, one of the four nav ids lost its home; re-read Steps 2 and 3. **Do not regenerate the baseline.**

- [ ] **Step 8: Commit**

```bash
git add synthi/src/components/codesite
git commit -m "feat(codesite): two-level navigation over four section groups

Ten flat tabs in a horizontal scroller told a newcomer nothing and needed a
280px status card beside them to explain the current section. Replaced with the
structure Workflows already uses next door: a four-tile command strip carrying a
live detail line and count per group, over a strip of that group's sections.

The four baseline nav test ids keep their homes -- the rail id on the host, the
desktop tab id on the view strip, the mobile ids on the group tabs -- so the
invariant still holds. selectSection in the test helper now clicks the owning
group first; no assertion changed."
```

---

# Part D — Verification

## Task 9: Prove it

**Files:** none modified.

- [ ] **Step 1: Full codesite suite**

```bash
cd synthi && npx vitest run src/components/codesite
```

Expected: `Tests  39 passed (39)`.

- [ ] **Step 2: Nothing else broke**

```bash
cd synthi && npx vitest run 2>&1 | tail -20
```

Expected: 20 failures across 7 files — `agent-workflows`, `programs` x2, `preview-store`, `terminal-preview-links`, `src/lib/codesite` x2. These are pre-existing. Any **new** failing file is yours.

- [ ] **Step 3: Container classes still compile**

Every layout class must generate real CSS. Reuse the probe from the previous slice:

```bash
cd synthi && node "$SCRATCH/cq-probe/verify-real.mjs"
```

Expected: `EVERY CONTAINER CLASS THE PANEL USES GENERATES CSS`. If `$SCRATCH` is gone, recreate it: compile `@import "tailwindcss" source(none);` plus an `@source` pointing at a file listing every `@min-[…]/panel:` class in the panel, through `@tailwindcss/postcss`, with `from:` set to a path **inside the repo** so the import resolves. Match classes by stripping backslashes from the output, not by reproducing Tailwind's escaping.

- [ ] **Step 4: No viewport breakpoints crept back**

```bash
cd synthi && grep -rn "[\"' ]\(2xl\|xl\|lg\|md\|sm\):" src/components/codesite/ --include=*.jsx | grep -v "views/graph/"
```

Expected: no output.

- [ ] **Step 5: Hardcoded-values audit**

```bash
cd synthi && grep -rn 'oklch(\|#[0-9a-fA-F]\{6\}\|localhost\|http://' src/components/codesite/ | grep -v __tests__
```

Expected: no output.

- [ ] **Step 6: The graph is still untouched**

```bash
git diff dev..HEAD -- synthi/src/components/codesite/views/graph/
```

Expected: empty. This is the evidence the deferral was honoured.

- [ ] **Step 7: Look at it**

Turbopack cannot build this repo on Windows — it fails resolving `node_modules/yjs/dist/yjs.mjs` and 500s every route. Use webpack:

```bash
cd synthi && npx next dev --port 3001
```

Open the panel at 320, 380, 700 and 1440px. Confirm: no horizontal scrollbar on the panel body at any width; all four command tiles reachable; every one of the ten sections reachable through its group; the panel's background reads the same as the Workflows panel beside it.

The API returns 401 without a signed-in session, so views render empty states. To exercise real data, bring up the compose stack, whose override sets the workspace auth bypass:

```bash
docker compose up -d frontend
```

- [ ] **Step 8: Compare against the sibling**

Open Workflows and CodeSite side by side. They should read as the same family: same frame, same toolbar, same command-strip geometry, same label treatment. If CodeSite still looks heavier, the remaining weight is almost certainly a drop shadow or a nested border in a view — find it and remove it.

---

## Self-review notes

- Every task is independently committable and independently revertable. Part A alone fixes "out of place"; Part B alone fixes most of "crowded"; Part C alone fixes "hard to understand". Stopping after any part leaves the panel working.
- The four baseline nav ids are traced explicitly to their new homes in Task 8 Steps 2 and 3, and Step 7 checks them. This is the plan's single highest-risk point: the invariant test fails hard if any id loses its home.
- `selectSection` is the only test change, and it is a helper, not an assertion. Task 8 Step 5 says so, and Step 6 asserts the count went up rather than down.
- Task 5 is the one task with genuine per-view judgement rather than transcribable code. It is stated as a rule with a worked example, and Step 3 catches the failure mode (applying it to a view's first section).
- The graph deferral is enforced twice: named as Invariant 4, and diffed in Task 9 Step 6.
- Naming is consistent throughout: `SECTION_GROUPS`, `groupForSection`, `groupSummary`, `DEFAULT_GROUP_KEY` are defined in Task 6 and used with those exact signatures in Tasks 8 and its test helper.
- Known gap, deliberate: Task 9 Step 7's live-data walkthrough depends on the compose stack's auth bypass actually reaching the client. `NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS` is a build arg that is empty in the built image, so it works for server-side route checks but may not for client-side ones. If the panel still shows 401 under compose, that is why, and it is not a redesign defect.
