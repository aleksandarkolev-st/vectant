/**
 * @fileoverview DockingProvider — root context provider for the docking system.
 * Wraps PanelRegistryProvider and provides layout persistence.
 */

'use client';

import React, { createContext, useContext, useMemo, useEffect, useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { PanelRegistryProvider } from '../state/panel-registry';
import { selectLayout, setLayout, resetLayout } from '../state/layout-slice';
import { useLayoutPersistence } from '../hooks/use-layout-persistence';
import { usePopout } from '../hooks/use-popout';
import {
  saveProfile,
  loadAllProfiles,
  deleteProfile,
  loadProfileLayout,
} from '../utils/serialization';
import { profileId as generateProfileId } from '../utils/id-generator';

const DockingContext = createContext(null);

/**
 * Root provider for the docking window manager.
 * Place this near the top of your component tree, inside the Redux Provider.
 *
 * @param {Object} props
 * @param {string} props.workspaceSlug - current workspace identifier
 * @param {import('../types').LayoutState} [props.defaultLayout] - initial layout if none saved
 * @param {boolean} [props.persistLayout] - enable localStorage persistence
 * @param {React.ReactNode} props.children
 */
export function DockingProvider({
  workspaceSlug,
  defaultLayout,
  persistLayout = true,
  children,
}) {
  const dispatch = useDispatch();
  const layout = useSelector(selectLayout);

  // Persistence
  const persistence = useLayoutPersistence({
    workspaceSlug,
    enabled: persistLayout,
  });

  // Popout windows
  const popout = usePopout();

  // Initialize with default layout if empty
  useEffect(() => {
    if (defaultLayout && !persistence.isLoaded) {
      // Wait for persistence to try loading first
    }
  }, [defaultLayout, persistence.isLoaded]);

  useEffect(() => {
    if (persistence.isLoaded && defaultLayout) {
      // If nothing was loaded from storage, use default
      const hasContent =
        layout.rootId && Object.keys(layout.nodes).length > 1;
      if (!hasContent) {
        dispatch(setLayout(defaultLayout));
      }
    }
  }, [persistence.isLoaded, defaultLayout, dispatch, layout.rootId, layout.nodes]);

  // ── Profile Management ─────────────────────────────

  const saveCurrentAsProfile = useCallback(
    (name, description) => {
      const id = generateProfileId();
      const now = Date.now();
      saveProfile({
        id,
        name,
        description,
        createdAt: now,
        updatedAt: now,
        layout: { ...layout },
      });
      return id;
    },
    [layout]
  );

  const loadProfile = useCallback(
    (profileIdVal) => {
      const loaded = loadProfileLayout(profileIdVal);
      if (loaded) {
        dispatch(setLayout(loaded));
      }
      return loaded;
    },
    [dispatch]
  );

  const removeProfile = useCallback((profileIdVal) => {
    deleteProfile(profileIdVal);
  }, []);

  const getAllProfiles = useCallback(() => {
    return Object.values(loadAllProfiles());
  }, []);

  const resetToDefault = useCallback(() => {
    if (defaultLayout) {
      dispatch(setLayout(defaultLayout));
    } else {
      dispatch(resetLayout());
    }
  }, [defaultLayout, dispatch]);

  // ── Context Value ──────────────────────────────────

  const value = useMemo(
    () => ({
      workspaceSlug,

      // Persistence
      persistence,

      // Popout
      popout,

      // Profiles
      profiles: {
        save: saveCurrentAsProfile,
        load: loadProfile,
        remove: removeProfile,
        getAll: getAllProfiles,
        resetToDefault,
      },
    }),
    [
      workspaceSlug,
      persistence,
      popout,
      saveCurrentAsProfile,
      loadProfile,
      removeProfile,
      getAllProfiles,
      resetToDefault,
    ]
  );

  return (
    <DockingContext.Provider value={value}>
      <PanelRegistryProvider>
        {children}
      </PanelRegistryProvider>
    </DockingContext.Provider>
  );
}

/**
 * Hook to access the docking provider context.
 */
export function useDockingContext() {
  const ctx = useContext(DockingContext);
  if (!ctx) {
    throw new Error('useDockingContext must be used within a DockingProvider');
  }
  return ctx;
}

export default DockingProvider;
