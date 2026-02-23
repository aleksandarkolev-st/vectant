/**
 * @fileoverview Synthi Extension System - Theme Registrar
 *
 * Extracts and registers color themes from a VSIX extension's manifest.
 * Follows VS Code's `contributes.themes` contract:
 *
 *   "contributes": {
 *       "themes": [
 *           {
 *               "label": "My Theme",
 *               "uiTheme": "vs-dark",        // "vs" | "vs-dark" | "hc-black" | "hc-light"
 *               "path": "./themes/my-theme-color-theme.json"
 *           }
 *       ]
 *   }
 *
 * The registrar:
 *   1. Reads the `contributes.themes` array
 *   2. For each entry, loads the referenced JSON theme file
 *   3. Normalises it into Synthi's schema via `normalizeVSCodeTheme`
 *   4. Dispatches `registerExtensionTheme` into the Redux store
 *
 * On uninstall, `unregisterExtensionThemes(extensionId)` removes all
 * themes contributed by a given extension.
 */

import { normalizeVSCodeTheme } from '@/lib/theme-engine';

// Map VS Code uiTheme strings to our theme type
const UI_THEME_TO_TYPE = {
  'vs':       'light',
  'vs-dark':  'dark',
  'hc-black': 'dark',
  'hc-light': 'light',
};

/**
 * Extract theme contribution entries from a manifest.
 *
 * @param {object} manifest - Normalised extension manifest
 * @returns {Array<{ label: string, uiTheme: string, path: string }>}
 */
export function getContributedThemes(manifest) {
  const themes = manifest?.contributes?.themes;
  if (!Array.isArray(themes)) return [];
  return themes.filter(
    (t) => t && typeof t.label === 'string' && typeof t.path === 'string'
  );
}

/**
 * Register all themes from an extension.
 *
 * @param {object} params
 * @param {string} params.extensionId - Unique extension identifier
 * @param {Array} params.themeEntries - From `getContributedThemes()`
 * @param {function} params.readFile - Async function `(relativePath) => string|object`
 *                                     that reads a file from the extension bundle
 * @param {function} params.dispatch - Redux dispatch function
 * @param {object} params.actions - `{ registerExtensionTheme }` from themeSlice
 * @returns {Promise<string[]>} Array of registered theme IDs
 */
export async function registerExtensionThemes({
  extensionId,
  themeEntries,
  readFile,
  dispatch,
  actions,
}) {
  const registered = [];

  for (const entry of themeEntries) {
    try {
      // Read the theme JSON from the extension bundle
      let raw = await readFile(entry.path);
      if (typeof raw === 'string') {
        // Strip JSON-C comments (VS Code themes often use them)
        raw = raw.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        raw = JSON.parse(raw);
      }

      // Determine theme type from uiTheme or from the file itself
      const themeType = UI_THEME_TO_TYPE[entry.uiTheme] || raw.type || 'dark';

      // Generate a stable, unique theme ID
      const themeId = `${extensionId}--${slugify(entry.label)}`;

      // Normalise VS Code theme → Synthi theme
      const normalised = normalizeVSCodeTheme(raw, {
        id: themeId,
        name: entry.label,
        type: themeType,
        source: 'extension',
      });

      // Tag with extension ID for easy removal later
      normalised._extensionId = extensionId;

      // Dispatch into Redux
      dispatch(actions.registerExtensionTheme(normalised));
      registered.push(themeId);

      console.log(
        `[ThemeRegistrar] Registered theme "${entry.label}" (${themeId}) from ${extensionId}`
      );
    } catch (err) {
      console.warn(
        `[ThemeRegistrar] Failed to register theme "${entry.label}" from ${extensionId}:`,
        err.message
      );
    }
  }

  return registered;
}

/**
 * Unregister all themes from a given extension.
 *
 * @param {object} params
 * @param {string} params.extensionId
 * @param {function} params.dispatch
 * @param {object} params.actions - `{ removeExtensionThemes }` from themeSlice
 */
export function unregisterExtensionThemes({ extensionId, dispatch, actions }) {
  dispatch(actions.removeExtensionThemes(extensionId));
  console.log(`[ThemeRegistrar] Removed all themes from ${extensionId}`);
}

// ─── Helpers ──────────────────────────────────────────────

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
