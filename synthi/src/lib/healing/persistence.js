// src/lib/healing/persistence.js
// localStorage persistence for self-healing configuration.
//
// Only persists `enabled` + `config` (NOT applied fix history, undo stacks,
// or transient status).  Writes are debounced to avoid thrashing localStorage.

const STORAGE_KEY = 'synthi.healing.v2';
const WRITE_DEBOUNCE_MS = 400;

export function loadHealingPersistedState() {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // Corrupt data — ignore, next save will overwrite.
  }
  return null;
}

let writeTimer = null;
export function saveHealingPersistedState({ enabled, config }) {
  if (typeof window === 'undefined') return;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ enabled, config })
      );
    } catch {
      // Quota exceeded or disabled storage — silently ignore.
    }
  }, WRITE_DEBOUNCE_MS);
}

export function clearHealingPersistedState() {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore.
  }
}
