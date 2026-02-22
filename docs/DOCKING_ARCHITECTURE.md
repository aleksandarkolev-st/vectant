# Docking Window Manager — Architecture Guide

## Overview

The Synthi IDE Docking Window Manager is a fully custom tiling/floating window
management system built from scratch. It enables a completely fluid workspace
where **any panel can be dragged, dropped, split, tabbed, or floated anywhere
on the screen** — including into separate browser windows.

## Design Principles

1. **Redux-native**: All layout state lives in a single Redux slice (`layout`)
   using a normalised flat-map structure for O(1) lookups and minimal Immer patches.

2. **Immutable operations**: Every tree mutation returns a new object.
   No in-place mutations, no `structuredClone`, no deep spreads.

3. **Zero-dependency DnD**: Uses the native HTML5 Drag and Drop API rather
   than `dnd-kit` or `react-dnd` to avoid bundle bloat.

4. **Incremental adoption**: A `USE_DOCKING_WM` feature flag in the workspace
   page allows progressive migration from the legacy rigid layout.

5. **Pluggable panels**: Panel components are registered at runtime via a global
   registry. The docking system doesn't know about Explorer, Editor, etc.

## Directory Structure

```
src/components/docking-wm/
├── index.js                    # Public API barrel export
├── DockableWorkspace.jsx       # Drop-in workspace integration wrapper
├── types.js                    # Type enums, constants, JSDoc typedefs
│
├── utils/
│   ├── id-generator.js         # Unique ID generation (node-, tab-, float-)
│   ├── layout-node.js          # Node/tab factory functions
│   ├── layout-query.js         # Tree traversal & search (walkTree, findTabGroup)
│   ├── layout-ops.js           # Immutable tree mutations (split, move, close, resize)
│   ├── layout-validation.js    # Deep validation & auto-repair
│   ├── geometry.js             # Drop zone hit-testing
│   ├── serialization.js        # JSON ser/de, localStorage, workspace profiles
│   ├── aria.js                 # ARIA attribute helpers
│   └── index.js                # Barrel export
│
├── state/
│   ├── layout-slice.js         # Redux Toolkit slice (actions + selectors)
│   ├── panel-registry.js       # Global panel type registry + React context
│   └── index.js                # Barrel export
│
├── hooks/
│   ├── use-docking.js          # Unified docking API hook
│   ├── use-drag-panel.js       # HTML5 DnD source with ghost image
│   ├── use-drop-zone.js        # DnD target with zone detection
│   ├── use-splitter.js         # Pointer-based resize with keyboard
│   ├── use-floating-window.js  # Title drag, 8-directional resize
│   ├── use-popout.js           # BroadcastChannel pop-out windows
│   ├── use-layout-persistence.js # Debounced localStorage auto-save
│   ├── use-keyboard-navigation.js # Global keyboard shortcuts
│   ├── use-activity-bar-docking.js # ActivityBar ↔ docking bridge
│   ├── use-layout-history.js   # Undo/redo with ring buffer
│   ├── use-responsive-layout.js # Container breakpoints & hints
│   └── index.js                # Barrel export
│
├── components/
│   ├── DockingProvider.jsx     # Root context (profile management)
│   ├── DockingContainer.jsx    # Root visual + floating layer
│   ├── LayoutRenderer.jsx      # Recursive tree renderer
│   ├── SplitContainer.jsx      # Row/column flex with splitters
│   ├── SplitterHandle.jsx      # 4px invisible handle + accent line
│   ├── TabGroup.jsx            # Leaf: TabBar + PanelContent + DropOverlay
│   ├── TabBar.jsx              # Scrollable tab row with maximize
│   ├── Tab.jsx                 # Draggable tab with close/middle-click
│   ├── PanelContainer.jsx      # Registry-based panel renderer
│   ├── PanelGrip.jsx           # 2×3 dot grid drag affordance
│   ├── DropOverlay.jsx         # Translucent zone highlight + compass
│   ├── FloatingWindow.jsx      # Draggable/resizable overlay
│   ├── PopoutWindow.jsx        # Detached browser window content
│   ├── WorkspaceProfileManager.jsx # Profile save/load/delete modal
│   ├── ContextMenu.jsx         # Right-click menu for tabs
│   ├── LayoutPresetPicker.jsx  # Preset grid with SVG thumbnails
│   ├── LayoutDebugOverlay.jsx  # Dev tool (Ctrl+Shift+D)
│   └── index.js                # Barrel export
│
├── panels/
│   ├── ide-panels.js           # IDE panel definitions + lazy loaders
│   ├── layout-presets.js       # Pre-built layout presets (5 layouts)
│   ├── panel-wrappers.jsx      # Docking-aware wrappers for IDE panels
│   └── index.js                # Barrel export
│
├── styles/
│   └── docking.css             # CSS variables, animations, a11y
│
└── __tests__/
    └── layout-ops.test.js      # Vitest unit tests
```

## Data Model

### Normalised Layout Tree

```
{
  version: 1,
  rootId: "node-1",
  nodes: {
    "node-1": { type: "split", direction: "row", children: ["node-2", "node-3"], sizes: [0.25, 0.75], parentId: null },
    "node-2": { type: "tabgroup", tabs: ["tab-1"], activeTabId: "tab-1", parentId: "node-1" },
    "node-3": { type: "tabgroup", tabs: ["tab-2"], activeTabId: "tab-2", parentId: "node-1" },
  },
  tabs: {
    "tab-1": { panelType: "explorer", title: "Explorer", data: {} },
    "tab-2": { panelType: "editor",   title: "Welcome",  data: { welcome: true } },
  },
  floating: { ... },
  popouts:  { ... },
  maximizedNodeId: null,
  focusedTabGroupId: "node-3",
  dragSourceTabId: null,
}
```

**Why flat?**
- O(1) node lookups by ID
- Minimal Redux patches (only the changed node is spread)
- No deep nesting means no 10-level spread chains
- Parent pointers enable O(1) upward traversal

### Node Types

| Type | Description | Children |
|------|-------------|----------|
| `split` | Container with direction (row/column) | Ordered list of child node IDs |
| `tabgroup` | Leaf with multiple tabs | Ordered list of tab IDs |

### Tab Structure

Each tab stores its `panelType` (registry key), `title`, and optional `data`
(e.g. file path for editors, session ID for terminals).

## DnD Mechanics

### Drop Zones

When a tab is dragged over a tab group, the drop overlay divides the target
into 5 zones:

```
┌──────────────────────┐
│        TOP           │
│   ┌──────────────┐   │
│ L │    CENTER     │ R │
│ E │   (add tab)  │ I │
│ F │              │ G │
│ T │              │ H │
│   └──────────────┘ T │
│       BOTTOM         │
└──────────────────────┘
```

- **CENTER**: Add tab to the existing group
- **TOP/BOTTOM/LEFT/RIGHT**: Split the group in that direction

Hit-testing uses a 25% edge threshold with the remaining centre area.

### Drag Data

```json
{
  "type": "docking-tab",
  "tabId": "tab-123",
  "sourceGroupId": "node-456",
  "panelType": "editor"
}
```

Encoded as JSON in `dataTransfer.setData('application/x-docking', ...)`.

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+Arrow | Move focus between tab groups |
| Ctrl+Tab | Cycle tabs forward |
| Ctrl+Shift+Tab | Cycle tabs backward |
| Ctrl+W | Close active tab |
| Ctrl+Shift+M | Maximize/restore panel |
| Ctrl+\\ | Split horizontally |
| Ctrl+Shift+\\ | Split vertically |
| Ctrl+B | Toggle sidebar |
| Ctrl+J | Toggle bottom panel |
| Ctrl+Z | Undo layout change |
| Ctrl+Shift+Z | Redo layout change |
| F6 | Focus next group |
| Shift+F6 | Focus previous group |

All Ctrl shortcuts use Cmd on macOS.

## Pop-out Windows

Panels can be popped out into separate browser windows using
`window.open()`. State is synchronised via `BroadcastChannel`:

1. User clicks "Pop out" → parent calls `window.open('/workspace/popout?tabId=...')`
2. Child window renders panel content via `PopoutWindowContent`
3. Child sends `popout:ready` message
4. On tab close/window unload, child sends `popout:closing`
5. Parent re-docks the tab automatically

## Workspace Profiles

Layouts can be saved as named profiles in localStorage:

```
localStorage key: synthi:docking:profiles
value: [{ id, name, createdAt, layout }]
```

The `WorkspaceProfileManager` component provides UI for CRUD operations.
Five built-in presets are available: Classic, Focus, Side-by-Side,
AI-Assisted, Three Column.

## Integration Guide

### 1. Enable the feature flag

```js
// In workspace/[slug]/page.jsx
const USE_DOCKING_WM = true;
```

### 2. The DockableWorkspace component handles everything:
- Registers IDE panels
- Loads persisted layout from localStorage
- Renders the docking container
- Enables keyboard navigation + auto-persistence

### 3. Register custom panels (extensions)

```js
import { registerPanel } from '@/components/docking-wm';

registerPanel({
  panelType: 'my-custom-panel',
  displayName: 'My Panel',
  icon: 'box',
  component: MyPanelComponent,
  allowMultiple: false,
  closable: true,
});
```

## Performance Considerations

- **Memoization**: All components use `React.memo`. Selectors use `createSelector`.
- **Lazy loading**: Panel components loaded via `next/dynamic` with ssr: false.
- **Minimal re-renders**: Normalised state means only changed nodes trigger updates.
- **Debounced persistence**: localStorage writes debounced to 800ms.
- **Virtual splitters**: Splitter resize uses `requestAnimationFrame` throttling.

## Accessibility

- Full keyboard navigation (see shortcuts table above)
- ARIA tab/tabpanel/separator roles with proper labelling
- Focus indicators on active tab group
- Screen reader live region for DnD announcements
- High contrast mode support via `forced-colors` media query
- `prefers-reduced-motion` disables animations
