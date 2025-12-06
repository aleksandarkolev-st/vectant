// src/redux/store.js
import { configureStore } from '@reduxjs/toolkit';
import workspaceReducer, { initialWorkspaceState } from './workspaceSlice';
import uiReducer, { initialUiState } from './uiSlice';
import gitReducer from './gitSlice';

import { enableMapSet } from 'immer';

enableMapSet();

// Persist a small subset of UI preferences to localStorage so they survive
// page reloads. We guard access to `localStorage` for SSR (Next.js server
// environment).
const UI_STORAGE_KEY = 'synthi:ui';
const OPEN_TABS_KEY = 'synthi:openTabs';
const ACTIVE_TAB_KEY = 'synthi:activeTab';
const EXPANDED_FOLDERS_KEY = 'synthi:expandedFolders';

export function loadUiPrefs() {
  if (typeof window === 'undefined' || !window.localStorage) return undefined;
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY);
    if (!raw) return undefined;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('Failed to load UI prefs from localStorage', e);
    return undefined;
  }
}

export function loadExpandedFolders() {
  if (typeof window === 'undefined' || !window.localStorage) return undefined;
  try {
    const raw = localStorage.getItem(EXPANDED_FOLDERS_KEY);
    if (!raw) return undefined;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('Failed to load expanded folders from localStorage', e);
    return undefined;
  }
}

export function loadOpenTabs() {
  if (typeof window === 'undefined' || !window.localStorage) return undefined;
  try {
    const raw = localStorage.getItem(OPEN_TABS_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    // Expect array of { path, name, language }
    // Ensure boolean isUnsaved default
    return parsed.map(p => ({ path: p.path, name: p.name, language: p.language, isUnsaved: !!p.isUnsaved }));
  } catch (e) {
    console.warn('Failed to load open tabs from localStorage', e);
    return undefined;
  }
}

export function loadActiveTab() {
  if (typeof window === 'undefined' || !window.localStorage) return undefined;
  try {
    const raw = localStorage.getItem(ACTIVE_TAB_KEY);
    if (!raw) return undefined;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('Failed to load active tab from localStorage', e);
    return undefined;
  }
}

function saveUiPrefs(uiState) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    // Only persist a small set of primitive preferences
    const toSave = {
      autoCompletionEnabled: !!uiState.autoCompletionEnabled,
      autoSaveEnabled: !!uiState.autoSaveEnabled,
      treeOnRight: !!uiState.treeOnRight,
      showTerminal: !!uiState.showTerminal,
    };
    localStorage.setItem(UI_STORAGE_KEY, JSON.stringify(toSave));
  } catch (e) {
    console.warn('Failed to save UI prefs to localStorage', e);
  }
}

function saveExpandedFolders(expandedFolders) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    localStorage.setItem(EXPANDED_FOLDERS_KEY, JSON.stringify(expandedFolders));
  } catch (e) {
    console.warn('Failed to save expanded folders to localStorage', e);
  }
}

function saveOpenTabs(openFiles) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    // Persist minimal info to restore tabs: path, name, language, isUnsaved
    const toSave = (openFiles || []).map(f => ({ path: f.path, name: f.name, language: f.language, isUnsaved: !!f.isUnsaved }));
    localStorage.setItem(OPEN_TABS_KEY, JSON.stringify(toSave));
  } catch (e) {
    console.warn('Failed to save open tabs to localStorage', e);
  }
}

function saveActiveTab(activeFile) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const toSave = activeFile && activeFile.path ? { path: activeFile.path, name: activeFile.name, language: activeFile.language } : null;
    if (toSave) localStorage.setItem(ACTIVE_TAB_KEY, JSON.stringify(toSave)); else localStorage.removeItem(ACTIVE_TAB_KEY);
  } catch (e) {
    console.warn('Failed to save active tab to localStorage', e);
  }
}

export const store = configureStore({
  reducer: {
    workspace: workspaceReducer,
    ui: uiReducer,
    git: gitReducer,
  },
  // We need to disable the serializable check for the Map used in fileContentCache
  middleware: (getDefaultMiddleware) =>
    getDefaultMiddleware({
      serializableCheck: {
        ignoredActions: ['workspace/selectFile/fulfilled', 'workspace/selectFile/pending'],
        ignoredPaths: ['workspace.fileContentCache'],
      },
    }),
});

// Subscribe to store updates and persist UI preferences when they change.
// We keep this lightweight and defensive for SSR.
if (typeof window !== 'undefined') {
  // Initialize with default state values to prevent overwriting localStorage on startup
  // before hydration has occurred.
  const ui = initialUiState;
  let lastUi = `${ui.autoCompletionEnabled}|${ui.autoSaveEnabled}|${ui.treeOnRight}|${ui.showTerminal}`;
  
  let lastExpandedFolders = (ui.expandedFolders || []).join('|');
  
  const ws = initialWorkspaceState;
  let lastOpenTabs = (ws.openFiles || []).map(f => f.path).join('|');
  
  let lastActiveTabPath = ws.activeFile && ws.activeFile.path ? ws.activeFile.path : null;

  store.subscribe(() => {
    try {
      const state = store.getState();
      const ui = state?.ui || {};
      // Simple shallow compare to avoid excessive writes
      const snapshot = `${ui.autoCompletionEnabled}|${ui.autoSaveEnabled}|${ui.treeOnRight}|${ui.showTerminal}`;
      if (snapshot !== lastUi) {
        lastUi = snapshot;
        saveUiPrefs(ui);
      }
      // Persist expanded folders
      try {
        const expanded = ui.expandedFolders || [];
        const expandedSnapshot = expanded.join('|');
        if (expandedSnapshot !== lastExpandedFolders) {
          lastExpandedFolders = expandedSnapshot;
          saveExpandedFolders(expanded);
        }
      } catch (_) {}
      // Persist open tabs when changed (store minimal snapshot)
      try {
        const openFiles = state?.workspace?.openFiles || [];
        const openSnapshot = openFiles.map(f => f.path).join('|');
        if (openSnapshot !== lastOpenTabs) {
          lastOpenTabs = openSnapshot;
          saveOpenTabs(openFiles);
        }
      } catch (_) {}
      // Persist active tab when it changes
      try {
        const active = state?.workspace?.activeFile || null;
        const activePath = active && active.path ? active.path : null;
        if (activePath !== (lastActiveTabPath || null)) {
          lastActiveTabPath = activePath;
          saveActiveTab(active);
        }
      } catch (_) {}
    } catch (e) {
      // ignore subscription errors
    }
  });
}
