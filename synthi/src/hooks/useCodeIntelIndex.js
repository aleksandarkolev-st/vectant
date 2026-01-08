/**
 * Hook to manage code intelligence indexing for a workspace.
 * 
 * Auto-indexes workspace when opened and handles incremental updates.
 */

import { useState, useEffect, useCallback, useRef } from 'react';

const CODE_INTEL_URL = process.env.NEXT_PUBLIC_CODE_INTEL_URL || 'http://localhost:8000';

/**
 * @typedef {Object} IndexStatus
 * @property {boolean} isIndexing - Whether indexing is in progress
 * @property {boolean} isIndexed - Whether workspace has been indexed
 * @property {number} filesIndexed - Number of files indexed
 * @property {number} chunksIndexed - Number of chunks indexed
 * @property {string|null} error - Error message if indexing failed
 * @property {number} lastIndexTime - Timestamp of last successful index
 */

/**
 * Hook for managing code intelligence workspace indexing.
 * 
 * @param {Object} options
 * @param {string} options.workspaceSlug - Workspace identifier
 * @param {boolean} options.autoIndex - Whether to auto-index on mount (default: true)
 * @param {Function} options.onIndexComplete - Callback when indexing completes
 * @returns {Object} Index status and control functions
 */
export function useCodeIntelIndex({
    workspaceSlug,
    autoIndex = true,
    onIndexComplete,
}) {
    const [status, setStatus] = useState({
        isIndexing: false,
        isIndexed: false,
        filesIndexed: 0,
        chunksIndexed: 0,
        symbolsTracked: 0,
        error: null,
        lastIndexTime: 0,
    });
    
    const indexingRef = useRef(false);
    const hasAutoIndexedRef = useRef(false);
    
    /**
     * Trigger workspace indexing.
     * @param {boolean} incremental - If true, only index changed files
     */
    const indexWorkspace = useCallback(async (incremental = true) => {
        if (!workspaceSlug || indexingRef.current) {
            return;
        }
        
        indexingRef.current = true;
        setStatus(prev => ({ ...prev, isIndexing: true, error: null }));
        
        try {
            const response = await fetch(`${CODE_INTEL_URL}/code-intel/index`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    workspace_path: workspaceSlug,
                    incremental,
                }),
            });
            
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Index failed: ${response.status} - ${errorText}`);
            }
            
            const result = await response.json();
            
            setStatus({
                isIndexing: false,
                isIndexed: true,
                filesIndexed: result.files_indexed || 0,
                chunksIndexed: result.chunks_indexed || 0,
                symbolsTracked: result.symbols_tracked || 0,
                error: null,
                lastIndexTime: Date.now(),
            });
            
            onIndexComplete?.(result);
            
            console.log(`[CodeIntel] Indexed workspace: ${result.files_indexed} files, ${result.chunks_indexed} chunks`);
            
        } catch (err) {
            console.warn('[CodeIntel] Index failed:', err.message);
            setStatus(prev => ({
                ...prev,
                isIndexing: false,
                error: err.message,
            }));
        } finally {
            indexingRef.current = false;
        }
    }, [workspaceSlug, onIndexComplete]);
    
    /**
     * Index a single file (for incremental updates after edits).
     * @param {string} filePath - Path to file within workspace
     */
    const indexFile = useCallback(async (filePath) => {
        if (!workspaceSlug || !filePath) return;
        
        try {
            const response = await fetch(`${CODE_INTEL_URL}/code-intel/index/file`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    workspace_path: workspaceSlug,
                    file_path: filePath,
                }),
            });
            
            if (response.ok) {
                console.log(`[CodeIntel] Re-indexed file: ${filePath}`);
            }
        } catch (err) {
            // Silent fail for incremental updates
            console.debug('[CodeIntel] File index failed:', err.message);
        }
    }, [workspaceSlug]);
    
    /**
     * Check if code intelligence backend is available.
     */
    const checkBackendHealth = useCallback(async () => {
        try {
            const response = await fetch(`${CODE_INTEL_URL}/health`, {
                method: 'GET',
                signal: AbortSignal.timeout(3000),
            });
            return response.ok;
        } catch {
            return false;
        }
    }, []);
    
    // Auto-index on mount if enabled
    useEffect(() => {
        if (!autoIndex || !workspaceSlug || hasAutoIndexedRef.current) {
            return;
        }
        
        hasAutoIndexedRef.current = true;
        
        // Check backend availability before indexing
        (async () => {
            const isAvailable = await checkBackendHealth();
            if (isAvailable) {
                // Small delay to let workspace load first
                setTimeout(() => {
                    indexWorkspace(true);
                }, 1000);
            } else {
                console.log('[CodeIntel] Backend not available, skipping auto-index');
            }
        })();
    }, [autoIndex, workspaceSlug, indexWorkspace, checkBackendHealth]);
    
    // Reset auto-index flag when workspace changes
    useEffect(() => {
        hasAutoIndexedRef.current = false;
    }, [workspaceSlug]);
    
    return {
        ...status,
        indexWorkspace,
        indexFile,
        checkBackendHealth,
    };
}

export default useCodeIntelIndex;
