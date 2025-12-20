'use client';
import { useEffect } from 'react';
import { useAppDispatch } from '@/redux/hooks';
import { hydrateUi } from '@/redux/uiSlice';
import { loadUiPrefs, loadExpandedFolders } from '@/redux/store';

/**
 * StoreHydrator - Hydrates global UI preferences from localStorage.
 * 
 * Note: Workspace-specific state (open tabs, active tab) is now hydrated by
 * WorkspaceHydrator component which is placed in the workspace page after
 * the slug is known. This ensures each workspace maintains its own tabs.
 */
export default function StoreHydrator() {
  const dispatch = useAppDispatch();

  useEffect(() => {
    // Hydrate global UI preferences
    const uiPrefs = loadUiPrefs();
    const expandedFolders = loadExpandedFolders();
    
    if (uiPrefs || expandedFolders) {
      const payload = { ...(uiPrefs || {}) };
      if (expandedFolders) payload.expandedFolders = expandedFolders;
      dispatch(hydrateUi(payload));
    }

    // Note: Workspace tabs are now hydrated per-workspace by WorkspaceHydrator
  }, [dispatch]);

  return null;
}
