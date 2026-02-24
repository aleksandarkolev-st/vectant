/**
 * @fileoverview Color Contrast Utilities
 *
 * WCAG 2.1 contrast ratio calculations for theme accessibility warnings.
 * Used by the Theme Creator to warn about low-contrast color pairings.
 *
 * References:
 *   - https://www.w3.org/TR/WCAG21/#dfn-relative-luminance
 *   - https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio
 */

// ─── Hex ➜ RGB ──────────────────────────────────────────────

/**
 * Parse a hex color string to { r, g, b } (0–255).
 * Supports #RGB, #RRGGBB, #RRGGBBAA (alpha is ignored).
 *
 * @param {string} hex
 * @returns {{ r: number, g: number, b: number } | null}
 */
export function hexToRgb(hex) {
  if (!hex || typeof hex !== 'string') return null;
  let h = hex.replace(/^#/, '');

  // Expand shorthand: #RGB → RRGGBB
  if (h.length === 3 || h.length === 4) {
    h = h.split('').map((c) => c + c).join('');
  }

  if (h.length < 6) return null;

  const r = parseInt(h.substring(0, 2), 16);
  const g = parseInt(h.substring(2, 4), 16);
  const b = parseInt(h.substring(4, 6), 16);

  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return { r, g, b };
}

// ─── Relative Luminance ─────────────────────────────────────

/**
 * Relative luminance of an sRGB colour per WCAG 2.1 §G17.
 *
 * @param {{ r: number, g: number, b: number }} rgb
 * @returns {number} 0 (darkest) … 1 (lightest)
 */
export function relativeLuminance({ r, g, b }) {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

// ─── Contrast Ratio ─────────────────────────────────────────

/**
 * WCAG 2.1 contrast ratio between two hex colours.
 *
 * @param {string} hex1
 * @param {string} hex2
 * @returns {number | null} Ratio 1–21, or null if either colour is invalid.
 */
export function contrastRatio(hex1, hex2) {
  const rgb1 = hexToRgb(hex1);
  const rgb2 = hexToRgb(hex2);
  if (!rgb1 || !rgb2) return null;

  const l1 = relativeLuminance(rgb1);
  const l2 = relativeLuminance(rgb2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);

  return (lighter + 0.05) / (darker + 0.05);
}

// ─── WCAG Thresholds ────────────────────────────────────────

/** WCAG 2.1 conformance thresholds. */
export const WCAG = {
  /** Enhanced contrast — Level AAA for normal text */
  AAA: 7,
  /** Minimum contrast — Level AA for normal text */
  AA: 4.5,
  /** Minimum contrast — Level AA for large text (≥ 18 pt / ≥ 14 pt bold) */
  AA_LARGE: 3,
};

/**
 * Return the highest WCAG conformance level for a given ratio.
 *
 * @param {number | null} ratio
 * @returns {'AAA' | 'AA' | 'AA-large' | 'fail' | 'unknown'}
 */
export function getWcagLevel(ratio) {
  if (ratio == null) return 'unknown';
  if (ratio >= WCAG.AAA) return 'AAA';
  if (ratio >= WCAG.AA) return 'AA';
  if (ratio >= WCAG.AA_LARGE) return 'AA-large';
  return 'fail';
}

/**
 * Human-readable contrast ratio string (e.g. "4.5:1").
 *
 * @param {number | null} ratio
 * @returns {string}
 */
export function formatRatio(ratio) {
  if (ratio == null) return '—';
  return `${ratio.toFixed(1)}:1`;
}
