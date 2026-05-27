# Multi-Pane Editor Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the TopNav "Split editor" button produce real, independent editor panes (N panes, horizontal or vertical), each showing its own file, with a single shared TopNav tab strip that attributes each open file to its pane(s) via a color + pane-number system, plus a per-pane breadcrumb header strip.

**Architecture:** Hybrid (approach C). docking-wm owns pane *geometry* (split/resize/persist — already built). Each editor pane is a docking editor tabgroup; the pane's current file is its editor tab's `data.filePath`. Global `workspaceSlice.activeFile` is kept as a mirror of the **focused** pane's file so the file tree, breadcrumb, git, AI and healing keep working unchanged. The shared `EditorTabStrip` and per-pane header strips *project* from the set of editor panes. `Editor.jsx` is decoupled so each instance renders its own `filePath`; the focused instance drives the shell's healing/completions.

**Tech Stack:** Next.js 15 / React 19, Redux Toolkit (`@reduxjs/toolkit`), Monaco (`@codingame/monaco-vscode-editor-api` + `@monaco-editor/react`), Yjs collab worker, docking-wm (`src/components/docking-wm`). Tests: **vitest** (added in Phase 0) + app-run verification with `npm run dev`.

**Spec:** `docs/superpowers/specs/2026-05-22-editor-split-multi-pane-design.md`

**Key facts established during design (do not re-derive):**
- An editor pane = a docking-wm **editor tabgroup** holding one editor tab. The pane's file = that tab's `data.filePath`. `PanelContainer` forwards `data` → `EditorPanelWrapper` already passes `data?.filePath` + `dockingMode` to `Editor.jsx`.
- Editor tabgroups already hide their own docking tab bar (`TabGroup.jsx:240`). The shared file-tab UI is `EditorTabStrip.jsx` only.
- `walkTree(state, rootId, cb)` (`layout-query.js`) is DFS in child order ⇒ left→right / top→bottom pane numbering.
- `splitNode(state, targetNodeId, tabId, zone, ratio)` (`layout-ops.js`) creates a new tabgroup for `tabId`; `DROP_ZONE.RIGHT` ⇒ horizontal, `DROP_ZONE.BOTTOM` ⇒ vertical.
- `selectFileThunk` (`workspaceSlice.js:315`) already calls `ensureEditorPanel(dispatch, getState)` — the integration seam for routing opens into the focused pane.
- `page.jsx` feeds the editor instance up via `memoEditorProps.innerRef = setEditor` / `onEditorMount = handleEditorMount` (`page.jsx:2694, 2972`). With multiple instances this must become focus-aware.
- `USE_DOCKING_WM = true` (`page.jsx:126`) — the docking path is live.

---

## File Structure

**Create:**
- `synthi/vitest.config.mjs` — vitest config (jsdom env, `@`→`src` alias). Matches the run command already documented in `layout-ops.test.js`.
- `synthi/src/components/docking-wm/utils/editor-panes.js` — pure helpers: ordered editor panes, pane numbering, palette, file→panes attribution.
- `synthi/src/components/docking-wm/utils/__tests__/editor-panes.test.js` — unit tests for the above.
- `synthi/src/components/docking-wm/state/__tests__/layout-slice.editor-split.test.js` — unit tests for `splitEditorPanel` + `setPaneFile` + selectors.
- `synthi/src/redux/__tests__/pane-active-file.test.js` — unit tests for the pure active-file-mirror helper.
- `synthi/src/components/EditorPaneHeader.jsx` — the per-pane breadcrumb + pane-number strip.

**Modify:**
- `synthi/package.json` — add `vitest` + `jsdom` devDeps and `test` scripts.
- `synthi/src/components/docking-wm/state/layout-slice.js` — fix `splitEditorPanel`, add `setPaneFile`, add editor-pane selectors.
- `synthi/src/redux/workspaceSlice.js` — route opens to focused pane; add pure mirror helper; `closeFile` pane fallback.
- `synthi/src/app/workspace/[slug]/Editor/Editor.jsx` — resolve `paneFile` from props in docking mode; per-pane content/model/identity/Yjs; focus-aware mount reporting; dimmed unfocused awareness.
- `synthi/src/components/docking-wm/panels/panel-wrappers.jsx` — pass `tabGroupId`/`paneId` into `Editor`; mount `EditorPaneHeader`.
- `synthi/src/app/workspace/[slug]/page.jsx` — focus-aware active editor (editors-by-pane map); focus→activeFile mirror effect.
- `synthi/src/components/EditorTabStrip.jsx` — segmented colored underline + pane-number badges.
- `synthi/src/app/workspace/TopNav.jsx` — split button gains a Right/Down choice.

---

## Phase 0 — Test harness

### Task 0: Install and configure vitest

**Files:**
- Modify: `synthi/package.json`
- Create: `synthi/vitest.config.mjs`

- [ ] **Step 1: Add dev dependencies**

Run (from `synthi/`):

```bash
npm install -D vitest@^2 jsdom@^25
```

Expected: `package.json` devDependencies gains `vitest` and `jsdom`; no peer-dep errors that abort install.

- [ ] **Step 2: Add test scripts to `package.json`**

In the `"scripts"` block, add:

```json
"test": "vitest run",
"test:watch": "vitest",
"test:dock": "vitest run src/components/docking-wm"
```

- [ ] **Step 3: Create `synthi/vitest.config.mjs`**

```js
import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.{test,spec}.{js,jsx,mjs}'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
```

- [ ] **Step 4: Verify the existing dormant docking tests now run**

Run (from `synthi/`): `npm run test:dock`
Expected: vitest discovers `src/components/docking-wm/__tests__/layout-ops.test.js` and reports PASS (or surfaces real assertions — they should pass since the utils are unchanged). If a couple fail due to pre-existing drift, note them but do not fix unrelated failures in this task.

- [ ] **Step 5: Commit**

```bash
git add synthi/package.json synthi/package-lock.json synthi/vitest.config.mjs
git commit -m "test: add vitest harness (revives dormant docking tests)"
```

---

## Phase 1 — Pure logic (TDD)

### Task 1: `editor-panes.js` — ordered panes, numbering, palette, attribution

**Files:**
- Create: `synthi/src/components/docking-wm/utils/editor-panes.js`
- Test: `synthi/src/components/docking-wm/utils/__tests__/editor-panes.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/components/docking-wm/utils/__tests__/editor-panes.test.js
import { describe, it, expect } from 'vitest';
import {
  PANE_PALETTE,
  getPaneColor,
  getEditorPaneIds,
  getEditorPanes,
  getPanesForFile,
} from '../editor-panes';

// Minimal layout: a row split with two editor tabgroups.
function twoPaneLayout() {
  return {
    rootId: 'split1',
    nodes: {
      split1: { id: 'split1', type: 'split', direction: 'row', children: ['g1', 'g2'], sizes: [0.5, 0.5], parentId: null },
      g1: { id: 'g1', type: 'tabgroup', tabs: ['t1'], activeTabId: 't1', parentId: 'split1' },
      g2: { id: 'g2', type: 'tabgroup', tabs: ['t2'], activeTabId: 't2', parentId: 'split1' },
    },
    tabs: {
      t1: { id: 't1', panelType: 'editor', data: { filePath: 'a.java' } },
      t2: { id: 't2', panelType: 'editor', data: { filePath: 'b.java' } },
    },
  };
}

describe('editor-panes', () => {
  it('orders editor panes by tree DFS (left→right)', () => {
    expect(getEditorPaneIds(twoPaneLayout())).toEqual(['g1', 'g2']);
  });

  it('assigns 1-based numbers and palette colors by order', () => {
    const panes = getEditorPanes(twoPaneLayout());
    expect(panes).toEqual([
      { paneId: 'g1', number: 1, filePath: 'a.java', color: getPaneColor(0) },
      { paneId: 'g2', number: 2, filePath: 'b.java', color: getPaneColor(1) },
    ]);
  });

  it('attributes a file to every pane displaying it, in order', () => {
    const layout = twoPaneLayout();
    layout.tabs.t2.data.filePath = 'a.java'; // both panes show a.java
    expect(getPanesForFile(layout, 'a.java')).toEqual([
      { paneId: 'g1', number: 1, color: getPaneColor(0) },
      { paneId: 'g2', number: 2, color: getPaneColor(1) },
    ]);
    expect(getPanesForFile(layout, 'missing.java')).toEqual([]);
  });

  it('palette cycles past its length and pane 1 is the gray token', () => {
    expect(PANE_PALETTE.length).toBeGreaterThanOrEqual(4);
    expect(getPaneColor(0)).toBe(PANE_PALETTE[0]);
    expect(getPaneColor(PANE_PALETTE.length)).toBe(PANE_PALETTE[0]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/docking-wm/utils/__tests__/editor-panes.test.js`
Expected: FAIL — `Cannot find module '../editor-panes'`.

- [ ] **Step 3: Implement `editor-panes.js`**

```js
// src/components/docking-wm/utils/editor-panes.js
/**
 * @fileoverview Pure helpers for projecting the layout's editor tabgroups
 * into ordered "panes" with stable numbers and colors. Consumed by the
 * shared TopNav tab strip and the per-pane header strips.
 */
import { NODE_TYPE } from '../types';
import { walkTree } from './layout-query';

const EDITOR = 'editor';

/**
 * Pane color palette. Index 0 (pane 1) is the existing muted/gray token so
 * the original editor keeps its current look; subsequent panes get distinct
 * hues. Tokens map to CSS variables defined in globals.css (Task 7).
 */
export const PANE_PALETTE = [
  'var(--pane-color-1)', // gray   (pane 1 — matches today's active underline)
  'var(--pane-color-2)', // blue   (pane 2)
  'var(--pane-color-3)', // teal   (pane 3)
  'var(--pane-color-4)', // amber  (pane 4)
  'var(--pane-color-5)', // purple (pane 5)
];

/** Color token for a 0-based pane index, cycling past the palette length. */
export function getPaneColor(index) {
  if (!Number.isInteger(index) || index < 0) return PANE_PALETTE[0];
  return PANE_PALETTE[index % PANE_PALETTE.length];
}

/** Is this tabgroup an editor pane (its active/any tab is an editor)? */
function isEditorGroup(layout, node) {
  if (!node || node.type !== NODE_TYPE.TAB_GROUP) return false;
  return (node.tabs || []).some((tid) => layout.tabs?.[tid]?.panelType === EDITOR);
}

/** The editor tab object that defines a pane's current file. */
function editorTabOf(layout, node) {
  const tabs = node.tabs || [];
  const active = tabs.find((tid) => tid === node.activeTabId && layout.tabs?.[tid]?.panelType === EDITOR);
  const id = active || tabs.find((tid) => layout.tabs?.[tid]?.panelType === EDITOR);
  return id ? layout.tabs[id] : null;
}

/** Editor pane node IDs in stable DFS (left→right / top→bottom) order. */
export function getEditorPaneIds(layout) {
  if (!layout || !layout.rootId) return [];
  const ids = [];
  walkTree(layout, layout.rootId, (node) => {
    if (isEditorGroup(layout, node)) ids.push(node.id);
  });
  return ids;
}

/** Ordered panes: { paneId, number, filePath, color }. */
export function getEditorPanes(layout) {
  return getEditorPaneIds(layout).map((paneId, i) => ({
    paneId,
    number: i + 1,
    filePath: editorTabOf(layout, layout.nodes[paneId])?.data?.filePath ?? null,
    color: getPaneColor(i),
  }));
}

/** Panes currently displaying a given file path, in order. */
export function getPanesForFile(layout, filePath) {
  if (!filePath) return [];
  return getEditorPanes(layout)
    .filter((p) => p.filePath === filePath)
    .map(({ paneId, number, color }) => ({ paneId, number, color }));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/docking-wm/utils/__tests__/editor-panes.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add synthi/src/components/docking-wm/utils/editor-panes.js synthi/src/components/docking-wm/utils/__tests__/editor-panes.test.js
git commit -m "feat(panes): pure editor-pane ordering, numbering, palette, attribution"
```

---

### Task 2: layout-slice — fix `splitEditorPanel`, add `setPaneFile`, add selectors

**Files:**
- Modify: `synthi/src/components/docking-wm/state/layout-slice.js` (reducers `splitEditorPanel` ~365-407; add `setPaneFile`; selectors region ~483-519)
- Test: `synthi/src/components/docking-wm/state/__tests__/layout-slice.editor-split.test.js`

- [ ] **Step 1: Write the failing test**

```js
// src/components/docking-wm/state/__tests__/layout-slice.editor-split.test.js
import { describe, it, expect } from 'vitest';
import reducer, {
  splitEditorPanel,
  setPaneFile,
  selectEditorPanes,
  selectFocusedEditorPaneId,
} from '../layout-slice';
import { getEditorPaneIds } from '../../utils/editor-panes';

// One editor pane showing a.java, focused.
function onePane() {
  return {
    version: 4,
    rootId: 'g1',
    nodes: { g1: { id: 'g1', type: 'tabgroup', tabs: ['t1'], activeTabId: 't1', parentId: null } },
    tabs: { t1: { id: 't1', panelType: 'editor', title: '', closable: false, data: { filePath: 'a.java' } } },
    floating: {}, popouts: {}, maximizedNodeId: null, focusedTabGroupId: 'g1', dragSourceTabId: null,
  };
}

describe('layout-slice editor split', () => {
  it('split copies the source pane file into the new pane and focuses it', () => {
    const next = reducer(onePane(), splitEditorPanel({ zone: 'right' }));
    const paneIds = getEditorPaneIds(next);
    expect(paneIds).toHaveLength(2);
    const panes = selectEditorPanes({ layout: next });
    expect(panes.map((p) => p.filePath)).toEqual(['a.java', 'a.java']);
    // newly created pane (the focused one) is the second in DFS order here
    expect(next.focusedTabGroupId).toBe(paneIds[1]);
  });

  it('splits to N panes (no 2-pane cap)', () => {
    let s = reducer(onePane(), splitEditorPanel({ zone: 'right' }));
    s = reducer(s, splitEditorPanel({ zone: 'right' }));
    expect(getEditorPaneIds(s)).toHaveLength(3);
  });

  it('vertical split produces a column split', () => {
    const next = reducer(onePane(), splitEditorPanel({ zone: 'bottom' }));
    const cols = Object.values(next.nodes).filter((n) => n.type === 'split' && n.direction === 'column');
    expect(cols).toHaveLength(1);
  });

  it('setPaneFile updates only the targeted pane editor tab filePath', () => {
    let s = reducer(onePane(), splitEditorPanel({ zone: 'right' }));
    const [p1, p2] = getEditorPaneIds(s);
    s = reducer(s, setPaneFile({ paneId: p2, filePath: 'b.java' }));
    const panes = selectEditorPanes({ layout: s });
    expect(panes.find((p) => p.paneId === p1).filePath).toBe('a.java');
    expect(panes.find((p) => p.paneId === p2).filePath).toBe('b.java');
  });

  it('selectFocusedEditorPaneId falls back to first pane when focus is non-editor', () => {
    const s = onePane();
    s.focusedTabGroupId = 'nonexistent';
    expect(selectFocusedEditorPaneId({ layout: s })).toBe('g1');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/docking-wm/state/__tests__/layout-slice.editor-split.test.js`
Expected: FAIL — `setPaneFile`/`selectEditorPanes`/`selectFocusedEditorPaneId` are not exported, and `splitEditorPanel` ignores `zone` + caps at 2.

- [ ] **Step 3a: Replace the `splitEditorPanel` reducer**

Replace the entire `splitEditorPanel(state)` reducer body (`layout-slice.js` ~365-407) with:

```js
    /**
     * Split the focused editor pane into a new side-by-side (or stacked) pane.
     * The new pane opens the SAME file as the source pane (data.filePath copied);
     * the new pane becomes focused. Supports N panes (no cap) and vertical splits.
     * Payload: { zone?: 'right' | 'bottom' }  (default 'right')
     */
    splitEditorPanel(state, action) {
      const zone = action?.payload?.zone === DROP_ZONE.BOTTOM ? DROP_ZONE.BOTTOM : DROP_ZONE.RIGHT;

      const editorGroups = [];
      for (const [nid, node] of Object.entries(state.nodes)) {
        if (node.type !== "tabgroup") continue;
        if ((node.tabs || []).some((tid) => state.tabs[tid]?.panelType === "editor")) {
          editorGroups.push({ id: nid, node });
        }
      }

      const sourceGroup =
        editorGroups.find((g) => g.id === state.focusedTabGroupId) ||
        editorGroups[0] ||
        getAllTabGroups(state)[0];
      const targetGroupId = sourceGroup?.id;
      if (!targetGroupId) return state;

      // Copy the source pane's current file into the new pane.
      const srcGroup = state.nodes[targetGroupId];
      const srcEditorTabId =
        (srcGroup.tabs || []).find((tid) => tid === srcGroup.activeTabId && state.tabs[tid]?.panelType === "editor") ||
        (srcGroup.tabs || []).find((tid) => state.tabs[tid]?.panelType === "editor");
      const srcFilePath = srcEditorTabId ? (state.tabs[srcEditorTabId]?.data?.filePath ?? null) : null;

      const tab = createTab({
        panelType: "editor",
        title: "",
        closable: false,
        data: { filePath: srcFilePath },
      });

      let next = {
        ...state,
        tabs: { ...state.tabs, [tab.id]: tab },
      };

      next = splitNode(next, targetGroupId, tab.id, zone, 0.5);

      // Focus the new pane (the group that now contains the new tab).
      const newGroup = findTabGroup(next, tab.id);
      if (newGroup) next = { ...next, focusedTabGroupId: newGroup.id };
      return next;
    },
```

- [ ] **Step 3b: Add the `setPaneFile` reducer**

Immediately after `splitEditorPanel`, add:

```js
    /**
     * Set which file an editor pane displays (writes the pane's editor tab
     * data.filePath). Payload: { paneId, filePath }.
     */
    setPaneFile(state, action) {
      const { paneId, filePath } = action.payload || {};
      const group = state.nodes[paneId];
      if (!group || group.type !== "tabgroup") return state;
      const editorTabId =
        (group.tabs || []).find((tid) => tid === group.activeTabId && state.tabs[tid]?.panelType === "editor") ||
        (group.tabs || []).find((tid) => state.tabs[tid]?.panelType === "editor");
      if (!editorTabId) return state;
      const tab = state.tabs[editorTabId];
      state.tabs[editorTabId] = { ...tab, data: { ...(tab.data || {}), filePath } };
    },
```

- [ ] **Step 3c: Export `setPaneFile` from the actions destructure**

In the `export const { ... } = layoutSlice.actions;` block (~422-445), add `setPaneFile,` next to `splitEditorPanel,`.

- [ ] **Step 3d: Add the selectors**

At the end of the selectors region (after `makeSelectTabGroupTabs`, ~519), add:

```js
import { getEditorPanes, getEditorPaneIds } from "../utils/editor-panes";

/** Ordered editor panes: { paneId, number, filePath, color } (memoized). */
export const selectEditorPanes = createSelector([selectLayout], (layout) =>
  getEditorPanes(layout),
);

/** The focused editor pane id, falling back to the first editor pane. */
export const selectFocusedEditorPaneId = createSelector([selectLayout], (layout) => {
  const ids = getEditorPaneIds(layout);
  const focused = layout.focusedTabGroupId;
  return focused && ids.includes(focused) ? focused : (ids[0] ?? null);
});
```

(Move the `import` to the top of the file with the other imports — shown here inline only for locality.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/docking-wm/state/__tests__/layout-slice.editor-split.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Run the whole docking suite to check for regressions**

Run: `npm run test:dock`
Expected: PASS (Task 0 baseline + new tests).

- [ ] **Step 6: Commit**

```bash
git add synthi/src/components/docking-wm/state/layout-slice.js synthi/src/components/docking-wm/state/__tests__/layout-slice.editor-split.test.js
git commit -m "feat(layout): split copies pane file, supports N/vertical, add setPaneFile + pane selectors"
```

---

### Task 3: workspaceSlice — pure active-file mirror helper + route opens to focused pane

**Files:**
- Modify: `synthi/src/redux/workspaceSlice.js` (`selectFileThunk` ~315-320; `closeFile` ~892-919)
- Test: `synthi/src/redux/__tests__/pane-active-file.test.js`

The thunk wiring is verified in-app (Task 4+). The *decision logic* (which pane to route to, and the activeFile-mirror rule) is extracted into a pure, exported helper and unit-tested here.

- [ ] **Step 1: Write the failing test**

```js
// src/redux/__tests__/pane-active-file.test.js
import { describe, it, expect } from 'vitest';
import { resolveOpenTarget, resolveMirrorFile } from '../paneActiveFile';

const layout = {
  rootId: 'split1',
  nodes: {
    split1: { id: 'split1', type: 'split', direction: 'row', children: ['g1', 'g2'], sizes: [0.5, 0.5], parentId: null },
    g1: { id: 'g1', type: 'tabgroup', tabs: ['t1'], activeTabId: 't1', parentId: 'split1' },
    g2: { id: 'g2', type: 'tabgroup', tabs: ['t2'], activeTabId: 't2', parentId: 'split1' },
  },
  tabs: {
    t1: { id: 't1', panelType: 'editor', data: { filePath: 'a.java' } },
    t2: { id: 't2', panelType: 'editor', data: { filePath: 'b.java' } },
  },
  focusedTabGroupId: 'g2',
};

describe('paneActiveFile', () => {
  it('routes an open to the focused editor pane', () => {
    expect(resolveOpenTarget(layout)).toBe('g2');
  });

  it('routes to the first pane when focus is not an editor', () => {
    expect(resolveOpenTarget({ ...layout, focusedTabGroupId: null })).toBe('g1');
  });

  it('mirror file = focused pane file', () => {
    expect(resolveMirrorFile(layout)).toBe('b.java');
    expect(resolveMirrorFile({ ...layout, focusedTabGroupId: 'g1' })).toBe('a.java');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/redux/__tests__/pane-active-file.test.js`
Expected: FAIL — `Cannot find module '../paneActiveFile'`.

- [ ] **Step 3: Create `synthi/src/redux/paneActiveFile.js`**

```js
// src/redux/paneActiveFile.js
/**
 * Pure decisions linking the global workspace file model to the docking
 * editor panes. Kept dependency-free so it is unit-testable in isolation.
 */
import { getEditorPaneIds, getEditorPanes } from '@/components/docking-wm/utils/editor-panes';

/** Which editor pane should receive a newly opened file (the focused one). */
export function resolveOpenTarget(layout) {
  const ids = getEditorPaneIds(layout);
  const focused = layout?.focusedTabGroupId;
  return focused && ids.includes(focused) ? focused : (ids[0] ?? null);
}

/** The file path the global activeFile should mirror (focused pane's file). */
export function resolveMirrorFile(layout) {
  const target = resolveOpenTarget(layout);
  if (!target) return null;
  return getEditorPanes(layout).find((p) => p.paneId === target)?.filePath ?? null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/redux/__tests__/pane-active-file.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the open path to set the focused pane's file**

In `workspaceSlice.js`, add the import near the top (with the other imports):

```js
import { setPaneFile } from '@/components/docking-wm/state/layout-slice';
import { resolveOpenTarget } from '@/redux/paneActiveFile';
```

In `selectFileThunk` (right after `ensureEditorPanel(dispatch, getState);` at ~319), add:

```js
        // Route this open into the focused editor pane (multi-pane split).
        try {
            const layoutAfterEnsure = getState().layout;
            const paneId = resolveOpenTarget(layoutAfterEnsure);
            if (paneId && file?.path) {
                dispatch(setPaneFile({ paneId, filePath: file.path }));
            }
        } catch (_) { /* layout not ready — single-pane fallback */ }
```

(The fulfilled handler continues to set `state.activeFile = file`, so activeFile already mirrors the focused pane after an open. Focus-driven mirroring is added in Task 5.)

- [ ] **Step 6: Make `closeFile` reassign any pane that showed the closed file**

`closeFile` lives in `workspaceSlice.js` (~892). It only knows the workspace model, not the layout, so the pane reassignment is dispatched from the UI close handler. Update `EditorTabStrip.handleClose` (Task 7) to, after `dispatch(closeFile(file.path))`, also clear the file from any pane via a thunk. Add this thunk to `workspaceSlice.js`:

```js
export const closeFileEverywhere = (path) => (dispatch, getState) => {
    const layout = getState().layout;
    const ws = getState().workspace;
    const remaining = (ws.openFiles || []).filter((f) => f.path !== path);
    const fallback = remaining[0]?.path ?? null;
    // Re-point any pane that showed the closed file to a fallback (or null).
    try {
        const { getEditorPanes } = require('@/components/docking-wm/utils/editor-panes');
        for (const pane of getEditorPanes(layout)) {
            if (pane.filePath === path) {
                dispatch(setPaneFile({ paneId: pane.paneId, filePath: fallback }));
            }
        }
    } catch (_) { /* ignore */ }
    dispatch(closeFile(path));
};
```

> Note for implementer: this file uses ES module imports at top; replace the inline `require` with a top-of-file `import { getEditorPanes } from '@/components/docking-wm/utils/editor-panes';` and reference it directly. The `require` is shown only to keep the snippet self-contained.

- [ ] **Step 7: Run the redux + docking suites**

Run: `npx vitest run src/redux src/components/docking-wm`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add synthi/src/redux/workspaceSlice.js synthi/src/redux/paneActiveFile.js synthi/src/redux/__tests__/pane-active-file.test.js
git commit -m "feat(workspace): route file opens into focused pane + close-everywhere fallback"
```

---

## Phase 2 — Editor decoupling (app-run verified)

> Phase 2 changes a ~3000-line legacy file (`Editor.jsx`) coupled to the global `activeFile`. **Before editing, read the whole file once**, paying attention to: props (~216-226), redux selectors (~239-254), the model pre-create effect (~2757-2789, keyed on `activeFileIdentity`), the Yjs binding effect (~2421-2526, uses `boundFilePathRef`), awareness listener (~2502+), and `activeLanguage`/`activeFileIdentity` (~2753-2755). Make the change behind the existing `filePath`/`dockingMode` seam so non-docking mode is unaffected. Each task ends with explicit app-run verification because there is no DOM/Monaco unit harness.

### Task 4: Editor renders its own pane file

**Files:**
- Modify: `synthi/src/app/workspace/[slug]/Editor/Editor.jsx`
- Modify: `synthi/src/components/docking-wm/panels/panel-wrappers.jsx` (`EditorPanelWrapper`)

- [ ] **Step 1: Pass `paneId` into the editor**

In `panel-wrappers.jsx` `EditorPanelWrapper`, the wrapper receives `tabGroupId` via `panelProps` (see `PanelContainer` `panelProps`). Forward it:

```jsx
export const EditorPanelWrapper = memo(function EditorPanelWrapper({ data, tabGroupId }) {
  const ctx = useWorkspacePanelContext();
  return (
    <div data-panel-type="editor" data-pane-id={tabGroupId}
         className="h-full w-full min-w-0 overflow-hidden flex flex-col"
         style={{ background: 'var(--bg-editor)' }}>
      <EditorPanel
        {...(ctx?.editorProps || {})}
        filePath={data?.filePath}
        paneId={tabGroupId}
        dockingMode={true}
      />
    </div>
  );
});
```

- [ ] **Step 2: Resolve `paneFile` inside `Editor.jsx`**

Add `paneId = null` to the prop destructure (next to `dockingMode = false`). After the existing selectors (~239-244), add a resolver that prefers the pane's file in docking mode:

```jsx
    const openFilesList = useAppSelector(selectOpenFiles);
    // In docking mode each pane renders its OWN file (props.filePath); fall
    // back to the global activeFile only outside docking (single-editor mode).
    const paneFile = useMemo(() => {
        if (dockingMode && filePath) {
            return openFilesList.find((f) => f.path === filePath)
                || { path: filePath, name: filePath.split('/').pop() };
        }
        return activeFile;
    }, [dockingMode, filePath, openFilesList, activeFile]);
```

- [ ] **Step 3: Switch file-identity uses from `activeFile` to `paneFile`**

Within `Editor.jsx`, change the values that determine *which file this editor view shows* to use `paneFile`:
- `activeFileIdentity` (~2754) → derive from `paneFile`.
- `activeLanguage` (~2753) → from `paneFile`.
- `activeFileIcon` (~2755) → from `paneFile`.
- The model pre-create/switch effect (~2757-2789): build the URI and pick cached content from `paneFile.path` instead of `activeFile.path`; keep its dependency array on the `paneFile`-derived identity.
- Initial editor content: source the model's initial value from `fileCacheEntries` for `paneFile.path` (not the global `currentContent`). The global `currentContent` stays bound to the focused file only.

> Implementer: keep all *non-file-identity* uses of `activeFile` as-is (e.g. shell-level behaviours). The rule: anything that answers "what file is in THIS editor view" → `paneFile`; anything that answers "what is the user's globally-active file" → leave as `activeFile`.

- [ ] **Step 4: Guard `onChange` → `updateContent` to the focused file only**

The editor `onChange` currently dispatches `updateContent` (global). Only the focused pane should write the global `currentContent`. Gate it:

```jsx
    const isFocusedPane = !dockingMode || (paneFile?.path && activeFile?.path === paneFile.path);
    // ...in the change handler:
    if (isFocusedPane) dispatch(updateContent(newValue));
```

Unfocused panes still edit their own Monaco model (and sync via Yjs in Task 5); they just don't drive the global `currentContent`/save buffer.

- [ ] **Step 5: App-run verification**

Run (from `synthi/`): `npm run dev`, open a workspace, open `A`, click **Split editor**.
Verify with the Playwright MCP (or manually):
- Both panes initially show `A`.
- In the left pane, open `B` from the file tree → left shows `B`, **right still shows `A`** (no mirroring).
- Type in `B` (left) → the right pane (`A`) does **not** change.
- Open `A` in both panes, type in one → both update (same shared Monaco model — expected).

Capture a screenshot of two panes showing different files.

- [ ] **Step 6: Commit**

```bash
git add synthi/src/app/workspace/[slug]/Editor/Editor.jsx synthi/src/components/docking-wm/panels/panel-wrappers.jsx
git commit -m "feat(editor): each pane renders its own file via paneId/filePath seam"
```

---

### Task 5: Focus-aware active editor + focus→activeFile mirror

**Files:**
- Modify: `synthi/src/app/workspace/[slug]/page.jsx` (~2694 `handleEditorMount`, ~2972 `memoEditorProps`, add a focus effect)
- Modify: `synthi/src/app/workspace/[slug]/Editor/Editor.jsx` (report mount with `paneId`, report focus)

Problem: `memoEditorProps.innerRef = setEditor` and `onEditorMount = handleEditorMount` are shared by every pane instance, so the last-mounted wins. The shell's `editor`/`editorRef` (used by healing, completions, command palette) must track the **focused** pane.

- [ ] **Step 1: Editors report (paneId, instance) and focus**

In `Editor.jsx`, when the Monaco editor mounts, call the existing `onEditorMount(editorInstance)` but also include the pane id, and dispatch focus on the pane when the editor gains DOM focus:

```jsx
    // onMount (existing handler that calls props.onEditorMount):
    props.onEditorMount?.(editorInstance, paneId);
    editorInstance.onDidFocusEditorWidget(() => {
        if (dockingMode && paneId) dispatch(setFocusedTabGroup(paneId));
    });
```

Import `setFocusedTabGroup` from `@/components/docking-wm/state/layout-slice` in `Editor.jsx`.

- [ ] **Step 2: page.jsx keeps an editors-by-pane map and exposes the focused one**

In `page.jsx`, replace the single `editor` registration with a per-pane map and derive the active editor from `selectFocusedEditorPaneId`:

```jsx
    import { selectFocusedEditorPaneId } from '@/components/docking-wm/state/layout-slice';
    // ...
    const editorsByPaneRef = useRef(new Map());
    const focusedPaneId = useAppSelector(selectFocusedEditorPaneId);

    const handleEditorMount = useCallback((editorInstance, paneId) => {
        if (paneId) editorsByPaneRef.current.set(paneId, editorInstance);
        // Promote to active editor if this is (or becomes) the focused pane.
        if (!focusedPaneId || paneId === focusedPaneId) {
            setEditor(editorInstance);
            editorRef.current = editorInstance;
        }
        if (activeFile && !hasInitialSnapshot) {
            setInitialContent(editorInstance.getValue());
            setHasInitialSnapshot(true);
        }
    }, [activeFile, hasInitialSnapshot, focusedPaneId]);

    // When focus moves between panes, point the shell at that pane's editor.
    useEffect(() => {
        if (!focusedPaneId) return;
        const inst = editorsByPaneRef.current.get(focusedPaneId);
        if (inst) { setEditor(inst); editorRef.current = inst; }
    }, [focusedPaneId]);
```

Keep `memoEditorProps.innerRef = setEditor` for backwards-compat in single-editor mode, but the map+effect is now the source of truth in docking mode.

- [ ] **Step 3: Mirror activeFile to the focused pane's file on focus change**

Add an effect in `page.jsx` that, when the focused pane shows a different file than `activeFile`, selects it (hits cache, no network):

```jsx
    const editorPanes = useAppSelector(selectEditorPanes); // import from layout-slice
    useEffect(() => {
        if (!focusedPaneId) return;
        const pane = editorPanes.find((p) => p.paneId === focusedPaneId);
        const path = pane?.filePath;
        if (path && path !== activeFile?.path) {
            const f = openFiles.find((o) => o.path === path) || { path, name: path.split('/').pop() };
            dispatch(selectFileThunk(f));
        }
    }, [focusedPaneId, editorPanes, activeFile?.path, openFiles, dispatch]);
```

- [ ] **Step 4: App-run verification**

`npm run dev`. With two panes showing `A` (left) and `B` (right):
- Click into the right pane (`B`) → the **file tree highlight, breadcrumb, and AI chat context** switch to `B`.
- Trigger healing/completion (Ctrl+K / type) → it acts on the focused pane's editor, not the other.
- Click into the left pane (`A`) → shell context switches back to `A`.

- [ ] **Step 5: Commit**

```bash
git add synthi/src/app/workspace/[slug]/page.jsx synthi/src/app/workspace/[slug]/Editor/Editor.jsx
git commit -m "feat(editor): focused pane drives shell editor + activeFile mirror"
```

---

### Task 6: Dimmed collaborator cursors in unfocused panes

**Files:**
- Modify: `synthi/src/app/workspace/[slug]/Editor/Editor.jsx` (awareness listener ~2502+ and the awareness/remote-cursor rendering)

- [ ] **Step 1: Compute `isFocusedPane` and thread it into awareness styling**

Reuse `isFocusedPane` from Task 4 Step 4. Where remote awareness cursors/selections are turned into Monaco decorations, reduce their opacity when `!isFocusedPane`:

```jsx
    // when building the decoration style for a remote cursor/selection:
    const dim = dockingMode && !isFocusedPane;
    // apply to the cursor caret + name label + selection background:
    //   opacity: dim ? 0.35 : 1
    // (add a `synthi-remote-cursor--dimmed` class or inline style on the
    //  decoration's inlineClassName / className depending on the existing
    //  decoration construction in this file.)
```

> Implementer: locate the existing remote-cursor decoration construction (search `addAwarenessListener` usage and the decoration array it builds). Add the dimmed variant there; do not introduce a second awareness listener.

- [ ] **Step 2: Add the dimmed CSS**

In the editor/collab stylesheet (search for the existing remote cursor class, e.g. `synthi-remote-cursor` / `yRemoteSelection`), add:

```css
.synthi-remote-cursor--dimmed,
.synthi-remote-cursor--dimmed::after { opacity: 0.35 !important; }
```

- [ ] **Step 3: App-run verification (collab)**

Open the same workspace in two browser sessions (or use a guest link) so a collaborator edits file `A`. Locally show `A` in the **unfocused** pane and `B` in the focused pane.
- Verify the collaborator's cursor appears in the unfocused `A` pane, **dimmed**.
- Focus the `A` pane → the cursor renders at full strength.

- [ ] **Step 4: Commit**

```bash
git add synthi/src/app/workspace/[slug]/Editor/Editor.jsx
git commit -m "feat(collab): dim remote cursors in unfocused panes"
```

---

## Phase 3 — Shared strip + per-pane chrome + split UI (app-run verified)

### Task 7: Shared strip — segmented colored underline + pane-number badges

**Files:**
- Modify: `synthi/src/components/EditorTabStrip.jsx`
- Modify: `synthi/src/app/globals.css` (define `--pane-color-1..5`)

- [ ] **Step 1: Define the palette CSS variables**

In `globals.css` (`:root` / theme block), add:

```css
:root {
  --pane-color-1: var(--text-muted);            /* pane 1 — gray (today's look) */
  --pane-color-2: #4c9aff;                       /* pane 2 — blue */
  --pane-color-3: #2bb8a3;                       /* pane 3 — teal */
  --pane-color-4: #e0a64e;                       /* pane 4 — amber */
  --pane-color-5: #b07cf0;                       /* pane 5 — purple */
}
```

- [ ] **Step 2: Read pane attribution in the strip**

In `EditorTabStrip.jsx`, add:

```jsx
import { useAppSelector } from '@/redux/hooks';
import { selectEditorPanes } from '@/components/docking-wm/state/layout-slice';
import { getPanesForFile } from '@/components/docking-wm/utils/editor-panes';
import { selectLayout } from '@/components/docking-wm/state/layout-slice';
// ...
const layout = useAppSelector(selectLayout);
const panesForFile = useCallback((path) => getPanesForFile(layout, path), [layout]);
```

- [ ] **Step 3: Render per-tab segmented underline + number badges**

Replace the single moving `tabIndicator` underline with a per-tab static underline composed of one segment per attributing pane, plus small number badges next to the filename. For each tab in the `openFiles.map`:

```jsx
const attrib = panesForFile(file.path);          // [{paneId, number, color}]
const segCount = attrib.length;
// underline: absolutely-positioned row of equal-width colored segments
{segCount > 0 && (
  <span aria-hidden className="absolute bottom-0 left-2.5 right-2.5 h-[2px] flex rounded-t-full overflow-hidden">
    {attrib.map((p) => (
      <span key={p.paneId} className="flex-1" style={{ background: p.color }} />
    ))}
  </span>
)}
// badges: next to the filename
{segCount > 0 && (
  <span className="flex items-center gap-0.5 ml-1">
    {attrib.map((p) => (
      <span key={p.paneId}
        className="inline-flex items-center justify-center text-[9px] leading-none rounded-sm px-1 h-3.5"
        style={{ color: p.color, border: `1px solid ${p.color}` }}>
        {p.number}
      </span>
    ))}
  </span>
)}
```

Keep the existing hover brand-gradient indicator layered above (it animates on hover); the new segmented underline is the persistent attribution layer. The focused pane's segment is rendered brightest — multiply its color by full opacity and dim non-focused segments to ~0.7 using `selectFocusedEditorPaneId`.

- [ ] **Step 4: Clicking a tab still opens into the focused pane**

`handleSelect` already dispatches `selectFileThunk(file)`, which (Task 3) routes into the focused pane. No change needed beyond confirming it.

- [ ] **Step 5: App-run verification**

`npm run dev`, two panes:
- Both showing `A` → the `A` tab shows a **half-and-half** underline (gray | blue) and two badges `1 2`.
- Open `B` in the right pane → `A` tab shows solid gray + badge `1`; `B` tab shows solid blue + badge `2`.
- Split a third time, open `C` → `C` tab shows teal + badge `3`.
- Screenshot the half-and-half state.

- [ ] **Step 6: Commit**

```bash
git add synthi/src/components/EditorTabStrip.jsx synthi/src/app/globals.css
git commit -m "feat(tabs): segmented colored underline + pane-number badges in shared strip"
```

---

### Task 8: Per-pane header strip (breadcrumb + pane number)

**Files:**
- Create: `synthi/src/components/EditorPaneHeader.jsx`
- Modify: `synthi/src/components/docking-wm/panels/panel-wrappers.jsx` (`EditorPanelWrapper`)
- Modify: `synthi/src/app/globals.css` (`--editor-pane-header-h`)

- [ ] **Step 1: Add the header-height CSS var**

In `globals.css` `:root`: `--editor-pane-header-h: 20px;`

- [ ] **Step 2: Create `EditorPaneHeader.jsx`**

```jsx
'use client';
import { memo } from 'react';
import { useAppSelector } from '@/redux/hooks';
import { selectEditorPanes } from '@/components/docking-wm/state/layout-slice';

export const EditorPaneHeader = memo(function EditorPaneHeader({ paneId, filePath }) {
  const panes = useAppSelector(selectEditorPanes);
  const pane = panes.find((p) => p.paneId === paneId);
  if (!pane || panes.length < 2) return null; // only show when actually split
  const crumb = (filePath || '').split('/').filter(Boolean);
  return (
    <div
      className="flex items-center gap-1.5 px-2 shrink-0 text-[11px] select-none"
      style={{ height: 'var(--editor-pane-header-h)', borderBottom: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}
    >
      <span
        className="inline-flex items-center justify-center text-[9px] rounded-sm px-1 h-3.5 shrink-0"
        style={{ color: pane.color, border: `1px solid ${pane.color}` }}
      >
        {pane.number}
      </span>
      <span className="truncate">{crumb.length ? crumb.join(' › ') : 'No file'}</span>
    </div>
  );
});
export default EditorPaneHeader;
```

- [ ] **Step 3: Mount it above the editor in `EditorPanelWrapper`**

```jsx
import EditorPaneHeader from '@/components/EditorPaneHeader';
// inside the wrapper's flex-col container, before <EditorPanel/>:
<EditorPaneHeader paneId={tabGroupId} filePath={data?.filePath} />
```

(The wrapper was made `flex flex-col` in Task 4 Step 1.)

- [ ] **Step 4: App-run verification**

`npm run dev`, split into two panes:
- Each pane shows a thin (~20px) strip with its colored number badge and the file's breadcrumb.
- A single (unsplit) editor shows **no** header strip.
- Resize the window narrow → breadcrumb truncates with ellipsis, strip height stays constant.
- Screenshot a vertical split (Task 9) showing both header strips.

- [ ] **Step 5: Commit**

```bash
git add synthi/src/components/EditorPaneHeader.jsx synthi/src/components/docking-wm/panels/panel-wrappers.jsx synthi/src/app/globals.css
git commit -m "feat(editor): per-pane breadcrumb + number header strip"
```

---

### Task 9: Split button — Right / Down choice

**Files:**
- Modify: `synthi/src/app/workspace/TopNav.jsx` (`handleSplitEditor` ~86-88, button ~172-180)

- [ ] **Step 1: Make the split button offer horizontal/vertical**

`splitEditorPanel` now takes `{ zone }`. Replace the single-action button with a split-button + tiny popover (the file already imports `Popover*`). Default click = Split Right; the popover offers Split Down:

```jsx
const handleSplitRight = () => dispatch(splitEditorPanel({ zone: 'right' }));
const handleSplitDown = () => dispatch(splitEditorPanel({ zone: 'bottom' }));
```

Wire the existing icon button's `onClick` to `handleSplitRight`, and add a small chevron/secondary trigger opening a popover with two items ("Split Right", "Split Down") calling the two handlers. Keep `title="Split editor"`.

- [ ] **Step 2: App-run verification**

`npm run dev`:
- Click Split (default) → new pane appears to the **right**.
- Use the Down option → new pane appears **below**; both header strips and both shared-strip badges render correctly (N + vertical).
- Split to 3–4 panes → numbering stays 1..N left→right / top→bottom; colors follow the palette.
- Close a pane (docking solo-close / close its file) → remaining panes **renumber** and a surviving pane gains focus; `activeFile` follows it.

- [ ] **Step 3: Commit**

```bash
git add synthi/src/app/workspace/TopNav.jsx
git commit -m "feat(topnav): split button offers Right/Down (horizontal/vertical)"
```

---

## Phase 4 — Integration verification

### Task 10: End-to-end verification against the spec's success criteria

- [ ] **Step 1: Run the full unit suite**

Run (from `synthi/`): `npm run test`
Expected: PASS (editor-panes, layout-slice editor-split, pane-active-file, plus revived docking suite).

- [ ] **Step 2: Lint**

Run: `npm run lint`
Expected: no new errors in the touched files.

- [ ] **Step 3: Production build smoke (catches Monaco/Yjs single-instance + standalone issues)**

Run: `npm run build`
Expected: build completes; no "duplicate monaco" / "duplicate yjs" warnings introduced.

- [ ] **Step 4: Manual run-through of every spec success criterion**

`npm run dev`, then confirm each (screenshot the starred ones):
1. ★ Split → second pane shows same file by default; typing in one does not mirror to the other (unless they share a file).
2. Open a different file in the focused pane → other pane unchanged.
3. ★ Shared strip: segmented underline + badges correct; same file in two panes → half-and-half.
4. Each pane shows a legible breadcrumb + pane number.
5. Healing/completions act on the focused pane; collaborator cursors dimmed in unfocused panes.
6. ★ Vertical + 3–4 panes work; closing/unsplitting renumbers and refocuses correctly.

- [ ] **Step 5: Update `tasks/todo.md` review section**

Per `CLAUDE.md`, append a short review summary (what changed, how verified) to `tasks/todo.md`.

- [ ] **Step 6: Final commit**

```bash
git add -A
git commit -m "docs: multi-pane editor split — verification notes + todo review"
```

---

## Self-Review (filled in)

**Spec coverage:**
- §1 state model → Tasks 1,2,3 (panes util, setPaneFile, mirror helper). ✓
- §2 one model many views + paneFile → Task 4. ✓
- §3 focus/open/split routing → Tasks 2 (split), 3 (open routing), 5 (focus mirror), 9 (zones). ✓
- §4 segmented strip → Task 7. ✓
- §5 per-pane header (~20px var) → Task 8. ✓
- §6 focused-only liveness + dimmed cursors → Tasks 5, 6. ✓
- §7 palette/numbering/close fallback → Tasks 1 (palette/order), 3 (close), 9 (renumber/refocus verify). ✓

**Placeholder scan:** No "TBD/TODO". Two snippets carry explicit implementer notes (the `require`→`import` in Task 3 Step 6, and locating the existing remote-cursor decoration in Task 6) because they touch large legacy files; both name the exact symbol to find and the exact change.

**Type/name consistency:** `setPaneFile({paneId, filePath})`, `splitEditorPanel({zone})`, `getEditorPanes/getEditorPaneIds/getPanesForFile`, `selectEditorPanes/selectFocusedEditorPaneId`, `resolveOpenTarget/resolveMirrorFile`, `PANE_PALETTE/getPaneColor`, `--pane-color-1..5`, `--editor-pane-header-h`, `paneId`/`tabGroupId` — used consistently across tasks.

**Known risk:** Phase 2 (`Editor.jsx`) is the load-bearing change; it is gated behind the `filePath`/`dockingMode` seam and verified in-app before the cosmetic Phase 3. If Phase 2 verification fails, STOP and re-plan rather than layering Phase 3 on a broken base.
