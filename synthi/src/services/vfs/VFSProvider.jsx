/**
 * VFS React Context Provider
 * 
 * Provides the Virtual File System to React components and integrates
 * with the existing Redux store for seamless state management.
 */

'use client';

import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '@/redux/hooks';
import { updateContent as reduxUpdateContent } from '@/redux/workspaceSlice';
import { getVFS, destroyVFS } from './VirtualFileSystem';

// ============================================================================
// Context
// ============================================================================

const VFSContext = createContext(null);

/**
 * Hook to use VFS from any component
 * @returns {{
 *   vfs: import('./VirtualFileSystem').VirtualFileSystem | null,
 *   readFile: (path: string) => Promise<import('./VirtualFileSystem').VFSFile>,
 *   updateFile: (path: string, content: string) => Promise<void>,
 *   saveFile: (path: string) => Promise<void>,
 *   getCurrentContent: (path: string) => string | null,
 *   isConnected: boolean,
 *   isDirty: (path: string) => boolean,
 * }}
 */
export function useVFS() {
  const context = useContext(VFSContext);
  if (!context) {
    throw new Error('useVFS must be used within a VFSProvider');
  }
  return context;
}

// ============================================================================
// Provider
// ============================================================================

/**
 * VFS Provider component
 * @param {{ children: React.ReactNode, workspaceId: string }} props
 */
export function VFSProvider({ children, workspaceId }) {
  const dispatch = useAppDispatch();
  const [vfs, setVfs] = useState(null);
  const [isConnected, setIsConnected] = useState(false);
  
  // Track which file content was last synced to Redux to avoid loops
  const lastSyncedRef = useRef(new Map());
  
  // Initialize VFS when workspace changes
  useEffect(() => {
    if (!workspaceId) {
      setVfs(null);
      setIsConnected(false);
      return;
    }
    
    const vfsInstance = getVFS(workspaceId);
    setVfs(vfsInstance);
    
    // Connect
    vfsInstance.connect().then(() => {
      setIsConnected(true);
    }).catch(err => {
      console.error('[VFS Provider] Connection failed:', err);
    });
    
    // Event handlers
    const handleConnected = () => setIsConnected(true);
    const handleDisconnected = () => setIsConnected(false);
    
    const handleChange = (event) => {
      if (event.type === 'change' && event.file) {
        // Sync to Redux for UI updates
        // Only if content is different from last synced to avoid loops
        const lastSynced = lastSyncedRef.current.get(event.path);
        if (lastSynced !== event.file.contentHash) {
          lastSyncedRef.current.set(event.path, event.file.contentHash);
          
          // Dispatch to Redux - this updates the editor
          // Note: We need to be careful here to not create a feedback loop
          // The Editor should use VFS directly for content updates
        }
      }
    };
    
    const handleConflict = (event) => {
      console.warn('[VFS Provider] Conflict detected:', event.path);
      // TODO: Show conflict resolution UI
    };
    
    vfsInstance.on('connected', handleConnected);
    vfsInstance.on('disconnected', handleDisconnected);
    vfsInstance.on('change', handleChange);
    vfsInstance.on('conflict', handleConflict);
    
    return () => {
      vfsInstance.off('connected', handleConnected);
      vfsInstance.off('disconnected', handleDisconnected);
      vfsInstance.off('change', handleChange);
      vfsInstance.off('conflict', handleConflict);
      
      // Note: We don't destroy VFS on unmount as it may be reused
      // destroyVFS(workspaceId);
    };
  }, [workspaceId, dispatch]);
  
  // ==========================================================================
  // API Methods
  // ==========================================================================
  
  /**
   * Read a file from VFS
   */
  const readFile = useCallback(async (path) => {
    if (!vfs) throw new Error('VFS not initialized');
    return vfs.readFile(path);
  }, [vfs]);
  
  /**
   * Update file content (marks as dirty, doesn't save)
   * This should be called on every editor change
   */
  const updateFile = useCallback(async (path, content) => {
    if (!vfs) throw new Error('VFS not initialized');
    
    const file = await vfs.updateContent(path, content);
    
    // Update last synced hash
    lastSyncedRef.current.set(path, file.contentHash);
    
    return file;
  }, [vfs]);
  
  /**
   * Save file to server
   */
  const saveFile = useCallback(async (path, content) => {
    if (!vfs) throw new Error('VFS not initialized');
    
    if (content !== undefined) {
      return vfs.saveFile(path, content);
    }
    return vfs.saveFile(path);
  }, [vfs]);
  
  /**
   * Get current content from hot cache (synchronous, for performance)
   */
  const getCurrentContent = useCallback((path) => {
    if (!vfs) return null;
    const file = vfs.getFromHotCache(path);
    return file?.content || null;
  }, [vfs]);
  
  /**
   * Check if a file has unsaved changes
   */
  const isDirty = useCallback((path) => {
    if (!vfs) return false;
    const file = vfs.getFromHotCache(path);
    return file?.syncState === 'dirty';
  }, [vfs]);
  
  /**
   * Get all dirty files
   */
  const getDirtyFiles = useCallback(() => {
    if (!vfs) return [];
    return vfs.getDirtyFiles();
  }, [vfs]);
  
  /**
   * Force refresh a file from server
   */
  const refreshFile = useCallback(async (path) => {
    if (!vfs) throw new Error('VFS not initialized');
    return vfs.readFile(path, { forceServer: true });
  }, [vfs]);
  
  // ==========================================================================
  // Context Value
  // ==========================================================================
  
  const contextValue = {
    vfs,
    isConnected,
    readFile,
    updateFile,
    saveFile,
    getCurrentContent,
    isDirty,
    getDirtyFiles,
    refreshFile,
  };
  
  return (
    <VFSContext.Provider value={contextValue}>
      {children}
    </VFSContext.Provider>
  );
}

export default VFSProvider;
