// src/redux/store.js
import { configureStore } from '@reduxjs/toolkit';
import workspaceReducer, { initialWorkspaceState } from './workspaceSlice';
import uiReducer, { initialUiState } from './uiSlice';

import { enableMapSet } from 'immer';

enableMapSet();

// Persist a small subset of UI preferences to localStorage so they survive
// page reloads. We guard access to `localStorage` for SSR (Next.js server
// environment).
const UI_STORAGE_KEY = 'synthi:ui';
const OPEN_TABS_KEY = 'synthi:openTabs';
const ACTIVE_TAB_KEY = 'synthi:activeTab';

function loadUiPrefs() {
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

function loadOpenTabs() {
  if (typeof window === 'undefined' || !window.localStorage) return undefined;
  try {
    const raw = localStorage.getItem(OPEN_TABS_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    // Expect array of { path, name, language }
    return parsed;
  } catch (e) {
    console.warn('Failed to load open tabs from localStorage', e);
    return undefined;
  }
}

function loadActiveTab() {
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

function saveOpenTabs(openFiles) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    // Persist minimal info to restore tabs: path, name, language
    const toSave = (openFiles || []).map(f => ({ path: f.path, name: f.name, language: f.language }));
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

const preloadedUi = loadUiPrefs();
const preloadedOpenTabs = loadOpenTabs();
const preloadedActive = loadActiveTab();

// Merge persisted UI prefs into the slice's initial state so we don't
// accidentally overwrite properties (like `uiActionState`) that the
// slice expects to always exist. Also restore any previously open tabs.
const preloadedState = (() => {
  const state = {};
  if (preloadedUi) state.ui = { ...initialUiState, ...preloadedUi };
  if (preloadedOpenTabs) {
    // Merge openTabs into the workspace initial state to ensure other keys remain.
    state.workspace = { ...initialWorkspaceState, openFiles: preloadedOpenTabs };
    // If there was an active tab saved, try to set activeFile to the matching entry
    if (preloadedActive && preloadedActive.path) {
      const match = (preloadedOpenTabs || []).find(f => f.path === preloadedActive.path);
      if (match) state.workspace.activeFile = match; else state.workspace.activeFile = preloadedActive;
    }
  } else if (preloadedActive && preloadedActive.path) {
    // No open tabs list, but active tab stored — set activeFile minimally so UI can trigger load
    state.workspace = { ...initialWorkspaceState, activeFile: preloadedActive };
  }
  return Object.keys(state).length > 0 ? state : undefined;
})();

export const store = configureStore({
  reducer: {
    workspace: workspaceReducer,
    ui: uiReducer,
  },
  preloadedState,
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
  let lastUi = null;
  let lastOpenTabs = null;
  let lastActiveTabPath = null;
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
