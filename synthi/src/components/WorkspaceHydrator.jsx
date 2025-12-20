'use client';
import { useEffect, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import { hydrateWorkspace } from '@/redux/workspaceSlice';
import { loadOpenTabs, loadActiveTab } from '@/redux/store';

/**
 * WorkspaceHydrator - Hydrates workspace-specific state (open tabs and active tab)
 * from localStorage when a workspace slug is known.
 * 
 * This component should be placed inside the workspace page after the slug is set.
 * It ensures each workspace maintains its own set of open tabs independently.
 */
export default function WorkspaceHydrator({ slug }) {
  const dispatch = useAppDispatch();
  const hasHydrated = useRef(false);
  
  // Get the current openFiles count to avoid hydrating if tabs are already open
  const openFilesCount = useAppSelector(state => state.workspace.openFiles?.length || 0);

  useEffect(() => {
    // Only hydrate once per slug, and only if we haven't already loaded tabs
    if (!slug || hasHydrated.current) return;
    
    // If tabs are already open (e.g., user already interacted), don't override
    if (openFilesCount > 0) {
      hasHydrated.current = true;
      return;
    }

    const openTabs = loadOpenTabs(slug);
    const activeTab = loadActiveTab(slug);

    if (openTabs || activeTab) {
      const payload = {};
      if (openTabs) payload.openFiles = openTabs;
      if (activeTab) payload.activeFile = activeTab;

      // If we have open tabs, ensure activeTab matches one of them
      if (openTabs && activeTab) {
        const match = openTabs.find(f => f.path === activeTab.path);
        if (match) payload.activeFile = match;
      }

      dispatch(hydrateWorkspace(payload));
    }

    hasHydrated.current = true;
  }, [slug, dispatch, openFilesCount]);

  // Reset hydration flag when slug changes (navigating to different workspace)
  useEffect(() => {
    hasHydrated.current = false;
  }, [slug]);

  return null;
}
