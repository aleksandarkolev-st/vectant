/**
 * @fileoverview Type definitions for the Synthi Docking Window Manager.
 *
 * Layout Model (Normalized Flat Tree):
 * ─────────────────────────────────────
 * The layout is represented as a flat map of nodes with parent references,
 * enabling O(1) lookups and Redux-friendly immutable updates.
 *
 *   ┌─────────────────────────────────────────┐
 *   │  Split(row) [root]                      │
 *   │  ┌──────────┐  ┌──────────────────────┐ │
 *   │  │ TabGroup  │  │ Split(col)           │ │
 *   │  │ [Explorer]│  │ ┌──────────────────┐ │ │
 *   │  │ [Search]  │  │ │ TabGroup         │ │ │
 *   │  │           │  │ │ [Editor1][Edit2] │ │ │
 *   │  │           │  │ ├──────────────────┤ │ │
 *   │  │           │  │ │ TabGroup         │ │ │
 *   │  │           │  │ │ [Terminal]       │ │ │
 *   │  │           │  │ └──────────────────┘ │ │
 *   │  └──────────┘  └──────────────────────┘ │
 *   └─────────────────────────────────────────┘
 */

// ─── Node Types ─────────────────────────────────────────
/** @enum {string} */
export const NODE_TYPE = Object.freeze({
  SPLIT: 'split',
  TAB_GROUP: 'tabgroup',
});

// ─── Split Directions ───────────────────────────────────
/** @enum {string} */
export const DIRECTION = Object.freeze({
  ROW: 'row',       // horizontal split (children side by side)
  COLUMN: 'column', // vertical split (children stacked)
});

// ─── Drop Zones ─────────────────────────────────────────
/** @enum {string} */
export const DROP_ZONE = Object.freeze({
  LEFT: 'left',
  RIGHT: 'right',
  TOP: 'top',
  BOTTOM: 'bottom',
  CENTER: 'center',   // merge into tab group
  TAB_BAR: 'tab-bar', // insert between tabs
});

// ─── Panel State ────────────────────────────────────────
/** @enum {string} */
export const PANEL_STATE = Object.freeze({
  DOCKED: 'docked',
  FLOATING: 'floating',
  POPOUT: 'popout',
  MAXIMIZED: 'maximized',
  HIDDEN: 'hidden',
});

// ─── Dock Position ──────────────────────────────────────
/** @enum {string} */
export const DOCK_POSITION = Object.freeze({
  LEFT: 'left',
  RIGHT: 'right',
  TOP: 'top',
  BOTTOM: 'bottom',
  CENTER: 'center',
});

/**
 * @typedef {Object} SplitNode
 * @property {string} id
 * @property {'split'} type
 * @property {string} direction - 'row' | 'column'
 * @property {string[]} children - node IDs
 * @property {number[]} sizes - fractional sizes (0-1), sums to 1
 * @property {string|null} parentId
 */

/**
 * @typedef {Object} TabGroupNode
 * @property {string} id
 * @property {'tabgroup'} type
 * @property {string[]} tabs - tab IDs
 * @property {string|null} activeTabId
 * @property {string|null} parentId
 * @property {boolean} [isPlaceholder] - empty placeholder during drag
 */

/**
 * @typedef {SplitNode|TabGroupNode} LayoutNode
 */

/**
 * @typedef {Object} TabDefinition
 * @property {string} id
 * @property {string} panelType - registry key for the panel component
 * @property {string} title
 * @property {string} [icon] - codicon name
 * @property {boolean} [closable] - default true
 * @property {boolean} [pinned]
 * @property {Object} [data] - arbitrary panel-specific data
 */

/**
 * @typedef {Object} FloatingWindow
 * @property {string} id
 * @property {string} tabId - the tab being shown
 * @property {number} x
 * @property {number} y
 * @property {number} width
 * @property {number} height
 * @property {number} zIndex
 * @property {boolean} [isMinimized]
 */

/**
 * @typedef {Object} PopoutWindow
 * @property {string} id
 * @property {string} tabId
 * @property {string} windowName - unique window.open name
 * @property {number} [width]
 * @property {number} [height]
 * @property {number} [left]
 * @property {number} [top]
 */

/**
 * @typedef {Object} LayoutState
 * @property {number} version - schema version for migrations
 * @property {string} rootId - ID of the root node
 * @property {Object<string, LayoutNode>} nodes - flat map of all nodes
 * @property {Object<string, TabDefinition>} tabs - flat map of all tabs
 * @property {Object<string, FloatingWindow>} floating - floating windows
 * @property {Object<string, PopoutWindow>} popouts - popped out windows
 * @property {string|null} maximizedNodeId - currently maximized node
 * @property {string|null} focusedTabGroupId - currently focused tab group
 * @property {string|null} dragSourceTabId - tab being dragged (null if not dragging)
 */

/**
 * @typedef {Object} PanelRegistration
 * @property {string} panelType - unique key
 * @property {string} displayName
 * @property {string} [icon] - codicon name
 * @property {React.ComponentType} component - the panel React component
 * @property {boolean} [singleton] - only one instance allowed
 * @property {boolean} [closable] - default true
 * @property {string} [defaultLocation] - 'left' | 'right' | 'bottom' | 'center'
 * @property {Object} [defaultData]
 */

/**
 * @typedef {Object} WorkspaceProfile
 * @property {string} id
 * @property {string} name
 * @property {string} [description]
 * @property {number} createdAt - timestamp
 * @property {number} updatedAt - timestamp
 * @property {LayoutState} layout - serialized layout state
 */

/**
 * @typedef {Object} DragPayload
 * @property {string} type - 'tab' | 'panel' | 'tab-group'
 * @property {string} tabId - the tab being dragged
 * @property {string} sourceTabGroupId - where the tab is coming from
 * @property {number} [sourceTabIndex]
 */

/**
 * @typedef {Object} DropTarget
 * @property {string} nodeId - target tab group or split node
 * @property {string} zone - DROP_ZONE value
 * @property {number} [tabIndex] - for TAB_BAR zone, insertion index
 */

export const LAYOUT_VERSION = 4;

export const MIN_PANEL_SIZE = 0.05; // 5% minimum
export const DEFAULT_SPLIT_RATIO = 0.5;
export const SPLITTER_SIZE = 4; // pixels
export const DROP_ZONE_EDGE_THRESHOLD = 0.25; // 25% from edge triggers split
export const DRAG_START_THRESHOLD = 8; // pixels before drag starts
export const FLOATING_MIN_WIDTH = 200;
export const FLOATING_MIN_HEIGHT = 150;
export const TAB_HEIGHT = 35; // pixels
export const POPOUT_CHANNEL_NAME = 'synthi-docking-popout';
