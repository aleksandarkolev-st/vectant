// src/redux/extensionSlice.js
import { createSlice, createAsyncThunk, createSelector } from '@reduxjs/toolkit';

/**
 * Extension Redux Slice
 * Authoritative state for the extension system on the main thread.
 * Tracks installed extensions, their lifecycle state, registered commands,
 * diagnostics, errors, and the host worker readiness.
 */

export const initialExtensionState = {
  /** Worker host readiness: 'idle' | 'initializing' | 'ready' | 'error' | 'dead' */
  hostStatus: 'idle',
  hostError: null,

  /**
   * Map of extensionId → extension info object:
   * {
   *   id, name, displayName, version, publisher, description,
   *   state: 'installed'|'loaded'|'activating'|'active'|'disabled'|'quarantined'|'crashed',
   *   manifest, code (not persisted to Redux - stored in IndexedDB),
   *   crashCount, activationCount, lastActiveTime,
   *   quarantineReason, failedReason,
   *   icon
   * }
   */
  extensions: {},

  /** Set of registered command IDs (from all extensions) */
  commands: [],

  /**
   * Contribution points aggregated from all installed extensions.
   * Parsed from each extension's manifest.contributes on registration.
   */
  contributions: {
    /** Activity bar view containers from contributes.viewsContainers.activitybar
     *  [{ id, title, icon, extensionId }] */
    containers: [],
    /** Views from contributes.views: { containerId: [{ id, name, type, extensionId }] } */
    views: {},
    /** Active webview panels created at runtime by extensions
     *  [{ viewId, viewType, title, extensionId }] */
    webviewPanels: [],
    /** Status bar items set by extensions [{ text, extensionId, priority }] */
    statusBarItems: [],
    /** Welcome content from contributes.viewsWelcome, keyed by view id
     *  { viewId: [{ contents, when, group, extensionId }] } */
    viewsWelcome: {},
  },

  /** Extension context values from setContext, keyed by context key name.
   *  Used for when-clause evaluation in view/welcome filtering. */
  contextValues: {},

  /** Recent errors: [{ extensionId, title, message, severity, suggestion, timestamp }] */
  errors: [],

  /** Whether the extension panel sidebar is visible */
  panelVisible: false,
};

const extensionSlice = createSlice({
  name: 'extensions',
  initialState: initialExtensionState,
  reducers: {
    // ─── Host lifecycle ────────────────────────────────────
    setHostStatus(state, action) {
      state.hostStatus = action.payload;
      if (action.payload === 'ready') state.hostError = null;
    },
    setHostError(state, action) {
      state.hostStatus = 'error';
      state.hostError = action.payload;
    },

    // ─── Extension CRUD ────────────────────────────────────
    /** Register a new extension (after manifest validated + code loaded) */
    registerExtension(state, action) {
      const ext = action.payload;
      state.extensions[ext.id] = {
        id: ext.id,
        name: ext.manifest?.name || ext.id,
        displayName: ext.manifest?.displayName || ext.manifest?.name || ext.id,
        version: ext.manifest?.version || '0.0.0',
        publisher: ext.manifest?.publisher || 'unknown',
        description: ext.manifest?.description || '',
        state: 'installed',
        manifest: ext.manifest,
        crashCount: 0,
        activationCount: 0,
        lastActiveTime: null,
        quarantineReason: null,
        failedReason: null,
        icon: ext.manifest?.icon || null,
      };
    },

    // ─── Contribution points ───────────────────────────
    /**
     * Parse and store contribution points from an extension's manifest.
     * Called after registerExtension when manifest.contributes exists.
     */
    parseContributions(state, action) {
      const { extensionId, contributes } = action.payload;
      if (!contributes) return;

      // Helper: resolve icon — if it's already an HTTP/data URL use it,
      // otherwise fall back to the extension's top-level icon (which is
      // set to the Open VSX files.icon URL during marketplace install).
      const ext = state.extensions[extensionId];
      const fallbackIcon = ext?.icon || null;
      const resolveIcon = (raw) => {
        if (!raw) return fallbackIcon;
        if (typeof raw === 'string' && (raw.startsWith('http') || raw.startsWith('data:'))) return raw;
        return fallbackIcon; // relative path can't be resolved — use extension icon
      };

      // viewsContainers.activitybar → sidebar icons
      const activitybar = contributes.viewsContainers?.activitybar;
      if (Array.isArray(activitybar)) {
        for (const c of activitybar) {
          if (!state.contributions.containers.find(x => x.id === c.id)) {
            state.contributions.containers.push({
              id: c.id,
              title: c.title || c.id,
              icon: resolveIcon(c.icon),
              extensionId,
            });
          }
        }
      }

      // viewsContainers.panel → bottom panel containers
      const panel = contributes.viewsContainers?.panel;
      if (Array.isArray(panel)) {
        for (const c of panel) {
          if (!state.contributions.containers.find(x => x.id === c.id)) {
            state.contributions.containers.push({
              id: c.id,
              title: c.title || c.id,
              icon: resolveIcon(c.icon),
              extensionId,
              location: 'panel',
            });
          }
        }
      }

      // views → tree views / webview views inside containers
      if (contributes.views && typeof contributes.views === 'object') {
        for (const [containerId, viewList] of Object.entries(contributes.views)) {
          if (!Array.isArray(viewList)) continue;
          if (!state.contributions.views[containerId]) {
            state.contributions.views[containerId] = [];
          }
          for (const v of viewList) {
            if (!state.contributions.views[containerId].find(x => x.id === v.id)) {
              state.contributions.views[containerId].push({
                id: v.id,
                name: v.name || v.id,
                type: v.type || 'tree',
                when: v.when || null,
                extensionId,
              });
            }
          }
        }
      }

      // viewsWelcome → welcome content shown in views when empty
      if (Array.isArray(contributes.viewsWelcome)) {
        for (const entry of contributes.viewsWelcome) {
          if (!entry.view || !entry.contents) continue;
          // NLS resolution may produce l10n objects {message, comment} — extract the string
          let contents = entry.contents;
          if (typeof contents === 'object' && contents !== null && typeof contents.message === 'string') {
            contents = contents.message;
          }
          if (typeof contents !== 'string') continue; // skip non-string entries
          if (!state.contributions.viewsWelcome[entry.view]) {
            state.contributions.viewsWelcome[entry.view] = [];
          }
          state.contributions.viewsWelcome[entry.view].push({
            contents,
            when: entry.when || null,
            group: entry.group || null,
            extensionId,
          });
        }
      }
    },

    /** Add a runtime webview panel (from worker createWebviewPanel call) */
    addWebviewPanel(state, action) {
      const { viewId, viewType, title, extensionId } = action.payload;
      if (!state.contributions.webviewPanels.find(p => p.viewId === viewId)) {
        state.contributions.webviewPanels.push({ viewId, viewType, title, extensionId });
      }
    },

    /** Remove a runtime webview panel */
    removeWebviewPanel(state, action) {
      state.contributions.webviewPanels = state.contributions.webviewPanels.filter(
        p => p.viewId !== action.payload
      );
    },

    /** Set a status bar item from an extension */
    setStatusBarItem(state, action) {
      const { extensionId, text, priority } = action.payload;
      const existing = state.contributions.statusBarItems.find(s => s.extensionId === extensionId);
      if (existing) {
        existing.text = text;
      } else {
        state.contributions.statusBarItems.push({ extensionId, text, priority: priority || 0 });
      }
    },

    /** Remove all contributions from a specific extension */
    removeContributions(state, action) {
      const extId = action.payload;
      state.contributions.containers = state.contributions.containers.filter(c => c.extensionId !== extId);
      for (const containerId of Object.keys(state.contributions.views)) {
        state.contributions.views[containerId] = state.contributions.views[containerId].filter(v => v.extensionId !== extId);
        if (state.contributions.views[containerId].length === 0) {
          delete state.contributions.views[containerId];
        }
      }
      state.contributions.webviewPanels = state.contributions.webviewPanels.filter(p => p.extensionId !== extId);
      state.contributions.statusBarItems = state.contributions.statusBarItems.filter(s => s.extensionId !== extId);
    },

    /** Update the lifecycle state of an extension */
    setExtensionState(state, action) {
      const { id, extensionState, reason, remote } = action.payload;
      const ext = state.extensions[id];
      if (!ext) return;
      ext.state = extensionState;
      if (remote !== undefined) ext.remote = remote;
      if (extensionState === 'active') {
        ext.activationCount = (ext.activationCount || 0) + 1;
        ext.lastActiveTime = Date.now();
        ext.failedReason = null;
      }
      if (extensionState === 'quarantined') {
        ext.quarantineReason = reason || 'Unknown';
      }
      if (extensionState === 'crashed') {
        ext.crashCount = (ext.crashCount || 0) + 1;
        ext.failedReason = reason || 'Crashed';
      }
      if (extensionState === 'disabled') {
        ext.failedReason = null;
      }
    },

    /** Remove an extension entirely */
    removeExtension(state, action) {
      const id = action.payload;
      delete state.extensions[id];
      // Clean up all contributions from this extension
      state.contributions.containers = state.contributions.containers.filter(c => c.extensionId !== id);
      for (const containerId of Object.keys(state.contributions.views)) {
        state.contributions.views[containerId] = state.contributions.views[containerId].filter(v => v.extensionId !== id);
        if (state.contributions.views[containerId].length === 0) delete state.contributions.views[containerId];
      }
      state.contributions.webviewPanels = state.contributions.webviewPanels.filter(p => p.extensionId !== id);
      state.contributions.statusBarItems = state.contributions.statusBarItems.filter(s => s.extensionId !== id);
    },

    // ─── Commands ──────────────────────────────────────────
    addCommand(state, action) {
      const cmdId = action.payload;
      if (!state.commands.includes(cmdId)) {
        state.commands.push(cmdId);
      }
    },
    removeCommand(state, action) {
      state.commands = state.commands.filter(c => c !== action.payload);
    },
    setCommands(state, action) {
      state.commands = action.payload;
    },

    // ─── Errors ────────────────────────────────────────────
    pushError(state, action) {
      state.errors.unshift({
        ...action.payload,
        timestamp: action.payload.timestamp || Date.now(),
      });
      // Keep max 50 errors
      if (state.errors.length > 50) state.errors = state.errors.slice(0, 50);
    },
    dismissError(state, action) {
      const idx = action.payload;
      if (typeof idx === 'number') {
        state.errors.splice(idx, 1);
      }
    },
    clearErrors(state) {
      state.errors = [];
    },

    // ─── Panel visibility ──────────────────────────────────
    setPanelVisible(state, action) {
      state.panelVisible = action.payload;
    },
    togglePanel(state) {
      state.panelVisible = !state.panelVisible;
    },

    // ─── Bulk state sync (from bridge/manager) ─────────────
    /** Sync all extension states from the bridge at once */
    syncExtensionStates(state, action) {
      const stateUpdates = action.payload; // [{ id, state, crashCount, ... }]
      for (const update of stateUpdates) {
        const ext = state.extensions[update.id];
        if (!ext) continue;
        if (update.state) ext.state = update.state;
        if (update.crashCount != null) ext.crashCount = update.crashCount;
        if (update.activationCount != null) ext.activationCount = update.activationCount;
        if (update.lastActiveTime != null) ext.lastActiveTime = update.lastActiveTime;
        if (update.failedReason != null) ext.failedReason = update.failedReason;
        if (update.quarantineReason != null) ext.quarantineReason = update.quarantineReason;
      }
    },

    /** Update a single extension context value (from setContext RPC) */
    setContextValue(state, action) {
      const { key, value } = action.payload;
      if (key) state.contextValues[key] = value;
    },
  },
});

export const {
  setHostStatus,
  setHostError,
  registerExtension,
  parseContributions,
  addWebviewPanel,
  removeWebviewPanel,
  setStatusBarItem,
  removeContributions,
  setExtensionState,
  removeExtension,
  addCommand,
  removeCommand,
  setCommands,
  pushError,
  dismissError,
  clearErrors,
  setPanelVisible,
  togglePanel,
  syncExtensionStates,
  setContextValue,
} = extensionSlice.actions;

// ─── Selectors ───────────────────────────────────────────────
export const selectHostStatus = (state) => state.extensions.hostStatus;
export const selectHostError = (state) => state.extensions.hostError;
export const selectExtensions = (state) => state.extensions.extensions;
export const selectExtensionList = createSelector(
  [selectExtensions],
  (extensions) => Object.values(extensions)
);
export const selectExtension = (id) => (state) => state.extensions.extensions[id];
export const selectCommands = (state) => state.extensions.commands;
export const selectExtensionErrors = (state) => state.extensions.errors;
export const selectPanelVisible = (state) => state.extensions.panelVisible;
export const selectContributions = (state) => state.extensions.contributions;
export const selectContributedContainers = (state) => state.extensions.contributions.containers;
export const selectContributedViews = (state) => state.extensions.contributions.views;
export const selectWebviewPanels = (state) => state.extensions.contributions.webviewPanels;
export const selectStatusBarItems = (state) => state.extensions.contributions.statusBarItems;
export const selectViewsWelcome = (state) => state.extensions.contributions.viewsWelcome;
export const selectContextValues = (state) => state.extensions.contextValues;
export const selectActiveExtensionCount = (state) =>
  Object.values(state.extensions.extensions).filter(e => e.state === 'active').length;
export const selectIssueExtensionCount = (state) =>
  Object.values(state.extensions.extensions).filter(
    e => e.state === 'crashed' || e.state === 'quarantined'
  ).length;

export default extensionSlice.reducer;
