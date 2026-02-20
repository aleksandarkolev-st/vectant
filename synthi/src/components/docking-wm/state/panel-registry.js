/**
 * @fileoverview Panel Registry — manages panel type registrations.
 * Panel components register themselves once, and the docking system
 * uses this registry to render the correct component for each tab.
 */

'use client';

import { createContext, useContext, useCallback, useRef, useMemo } from 'react';

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

// ─── React Context for Panel Registry ───────────────────

const PanelRegistryContext = createContext(null);

/**
 * Provider that exposes the panel registry to the React tree.
 */
export function PanelRegistryProvider({ children }) {
  const registryRef = useRef(globalRegistry);

  const register = useCallback((registration) => {
    registerPanel(registration);
    // Force a re-render could be triggered if needed
  }, []);

  const unregister = useCallback((panelType) => {
    unregisterPanel(panelType);
  }, []);

  const get = useCallback((panelType) => {
    return getPanel(panelType);
  }, []);

  const getAll = useCallback(() => {
    return getAllPanels();
  }, []);

  const value = useMemo(
    () => ({
      register,
      unregister,
      get,
      getAll,
      has: hasPanel,
    }),
    [register, unregister, get, getAll]
  );

  return (
    <PanelRegistryContext.Provider value={value}>
      {children}
    </PanelRegistryContext.Provider>
  );
}

/**
 * Hook to access the panel registry.
 * @returns {{ register, unregister, get, getAll, has }}
 */
export function usePanelRegistry() {
  const ctx = useContext(PanelRegistryContext);
  if (!ctx) {
    // Fallback to global registry if outside provider
    return {
      register: registerPanel,
      unregister: unregisterPanel,
      get: getPanel,
      getAll: getAllPanels,
      has: hasPanel,
    };
  }
  return ctx;
}

// ─── Built-in Panel Types ───────────────────────────────

/** Well-known panel type constants */
export const PANEL_TYPES = Object.freeze({
  EXPLORER: 'explorer',
  EDITOR: 'editor',
  TERMINAL: 'terminal',
  SEARCH: 'search',
  SOURCE_CONTROL: 'source-control',
  EXTENSIONS: 'extensions',
  PROBLEMS: 'problems',
  OUTPUT: 'output',
  DEBUG_CONSOLE: 'debug-console',
  CHAT: 'chat',
  EMULATOR: 'emulator',
  SETTINGS: 'settings',
});
