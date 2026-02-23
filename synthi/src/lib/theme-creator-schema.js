/**
 * @fileoverview Theme Creator Section Schema
 *
 * Organises UI_COLOR_KEYS into user-facing sections grouped by
 * visual region of the IDE — used to render the Theme Creator
 * sidebar and color-input panels.
 *
 * Also defines:
 *   - CONTRAST_PAIRS — bg/fg pairings that must meet WCAG thresholds
 *   - SHADOW_KEYS — keys that hold box-shadow strings (not hex colours)
 *   - Helper functions for completion tracking
 */

import { UI_COLOR_KEYS } from '../themes/theme-schema';

// ─── Creator Sections ───────────────────────────────────────

/**
 * Each section maps to a navigable category in the Theme Creator's
 * left sidebar. `keys` reference entries in UI_COLOR_KEYS.
 */
export const CREATOR_SECTIONS = [
  {
    id: 'general',
    label: 'General',
    icon: 'Layout',
    description: 'Overall app backgrounds and surfaces',
    keys: ['bgApp', 'bgSurface', 'bgElevated', 'background', 'foreground'],
  },
  {
    id: 'sidebar',
    label: 'Sidebar',
    icon: 'PanelLeft',
    description: 'File explorer and sidebar areas',
    keys: [
      'bgSidebar', 'sidebar', 'sidebarForeground',
      'sidebarPrimary', 'sidebarPrimaryForeground',
      'sidebarAccent', 'sidebarAccentForeground',
      'sidebarBorder', 'sidebarRing',
    ],
  },
  {
    id: 'editor',
    label: 'Editor',
    icon: 'Code',
    description: 'Code editor area',
    keys: ['bgEditor'],
  },
  {
    id: 'panels',
    label: 'Panels',
    icon: 'PanelBottom',
    description: 'Terminal, output, and bottom panels',
    keys: ['bgPanel'],
  },
  {
    id: 'text',
    label: 'Text',
    icon: 'Type',
    description: 'Text colours used throughout the UI',
    keys: ['textPrimary', 'textSecondary', 'textMuted', 'textDim', 'muted', 'mutedForeground'],
  },
  {
    id: 'borders',
    label: 'Borders',
    icon: 'Square',
    description: 'Dividers, outlines, and separators',
    keys: ['borderSubtle', 'borderMedium', 'borderFocus', 'borderStrong', 'border', 'input'],
  },
  {
    id: 'accents',
    label: 'Accents',
    icon: 'Sparkles',
    description: 'Primary brand colours and status indicators',
    keys: [
      'accentPrimary', 'accentSecondary', 'accentTertiary',
      'accentDanger', 'accentDangerSoft', 'accentSuccess', 'accentWarning',
      'primary', 'primaryForeground', 'ring', 'destructive',
    ],
  },
  {
    id: 'syntax',
    label: 'Syntax',
    icon: 'Braces',
    description: 'Code syntax highlighting colours',
    keys: [
      'syntaxKeyword', 'syntaxString', 'syntaxFunction',
      'syntaxComment', 'syntaxPreprocessor', 'syntaxNumber', 'syntaxType',
    ],
  },
  {
    id: 'components',
    label: 'Components',
    icon: 'Component',
    description: 'Cards, popovers, menus, and overlays',
    keys: [
      'card', 'cardForeground', 'popover', 'popoverForeground',
      'secondary', 'secondaryForeground', 'accent', 'accentForeground',
    ],
  },
  {
    id: 'charts',
    label: 'Charts',
    icon: 'BarChart3',
    description: 'Data visualisation palette',
    keys: ['chart1', 'chart2', 'chart3', 'chart4', 'chart5'],
  },
  {
    id: 'shadows',
    label: 'Shadows',
    icon: 'Layers',
    description: 'Depth and elevation effects',
    keys: ['shadowPanel', 'shadowDropdown', 'shadowGlow'],
  },
];

// ─── Contrast Pairs ─────────────────────────────────────────

/**
 * Background/foreground pairs that must meet WCAG minimum contrast.
 * `min` is the minimum required contrast ratio.
 *
 * AA normal text = 4.5:1, AA large text = 3:1.
 */
export const CONTRAST_PAIRS = [
  // App backgrounds + text
  { bg: 'bgApp',      fg: 'textPrimary',   min: 4.5 },
  { bg: 'bgApp',      fg: 'textSecondary', min: 4.5 },
  { bg: 'bgApp',      fg: 'textMuted',     min: 3   },

  // Editor + text / syntax
  { bg: 'bgEditor',   fg: 'textPrimary',      min: 4.5 },
  { bg: 'bgEditor',   fg: 'textSecondary',    min: 4.5 },
  { bg: 'bgEditor',   fg: 'syntaxKeyword',    min: 3   },
  { bg: 'bgEditor',   fg: 'syntaxString',     min: 3   },
  { bg: 'bgEditor',   fg: 'syntaxFunction',   min: 3   },
  { bg: 'bgEditor',   fg: 'syntaxComment',    min: 3   },
  { bg: 'bgEditor',   fg: 'syntaxNumber',     min: 3   },
  { bg: 'bgEditor',   fg: 'syntaxType',       min: 3   },

  // Sidebar + text
  { bg: 'bgSidebar',  fg: 'textPrimary',   min: 4.5 },
  { bg: 'bgSidebar',  fg: 'textSecondary', min: 4.5 },
  { bg: 'bgSidebar',  fg: 'textMuted',     min: 3   },

  // Panel + text
  { bg: 'bgPanel',    fg: 'textPrimary',   min: 4.5 },
  { bg: 'bgPanel',    fg: 'textSecondary', min: 4.5 },

  // Surface / elevated
  { bg: 'bgSurface',  fg: 'textPrimary',   min: 4.5 },
  { bg: 'bgElevated', fg: 'textPrimary',   min: 4.5 },

  // Accent button
  { bg: 'accentPrimary', fg: 'primaryForeground', min: 3 },

  // shadcn semantic pairings
  { bg: 'background', fg: 'foreground',        min: 4.5 },
  { bg: 'card',       fg: 'cardForeground',    min: 4.5 },
  { bg: 'popover',    fg: 'popoverForeground', min: 4.5 },
  { bg: 'sidebar',    fg: 'sidebarForeground', min: 4.5 },
];

// ─── Shadow Keys ────────────────────────────────────────────

/**
 * Keys whose values are full CSS box-shadow strings, not hex colours.
 * The Theme Creator renders a text input for these instead of a colour picker.
 */
export const SHADOW_KEYS = new Set([
  'shadowPanel',
  'shadowDropdown',
  'shadowGlow',
]);

// ─── Helpers ────────────────────────────────────────────────

/**
 * Look up the display label and CSS variable name for a colour key.
 *
 * @param {string} key — a key from UI_COLOR_KEYS
 * @returns {{ css: string, label: string, category: string } | null}
 */
export function getKeyMeta(key) {
  return UI_COLOR_KEYS[key] || null;
}

/**
 * Count how many colour fields have been filled in.
 *
 * @param {Record<string, string>} uiColors — the WIP ui colour map
 * @returns {{ total: number, filled: number, complete: boolean }}
 */
export function countFilledKeys(uiColors) {
  let total = 0;
  let filled = 0;
  for (const section of CREATOR_SECTIONS) {
    for (const key of section.keys) {
      total++;
      if (uiColors[key] && uiColors[key].trim()) filled++;
    }
  }
  return { total, filled, complete: filled === total };
}

/**
 * Return all unfilled keys grouped by section (for the mandatory check).
 *
 * @param {Record<string, string>} uiColors
 * @returns {Array<{ key: string, label: string, section: string }>}
 */
export function getUnfilledKeys(uiColors) {
  const unfilled = [];
  for (const section of CREATOR_SECTIONS) {
    for (const key of section.keys) {
      if (!uiColors[key] || !uiColors[key].trim()) {
        const meta = UI_COLOR_KEYS[key];
        unfilled.push({
          key,
          label: meta?.label || key,
          section: section.label,
        });
      }
    }
  }
  return unfilled;
}
