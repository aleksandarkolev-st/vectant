'use client';
import { useEffect } from 'react';
import { useAppDispatch } from '@/redux/hooks';
import { hydrateUi } from '@/redux/uiSlice';
import { hydrateWorkspace } from '@/redux/workspaceSlice';
import { loadUiPrefs, loadOpenTabs, loadActiveTab, loadExpandedFolders } from '@/redux/store';

export default function StoreHydrator() {
  const dispatch = useAppDispatch();

  useEffect(() => {
    const uiPrefs = loadUiPrefs();
    const expandedFolders = loadExpandedFolders();
    
    if (uiPrefs || expandedFolders) {
      const payload = { ...(uiPrefs || {}) };
      if (expandedFolders) payload.expandedFolders = expandedFolders;
      dispatch(hydrateUi(payload));
    }

    const openTabs = loadOpenTabs();
    const activeTab = loadActiveTab();
    
    if (openTabs || activeTab) {
        const payload = {};
        if (openTabs) payload.openFiles = openTabs;
        if (activeTab) payload.activeFile = activeTab;
        
        // If we have open tabs, we should try to match activeTab to one of them
        if (openTabs && activeTab) {
             const match = openTabs.find(f => f.path === activeTab.path);
             if (match) payload.activeFile = match;
        }
        
        dispatch(hydrateWorkspace(payload));
    }
  }, [dispatch]);

  return null;
}
