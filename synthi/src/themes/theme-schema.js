/**
 * @fileoverview Synthi Theme Schema
 *
 * Defines the canonical shape of a Synthi IDE theme. Every built-in,
 * extension, and user-created theme **must** conform to this schema.
 *
 * The schema is intentionally JS (not JSON-Schema) so it can be
 * imported by both the theme engine and the theme editor's Monaco
 * JSON validation without a build step.
 *
 * ────────────────────────────────────────────────────────────────
 * Property Groups
 * ────────────────────────────────────────────────────────────────
 *
 * 1. **Meta** – id, name, type, source, parentThemeId
 * 2. **UI Shell** – backgrounds, borders, text, accent, shadows
 * 3. **Editor** – Monaco editor chrome colors (VS Code key format)
 * 4. **Terminal** – ANSI 0-15 + background/foreground/cursor
 * 5. **Syntax (tokenColors)** – TextMate-style scope → settings
 * 6. **Semantic Tokens** – LSP semantic token type → color overrides
 */

// ─── Valid theme types ──────────────────────────────────────
export const THEME_TYPES = ['dark', 'light'];

// ─── Valid theme sources ────────────────────────────────────
export const THEME_SOURCES = ['builtin', 'extension', 'user'];

// ─── Default theme ID (fallback) ────────────────────────────
export const DEFAULT_THEME_ID = 'synthi-dark';

/**
 * All recognised **UI Shell** color keys.
 * These map 1-to-1 to CSS custom properties on :root.
 * e.g. `ui.bgApp` → `--bg-app`
 */
export const UI_COLOR_KEYS = {
  // Backgrounds
  bgApp:        { css: '--bg-app',        label: 'App Background',       category: 'background' },
  bgEditor:     { css: '--bg-editor',     label: 'Editor Background',    category: 'background' },
  bgSidebar:    { css: '--bg-sidebar',    label: 'Sidebar Background',   category: 'background' },
  bgPanel:      { css: '--bg-panel',      label: 'Panel Background',     category: 'background' },
  bgSurface:    { css: '--bg-surface',    label: 'Surface Background',   category: 'background' },
  bgElevated:   { css: '--bg-elevated',   label: 'Elevated Background',  category: 'background' },

  // Borders
  borderSubtle: { css: '--border-subtle', label: 'Subtle Border',   category: 'border' },
  borderMedium: { css: '--border-medium', label: 'Medium Border',   category: 'border' },
  borderFocus:  { css: '--border-focus',  label: 'Focus Border',    category: 'border' },
  borderStrong: { css: '--border-strong', label: 'Strong Border',   category: 'border' },

  // Text
  textPrimary:   { css: '--text-primary',   label: 'Primary Text',    category: 'text' },
  textSecondary: { css: '--text-secondary', label: 'Secondary Text',  category: 'text' },
  textMuted:     { css: '--text-muted',     label: 'Muted Text',      category: 'text' },
  textDim:       { css: '--text-dim',       label: 'Dim Text',        category: 'text' },

  // Accents
  accentPrimary:   { css: '--accent-primary',   label: 'Primary Accent',   category: 'accent' },
  accentSecondary: { css: '--accent-secondary', label: 'Secondary Accent', category: 'accent' },
  accentTertiary:  { css: '--accent-tertiary',  label: 'Tertiary Accent',  category: 'accent' },
  accentDanger:    { css: '--accent-danger',     label: 'Danger',           category: 'accent' },
  accentDangerSoft:{ css: '--accent-danger-soft',label: 'Danger Soft',      category: 'accent' },
  accentSuccess:   { css: '--accent-success',    label: 'Success',          category: 'accent' },
  accentWarning:   { css: '--accent-warning',    label: 'Warning',          category: 'accent' },

  // Syntax tokens (used in CSS utilities & AI chat highlighting)
  syntaxKeyword:      { css: '--syntax-keyword',      label: 'Keyword',       category: 'syntax' },
  syntaxString:       { css: '--syntax-string',       label: 'String',        category: 'syntax' },
  syntaxFunction:     { css: '--syntax-function',     label: 'Function',      category: 'syntax' },
  syntaxComment:      { css: '--syntax-comment',      label: 'Comment',       category: 'syntax' },
  syntaxPreprocessor: { css: '--syntax-preprocessor', label: 'Preprocessor',  category: 'syntax' },
  syntaxNumber:       { css: '--syntax-number',       label: 'Number',        category: 'syntax' },
  syntaxType:         { css: '--syntax-type',         label: 'Type',          category: 'syntax' },

  // Shadows (values are full box-shadow strings, not colors)
  shadowPanel:    { css: '--shadow-panel',    label: 'Panel Shadow',    category: 'shadow' },
  shadowDropdown: { css: '--shadow-dropdown', label: 'Dropdown Shadow', category: 'shadow' },
  shadowGlow:     { css: '--shadow-glow',     label: 'Glow Shadow',     category: 'shadow' },

  // shadcn / Tailwind design-system tokens
  background:               { css: '--background',               label: 'Background',                category: 'shadcn' },
  foreground:               { css: '--foreground',               label: 'Foreground',                category: 'shadcn' },
  card:                     { css: '--card',                     label: 'Card',                      category: 'shadcn' },
  cardForeground:           { css: '--card-foreground',          label: 'Card Foreground',           category: 'shadcn' },
  popover:                  { css: '--popover',                  label: 'Popover',                   category: 'shadcn' },
  popoverForeground:        { css: '--popover-foreground',       label: 'Popover Foreground',        category: 'shadcn' },
  primary:                  { css: '--primary',                  label: 'Primary',                   category: 'shadcn' },
  primaryForeground:        { css: '--primary-foreground',       label: 'Primary Foreground',        category: 'shadcn' },
  secondary:                { css: '--secondary',                label: 'Secondary',                 category: 'shadcn' },
  secondaryForeground:      { css: '--secondary-foreground',     label: 'Secondary Foreground',      category: 'shadcn' },
  muted:                    { css: '--muted',                    label: 'Muted',                     category: 'shadcn' },
  mutedForeground:          { css: '--muted-foreground',         label: 'Muted Foreground',          category: 'shadcn' },
  accent:                   { css: '--accent',                   label: 'Accent',                    category: 'shadcn' },
  accentForeground:         { css: '--accent-foreground',        label: 'Accent Foreground',         category: 'shadcn' },
  destructive:              { css: '--destructive',              label: 'Destructive',               category: 'shadcn' },
  border:                   { css: '--border',                   label: 'Border',                    category: 'shadcn' },
  input:                    { css: '--input',                    label: 'Input',                     category: 'shadcn' },
  ring:                     { css: '--ring',                     label: 'Ring',                      category: 'shadcn' },
  chart1:                   { css: '--chart-1',                  label: 'Chart 1',                   category: 'shadcn' },
  chart2:                   { css: '--chart-2',                  label: 'Chart 2',                   category: 'shadcn' },
  chart3:                   { css: '--chart-3',                  label: 'Chart 3',                   category: 'shadcn' },
  chart4:                   { css: '--chart-4',                  label: 'Chart 4',                   category: 'shadcn' },
  chart5:                   { css: '--chart-5',                  label: 'Chart 5',                   category: 'shadcn' },
  sidebar:                  { css: '--sidebar',                  label: 'Sidebar',                   category: 'shadcn' },
  sidebarForeground:        { css: '--sidebar-foreground',       label: 'Sidebar Foreground',        category: 'shadcn' },
  sidebarPrimary:           { css: '--sidebar-primary',          label: 'Sidebar Primary',           category: 'shadcn' },
  sidebarPrimaryForeground: { css: '--sidebar-primary-foreground', label: 'Sidebar Primary Fg',     category: 'shadcn' },
  sidebarAccent:            { css: '--sidebar-accent',           label: 'Sidebar Accent',            category: 'shadcn' },
  sidebarAccentForeground:  { css: '--sidebar-accent-foreground',label: 'Sidebar Accent Fg',        category: 'shadcn' },
  sidebarBorder:            { css: '--sidebar-border',           label: 'Sidebar Border',            category: 'shadcn' },
  sidebarRing:              { css: '--sidebar-ring',             label: 'Sidebar Ring',              category: 'shadcn' },
};

/**
 * All recognised **Terminal** color keys.
 * These map to xterm.js `ITheme` options.
 */
export const TERMINAL_COLOR_KEYS = [
  'background', 'foreground', 'cursor', 'cursorAccent',
  'selectionBackground', 'selectionForeground', 'selectionInactiveBackground',
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];

/**
 * Categories for grouping UI keys in the visual theme editor.
 */
export const UI_CATEGORIES = [
  { id: 'background', label: 'Backgrounds' },
  { id: 'border',     label: 'Borders' },
  { id: 'text',       label: 'Text' },
  { id: 'accent',     label: 'Accents' },
  { id: 'syntax',     label: 'Syntax' },
  { id: 'shadow',     label: 'Shadows' },
  { id: 'shadcn',     label: 'Design System (shadcn)' },
];

/**
 * Returns a skeleton theme object with all keys set to empty/default.
 * Useful for validation or scaffolding a new theme.
 */
export function createEmptyTheme() {
  return {
    id: '',
    name: '',
    type: 'dark',
    source: 'user',
    parentThemeId: null,

    // UI Shell – keyed by UI_COLOR_KEYS camelCase names
    ui: {},

    // Monaco editor chrome – VS Code color reference keys
    editor: {},

    // Terminal – ANSI palette
    terminal: {},

    // Syntax – TextMate-style token colors
    tokenColors: [],

    // Semantic tokens (optional)
    semanticTokenColors: {},
  };
}

/**
 * Validate a theme object against the schema.
 * Returns `{ valid: boolean, errors: string[] }`.
 */
export function validateTheme(theme) {
  const errors = [];

  if (!theme || typeof theme !== 'object') {
    return { valid: false, errors: ['Theme must be an object'] };
  }

  // Meta
  if (!theme.id || typeof theme.id !== 'string') {
    errors.push('Missing or invalid "id" (must be a non-empty string)');
  }
  if (!theme.name || typeof theme.name !== 'string') {
    errors.push('Missing or invalid "name" (must be a non-empty string)');
  }
  if (!THEME_TYPES.includes(theme.type)) {
    errors.push(`Invalid "type": "${theme.type}" (must be one of: ${THEME_TYPES.join(', ')})`);
  }
  if (theme.source && !THEME_SOURCES.includes(theme.source)) {
    errors.push(`Invalid "source": "${theme.source}" (must be one of: ${THEME_SOURCES.join(', ')})`);
  }

  // UI colors
  if (theme.ui && typeof theme.ui !== 'object') {
    errors.push('"ui" must be an object');
  }

  // Editor colors
  if (theme.editor && typeof theme.editor !== 'object') {
    errors.push('"editor" must be an object');
  }

  // Terminal colors
  if (theme.terminal && typeof theme.terminal !== 'object') {
    errors.push('"terminal" must be an object');
  }

  // Token colors
  if (theme.tokenColors) {
    if (!Array.isArray(theme.tokenColors)) {
      errors.push('"tokenColors" must be an array');
    } else {
      for (let i = 0; i < theme.tokenColors.length; i++) {
        const tc = theme.tokenColors[i];
        if (!tc.settings || typeof tc.settings !== 'object') {
          errors.push(`tokenColors[${i}]: missing "settings" object`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}
