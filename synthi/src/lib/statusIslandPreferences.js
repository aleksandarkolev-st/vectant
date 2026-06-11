export const STATUS_ISLAND_OFFSET_KEY = 'synthi:status-island-offset';
export const STATUS_ISLAND_COMPACT_KEY = 'synthi:status-island-compact';
export const STATUS_ISLAND_POSITION_LOCK_KEY = 'synthi:status-island-position-locked';
export const STATUS_ISLAND_DOCK_KEY = 'synthi:status-island-dock';
export const STATUS_ISLAND_SAVED_PRESETS_KEY = 'synthi:status-island-saved-presets';
export const STATUS_ISLAND_SHARED_SCOPE = 'shared';
export const STATUS_ISLAND_MOBILE_SCOPE = 'mobile';

const STATUS_ISLAND_SETTINGS_EVENT = 'synthi:status-island-preferences-change';

export const STATUS_ISLAND_DOCK_PRESETS = ['free', 'left', 'center', 'right'];

export const STATUS_ISLAND_MENU_PRESETS = {
  default: {
    label: 'Default',
    isCompact: false,
    isPositionLocked: false,
    dockPreset: 'center',
  },
  minimal: {
    label: 'Minimal',
    isCompact: true,
    isPositionLocked: false,
    dockPreset: 'center',
  },
  'left-rail': {
    label: 'Left rail',
    isCompact: true,
    isPositionLocked: true,
    dockPreset: 'left',
  },
  'right-rail': {
    label: 'Right rail',
    isCompact: true,
    isPositionLocked: true,
    dockPreset: 'right',
  },
};

function getStatusIslandScopedKey(baseKey, scope = STATUS_ISLAND_SHARED_SCOPE) {
  return scope === STATUS_ISLAND_MOBILE_SCOPE
    ? `${baseKey}:mobile`
    : baseKey;
}

function readStatusIslandOffset(scope = STATUS_ISLAND_SHARED_SCOPE) {
  if (typeof window === 'undefined') return null;

  try {
    const saved = window.localStorage?.getItem(getStatusIslandScopedKey(STATUS_ISLAND_OFFSET_KEY, scope));
    if (!saved) return null;

    const parsed = JSON.parse(saved);
    if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number') {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

function emitStatusIslandPreferencesChanged() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(STATUS_ISLAND_SETTINGS_EVENT));
}

export function sanitizeStatusIslandPresetLabel(rawLabel) {
  return String(rawLabel || '').trim().slice(0, 40);
}

export function normalizeSavedPreset(candidate, fallbackId) {
  if (!candidate || typeof candidate !== 'object') return null;

  const label = sanitizeStatusIslandPresetLabel(candidate.label);
  if (!label) return null;

  const dockPreset = STATUS_ISLAND_DOCK_PRESETS.includes(candidate.dockPreset)
    ? candidate.dockPreset
    : 'center';

  return {
    id: typeof candidate.id === 'string' && candidate.id ? candidate.id : fallbackId,
    label,
    isCompact: Boolean(candidate.isCompact),
    isPositionLocked: Boolean(candidate.isPositionLocked),
    dockPreset,
  };
}

export function doesPresetMatchState(preset, state) {
  return preset.isCompact === state.isCompact
    && preset.isPositionLocked === state.isPositionLocked
    && preset.dockPreset === state.dockPreset;
}

export function readStatusIslandCompact() {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage?.getItem(STATUS_ISLAND_COMPACT_KEY) === '1';
  } catch {
    return false;
  }
}

export function persistStatusIslandCompact(next) {
  const resolved = Boolean(next);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage?.setItem(STATUS_ISLAND_COMPACT_KEY, resolved ? '1' : '0');
    } catch {
      // Ignore storage failures; in-memory state can still update.
    }
    emitStatusIslandPreferencesChanged();
  }
  return resolved;
}

export function readStatusIslandPositionLocked(scope = STATUS_ISLAND_SHARED_SCOPE) {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage?.getItem(getStatusIslandScopedKey(STATUS_ISLAND_POSITION_LOCK_KEY, scope)) === '1';
  } catch {
    return false;
  }
}

export function persistStatusIslandPositionLocked(next, scope = STATUS_ISLAND_SHARED_SCOPE) {
  const resolved = Boolean(next);
  if (typeof window !== 'undefined') {
    try {
      window.localStorage?.setItem(getStatusIslandScopedKey(STATUS_ISLAND_POSITION_LOCK_KEY, scope), resolved ? '1' : '0');
    } catch {
      // Ignore storage failures; in-memory state can still update.
    }
    emitStatusIslandPreferencesChanged();
  }
  return resolved;
}

export function readStatusIslandDockPreset(scope = STATUS_ISLAND_SHARED_SCOPE) {
  if (typeof window === 'undefined') return 'center';

  try {
    const saved = window.localStorage?.getItem(getStatusIslandScopedKey(STATUS_ISLAND_DOCK_KEY, scope));
    if (STATUS_ISLAND_DOCK_PRESETS.includes(saved)) {
      return saved;
    }

    const parsedOffset = readStatusIslandOffset(scope);
    if (parsedOffset?.x || parsedOffset?.y) {
      return 'free';
    }

    return 'center';
  } catch {
    return 'center';
  }
}

export function persistStatusIslandDockPreset(next, scope = STATUS_ISLAND_SHARED_SCOPE) {
  const resolved = STATUS_ISLAND_DOCK_PRESETS.includes(next) ? next : 'free';
  if (typeof window !== 'undefined') {
    try {
      window.localStorage?.setItem(getStatusIslandScopedKey(STATUS_ISLAND_DOCK_KEY, scope), resolved);
    } catch {
      // Ignore storage failures; in-memory state can still update.
    }
    emitStatusIslandPreferencesChanged();
  }
  return resolved;
}

export function applyStatusIslandPreferenceState(state, scope = STATUS_ISLAND_SHARED_SCOPE) {
  const resolved = {
    isCompact: Boolean(state?.isCompact),
    isPositionLocked: Boolean(state?.isPositionLocked),
    dockPreset: STATUS_ISLAND_DOCK_PRESETS.includes(state?.dockPreset) ? state.dockPreset : 'center',
  };

  if (typeof window !== 'undefined') {
    try {
      window.localStorage?.setItem(STATUS_ISLAND_COMPACT_KEY, resolved.isCompact ? '1' : '0');
      window.localStorage?.setItem(getStatusIslandScopedKey(STATUS_ISLAND_POSITION_LOCK_KEY, scope), resolved.isPositionLocked ? '1' : '0');
      window.localStorage?.setItem(getStatusIslandScopedKey(STATUS_ISLAND_DOCK_KEY, scope), resolved.dockPreset);
    } catch {
      // Ignore storage failures; in-memory state can still update.
    }
    emitStatusIslandPreferencesChanged();
  }

  return resolved;
}

export function readStatusIslandSavedPresets() {
  if (typeof window === 'undefined') return [];

  try {
    const savedPresetBlob = window.localStorage?.getItem(STATUS_ISLAND_SAVED_PRESETS_KEY);
    if (!savedPresetBlob) return [];
    const parsed = JSON.parse(savedPresetBlob);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((preset, index) => normalizeSavedPreset(preset, `status-island-preset-${index + 1}`))
      .filter(Boolean);
  } catch {
    return [];
  }
}

export function persistStatusIslandSavedPresets(next) {
  const normalized = Array.isArray(next)
    ? next
      .map((preset, index) => normalizeSavedPreset(preset, `status-island-preset-${index + 1}`))
      .filter(Boolean)
    : [];

  if (typeof window !== 'undefined') {
    try {
      window.localStorage?.setItem(STATUS_ISLAND_SAVED_PRESETS_KEY, JSON.stringify(normalized));
    } catch {
      // Ignore storage failures; in-memory state can still update.
    }
    emitStatusIslandPreferencesChanged();
  }

  return normalized;
}

export function readStatusIslandPreferences(scope = STATUS_ISLAND_SHARED_SCOPE) {
  return {
    isCompact: readStatusIslandCompact(),
    isPositionLocked: readStatusIslandPositionLocked(scope),
    dockPreset: readStatusIslandDockPreset(scope),
    savedPresets: readStatusIslandSavedPresets(),
  };
}

export function subscribeStatusIslandPreferences(callback, scope = STATUS_ISLAND_SHARED_SCOPE) {
  if (typeof window === 'undefined') return () => {};

  const relevantKeys = new Set([
    STATUS_ISLAND_COMPACT_KEY,
    getStatusIslandScopedKey(STATUS_ISLAND_POSITION_LOCK_KEY, scope),
    getStatusIslandScopedKey(STATUS_ISLAND_DOCK_KEY, scope),
    STATUS_ISLAND_SAVED_PRESETS_KEY,
  ]);

  const notify = () => {
    callback(readStatusIslandPreferences(scope));
  };

  const handleStorage = (event) => {
    if (!event.key || relevantKeys.has(event.key)) {
      notify();
    }
  };

  window.addEventListener('storage', handleStorage);
  window.addEventListener(STATUS_ISLAND_SETTINGS_EVENT, notify);

  return () => {
    window.removeEventListener('storage', handleStorage);
    window.removeEventListener(STATUS_ISLAND_SETTINGS_EVENT, notify);
  };
}

export function upsertStatusIslandSavedPreset({ label, state, activePresetId = '' }) {
  const normalizedLabel = sanitizeStatusIslandPresetLabel(label);
  if (!normalizedLabel) {
    return {
      error: 'empty-label',
      updated: false,
      preset: null,
      presets: readStatusIslandSavedPresets(),
    };
  }

  const previous = readStatusIslandSavedPresets();
  const existingById = activePresetId ? previous.find((preset) => preset.id === activePresetId) : null;
  const existingByLabel = previous.find((preset) => preset.label.toLowerCase() === normalizedLabel.toLowerCase());
  const targetPreset = existingById || existingByLabel;
  const nextPreset = normalizeSavedPreset({
    id: targetPreset?.id || `status-island-preset-${Date.now()}`,
    label: normalizedLabel,
    ...state,
  }, `status-island-preset-${Date.now()}`);
  const next = targetPreset
    ? previous.map((preset) => (preset.id === targetPreset.id ? nextPreset : preset))
    : [...previous, nextPreset];

  return {
    error: null,
    updated: Boolean(targetPreset),
    preset: nextPreset,
    presets: persistStatusIslandSavedPresets(next),
  };
}

export function deleteStatusIslandSavedPreset(presetId) {
  const previous = readStatusIslandSavedPresets();
  const next = previous.filter((preset) => preset.id !== presetId);

  return {
    deleted: next.length !== previous.length,
    presets: persistStatusIslandSavedPresets(next),
  };
}