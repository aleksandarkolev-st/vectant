/**
 * @fileoverview Synthi Docking Window Manager — Public API
 *
 * A fully fluid workspace docking system where any panel can be
 * dragged, dropped, split, tabbed, or floated anywhere on the screen.
 *
 * ## Quick Start
 *
 * ```jsx
 * import {
 *   DockingProvider,
 *   DockingContainer,
 *   registerPanel,
 *   useDocking,
 *   createDefaultIDELayout,
 *   createTab,
 *   PANEL_TYPES,
 * } from '@/components/docking-wm';
 *
 * // 1. Register panels
 * registerPanel({
 *   panelType: 'explorer',
 *   displayName: 'Explorer',
 *   icon: 'files',
 *   component: ExplorerPanel,
 * });
 *
 * // 2. Create initial layout
 * const defaultLayout = createDefaultIDELayout({
 *   sidebarTabs: [createTab({ panelType: 'explorer', title: 'Explorer' })],
 *   editorTabs: [createTab({ panelType: 'editor', title: 'Welcome' })],
 *   bottomTabs: [createTab({ panelType: 'terminal', title: 'Terminal' })],
 * });
 *
 * // 3. Wrap with provider and render
 * function IDE() {
 *   return (
 *     <DockingProvider workspaceSlug="my-ws" defaultLayout={defaultLayout}>
 *       <DockingContainer />
 *     </DockingProvider>
 *   );
 * }
 * ```
 */

// ─── Types & Constants ──────────────────────────────────
export {
  NODE_TYPE,
  DIRECTION,
  DROP_ZONE,
  PANEL_STATE,
  DOCK_POSITION,
  LAYOUT_VERSION,
  MIN_PANEL_SIZE,
  DEFAULT_SPLIT_RATIO,
  SPLITTER_SIZE,
  DROP_ZONE_EDGE_THRESHOLD,
  DRAG_START_THRESHOLD,
  FLOATING_MIN_WIDTH,
  FLOATING_MIN_HEIGHT,
  TAB_HEIGHT,
  POPOUT_CHANNEL_NAME,
} from './types';

// ─── Utilities ──────────────────────────────────────────
export {
  // ID generation
  generateId,
  nodeId,
  tabId,
  floatId,
  popoutId,
  profileId,

  // Node creation
  createSplitNode,
  createTabGroupNode,
  createTab,
  createFloatingWindow,
  createPopoutWindow,
  normalizeSizes,
  createEmptyLayout,
  createDefaultIDELayout,

  // Tree queries
  getNode,
  getParent,
  getChildIndex,
  getAllTabGroups,
  getAllSplitNodes,
  findTabGroup,
  isAncestor,
  getPathFromRoot,
  getDepth,
  walkTree,
  collectDescendants,
  collectTabIds,
  findFirstTabGroup,
  countTabGroups,
  getSiblings,
  validateLayout,

  // Tree operations
  splitNode,
  addTabToGroup,
  removeTabFromCurrentGroup,
  closeTab,
  moveTab,
  activateTab,
  resizeSplit,
  toggleMaximize,
  floatTab,
  dockFloat,
  updateFloat,
  bringFloatToFront,
  popoutTab,
  dockPopout,
  handleDrop,
  cleanupEmptyNodes,

  // Geometry
  hitTestDropZone,
  getDropZonePreviewRect,
  getTabInsertIndex,
  getDropZoneLabel,

  // Serialization
  serializeLayout,
  serializeLayoutToJSON,
  deserializeLayout,
  restoreLayout,
  saveLayoutToStorage,
  loadLayoutFromStorage,
  clearLayoutFromStorage,
  saveProfile,
  loadAllProfiles,
  deleteProfile,
  loadProfileLayout,
} from './utils';

// ─── State Management ───────────────────────────────────
export {
  // Redux slice
  default as layoutReducer,
  setLayout,
  resetLayout,
  openTab,
  closeTabAction,
  activateTabAction,
  moveTabAction,
  updateTabData,
  splitNodeAction,
  resizeSplitAction,
  toggleMaximizeAction,
  floatTabAction,
  dockFloatAction,
  updateFloatAction,
  bringFloatToFrontAction,
  popoutTabAction,
  dockPopoutAction,
  setDragSource,
  handleDropAction,
  setFocusedTabGroup,
  cleanupLayout,

  // Selectors
  selectLayout,
  selectRootId,
  selectNodes,
  selectTabs,
  selectNode,
  selectTab,
  selectFloating,
  selectPopouts,
  selectMaximizedNodeId,
  selectFocusedTabGroupId,
  selectDragSourceTabId,
  selectAllTabGroups,
  selectFloatingWindows,
  selectPopoutWindows,
  selectIsDragging,
  selectFocusedTabGroup,
  makeSelectTabGroupTabs,
} from './state/layout-slice';

// Panel Registry
export {
  registerPanel,
  unregisterPanel,
  getPanel,
  getAllPanels,
  hasPanel,
  PanelRegistryProvider,
  usePanelRegistry,
  PANEL_TYPES,
} from './state/panel-registry';

// ─── Hooks ──────────────────────────────────────────────
export {
  useDocking,
  useDragPanel,
  parseDragPayload,
  useDropZone,
  useSplitter,
  useSplitterKeyboard,
  useFloatingWindow,
  usePopout,
  useLayoutPersistence,
} from './hooks';

// ─── Components ─────────────────────────────────────────
export {
  DockingProvider,
  useDockingContext,
  DockingContainer,
  LayoutRenderer,
  SplitContainer,
  SplitterHandle,
  TabGroup,
  TabBar,
  Tab,
  PanelContainer,
  PanelContentArea,
  PanelGrip,
  DropOverlay,
  FloatingWindow,
  PopoutWindowContent,
  WorkspaceProfileManager,
} from './components';

// ─── Styles ─────────────────────────────────────────────
// Import in your app: import '@/components/docking-wm/styles/docking.css';
