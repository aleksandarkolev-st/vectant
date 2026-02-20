/**
 * @fileoverview Theme Redux Slice
 *
 * Manages the complete theme lifecycle:
 *   - Active / preview theme IDs
 *   - Built-in, extension, and user theme registries
 *   - User override layers (per base-theme customisations)
 *   - Theme editor panel state
 */

import { createSlice, createSelector } from '@reduxjs/toolkit';
import { DEFAULT_THEME_ID } from '../themes/theme-schema';

// ─── Initial State ─────────────────────────────────────────

export const initialThemeState = {
  /** Currently applied theme ID */
  activeThemeId: DEFAULT_THEME_ID,

  /** Theme being previewed (e.g. when hovering in picker). null = no preview */
  previewThemeId: null,

  /** Built-in themes  { [id]: themeObj } */
  builtinThemes: {},

  /** Extension-contributed themes  { [id]: themeObj } */
  extensionThemes: {},

  /** User-created themes  { [id]: themeObj } */
  userThemes: {},

  /**
   * User override layers keyed by base theme ID.
   * Each value is a partial theme object that gets deep-merged
   * on top of the base when resolving.
   * { [baseThemeId]: Partial<Theme> }
   */
  userOverrides: {},

  /** Whether the theme editor panel is open */
  editorOpen: false,

  /** Which theme is being edited in the theme editor (null = none) */
  editorTargetThemeId: null,

  /** Dirty (unsaved) state in the theme editor – serialisable partial theme */
  editorDirtyState: null,
};

// ─── Slice ──────────────────────────────────────────────────

const themeSlice = createSlice({
  name: 'theme',
  initialState: initialThemeState,
  reducers: {
    // ── Active theme ────────────────────────────────────
    setActiveTheme(state, action) {
      state.activeThemeId = action.payload;
      state.previewThemeId = null; // clear preview
    },

    // ── Preview (hover in picker) ───────────────────────
    previewTheme(state, action) {
      state.previewThemeId = action.payload;
    },
    clearPreview(state) {
      state.previewThemeId = null;
    },

    // ── Built-in themes ─────────────────────────────────
    registerBuiltinThemes(state, action) {
      // action.payload: Record<id, theme>
      state.builtinThemes = { ...state.builtinThemes, ...action.payload };
    },

    // ── Extension themes ────────────────────────────────
    registerExtensionTheme(state, action) {
      const theme = action.payload;
      if (theme && theme.id) {
        state.extensionThemes[theme.id] = theme;
      }
    },
    unregisterExtensionTheme(state, action) {
      const id = action.payload;
      delete state.extensionThemes[id];
      // If the active theme was from this extension, fall back
      if (state.activeThemeId === id) {
        state.activeThemeId = DEFAULT_THEME_ID;
      }
      if (state.previewThemeId === id) {
        state.previewThemeId = null;
      }
    },
    /** Remove all themes contributed by a specific extension */
    removeExtensionThemes(state, action) {
      const extensionId = action.payload;
      const toRemove = [];
      for (const [id, theme] of Object.entries(state.extensionThemes)) {
        if (theme._extensionId === extensionId) {
          toRemove.push(id);
        }
      }
      for (const id of toRemove) {
        delete state.extensionThemes[id];
      }
      if (toRemove.includes(state.activeThemeId)) {
        state.activeThemeId = DEFAULT_THEME_ID;
      }
      if (toRemove.includes(state.previewThemeId)) {
        state.previewThemeId = null;
      }
    },

    // ── User themes ─────────────────────────────────────
    saveUserTheme(state, action) {
      const theme = action.payload;
      if (theme && theme.id) {
        state.userThemes[theme.id] = { ...theme, source: 'user' };
      }
    },
    deleteUserTheme(state, action) {
      const id = action.payload;
      delete state.userThemes[id];
      if (state.activeThemeId === id) {
        state.activeThemeId = DEFAULT_THEME_ID;
      }
    },

    // ── User overrides (edit existing themes) ───────────
    saveUserOverride(state, action) {
      const { baseThemeId, override } = action.payload;
      state.userOverrides[baseThemeId] = override;
    },
    deleteUserOverride(state, action) {
      const baseThemeId = action.payload;
      delete state.userOverrides[baseThemeId];
    },

    // ── Theme editor panel ──────────────────────────────
    openThemeEditor(state, action) {
      state.editorOpen = true;
      state.editorTargetThemeId = action.payload || state.activeThemeId;
      state.editorDirtyState = null;
    },
    closeThemeEditor(state) {
      state.editorOpen = false;
      state.editorTargetThemeId = null;
      state.editorDirtyState = null;
    },
    setEditorDirty(state, action) {
      state.editorDirtyState = action.payload;
    },

    // ── Hydration (from localStorage/IndexedDB) ────────
    hydrateTheme(state, action) {
      const payload = action.payload;
      if (payload.activeThemeId) state.activeThemeId = payload.activeThemeId;
      if (payload.userThemes) state.userThemes = payload.userThemes;
      if (payload.userOverrides) state.userOverrides = payload.userOverrides;
    },
  },
});

export const {
  setActiveTheme,
  previewTheme,
  clearPreview,
  registerBuiltinThemes,
  registerExtensionTheme,
  unregisterExtensionTheme,
  removeExtensionThemes,
  saveUserTheme,
  deleteUserTheme,
  saveUserOverride,
  deleteUserOverride,
  openThemeEditor,
  closeThemeEditor,
  setEditorDirty,
  hydrateTheme,
} = themeSlice.actions;

// ─── Selectors ──────────────────────────────────────────────

export const selectActiveThemeId = (state) => state.theme.activeThemeId;
export const selectPreviewThemeId = (state) => state.theme.previewThemeId;
export const selectBuiltinThemes = (state) => state.theme.builtinThemes;
export const selectExtensionThemes = (state) => state.theme.extensionThemes;
export const selectUserThemes = (state) => state.theme.userThemes;
export const selectUserOverrides = (state) => state.theme.userOverrides;
export const selectThemeEditorOpen = (state) => state.theme.editorOpen;
export const selectThemeEditorTarget = (state) => state.theme.editorTargetThemeId;
export const selectEditorDirtyState = (state) => state.theme.editorDirtyState;

/** Effective theme ID (preview if hovering, otherwise active) */
export const selectEffectiveThemeId = createSelector(
  [selectActiveThemeId, selectPreviewThemeId],
  (active, preview) => preview || active
);

/** All themes merged into a single map (for resolution). */
export const selectAllThemes = createSelector(
  [selectBuiltinThemes, selectExtensionThemes, selectUserThemes],
  (builtin, extension, user) => ({ ...builtin, ...extension, ...user })
);

/** Ordered list of all themes for the picker (grouped by source). */
export const selectThemeList = createSelector(
  [selectBuiltinThemes, selectExtensionThemes, selectUserThemes],
  (builtin, extension, user) => {
    const list = [];
    // Built-in first
    for (const theme of Object.values(builtin)) {
      list.push({ ...theme, _group: 'Built-in' });
    }
    // Extension themes
    for (const theme of Object.values(extension)) {
      list.push({ ...theme, _group: 'Extensions' });
    }
    // User themes last
    for (const theme of Object.values(user)) {
      list.push({ ...theme, _group: 'User' });
    }
    return list;
  }
);

export default themeSlice.reducer;
