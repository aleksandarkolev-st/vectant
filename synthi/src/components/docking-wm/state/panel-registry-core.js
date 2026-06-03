/**
 * @fileoverview JSX-free panel registry primitives.
 *
 * Reducers, utilities, and tests import this module directly so they can
 * consult panel metadata without pulling in the React provider wrapper.
 */

/**
 * @type {Map<string, import('../types').PanelRegistration>}
 */
const globalRegistry = new Map();

/**
 * Register a panel type. Call once per panel type at module load.
 *
 * @param {import('../types').PanelRegistration} registration
 */
export function registerPanel(registration) {
  if (!registration.panelType) {
    throw new Error('[docking-wm] Panel registration must have a panelType');
  }
  if (globalRegistry.has(registration.panelType)) {
    console.warn(
      `[docking-wm] Panel type '${registration.panelType}' is already registered. Overwriting.`
    );
  }
  globalRegistry.set(registration.panelType, {
    closable: true,
    singleton: false,
    ...registration,
  });
}

/**
 * Unregister a panel type.
 * @param {string} panelType
 */
export function unregisterPanel(panelType) {
  globalRegistry.delete(panelType);
}

/**
 * Get a panel registration by type.
 * @param {string} panelType
 * @returns {import('../types').PanelRegistration|undefined}
 */
export function getPanel(panelType) {
  return globalRegistry.get(panelType);
}

/**
 * Get all registered panel types.
 * @returns {import('../types').PanelRegistration[]}
 */
export function getAllPanels() {
  return Array.from(globalRegistry.values());
}

/**
 * Check if a panel type is registered.
 * @param {string} panelType
 * @returns {boolean}
 */
export function hasPanel(panelType) {
  return globalRegistry.has(panelType);
}