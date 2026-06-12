'use client';

/**
 * @fileoverview DockableWorkspace — drop-in replacement for the rigid
 * ResizablePanelGroup layout in the workspace page.
 *
 * This component:
 * 1. Registers all IDE panels with the panel registry
 * 2. Initialises the layout from localStorage or a preset
 * 3. Renders the DockingContainer
 * 4. Enables keyboard navigation and persistence
 * 5. Passes workspace context (editor, slug, etc.) to panels via context
 *
 * Usage in workspace page:
 * ```jsx
 * <DockableWorkspace
 *   workspaceSlug={slug}
 *   defaultPreset="classic"
 *   panelProps={{ editor, activeFile, ... }}
 * />
 * ```
 */

import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useStore } from 'react-redux';

// Docking CSS
import './styles/docking.css';

// Docking system imports
import { DockingProvider } from './components/DockingProvider';
import { DockingContainer } from './components/DockingContainer';
import { registerAllIDEPanels } from './panels/ide-panels';
import { createLayoutFromPreset, createClassicLayout } from './panels/layout-presets';
import { registerPanel, getAllPanels } from './state/panel-registry';
import { useKeyboardNavigation, useFocusIndicator } from './hooks/use-keyboard-navigation';
import { useLayoutPersistence } from './hooks/use-layout-persistence';
import {
  setLayout,
  resetLayout,
  closeTabAction,
  activateTabAction,
  splitNodeAction,
  toggleMaximizeAction,
  floatTabAction,
  popoutTabAction,
  setFocusedTabGroup,
  selectFocusedTabGroupId,
  selectMaximizedNodeId,
  selectNode,
  selectLayout,
  selectTabs,
} from './state/layout-slice';
import { loadLayoutFromStorage } from './utils/serialization';
import { createTab } from './utils';

import { DockingActivityBar } from './components/DockingActivityBar';

// ────────────────────────────────────────────────────────
//  Workspace Panel Context (shared module to avoid circular deps)
// ────────────────────────────────────────────────────────
import {
  WorkspacePanelContext,
  useWorkspacePanelContext,
} from './context/workspace-panel-context';

// Re-export so existing consumers still work
export { useWorkspacePanelContext };

// ────────────────────────────────────────────────────────
//  Inner component (needs Redux available)
// ────────────────────────────────────────────────────────

function DockableWorkspaceInner({
  workspaceSlug,
  defaultPreset = 'classic',
}) {
  const dispatch = useDispatch();
  const store = useStore();
  const focusedGroupId = useSelector(selectFocusedTabGroupId);
  const maximizedNodeId = useSelector(selectMaximizedNodeId);
  const layout = useSelector(selectLayout);
  const initialised = useRef(false);

  // ── Register panels once ──
  useEffect(() => {
    if (initialised.current) return;
    initialised.current = true;

    // Register all IDE panel definitions
    const existing = getAllPanels();
    if (Object.keys(existing).length === 0) {
      registerAllIDEPanels(registerPanel);
    }

    // Load layout from localStorage or create default
    let layoutToUse;
    const stored = loadLayoutFromStorage(workspaceSlug);
    if (stored && stored.rootId && stored.nodes && Object.keys(stored.nodes).length > 0) {
      layoutToUse = stored;
    } else {
      layoutToUse = createLayoutFromPreset(defaultPreset);
    }

    // ── Migration: ensure Output tab exists ──
    // If no tab with panelType 'output' exists, inject one next to the Terminal tab.
    const hasStaleVSCodeServerTab = Object.values(layoutToUse.tabs || {})
      .some((tab) => tab?.panelType === 'vscode-server');
    if (hasStaleVSCodeServerTab) {
      layoutToUse = createLayoutFromPreset(defaultPreset);
    }

    const allTabs = layoutToUse.tabs || {};
    const hasOutputTab = Object.values(allTabs).some((t) => t.panelType === 'output');
    if (!hasOutputTab) {
      // Create the Output tab
      const outputTab = createTab({ panelType: 'output', title: 'Output', closable: true });
      layoutToUse.tabs = { ...allTabs, [outputTab.id]: outputTab };

      // Find the tab group containing the Terminal tab
      const terminalTabId = Object.keys(allTabs).find((id) => allTabs[id]?.panelType === 'terminal');
      if (terminalTabId) {
        const nodes = layoutToUse.nodes || {};
        const termGroupId = Object.keys(nodes).find(
          (nId) => nodes[nId]?.type === 'tabgroup' && Array.isArray(nodes[nId].tabs) && nodes[nId].tabs.includes(terminalTabId)
        );
        if (termGroupId) {
          const group = { ...nodes[termGroupId] };
          group.tabs = [...group.tabs, outputTab.id];
          layoutToUse.nodes = { ...nodes, [termGroupId]: group };
        }
      }
    }

    dispatch(setLayout(layoutToUse));
  }, [workspaceSlug, defaultPreset, dispatch]);

  // ── Auto-persist layout ──
  useLayoutPersistence({ workspaceSlug, debounceMs: 800 });

  // ── Focus indicator ──
  useFocusIndicator(focusedGroupId);

  // ── Keyboard navigation ──
  const getActiveTabForGroup = useCallback(
    (groupId) => {
      const node = layout?.nodes?.[groupId];
      return node?.activeTabId ?? null;
    },
    [layout],
  );

  const keyboardActions = useMemo(
    () => ({
      setFocusedGroup: (id) => dispatch(setFocusedTabGroup(id)),
      activateTab: (tabId) => dispatch(activateTabAction({ tabId })),
      closeTab: (tabId) => dispatch(closeTabAction({ tabId })),
      toggleMaximize: () => {
        if (focusedGroupId) {
          dispatch(toggleMaximizeAction({ nodeId: focusedGroupId }));
        }
      },
      resetLayout: () => {
        const freshLayout = createLayoutFromPreset(defaultPreset);
        dispatch(setLayout(freshLayout));
      },
      splitGroup: (groupId, direction) => {
        dispatch(splitNodeAction({ nodeId: groupId, direction }));
      },
      getFocusedGroup: () => focusedGroupId,
      getActiveTab: getActiveTabForGroup,
    }),
    [dispatch, focusedGroupId, defaultPreset, getActiveTabForGroup],
  );

  useKeyboardNavigation(keyboardActions);

  // ── Auto-switch to Output tab when a build starts ──
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = () => {
      // Read latest tabs from the store to avoid stale closure
      const currentTabs = selectTabs(store.getState());
      const outputTabId = Object.keys(currentTabs || {}).find(
        (id) => currentTabs[id]?.panelType === 'output'
      );
      if (outputTabId) {
        dispatch(activateTabAction({ tabId: outputTabId }));
      }
    };
    window.addEventListener('synthi:show-output-panel', handler);
    return () => window.removeEventListener('synthi:show-output-panel', handler);
  }, [store, dispatch]);

  return <DockingContainer />;
}

// ────────────────────────────────────────────────────────
//  Main exported component
// ────────────────────────────────────────────────────────

/**
 * @param {Object}  props
 * @param {string}  props.workspaceSlug   - Current workspace ID
 * @param {string}  [props.defaultPreset] - Layout preset ID for first load
 * @param {Object}  [props.panelProps]    - Props passed to panel components via context
 * @param {string}  [props.className]
 */
export const DockableWorkspace = memo(function DockableWorkspace({
  workspaceSlug,
  defaultPreset = 'classic',
  panelProps = {},
  className = '',
}) {
  const ctxValue = useMemo(
    () => ({
      workspaceSlug,
      ...panelProps,
    }),
    [workspaceSlug, panelProps],
  );

  return (
    <WorkspacePanelContext.Provider value={ctxValue}>
      <DockingProvider workspaceSlug={workspaceSlug}>
        <div className={`dock-workspace-root h-full w-full overflow-hidden flex flex-row ${className}`}>
          <DockingActivityBar />
          <div className="flex-1 min-w-0 min-h-0 h-full overflow-hidden">
            <DockableWorkspaceInner
              workspaceSlug={workspaceSlug}
              defaultPreset={defaultPreset}
            />
          </div>
        </div>
      </DockingProvider>
    </WorkspacePanelContext.Provider>
  );
});
