'use client';

/**
 * Terminal color overrides — per-browser tweaks layered on top of whatever
 * `terminalTheme` ThemeProvider produces. Persisted to localStorage so the
 * user's tweaks survive reloads; broadcast over a window event so every
 * TerminalPane (memo-frozen) can re-apply without the parent re-rendering.
 */

const STORAGE_KEY = 'synthi-terminal-color-overrides-v1';
const EVENT_NAME = 'synthi:terminal-colors-changed';

/** All keys the user can customise (xterm.js ITheme fields we expose). */
export const TERMINAL_COLOR_KEYS = [
  'background',
  'foreground',
  'cursor',
  'cursorAccent',
  'selectionBackground',
  'selectionForeground',
  'black',
  'red',
  'green',
  'yellow',
  'blue',
  'magenta',
  'cyan',
  'white',
  'brightBlack',
  'brightRed',
  'brightGreen',
  'brightYellow',
  'brightBlue',
  'brightMagenta',
  'brightCyan',
  'brightWhite',
];

let cache = null;

function readFromStorage() {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (_) {
    return {};
  }
}

export function getTerminalOverrides() {
  if (cache === null) cache = readFromStorage();
  return cache;
}

export function setTerminalOverrides(next) {
  cache = next && typeof next === 'object' ? { ...next } : {};
  if (typeof window !== 'undefined') {
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cache)); } catch (_) {}
    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: cache }));
  }
}

export function clearTerminalOverrides() {
  setTerminalOverrides({});
}

/**
 * Subscribe to override changes. Returns an unsubscribe fn.
 * @param {(overrides: Record<string, string>) => void} cb
 */
export function subscribeTerminalOverrides(cb) {
  if (typeof window === 'undefined') return () => {};
  const handler = (e) => cb(e?.detail || getTerminalOverrides());
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}

/** Merge overrides onto a base xterm theme, dropping empty values. */
export function applyOverridesToTheme(baseTheme, overrides) {
  const merged = { ...(baseTheme || {}) };
  for (const [k, v] of Object.entries(overrides || {})) {
    if (typeof v === 'string' && v.trim()) merged[k] = v;
  }
  return merged;
}
