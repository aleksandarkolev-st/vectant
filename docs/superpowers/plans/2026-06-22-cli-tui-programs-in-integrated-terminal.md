# CLI/TUI Programs in the Integrated Terminal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Launching a `cli`/`tui` program opens a tab in the integrated terminal running it, instead of a docked ProgramSessionPanel.

**Architecture:** One routing branch in `ProgramsPanel.openProgramSession` detects `cli`/`tui` sessions and fires the existing `terminal-session-open` window event + `setShowTerminal(true)` (the same mechanism the AI terminal uses), then returns before the panel/floating paths. A tiny pure predicate `isTerminalRuntimeType` (in `programSessionSections.js`) decides the routing. No backend, runtime, or PTY changes — the managed session and its lifecycle are untouched; the terminal tab is just the live view of its PTY (`TerminalManager` binds it via `fixedSessionId`).

**Tech Stack:** Next.js + React, Redux (`@/redux/uiSlice` for `setShowTerminal`), Vitest + jsdom (tests run from `synthi/`).

**Spec:** `docs/superpowers/specs/2026-06-22-cli-tui-programs-in-integrated-terminal-design.md`

**Conventions:** All test commands run from the `synthi/` package dir. To avoid leaking the shell's working directory into later commands, run them in a subshell: `(cd synthi && npx vitest run <path>)`.

---

## File Structure

- **Modify** `synthi/src/components/programs/programSessionSections.js` — add the pure predicate `isTerminalRuntimeType(runtimeType)`. (Home of the existing pure session helpers — DRY.)
- **Modify** `synthi/src/components/programs/__tests__/programSessionSections.test.js` — unit tests for the predicate.
- **Modify** `synthi/src/components/programs/ProgramsPanel.jsx` — route `cli`/`tui` in `openProgramSession`; thread a label hint from the launch handlers; import `setShowTerminal` + `isTerminalRuntimeType`.
- **Create** `synthi/src/components/programs/__tests__/programsPanelTerminalRouting.test.jsx` — jsdom routing tests (cli/tui → terminal event; ad-hoc cli → terminal; web → panel regression guard).

No changes to `TerminalManager.jsx` (it already handles `terminal-session-open`), the backend, or the runtime.

---

## Task 1: `isTerminalRuntimeType` pure predicate

**Files:**
- Modify: `synthi/src/components/programs/programSessionSections.js`
- Test: `synthi/src/components/programs/__tests__/programSessionSections.test.js`

- [ ] **Step 1: Write the failing test**

In `synthi/src/components/programs/__tests__/programSessionSections.test.js`, add `isTerminalRuntimeType` to the existing `import { … } from '../programSessionSections';` line, then append this block at the end of the file:

```js
describe('isTerminalRuntimeType', () => {
  it('is true for cli and tui (case-insensitive)', () => {
    expect(isTerminalRuntimeType('cli')).toBe(true);
    expect(isTerminalRuntimeType('tui')).toBe(true);
    expect(isTerminalRuntimeType('TUI')).toBe(true);
    expect(isTerminalRuntimeType('Cli')).toBe(true);
  });

  it('is false for web/container/background/gui/unknown/empty', () => {
    for (const rt of ['web', 'container', 'background', 'gui', 'webgui', 'unknown', '', null, undefined]) {
      expect(isTerminalRuntimeType(rt)).toBe(false);
    }
  });
});
```

If the test file does not already import `describe/it/expect`, confirm they are imported from `vitest` at the top (the file already uses them).

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd synthi && npx vitest run src/components/programs/__tests__/programSessionSections.test.js)`
Expected: FAIL — `isTerminalRuntimeType is not a function` (the import is `undefined`).

- [ ] **Step 3: Write minimal implementation**

In `synthi/src/components/programs/programSessionSections.js`, add after the `canRestartProgramSession` function (after line 16):

```js
const TERMINAL_RUNTIME_TYPES = new Set(['cli', 'tui']);

/** cli/tui programs run in the integrated terminal, not a ProgramSessionPanel. */
export function isTerminalRuntimeType(runtimeType) {
  return TERMINAL_RUNTIME_TYPES.has(String(runtimeType || '').toLowerCase());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `(cd synthi && npx vitest run src/components/programs/__tests__/programSessionSections.test.js)`
Expected: PASS (all tests in the file green, including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add synthi/src/components/programs/programSessionSections.js synthi/src/components/programs/__tests__/programSessionSections.test.js
git commit -F - <<'MSG'
feat(programs): add isTerminalRuntimeType predicate (cli/tui)

Pure helper to decide which program runtime types surface in the integrated
terminal rather than a ProgramSessionPanel. Used by the next task's routing.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
```

---

## Task 2: Route cli/tui launches to the integrated terminal

**Files:**
- Create: `synthi/src/components/programs/__tests__/programsPanelTerminalRouting.test.jsx`
- Modify: `synthi/src/components/programs/ProgramsPanel.jsx`

- [ ] **Step 1: Write the failing test**

Create `synthi/src/components/programs/__tests__/programsPanelTerminalRouting.test.jsx` with exactly:

```jsx
/* @vitest-environment jsdom */

import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDE_PANEL } from '@/components/docking-wm/panels/panel-types';

const h = vi.hoisted(() => ({
  dispatch: vi.fn(),
  state: {},
  fetchProgramSessions: vi.fn(),
  fetchInstalledPrograms: vi.fn(),
  launchProgramSession: vi.fn(),
  installWorkspaceProgram: vi.fn(),
  launchInstalledProgram: vi.fn(),
  stopProgramSession: vi.fn(),
  restartProgramSession: vi.fn(),
  publishWorkspaceProgram: vi.fn(),
  fetchMarketplace: vi.fn(),
  installPublishedProgram: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  scaffoldProgram: vi.fn(),
  fetchDetectedProgram: vi.fn(),
  launchDetectedProgram: vi.fn(),
}));

vi.mock('react-redux', () => ({
  useDispatch: () => h.dispatch,
  useSelector: (sel) => sel(h.state),
}));
vi.mock('sonner', () => ({ toast: { success: h.toastSuccess, error: h.toastError } }));
vi.mock('../programsClient', () => ({
  fetchProgramSessions: h.fetchProgramSessions,
  fetchInstalledPrograms: h.fetchInstalledPrograms,
  launchProgramSession: h.launchProgramSession,
  installWorkspaceProgram: h.installWorkspaceProgram,
  launchInstalledProgram: h.launchInstalledProgram,
  stopProgramSession: h.stopProgramSession,
  restartProgramSession: h.restartProgramSession,
  publishWorkspaceProgram: h.publishWorkspaceProgram,
  fetchMarketplace: h.fetchMarketplace,
  installPublishedProgram: h.installPublishedProgram,
  scaffoldProgram: h.scaffoldProgram,
  fetchDetectedProgram: h.fetchDetectedProgram,
  launchDetectedProgram: h.launchDetectedProgram,
}));
vi.mock('@/components/docking-wm/state/layout-slice', () => ({
  selectNodes: (s) => s.nodes,
  selectTabs: (s) => s.tabs,
  selectFloating: (s) => s.floating,
  openTab: (p) => ({ type: 'openTab', payload: p }),
  activateTabAction: (p) => ({ type: 'activate', payload: p }),
  setFocusedTabGroup: (p) => ({ type: 'focus', payload: p }),
  openFloatingPanel: (p) => ({ type: 'openFloatingPanel', payload: p }),
  bringFloatToFrontAction: (p) => ({ type: 'bringFloatToFront', payload: p }),
}));
vi.mock('@/redux/uiSlice', () => ({
  setShowTerminal: (v) => ({ type: 'ui/setShowTerminal', payload: v }),
}));

import ProgramsPanel from '../ProgramsPanel';

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await Promise.resolve();
    }
  });
}
function byTestId(container, id) {
  return container.querySelector(`[data-testid="${id}"]`);
}

describe('ProgramsPanel — cli/tui programs route to the integrated terminal', () => {
  let container;
  let root;
  let dispatchEventSpy;

  beforeEach(() => {
    vi.clearAllMocks();
    h.state = {
      workspace: { slug: 'team', role: 'owner' },
      nodes: { g1: { type: 'tabgroup', tabs: ['t1'] } },
      tabs: { t1: { panelType: IDE_PANEL.EDITOR } },
      floating: {},
    };
    h.fetchProgramSessions.mockResolvedValue([]);
    h.fetchInstalledPrograms.mockResolvedValue([]);
    h.fetchMarketplace.mockResolvedValue([]);
    h.fetchDetectedProgram.mockResolvedValue(null);
    dispatchEventSpy = vi.spyOn(window, 'dispatchEvent');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    dispatchEventSpy.mockRestore();
  });

  async function render() {
    await act(async () => {
      root.render(React.createElement(ProgramsPanel));
    });
    await flush();
  }

  function terminalEvents() {
    return dispatchEventSpy.mock.calls
      .map((c) => c[0])
      .filter((e) => e && e.type === 'terminal-session-open');
  }
  function dispatchedTypes() {
    return h.dispatch.mock.calls.map((c) => c[0]?.type);
  }

  it('launching a tui install opens a terminal tab, not a panel', async () => {
    h.fetchInstalledPrograms.mockResolvedValue([{ id: 'inst1', packageId: '@vectant/lazygit', version: '1.0.0', status: 'installed' }]);
    h.launchInstalledProgram.mockResolvedValue({ session: { id: 'ps-tui', state: 'running', runtimeType: 'tui' } });
    await render();

    await act(async () => { byTestId(container, 'launch-install-inst1').click(); });
    await flush();

    expect(dispatchedTypes()).toContain('ui/setShowTerminal');
    const evts = terminalEvents();
    expect(evts).toHaveLength(1);
    expect(evts[0].detail.sessionId).toBe('ps-tui');
    expect(dispatchedTypes()).not.toContain('openTab');
    expect(dispatchedTypes()).not.toContain('openFloatingPanel');
  });

  it('the ad-hoc Launch Command (cli) routes to the terminal', async () => {
    h.launchProgramSession.mockResolvedValue({ session: { id: 'ps-cli', state: 'running', runtimeType: 'cli' } });
    await render();

    // The ad-hoc form's Launch button is the only type="submit" in the panel.
    await act(async () => { container.querySelector('button[type="submit"]').click(); });
    await flush();

    expect(h.launchProgramSession).toHaveBeenCalled();
    expect(dispatchedTypes()).toContain('ui/setShowTerminal');
    const evts = terminalEvents();
    expect(evts).toHaveLength(1);
    expect(evts[0].detail.sessionId).toBe('ps-cli');
  });

  it('a web install still opens a docked program-session panel (not the terminal)', async () => {
    h.fetchInstalledPrograms.mockResolvedValue([{ id: 'inst2', packageId: 'local:team:web', version: '1.0.0', status: 'installed' }]);
    h.launchInstalledProgram.mockResolvedValue({ session: { id: 'ps-web', state: 'running', runtimeType: 'web' } });
    await render();

    await act(async () => { byTestId(container, 'launch-install-inst2').click(); });
    await flush();

    expect(terminalEvents()).toHaveLength(0);
    expect(dispatchedTypes()).toContain('openTab');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `(cd synthi && npx vitest run src/components/programs/__tests__/programsPanelTerminalRouting.test.jsx)`
Expected: FAIL — the first two tests fail because today a `tui`/`cli` session goes through `openTab` (no `terminal-session-open` event, no `ui/setShowTerminal`). The web test passes already.

- [ ] **Step 3a: Add the imports in `ProgramsPanel.jsx`**

Add `isTerminalRuntimeType` to the existing `programSessionSections` import (currently lines 23–29) so it reads:

```jsx
import {
  buildProgramSessionSections,
  canRestartProgramSession,
  formatProgramSessionAge,
  formatProgramSessionPorts,
  isActiveProgramSession,
  isTerminalRuntimeType,
} from './programSessionSections';
```

And add a new import after the `layout-slice` import (after line 30):

```jsx
import { setShowTerminal } from '@/redux/uiSlice';
```

- [ ] **Step 3b: Add the routing branch + label arg in `openProgramSession`**

Replace the start of `openProgramSession` (currently `const openProgramSession = useCallback((session) => {` followed by the `if (!session?.id) return;` guard) with:

```jsx
  const openProgramSession = useCallback((session, { label = null, command = null } = {}) => {
    if (!session?.id) return;

    // CLI/TUI programs run in the REAL integrated terminal (a terminal tab bound
    // to the session PTY), not a ProgramSessionPanel. Reuses the same
    // terminal-session-open event the AI terminal uses; TerminalManager dedups by
    // fixedSessionId, so re-launch / Open re-focuses the existing tab. Closing the
    // tab only detaches — the managed session is stopped from this panel.
    if (isTerminalRuntimeType(session.runtimeType)) {
      dispatch(setShowTerminal(true));
      window.dispatchEvent(new CustomEvent('terminal-session-open', {
        detail: { sessionId: session.id, command: command || null, label: label || sessionLabel(session) },
      }));
      return;
    }
```

Leave the rest of the function (the existing docked-tab / floating-window logic and its closing `}, [dispatch, nodes, tabs, floating, workspaceSlug]);`) unchanged. The dependency array is unchanged — `setShowTerminal`, `isTerminalRuntimeType`, and `sessionLabel` are module-level imports, and `dispatch` is already a dependency.

- [ ] **Step 3c: Pass a label hint from the launch handlers**

In `handleLaunch`, change `openProgramSession(launched.session);` to:

```jsx
        openProgramSession(launched.session, { command: trimmed, label: trimmed });
```

In `handleLaunchInstall`, change `openProgramSession(result.session);` to:

```jsx
        openProgramSession(result.session, { label: install.packageId });
```

Leave `handleLaunchDetected` and the `SessionCard` `onOpen` call unchanged — detected programs are container-type (panel-routed), and the `Open` button falls back to `sessionLabel`.

- [ ] **Step 4: Run test to verify it passes**

Run: `(cd synthi && npx vitest run src/components/programs/__tests__/programsPanelTerminalRouting.test.jsx)`
Expected: PASS (all three tests green).

- [ ] **Step 5: Commit**

```bash
git add synthi/src/components/programs/ProgramsPanel.jsx synthi/src/components/programs/__tests__/programsPanelTerminalRouting.test.jsx
git commit -F - <<'MSG'
feat(programs): run cli/tui programs in the integrated terminal

Launching a cli/tui program (incl. the ad-hoc Launch Command) now opens a tab in
the integrated terminal bound to the session PTY (via the existing
terminal-session-open event + setShowTerminal), instead of a docked
ProgramSessionPanel. web/container/webGui/background are unchanged. The managed
session lifecycle is untouched; closing the tab detaches (stop stays in the
Programs panel).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
MSG
```

---

## Task 3: Regression sweep

**Files:** none (verification only)

- [ ] **Step 1: Run the programs + docking suites**

Run: `(cd synthi && npx vitest run src/components/programs src/components/docking-wm)`
Expected: PASS — all existing programs tests (including `programsPanelInstall.test.jsx`, `ProgramSessionPanel.test.jsx`) plus the two new files are green. No failures. (The `programsPanelInstall.test.jsx` "launches an installed program" test uses `runtimeType: 'web'`, so it still asserts a panel open — unaffected.)

- [ ] **Step 2: If anything fails, stop and diagnose**

A failure here means a regression. Most likely cause if the install suite breaks: a `web`/`container` session was accidentally routed to the terminal — re-check that the `isTerminalRuntimeType` branch only triggers for `cli`/`tui`. Fix before proceeding; do not paper over with test edits.

---

## Self-Review

**Spec coverage:**
- Routing branch in `openProgramSession` for cli/tui → Task 2 (Step 3b). ✓
- Reuse `terminal-session-open` + `setShowTerminal(true)` → Task 2 (Step 3b). ✓
- Routing table (web/container/webGui/background unchanged) → Task 2 leaves those paths intact; regression guard in the web test + Task 3. ✓
- Tab label (program/command name, fallback to `sessionLabel`) → Task 2 (Steps 3b, 3c). ✓
- Decision 1 (ad-hoc cli → terminal) → covered by the cli branch; verified by the ad-hoc test in Task 2. ✓
- Decision 2 (close = detach only) → no tab↔session lifecycle wiring added; nothing to implement (it's the default). ✓
- Pure predicate unit test → Task 1. ✓
- jsdom routing tests (cli/tui → terminal; web → panel) → Task 2. ✓
- Regression green → Task 3. ✓

**Placeholder scan:** No TBD/TODO; all steps carry exact code and commands. ✓

**Type/name consistency:** `isTerminalRuntimeType` (defined Task 1, used Task 2); `setShowTerminal` from `@/redux/uiSlice` (mocked as `ui/setShowTerminal` in the test, real action in impl — the test asserts on the action `type` string the mock produces, so it is self-consistent); `terminal-session-open` event name matches `TerminalManager`'s listener; `sessionLabel` is an existing module-level function in `ProgramsPanel.jsx`. ✓
