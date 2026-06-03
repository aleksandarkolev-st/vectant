/**
 * @fileoverview Panel Registry — manages panel type registrations.
 * Panel components register themselves once, and the docking system
 * uses this registry to render the correct component for each tab.
 */

'use client';

import { createContext, useContext, useCallback, useMemo } from 'react';
import {
  registerPanel,
  unregisterPanel,
  getPanel,
  getAllPanels,
  hasPanel,
} from './panel-registry-core';

// Re-export the core registry primitives so consumers that import them from this
// wrapper (DockableWorkspace, the docking-wm barrel, the state barrel) keep working
// after the panel-registry-core extraction (C1).
export { registerPanel, unregisterPanel, getPanel, getAllPanels, hasPanel } from './panel-registry-core';

// ─── React Context for Panel Registry ───────────────────

const PanelRegistryContext = createContext(null);

/**
 * Provider that exposes the panel registry to the React tree.
 */
export function PanelRegistryProvider({ children }) {
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
