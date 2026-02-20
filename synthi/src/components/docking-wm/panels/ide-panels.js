'use client';

/**
 * @fileoverview IDE panel definitions for the docking window manager.
 *
 * Each definition tells the docking system everything it needs to
 * lazily render, serialise and restore a specific IDE panel.
 *
 * Panel components are loaded via `next/dynamic` to keep the initial
 * bundle lean — only the panels actually visible will be code-split in.
 */

import dynamic from 'next/dynamic';

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
//  Lazy component loaders
// ────────────────────────────────────────────────────────
const PanelPlaceholder = () => (
  <div className="flex h-full w-full items-center justify-center text-xs text-zinc-500">
    Loading…
  </div>
);

const LazyFileTree = dynamic(
  () => import('@/app/workspace/[slug]/FileTree'),
  { ssr: false, loading: PanelPlaceholder },
);
const LazySearchView = dynamic(
  () => import('@/app/workspace/[slug]/SearchView'),
  { ssr: false, loading: PanelPlaceholder },
);
const LazyGitSummary = dynamic(
  () => import('@/components/git/GitSummaryPanel').then(m => m),
  { ssr: false, loading: PanelPlaceholder },
);
const LazyExtensionSidebar = dynamic(
  () => import('@/components/extensions/ExtensionSidebar'),
  { ssr: false, loading: PanelPlaceholder },
);
const LazyEditor = dynamic(
  () => import('@/app/workspace/[slug]/Editor/Editor'),
  { ssr: false, loading: PanelPlaceholder },
);
const LazyProblemsPanel = dynamic(
  () => import('@/components/analysis').then(m => ({ default: m.ProblemsPanel })),
  { ssr: false, loading: PanelPlaceholder },
);
const LazyAIChat = dynamic(
  () => import('@/components/chat/AIChatWindow'),
  { ssr: false, loading: PanelPlaceholder },
);

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
    component: LazyFileTree,
    allowMultiple: false,
    defaultLocation: 'left',
    closable: false,
  },
  {
    panelType: IDE_PANEL.SEARCH,
    displayName: 'Search',
    icon: 'search',
    category: 'sidebar',
    component: LazySearchView,
    allowMultiple: false,
    defaultLocation: 'left',
    closable: true,
  },
  {
    panelType: IDE_PANEL.GIT,
    displayName: 'Source Control',
    icon: 'git-branch',
    category: 'sidebar',
    component: LazyGitSummary,
    allowMultiple: false,
    defaultLocation: 'left',
    closable: true,
  },
  {
    panelType: IDE_PANEL.EXTENSIONS,
    displayName: 'Extensions',
    icon: 'puzzle',
    category: 'sidebar',
    component: LazyExtensionSidebar,
    allowMultiple: false,
    defaultLocation: 'left',
    closable: true,
  },
  {
    panelType: IDE_PANEL.EDITOR,
    displayName: 'Editor',
    icon: 'file-code',
    category: 'editor',
    component: LazyEditor,
    allowMultiple: true,
    defaultLocation: 'center',
    closable: true,
  },
  {
    panelType: IDE_PANEL.TERMINAL,
    displayName: 'Terminal',
    icon: 'terminal',
    category: 'bottom',
    component: null, // Terminal uses XTerm directly; rendered by panel wrapper
    allowMultiple: true,
    defaultLocation: 'bottom',
    closable: true,
  },
  {
    panelType: IDE_PANEL.CHAT,
    displayName: 'AI Chat',
    icon: 'message-square',
    category: 'sidebar',
    component: LazyAIChat,
    allowMultiple: false,
    defaultLocation: 'right',
    closable: true,
  },
  {
    panelType: IDE_PANEL.PROBLEMS,
    displayName: 'Problems',
    icon: 'alert-circle',
    category: 'bottom',
    component: LazyProblemsPanel,
    allowMultiple: false,
    defaultLocation: 'bottom',
    closable: true,
  },
  {
    panelType: IDE_PANEL.OUTPUT,
    displayName: 'Output',
    icon: 'list',
    category: 'bottom',
    component: null, // Will be wired separately
    allowMultiple: false,
    defaultLocation: 'bottom',
    closable: true,
  },
  {
    panelType: IDE_PANEL.PREVIEW,
    displayName: 'Preview',
    icon: 'globe',
    category: 'editor',
    component: null, // Will render emulator / web preview
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
