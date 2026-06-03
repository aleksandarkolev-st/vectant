"use client";

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
  SettingsPanelWrapper,
  ThemeEditorPanelWrapper,
  PullRequestsPanelWrapper,
  CommitHistoryPanelWrapper,
  AIHealingPanelWrapper,
  IntegrationsPanelWrapper,
  ProgramsPanelWrapper,
  ProgramSessionPanelWrapper,
} from './panel-wrappers';
import { IDE_PANEL } from './panel-types';

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
    displayName: "Explorer",
    icon: "files",
    category: "sidebar",
    component: ExplorerPanelWrapper,
    allowMultiple: false,
    defaultLocation: "left",
    closable: false,
  },
  {
    panelType: IDE_PANEL.SEARCH,
    displayName: "Search",
    icon: "search",
    category: "sidebar",
    component: SearchPanelWrapper,
    allowMultiple: false,
    defaultLocation: "left",
    closable: true,
  },
  {
    panelType: IDE_PANEL.GIT,
    displayName: "Source Control",
    icon: "git-branch",
    category: "sidebar",
    component: GitPanelWrapper,
    allowMultiple: false,
    defaultLocation: "left",
    closable: true,
  },
  {
    panelType: IDE_PANEL.EXTENSIONS,
    displayName: "Extensions",
    icon: "puzzle",
    category: "sidebar",
    component: ExtensionsPanelWrapper,
    allowMultiple: false,
    defaultLocation: "left",
    closable: true,
  },
  {
    panelType: IDE_PANEL.PROGRAMS,
    displayName: 'Programs',
    icon: 'command',
    category: 'sidebar',
    component: ProgramsPanelWrapper,
    allowMultiple: false,
    defaultLocation: 'left',
    closable: true,
  },
  {
    panelType: IDE_PANEL.PROGRAM_SESSION,
    displayName: 'Program Session',
    icon: 'command',
    category: 'editor',
    component: ProgramSessionPanelWrapper,
    allowMultiple: true,
    defaultLocation: 'center',
    closable: true,
  },
  {
    panelType: IDE_PANEL.EXTENSION_VIEW,
    displayName: "Extension View",
    icon: "box",
    category: "sidebar",
    component: ExtensionsPanelWrapper,
    allowMultiple: true,
    defaultLocation: "left",
    closable: true,
  },
  {
    panelType: IDE_PANEL.EDITOR,
    // The editor panel is a meta-container for file tabs; its own
    // tab label is redundant — the file tab strip below already
    // tells the user what's open. Empty displayName hides the chrome.
    displayName: "",
    icon: "file-code",
    category: "editor",
    component: EditorPanelWrapper,
    allowMultiple: true,
    defaultLocation: "center",
    closable: false,
    draggable: false,
  },
  {
    panelType: IDE_PANEL.TERMINAL,
    displayName: "Terminal",
    icon: "terminal",
    category: "bottom",
    component: TerminalPanelWrapper,
    allowMultiple: true,
    defaultLocation: "bottom",
    closable: true,
  },
  {
    panelType: IDE_PANEL.CHAT,
    displayName: "AI Chat",
    icon: "message-square",
    category: "sidebar",
    component: ChatPanelWrapper,
    allowMultiple: false,
    defaultLocation: "right",
    closable: true,
  },
  {
    panelType: IDE_PANEL.PROBLEMS,
    displayName: "Problems",
    icon: "alert-circle",
    category: "bottom",
    component: ProblemsPanelWrapper,
    allowMultiple: false,
    defaultLocation: "bottom",
    closable: true,
  },
  {
    panelType: IDE_PANEL.OUTPUT,
    displayName: "Output",
    icon: "list",
    category: "bottom",
    component: OutputPanelWrapper,
    allowMultiple: false,
    defaultLocation: "bottom",
    closable: true,
  },
  {
    panelType: IDE_PANEL.PREVIEW,
    displayName: "Preview",
    icon: "globe",
    category: "editor",
    component: PreviewPanelWrapper,
    allowMultiple: false,
    defaultLocation: "center",
    closable: true,
  },
  {
    panelType: IDE_PANEL.SETTINGS,
    displayName: "Settings",
    icon: "settings",
    category: "sidebar",
    component: SettingsPanelWrapper,
    allowMultiple: false,
    defaultLocation: "left",
    closable: true,
  },
  {
    panelType: IDE_PANEL.THEME_EDITOR,
    displayName: "Theme Editor",
    icon: "palette",
    category: "sidebar",
    component: ThemeEditorPanelWrapper,
    allowMultiple: false,
    defaultLocation: "right",
    closable: true,
  },
  {
    panelType: IDE_PANEL.PULL_REQUESTS,
    displayName: 'Pull Requests',
    icon: 'git-pull-request',
    category: 'sidebar',
    component: PullRequestsPanelWrapper,
    allowMultiple: false,
    defaultLocation: 'left',
    closable: true,
  },
  {
    panelType: IDE_PANEL.COMMIT_HISTORY,
    displayName: 'Commit History',
    icon: 'git-commit',
    category: 'bottom',
    component: CommitHistoryPanelWrapper,
    allowMultiple: false,
    defaultLocation: 'bottom',
    closable: true,
  },
  {
    panelType: IDE_PANEL.AI_HEALING,
    displayName: 'AI Healing',
    icon: 'sparkles',
    category: 'sidebar',
    component: AIHealingPanelWrapper,
    allowMultiple: false,
    defaultLocation: 'left',
    closable: true,
  },
  {
    panelType: IDE_PANEL.INTEGRATIONS,
    displayName: 'Connected Tools',
    icon: 'plug',
    category: 'sidebar',
    component: IntegrationsPanelWrapper,
    allowMultiple: false,
    defaultLocation: 'left',
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
