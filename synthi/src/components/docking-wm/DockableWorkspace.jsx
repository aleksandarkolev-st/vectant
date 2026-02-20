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
} from './state/layout-slice';
import { loadLayoutFromStorage } from './utils/serialization';

// ────────────────────────────────────────────────────────
//  Workspace Panel Context
// ────────────────────────────────────────────────────────
import { createContext, useContext } from 'react';

/**
 * Context for passing workspace-level props to panel components.
 * Panel components can `useWorkspacePanelContext()` to get editor,
 * activeFile, dispatch, etc.
 */
const WorkspacePanelContext = createContext(null);

export function useWorkspacePanelContext() {
  return useContext(WorkspacePanelContext);
}

// ────────────────────────────────────────────────────────
//  Inner component (needs Redux available)
// ────────────────────────────────────────────────────────

function DockableWorkspaceInner({
  workspaceSlug,
  defaultPreset = 'classic',
}) {
  const dispatch = useDispatch();
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
    const stored = loadLayoutFromStorage(workspaceSlug);
    if (stored && stored.rootId && stored.nodes && Object.keys(stored.nodes).length > 0) {
      dispatch(setLayout(stored));
    } else {
      const defaultLayout = createLayoutFromPreset(defaultPreset);
      dispatch(setLayout(defaultLayout));
    }
  }, [workspaceSlug, defaultPreset, dispatch]);

  // ── Auto-persist layout ──
  useLayoutPersistence(workspaceSlug, layout, { debounceMs: 800 });

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
        <div className={`h-full w-full overflow-hidden ${className}`}>
          <DockableWorkspaceInner
            workspaceSlug={workspaceSlug}
            defaultPreset={defaultPreset}
          />
        </div>
      </DockingProvider>
    </WorkspacePanelContext.Provider>
  );
});
