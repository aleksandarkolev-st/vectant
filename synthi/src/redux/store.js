// src/redux/store.js
import { configureStore } from '@reduxjs/toolkit';
import workspaceReducer from './workspaceSlice';
import uiReducer, { initialUiState } from './uiSlice';

import { enableMapSet } from 'immer';

enableMapSet();

// Persist a small subset of UI preferences to localStorage so they survive
// page reloads. We guard access to `localStorage` for SSR (Next.js server
// environment).
const UI_STORAGE_KEY = 'synthi:ui';

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

const preloadedUi = loadUiPrefs();

// Merge persisted UI prefs into the slice's initial state so we don't
// accidentally overwrite properties (like `uiActionState`) that the
// slice expects to always exist.
const preloadedState = preloadedUi ? { ui: { ...initialUiState, ...preloadedUi } } : undefined;

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
    } catch (e) {
      // ignore subscription errors
    }
  });
}
