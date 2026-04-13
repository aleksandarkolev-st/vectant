// ============================================================
// adapter-health-panel.js — Frontend adapter health panel
// ============================================================
// React-free reactive UI component data for displaying adapter
// health in the IDE.  Aggregates signals from adapter-status
// and ai-loop-status into a unified health view.
// ============================================================

const INITIAL_PANEL = {
  /** @type {'hidden'|'minimized'|'expanded'} */
  displayMode: 'hidden',

  /** Per-adapter-family health summary. */
  adapters: {
    dynlib:          { active: false, health: 'unknown', reloads: 0, lastMs: null },
    managed_runtime: { active: false, health: 'unknown', reloads: 0, lastMs: null },
    process_swap:    { active: false, health: 'unknown', reloads: 0, lastMs: null },
  },

  /** Aggregate health across all active adapters. */
  overallHealth: 'unknown',

  /** Lifecycle state of the primary adapter. */
  lifecycleState: 'created',

  /** Whether AI loop is active. */
  aiActive: false,

  /** Error messages to surface. */
  errors: [],
};

let panelState = deepCopy(INITIAL_PANEL);
const panelListeners = new Set();

function deepCopy(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function notifyPanel() {
  const snapshot = deepCopy(panelState);
  panelListeners.forEach((fn) => fn(snapshot));
}

/**
 * Subscribe to health panel updates.
 * @param {(state: typeof INITIAL_PANEL) => void} fn
 * @returns {() => void} unsubscribe
 */
export function subscribeHealthPanel(fn) {
  panelListeners.add(fn);
  fn(deepCopy(panelState));
  return () => panelListeners.delete(fn);
}

/** Get current panel snapshot. */
export function getHealthPanel() {
  return deepCopy(panelState);
}

/**
 * Update a specific adapter's health data.
 * @param {'dynlib'|'managed_runtime'|'process_swap'} family
 * @param {object} update
 */
export function updateAdapterHealth(family, update) {
  if (!panelState.adapters[family]) return;

  const a = panelState.adapters[family];
  if (update.active != null) a.active = update.active;
  if (update.health != null) a.health = update.health;
  if (update.reloads != null) a.reloads = update.reloads;
  if (update.lastMs != null) a.lastMs = update.lastMs;

  recomputeOverallHealth();
  notifyPanel();
}

/**
 * Set the lifecycle state.
 * @param {string} state
 */
export function setLifecycleState(state) {
  panelState.lifecycleState = state;
  notifyPanel();
}

/**
 * Set AI loop active flag.
 * @param {boolean} active
 */
export function setAiActive(active) {
  panelState.aiActive = active;
  notifyPanel();
}

/**
 * Push an error message.
 * @param {string} message
 */
export function pushError(message) {
  panelState.errors.push(message);
  // Keep last 20 errors.
  if (panelState.errors.length > 20) {
    panelState.errors = panelState.errors.slice(-20);
  }
  notifyPanel();
}

/** Clear all errors. */
export function clearErrors() {
  panelState.errors = [];
  notifyPanel();
}

/**
 * Set display mode.
 * @param {'hidden'|'minimized'|'expanded'} mode
 */
export function setDisplayMode(mode) {
  panelState.displayMode = mode;
  notifyPanel();
}

/** Reset to initial state. */
export function resetHealthPanel() {
  panelState = deepCopy(INITIAL_PANEL);
  notifyPanel();
}

// ---- Internal helpers ----

function recomputeOverallHealth() {
  const active = Object.values(panelState.adapters).filter((a) => a.active);
  if (active.length === 0) {
    panelState.overallHealth = 'unknown';
    return;
  }

  const hasFaulted = active.some((a) => a.health === 'faulted');
  const hasDegraded = active.some((a) => a.health === 'degraded');

  if (hasFaulted) {
    panelState.overallHealth = 'faulted';
  } else if (hasDegraded) {
    panelState.overallHealth = 'degraded';
  } else {
    panelState.overallHealth = 'healthy';
  }
}
