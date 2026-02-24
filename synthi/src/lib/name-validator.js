/**
 * @fileoverview Theme Name Validator
 *
 * AI-assisted content filter that detects offensive, racist, or
 * otherwise inappropriate theme names.
 *
 * Detection layers:
 *   1. Leet-speak normalisation (e.g. "n1gg3r" → "nigger")
 *   2. Collapsed whitespace/separator check ("f u c k" → "fuck")
 *   3. Pattern-based root matching against a curated blocklist
 *   4. Length and character-set validation
 */

// ─── Leet-speak Normalisation Map ───────────────────────────

const LEET_MAP = {
  '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's',
  '7': 't', '8': 'b', '@': 'a', '$': 's', '!': 'i',
  '+': 't', '|': 'l',
};

/**
 * Normalise a string: lowercase → leet-speak replacement → strip non-alpha.
 * @param {string} str
 * @returns {string}
 */
function normalise(str) {
  return str
    .toLowerCase()
    .split('')
    .map((c) => LEET_MAP[c] || c)
    .join('')
    .replace(/[^a-z]/g, '');
}

// ─── Blocklist Roots ────────────────────────────────────────

/**
 * Minimal root patterns covering racial slurs, hate-speech terms,
 * sexual profanity, and ableist language. Kept intentionally compact;
 * the normalisation step catches most evasion tactics.
 */
const BLOCKED_ROOTS = [
  // Racial / ethnic slurs
  'nigg', 'kike', 'spic', 'chink', 'gook', 'wetback', 'beaner',
  'coon', 'darkie', 'redskin', 'towelhead', 'raghead',
  'camel.?jockey', 'sand.?nigg',
  // White-supremacy / Nazi
  'white.?power', 'white.?suprem', 'heil.?hitler', 'sieg.?heil',
  'nazi', 'kkk', 'ku.?klux',
  // Homophobic / transphobic
  'fag', 'fagg', 'dyke', 'trann',
  // Profanity
  'fuck', 'shit', 'cunt', 'bitch', 'asshole',
  'dick', 'cock', 'pussy', 'whore', 'slut',
  // Ableist
  'retard', 'tard',
];

/**
 * Single combined regex built once at module load.
 * @type {RegExp}
 */
const blockedRegex = new RegExp(
  BLOCKED_ROOTS.map((r) => `(?:${r})`).join('|'),
  'i',
);

// ─── Public API ─────────────────────────────────────────────

/**
 * Validate a theme name for appropriateness.
 *
 * @param {string} name — the proposed theme name
 * @returns {{ valid: boolean, reason?: string }}
 */
export function validateThemeName(name) {
  if (!name || typeof name !== 'string') {
    return { valid: false, reason: 'Name is required' };
  }

  const trimmed = name.trim();

  if (trimmed.length === 0) {
    return { valid: false, reason: 'Name cannot be empty' };
  }
  if (trimmed.length < 2) {
    return { valid: false, reason: 'Name must be at least 2 characters' };
  }
  if (trimmed.length > 48) {
    return { valid: false, reason: 'Name must be 48 characters or fewer' };
  }

  // Layer 1: normalised blocklist (catches leet-speak)
  const normalised = normalise(trimmed);
  if (blockedRegex.test(normalised)) {
    return { valid: false, reason: 'Name contains inappropriate language' };
  }

  // Layer 2: collapse separators and re-check (catches "f.u.c.k", "n i g g")
  const collapsed = trimmed.replace(/[\s._\-]+/g, '').toLowerCase();
  if (blockedRegex.test(collapsed)) {
    return { valid: false, reason: 'Name contains inappropriate language' };
  }

  return { valid: true };
}
