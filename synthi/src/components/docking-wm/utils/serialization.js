/**
 * @fileoverview Layout serialization, deserialization, and migration.
 * Handles persisting layout state to JSON and loading it back with
 * schema version migration support.
 */

import { LAYOUT_VERSION } from '../types';
import { validateLayout } from './layout-query';
import { createEmptyLayout } from './layout-node';

/**
 * Serialize layout state to a JSON-safe object.
 * Strips any runtime-only fields.
 *
 * @param {import('../types').LayoutState} state
 * @returns {object} - plain JSON-safe object
 */
export function serializeLayout(state) {
  return {
    version: state.version || LAYOUT_VERSION,
    rootId: state.rootId,
    nodes: state.nodes,
    tabs: state.tabs,
    floating: state.floating,
    popouts: {}, // Don't persist popouts (windows closed on reload)
    maximizedNodeId: null, // Don't persist maximized state
    focusedTabGroupId: state.focusedTabGroupId,
    // Omit dragSourceTabId (runtime only)
  };
}

/**
 * Serialize layout state to a JSON string.
 * @param {import('../types').LayoutState} state
 * @returns {string}
 */
export function serializeLayoutToJSON(state) {
  return JSON.stringify(serializeLayout(state));
}

/**
 * Deserialize layout state from a JSON string.
 * Returns null if parsing or validation fails.
 *
 * @param {string} json
 * @returns {import('../types').LayoutState|null}
 */
export function deserializeLayout(json) {
  try {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    return restoreLayout(parsed);
  } catch (err) {
    console.warn('[docking-wm] Failed to deserialize layout:', err);
    return null;
  }
}

/**
 * Restore and validate a parsed layout object.
 * Applies migrations if the version is older.
 *
 * @param {object} raw
 * @returns {import('../types').LayoutState|null}
 */
export function restoreLayout(raw) {
  if (!raw || typeof raw !== 'object') return null;

  // Apply migrations
  let state = raw;
  if (state.version !== LAYOUT_VERSION) {
    state = migrateLayout(state);
  }

  // Restore runtime fields
  state = {
    ...state,
    popouts: state.popouts || {},
    floating: state.floating || {},
    maximizedNodeId: null,
    dragSourceTabId: null,
  };

  // Validate
  const { valid, errors } = validateLayout(state);
  if (!valid) {
    console.warn('[docking-wm] Layout validation failed:', errors);
    return null;
  }

  return state;
}

/**
 * Migrate a layout from an older version to the current version.
 * Add migration steps here as the schema evolves.
 *
 * @param {object} state
 * @returns {object}
 */
function migrateLayout(state) {
  let result = { ...state };
  const fromVersion = result.version || 0;

  // Migration steps: add cases as version increments
  if (fromVersion < 1) {
    // v0 → v1: Add floating and popouts maps if missing
    result.floating = result.floating || {};
    result.popouts = result.popouts || {};
    result.maximizedNodeId = result.maximizedNodeId ?? null;
    result.focusedTabGroupId = result.focusedTabGroupId ?? null;
    result.dragSourceTabId = null;

    // Ensure all nodes have parentId
    for (const node of Object.values(result.nodes || {})) {
      if (node.parentId === undefined) {
        node.parentId = null;
      }
    }

    // Ensure all tabs have closable field
    for (const tab of Object.values(result.tabs || {})) {
      if (tab.closable === undefined) {
        tab.closable = true;
      }
    }
  }

  // Future migrations:
  // if (fromVersion < 2) { ... }

  result.version = LAYOUT_VERSION;
  return result;
}

// ─── localStorage helpers ─────────────────────────────────

const STORAGE_PREFIX = 'synthi-dock-layout';
const PROFILES_KEY = 'synthi-dock-profiles';

/**
 * Get the storage key for a workspace layout.
 * @param {string} workspaceSlug
 * @returns {string}
 */
function getLayoutKey(workspaceSlug) {
  return `${STORAGE_PREFIX}:${workspaceSlug}`;
}

/**
 * Save layout state to localStorage for a workspace.
 * @param {string} workspaceSlug
 * @param {import('../types').LayoutState} state
 */
export function saveLayoutToStorage(workspaceSlug, state) {
  try {
    const json = serializeLayoutToJSON(state);
    localStorage.setItem(getLayoutKey(workspaceSlug), json);
  } catch (err) {
    console.warn('[docking-wm] Failed to save layout:', err);
  }
}

/**
 * Load layout state from localStorage for a workspace.
 * @param {string} workspaceSlug
 * @returns {import('../types').LayoutState|null}
 */
export function loadLayoutFromStorage(workspaceSlug) {
  try {
    const json = localStorage.getItem(getLayoutKey(workspaceSlug));
    if (!json) return null;
    return deserializeLayout(json);
  } catch (err) {
    console.warn('[docking-wm] Failed to load layout:', err);
    return null;
  }
}

/**
 * Clear saved layout for a workspace.
 * @param {string} workspaceSlug
 */
export function clearLayoutFromStorage(workspaceSlug) {
  try {
    localStorage.removeItem(getLayoutKey(workspaceSlug));
  } catch (err) {
    // ignore
  }
}

// ─── Workspace Profiles ─────────────────────────────────

/**
 * Save a workspace profile.
 * @param {import('../types').WorkspaceProfile} profile
 */
export function saveProfile(profile) {
  try {
    const profiles = loadAllProfiles();
    profiles[profile.id] = profile;
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
  } catch (err) {
    console.warn('[docking-wm] Failed to save profile:', err);
  }
}

/**
 * Load all workspace profiles.
 * @returns {Object<string, import('../types').WorkspaceProfile>}
 */
export function loadAllProfiles() {
  try {
    const json = localStorage.getItem(PROFILES_KEY);
    return json ? JSON.parse(json) : {};
  } catch (err) {
    return {};
  }
}

/**
 * Delete a workspace profile.
 * @param {string} profileId
 */
export function deleteProfile(profileId) {
  try {
    const profiles = loadAllProfiles();
    delete profiles[profileId];
    localStorage.setItem(PROFILES_KEY, JSON.stringify(profiles));
  } catch (err) {
    // ignore
  }
}

/**
 * Load a profile's layout state.
 * @param {string} profileId
 * @returns {import('../types').LayoutState|null}
 */
export function loadProfileLayout(profileId) {
  const profiles = loadAllProfiles();
  const profile = profiles[profileId];
  if (!profile) return null;
  return restoreLayout(profile.layout);
}
