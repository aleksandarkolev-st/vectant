/**
 * @fileoverview Synthi Theme Engine
 *
 * Pure-function module that converts a theme JSON into the artefacts
 * the runtime needs:
 *   1. A flat CSS-variable map ready for injection into :root
 *   2. A Monaco `IStandaloneThemeData` object
 *   3. An xterm.js `ITheme` object
 *
 * The engine also handles:
 *   - Resolving theme inheritance (parentThemeId → deep merge)
 *   - Merging user-override layers on top of base themes
 *   - Converting VS Code extension themes into Synthi's format
 *
 * ⚡ Performance contract: every public function must complete in < 5 ms
 *    on a mid-range device.  No DOM access, no side effects.
 */

import { UI_COLOR_KEYS, TERMINAL_COLOR_KEYS } from '../themes/theme-schema';

// ────────────────────────────────────────────────────────
// 1. Theme Resolution (inheritance + overrides)
// ────────────────────────────────────────────────────────

/**
 * Deep-merge two plain objects. Arrays replace (no concat).
 * @param {object} base
 * @param {object} override
 * @returns {object}
 */
function deepMerge(base, override) {
  if (!override) return base;
  if (!base) return override;
  const result = { ...base };
  for (const key of Object.keys(override)) {
    const bVal = base[key];
    const oVal = override[key];
    if (
      oVal &&
      typeof oVal === 'object' &&
      !Array.isArray(oVal) &&
      bVal &&
      typeof bVal === 'object' &&
      !Array.isArray(bVal)
    ) {
      result[key] = deepMerge(bVal, oVal);
    } else {
      result[key] = oVal;
    }
  }
  return result;
}

/**
 * Resolve a theme by walking the parentThemeId chain and applying
 * any user-override layer.
 *
 * @param {string} themeId          - The theme to resolve.
 * @param {Record<string, object>} allThemes - Map of all available themes
 *        (builtins + extension + user) keyed by id.
 * @param {Record<string, object>} userOverrides - Partial theme overrides
 *        keyed by base theme id.
 * @param {Set<string>} [_visited] - Internal cycle guard.
 * @returns {object} Fully resolved theme.
 */
export function resolveTheme(themeId, allThemes, userOverrides = {}, _visited = new Set()) {
  if (_visited.has(themeId)) {
    console.warn(`[theme-engine] Circular parentThemeId detected at "${themeId}"`);
    return allThemes[themeId] || {};
  }
  _visited.add(themeId);

  const theme = allThemes[themeId];
  if (!theme) {
    console.warn(`[theme-engine] Theme "${themeId}" not found, returning empty`);
    return {};
  }

  // Walk up the inheritance chain
  let resolved = theme;
  if (theme.parentThemeId && allThemes[theme.parentThemeId]) {
    const parent = resolveTheme(theme.parentThemeId, allThemes, {}, _visited);
    resolved = deepMerge(parent, theme);
  }

  // Apply user overrides (if any exist for this theme)
  const override = userOverrides[themeId];
  if (override) {
    resolved = deepMerge(resolved, override);
  }

  return resolved;
}

// ────────────────────────────────────────────────────────
// 2. CSS Variable Generation
// ────────────────────────────────────────────────────────

/**
 * Convert the `ui` section of a resolved theme into a flat
 * Map of CSS custom-property name → value string.
 *
 * @param {object} uiColors - theme.ui object
 * @returns {Map<string, string>}
 */
export function generateCSSVariables(uiColors) {
  const vars = new Map();
  if (!uiColors) return vars;

  for (const [key, meta] of Object.entries(UI_COLOR_KEYS)) {
    const value = uiColors[key];
    if (value !== undefined && value !== null) {
      vars.set(meta.css, value);
    }
  }

  return vars;
}

/**
 * Build the accent-gradient and accent-glow values from the resolved
 * accent colours (they are composite values, not simple hex).
 *
 * @param {object} ui
 * @returns {Map<string, string>}
 */
export function generateDerivedVariables(ui) {
  const vars = new Map();
  if (!ui) return vars;

  const p = ui.accentPrimary || '#327464';
  const s = ui.accentSecondary || '#3d8b78';
  const t = ui.accentTertiary || '#4a9e8a';

  vars.set('--accent-gradient', `linear-gradient(135deg, ${p} 0%, ${s} 50%, ${t} 100%)`);

  // Parse hex to rgba for glow
  const rgb = hexToRgb(p);
  if (rgb) {
    vars.set('--accent-glow', `0 0 20px rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.4)`);
  }

  // ── Disabled text alias (used by several components) ──
  if (ui.textDim) {
    vars.set('--text-disabled', ui.textDim);
  }

  return vars;
}

// ────────────────────────────────────────────────────────
// 3. Monaco Theme Generation
// ────────────────────────────────────────────────────────

/**
 * Build a Monaco `IStandaloneThemeData` object from a resolved theme.
 *
 * @param {object} theme - Resolved theme
 * @returns {{ base: string, inherit: boolean, rules: object[], colors: object }}
 */
export function generateMonacoTheme(theme) {
  const base = theme.type === 'light' ? 'vs' : 'vs-dark';

  // Build token rules from tokenColors
  const rules = [];
  if (Array.isArray(theme.tokenColors)) {
    for (const tc of theme.tokenColors) {
      if (!tc.settings) continue;
      const scopes = tc.scope
        ? (Array.isArray(tc.scope) ? tc.scope : [tc.scope])
        : [''];
      for (const scope of scopes) {
        const rule = { token: scope };
        if (tc.settings.foreground) {
          rule.foreground = stripHash(tc.settings.foreground);
        }
        if (tc.settings.background) {
          rule.background = stripHash(tc.settings.background);
        }
        if (tc.settings.fontStyle) {
          rule.fontStyle = tc.settings.fontStyle;
        }
        rules.push(rule);
      }
    }
  }

  // Editor chrome colors — pass through as-is (already in VS Code format)
  const colors = theme.editor ? { ...theme.editor } : {};

  // Inline-suggestion ghost text. Monaco's built-in default reads as a harsh,
  // theme-agnostic colour (often green/lime against dark backgrounds). Derive a
  // muted variant from editor.foreground so AI ghost text reads as a quiet
  // preview that respects the active theme.
  const fg = colors['editor.foreground'];
  if (fg && !colors['editorGhostText.foreground']) {
    colors['editorGhostText.foreground'] = fg + '66'; // ~40% alpha
  }
  if (fg && !colors['editorGhostText.border']) {
    colors['editorGhostText.border'] = fg + '22';
  }

  return { base, inherit: true, rules, colors };
}

// ────────────────────────────────────────────────────────
// 3b. Shiki Theme Generation
// ────────────────────────────────────────────────────────

/**
 * Build a Shiki-compatible theme object from a resolved Synthi theme.
 *
 * Shiki accepts VS Code-style theme JSON (`colors` + `tokenColors`), which
 * matches the Synthi theme shape one-to-one — `editor` becomes `colors`
 * and `tokenColors` passes through.
 *
 * @param {object} theme - Resolved Synthi theme
 * @returns {object} Shiki theme registration object
 */
export function generateShikiTheme(theme) {
  if (!theme) return null;
  return {
    name: theme.id || 'synthi',
    type: theme.type === 'light' ? 'light' : 'dark',
    colors: theme.editor || {},
    tokenColors: theme.tokenColors || [],
    semanticTokenColors: theme.semanticTokenColors || {},
    semanticHighlighting: true,
  };
}

// ────────────────────────────────────────────────────────
// 4. Terminal Theme Generation
// ────────────────────────────────────────────────────────

/**
 * Build an xterm.js `ITheme` object from a resolved theme.
 *
 * @param {object} theme - Resolved theme
 * @returns {object} xterm.js theme
 */
export function generateTerminalTheme(theme) {
  if (!theme.terminal) return {};
  const result = {};
  for (const key of TERMINAL_COLOR_KEYS) {
    if (theme.terminal[key] !== undefined) {
      result[key] = theme.terminal[key];
    }
  }
  return result;
}

// ────────────────────────────────────────────────────────
// 5. VS Code Extension Theme Normalizer
// ────────────────────────────────────────────────────────

/**
 * Map from VS Code `colors` keys to Synthi `ui` keys.
 * Only a subset is mapped — unmapped keys stay in `editor`.
 */
const VSCODE_TO_SYNTHI_UI = {
  // Backgrounds
  'editor.background':            'bgEditor',
  'sideBar.background':           'bgSidebar',
  'panel.background':             'bgPanel',
  'editorGroupHeader.tabsBackground': 'bgSurface',
  'tab.inactiveBackground':       'bgSurface',
  'activityBar.background':       'bgApp',

  // Borders
  'sideBar.border':               'borderSubtle',
  'panel.border':                 'borderMedium',
  'focusBorder':                  'borderFocus',
  'contrastBorder':               'borderStrong',

  // Text
  'foreground':                   'textPrimary',
  'descriptionForeground':        'textSecondary',
  'disabledForeground':           'textMuted',

  // Accents
  'focusBorder':                  'accentPrimary',
  'errorForeground':              'accentDanger',
  'notificationsErrorIcon.foreground': 'accentDanger',
  'testing.iconPassed':           'accentSuccess',

  // Terminal
  'terminal.background':          null, // handled by terminal section
  'terminal.foreground':          null,
};

/**
 * Normalize a VS Code extension color-theme JSON into Synthi's
 * internal theme format.
 *
 * @param {object} vscodeTheme - Raw VS Code theme JSON
 * @param {object} meta        - { id, name, extensionId }
 * @returns {object} Synthi theme object
 */
export function normalizeVSCodeTheme(vscodeTheme, meta) {
  const uiThemeType = vscodeTheme.type ||
    (vscodeTheme.$schema?.includes('light') ? 'light' : 'dark');

  const result = {
    id: meta.id,
    name: meta.name || vscodeTheme.name || meta.id,
    type: uiThemeType === 'light' || uiThemeType === 'vs' ? 'light' : 'dark',
    source: 'extension',
    parentThemeId: null,
    ui: {},
    editor: {},
    terminal: {},
    tokenColors: [],
    semanticTokenColors: vscodeTheme.semanticTokenColors || {},
  };

  // Process `colors`
  if (vscodeTheme.colors && typeof vscodeTheme.colors === 'object') {
    for (const [key, value] of Object.entries(vscodeTheme.colors)) {
      // Check if this maps to a Synthi UI key
      const synthiKey = VSCODE_TO_SYNTHI_UI[key];
      if (synthiKey) {
        result.ui[synthiKey] = value;
      }
      // Terminal colors
      if (key.startsWith('terminal.')) {
        const termKey = key.replace('terminal.', '').replace('ansi', '');
        // Convert e.g. 'terminal.ansiRed' → 'red'
        const normalized = termKey.charAt(0).toLowerCase() + termKey.slice(1);
        result.terminal[normalized] = value;
      }
      // All colors go into editor for Monaco
      result.editor[key] = value;
    }
  }

  // Process tokenColors (already in TextMate format)
  if (Array.isArray(vscodeTheme.tokenColors)) {
    result.tokenColors = vscodeTheme.tokenColors.map(tc => ({
      scope: tc.scope || '',
      settings: tc.settings || {},
      name: tc.name || undefined,
    }));
  }

  // Map the shadcn tokens from the VS Code colors we extracted
  mapShadcnTokens(result);

  return result;
}

/**
 * Attempt to populate shadcn design-system tokens from the resolved
 * editor/ui colors so that the entire Tailwind/shadcn layer works.
 */
function mapShadcnTokens(theme) {
  const ui = theme.ui;
  const editor = theme.editor;

  // Use editor background as the main background if not already set
  if (!ui.background && editor['editor.background']) {
    ui.background = editor['editor.background'];
  }
  if (!ui.foreground && editor['editor.foreground']) {
    ui.foreground = editor['editor.foreground'];
  }
  if (!ui.card && ui.bgPanel) {
    ui.card = ui.bgPanel;
  }
  if (!ui.cardForeground && ui.textPrimary) {
    ui.cardForeground = ui.textPrimary;
  }
  if (!ui.popover && ui.bgPanel) {
    ui.popover = ui.bgPanel;
  }
  if (!ui.popoverForeground && ui.textPrimary) {
    ui.popoverForeground = ui.textPrimary;
  }
}

// ────────────────────────────────────────────────────────
// 6. DOM Application (batched into a single rAF)
// ────────────────────────────────────────────────────────

let _pendingApply = null;

/**
 * Apply a resolved theme to the DOM.  Batches all writes into a
 * single `requestAnimationFrame` for < 50 ms switch time.
 *
 * @param {object} theme   - Fully resolved theme
 * @param {object} [monaco] - Monaco editor namespace (optional; pass when available)
 * @param {string} [monacoThemeName] - Name for the Monaco theme (default: 'synthi-theme')
 * @returns {Promise<void>} resolves once applied
 */
export function applyThemeToDOM(theme, monaco = null, monacoThemeName = 'synthi-theme') {
  // Cancel any pending apply
  if (_pendingApply) {
    cancelAnimationFrame(_pendingApply);
  }

  return new Promise((resolve) => {
    _pendingApply = requestAnimationFrame(() => {
      _pendingApply = null;

      // 1. CSS custom properties on :root
      const cssVars = generateCSSVariables(theme.ui);
      const derived = generateDerivedVariables(theme.ui);
      const root = document.documentElement;

      // Batch all writes
      for (const [prop, val] of cssVars) {
        root.style.setProperty(prop, val);
      }
      for (const [prop, val] of derived) {
        root.style.setProperty(prop, val);
      }

      // 2. Set `data-theme-type` attribute for CSS selectors
      root.setAttribute('data-theme-type', theme.type || 'dark');

      // 3. Monaco theme
      if (monaco) {
        try {
          const monacoTheme = generateMonacoTheme(theme);
          monaco.editor.defineTheme(monacoThemeName, monacoTheme);
          monaco.editor.setTheme(monacoThemeName);
        } catch (e) {
          console.warn('[theme-engine] Failed to apply Monaco theme:', e);
        }
      }

      resolve();
    });
  });
}

// ────────────────────────────────────────────────────────
// 7. Utilities
// ────────────────────────────────────────────────────────

/** Strip leading '#' from a hex color. */
function stripHash(hex) {
  if (!hex) return '';
  return hex.startsWith('#') ? hex.slice(1) : hex;
}

/** Convert hex (#RRGGBB) to { r, g, b }. Returns null on failure. */
function hexToRgb(hex) {
  if (!hex) return null;
  const clean = stripHash(hex);
  if (clean.length < 6) return null;
  const num = parseInt(clean.substring(0, 6), 16);
  if (isNaN(num)) return null;
  return {
    r: (num >> 16) & 255,
    g: (num >> 8) & 255,
    b: num & 255,
  };
}

/**
 * Get all themes merged into a single lookup map.
 * @param {object} state - themeSlice state
 * @returns {Record<string, object>}
 */
export function getAllThemesMap(state) {
  return {
    ...state.builtinThemes,
    ...state.extensionThemes,
    ...state.userThemes,
  };
}
