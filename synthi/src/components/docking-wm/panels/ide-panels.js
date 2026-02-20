'use client';

/**
 * @fileoverview IDE panel definitions for the docking window manager.
 *
 * Each definition tells the docking system everything it needs to
 * lazily render, serialise and restore a specific IDE panel.
 *
 * The `component` field for each panel points to the docking-aware
 * wrapper (from panel-wrappers.jsx), which imports the real component
 * via next/dynamic and reads shared state from WorkspacePanelContext.
 */

import {
  ExplorerPanelWrapper,
  EditorPanelWrapper,
  TerminalPanelWrapper,
  ChatPanelWrapper,
  ProblemsPanelWrapper,
  SearchPanelWrapper,
  GitPanelWrapper,
  ExtensionsPanelWrapper,
  OutputPanelWrapper,
  PreviewPanelWrapper,
} from './panel-wrappers';

// ────────────────────────────────────────────────────────
//  Panel type keys (match PANEL_TYPES in panel-registry)
// ────────────────────────────────────────────────────────
export const IDE_PANEL = Object.freeze({
  EXPLORER:   'explorer',
  SEARCH:     'search',
  GIT:        'git',
  EXTENSIONS: 'extensions',
  EDITOR:     'editor',
  TERMINAL:   'terminal',
  CHAT:       'chat',
  PROBLEMS:   'problems',
  OUTPUT:     'output',
  PREVIEW:    'preview',
  SETTINGS:   'settings',
});

// ────────────────────────────────────────────────────────
//  Panel definition objects
// ────────────────────────────────────────────────────────

/**
 * Complete set of IDE panel definitions. Each entry is
 * registered with `registerPanel()` during app bootstrap.
 *
 * @type {Array<import('../docking-wm/state/panel-registry').PanelDefinition>}
 */
export const IDE_PANEL_DEFINITIONS = [
  {
    panelType: IDE_PANEL.EXPLORER,
    displayName: 'Explorer',
    icon: 'files',
    category: 'sidebar',
    component: ExplorerPanelWrapper,
    allowMultiple: false,
    defaultLocation: 'left',
    closable: false,
  },
  {
    panelType: IDE_PANEL.SEARCH,
    displayName: 'Search',
    icon: 'search',
    category: 'sidebar',
    component: SearchPanelWrapper,
    allowMultiple: false,
    defaultLocation: 'left',
    closable: true,
  },
  {
    panelType: IDE_PANEL.GIT,
    displayName: 'Source Control',
    icon: 'git-branch',
    category: 'sidebar',
    component: GitPanelWrapper,
    allowMultiple: false,
    defaultLocation: 'left',
    closable: true,
  },
  {
    panelType: IDE_PANEL.EXTENSIONS,
    displayName: 'Extensions',
    icon: 'puzzle',
    category: 'sidebar',
    component: ExtensionsPanelWrapper,
    allowMultiple: false,
    defaultLocation: 'left',
    closable: true,
  },
  {
    panelType: IDE_PANEL.EDITOR,
    displayName: 'Editor',
    icon: 'file-code',
    category: 'editor',
    component: EditorPanelWrapper,
    allowMultiple: true,
    defaultLocation: 'center',
    closable: false,
  },
  {
    panelType: IDE_PANEL.TERMINAL,
    displayName: 'Terminal',
    icon: 'terminal',
    category: 'bottom',
    component: TerminalPanelWrapper,
    allowMultiple: true,
    defaultLocation: 'bottom',
    closable: true,
  },
  {
    panelType: IDE_PANEL.CHAT,
    displayName: 'AI Chat',
    icon: 'message-square',
    category: 'sidebar',
    component: ChatPanelWrapper,
    allowMultiple: false,
    defaultLocation: 'right',
    closable: true,
  },
  {
    panelType: IDE_PANEL.PROBLEMS,
    displayName: 'Problems',
    icon: 'alert-circle',
    category: 'bottom',
    component: ProblemsPanelWrapper,
    allowMultiple: false,
    defaultLocation: 'bottom',
    closable: true,
  },
  {
    panelType: IDE_PANEL.OUTPUT,
    displayName: 'Output',
    icon: 'list',
    category: 'bottom',
    component: OutputPanelWrapper,
    allowMultiple: false,
    defaultLocation: 'bottom',
    closable: true,
  },
  {
    panelType: IDE_PANEL.PREVIEW,
    displayName: 'Preview',
    icon: 'globe',
    category: 'editor',
    component: PreviewPanelWrapper,
    allowMultiple: false,
    defaultLocation: 'center',
    closable: true,
  },
];

/**
 * Map from panelType → definition for O(1) lookups.
 */
export const IDE_PANEL_MAP = Object.freeze(
  IDE_PANEL_DEFINITIONS.reduce((acc, def) => {
    acc[def.panelType] = def;
    return acc;
  }, {}),
);

/**
 * Register every IDE panel definition with the global panel registry.
 *
 * Call this once at app startup (e.g. inside `DockingProvider`).
 *
 * @param {function} register - `registerPanel` from panel-registry
 */
export function registerAllIDEPanels(register) {
  for (const def of IDE_PANEL_DEFINITIONS) {
    register(def);
  }
}
