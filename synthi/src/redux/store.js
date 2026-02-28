// src/redux/store.js
import { configureStore } from '@reduxjs/toolkit';
import workspaceReducer, { initialWorkspaceState } from './workspaceSlice';
import uiReducer, { initialUiState } from './uiSlice';
import gitReducer from './gitSlice';
import extensionReducer from './extensionSlice';
import themeReducer from './themeSlice';
import layoutReducer from '@/components/docking-wm/state/layout-slice';
import healingReducer, { initialHealingState } from './healingSlice';
import prReducer from './prSlice';

import { enableMapSet } from 'immer';

enableMapSet();

// Persist a small subset of UI preferences to localStorage so they survive
// page reloads. We guard access to `localStorage` for SSR (Next.js server
// environment).
const UI_STORAGE_KEY = 'synthi:ui';
const EXPANDED_FOLDERS_KEY = 'synthi:expandedFolders';
const THEME_STORAGE_KEY = 'synthi:theme';
const HEALING_STORAGE_KEY = 'synthi:healing';

// Workspace-specific storage key helpers
const getOpenTabsKey = (slug) => `synthi:openTabs:${slug}`;
const getActiveTabKey = (slug) => `synthi:activeTab:${slug}`;

export function loadUiPrefs() {
  if (typeof window === 'undefined' || !window.localStorage) return undefined;
  try {
    const raw = localStorage.getItem(UI_STORAGE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw);
    // The emulator panel should be default-closed on refresh and not persisted.
    // The emulator preview panel must be hidden by default and only opened
    // when the user clicks Run and a mobile build is detected.
    if (parsed && typeof parsed === 'object') {
      delete parsed.showEmulatorPreview;
    }
    return parsed;
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

export function loadThemePrefs() {
  if (typeof window === 'undefined' || !window.localStorage) return undefined;
  try {
    const raw = localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return undefined;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('Failed to load theme prefs from localStorage', e);
    return undefined;
  }
}

export function loadHealingPrefs() {
  if (typeof window === 'undefined' || !window.localStorage) return undefined;
  try {
    const raw = localStorage.getItem(HEALING_STORAGE_KEY);
    if (!raw) return undefined;
    return JSON.parse(raw);
  } catch (e) {
    console.warn('Failed to load healing prefs from localStorage', e);
    return undefined;
  }
}

export function loadOpenTabs(slug) {
  if (typeof window === 'undefined' || !window.localStorage) return undefined;
  if (!slug) return undefined;
  try {
    const raw = localStorage.getItem(getOpenTabsKey(slug));
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

export function loadActiveTab(slug) {
  if (typeof window === 'undefined' || !window.localStorage) return undefined;
  if (!slug) return undefined;
  try {
    const raw = localStorage.getItem(getActiveTabKey(slug));
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

function saveOpenTabs(slug, openFiles) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  if (!slug) return; // Don't save tabs without a workspace slug
  try {
    // Persist minimal info to restore tabs: path, name, language, isUnsaved
    const toSave = (openFiles || []).map(f => ({ path: f.path, name: f.name, language: f.language, isUnsaved: !!f.isUnsaved }));
    localStorage.setItem(getOpenTabsKey(slug), JSON.stringify(toSave));
  } catch (e) {
    console.warn('Failed to save open tabs to localStorage', e);
  }
}

function saveActiveTab(slug, activeFile) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  if (!slug) return; // Don't save active tab without a workspace slug
  try {
    const key = getActiveTabKey(slug);
    const toSave = activeFile && activeFile.path ? { path: activeFile.path, name: activeFile.name, language: activeFile.language } : null;
    if (toSave) localStorage.setItem(key, JSON.stringify(toSave)); else localStorage.removeItem(key);
  } catch (e) {
    console.warn('Failed to save active tab to localStorage', e);
  }
}

function saveHealingPrefs(healingState) {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    const toSave = {
      enabled: !!healingState.enabled,
      config: healingState.config || {},
    };
    localStorage.setItem(HEALING_STORAGE_KEY, JSON.stringify(toSave));
  } catch (e) {
    console.warn('Failed to save healing prefs to localStorage', e);
  }
}

export const store = configureStore({
  reducer: {
    workspace: workspaceReducer,
    ui: uiReducer,
    git: gitReducer,
    extensions: extensionReducer,
    theme: themeReducer,
    layout: layoutReducer,
    healing: healingReducer,
    pr: prReducer,
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
  
  // Track workspace-specific tab state per slug
  let lastSlug = null;
  let lastOpenTabs = '';
  let lastActiveTabPath = null;

  // Track theme for persistence
  let lastThemeId = '';
  let lastUserThemes = '{}';
  let lastUserOverrides = '{}';

  // Track healing preferences for persistence
  let lastHealingSnapshot = '';

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

      // Persist active theme ID + user themes + overrides
      try {
        const themeId = state?.theme?.activeThemeId || '';
        const userThemes = state?.theme?.userThemes || {};
        const userOverrides = state?.theme?.userOverrides || {};
        const userThemesSnapshot = JSON.stringify(userThemes);
        const userOverridesSnapshot = JSON.stringify(userOverrides);
        // Write when anything has changed
        if (
          (themeId && themeId !== lastThemeId) ||
          userThemesSnapshot !== (lastUserThemes || '{}') ||
          userOverridesSnapshot !== (lastUserOverrides || '{}')
        ) {
          lastThemeId = themeId;
          lastUserThemes = userThemesSnapshot;
          lastUserOverrides = userOverridesSnapshot;
          localStorage.setItem(THEME_STORAGE_KEY, JSON.stringify({
            activeThemeId: themeId,
            userThemes,
            userOverrides,
          }));
        }
      } catch (_) {}
      
      // Workspace-specific tab persistence
      const currentSlug = state?.workspace?.slug || null;
      
      // When slug changes, reset our tracking state for the new workspace
      if (currentSlug !== lastSlug) {
        lastSlug = currentSlug;
        // Reset tracking for the new workspace
        lastOpenTabs = '';
        lastActiveTabPath = null;
      }
      
      // Only persist tabs if we have a valid workspace slug
      if (currentSlug) {
        // Persist open tabs when changed (store minimal snapshot)
        try {
          const openFiles = state?.workspace?.openFiles || [];
          const openSnapshot = openFiles.map(f => f.path).join('|');
          if (openSnapshot !== lastOpenTabs) {
            lastOpenTabs = openSnapshot;
            saveOpenTabs(currentSlug, openFiles);
          }
        } catch (_) {}
        // Persist active tab when it changes
        try {
          const active = state?.workspace?.activeFile || null;
          const activePath = active && active.path ? active.path : null;
          if (activePath !== (lastActiveTabPath || null)) {
            lastActiveTabPath = activePath;
            saveActiveTab(currentSlug, active);
          }
        } catch (_) {}
      }

      // Persist healing preferences when changed
      try {
        const healing = state?.healing;
        if (healing) {
          const healSnapshot = `${healing.enabled}|${healing.config?.minConfidence}|${(healing.config?.autoHealCategories || []).join(',')}`;
          if (healSnapshot !== lastHealingSnapshot) {
            lastHealingSnapshot = healSnapshot;
            saveHealingPrefs(healing);
          }
        }
      } catch (_) {}
    } catch (e) {
      // ignore subscription errors
    }
  });
}
