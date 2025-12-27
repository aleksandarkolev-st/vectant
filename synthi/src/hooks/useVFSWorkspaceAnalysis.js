/**
 * VFS-Backed Workspace Analysis Hook
 * 
 * This hook integrates with the Virtual File System to ensure the AI analyzer
 * always receives the correct, up-to-date file content from the VFS.
 * 
 * Key principle: The VFS is the single source of truth for file content.
 * The analyzer reads from VFS, never from stale Redux state or local caches.
 */

'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAnalyzerGateway } from './useAnalyzerGateway';
import { getVFS } from '@/services/vfs/VirtualFileSystem';

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_DEBOUNCE_MS = 500;  // Faster debounce since VFS handles deduplication
const AI_RATE_LIMIT_MS = 8000;    // Rate limit AI analysis
const MAX_FILES_PER_ANALYSIS = 50;

// ============================================================================
// Utilities
// ============================================================================

/**
 * Compute content hash for change detection (matches VFS)
 */
async function computeContentHash(content) {
  if (!content || typeof content !== 'string') return '';
  
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
  
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

function detectLanguage(path) {
  if (!path) return 'plaintext';
  const ext = path.split('.').pop()?.toLowerCase();
  const langMap = {
    'js': 'javascript', 'jsx': 'javascriptreact',
    'ts': 'typescript', 'tsx': 'typescriptreact',
    'py': 'python', 'rs': 'rust', 'go': 'go',
    'java': 'java', 'c': 'c', 'cpp': 'cpp',
    'h': 'c', 'hpp': 'cpp', 'css': 'css',
    'scss': 'scss', 'html': 'html', 'json': 'json',
    'yaml': 'yaml', 'yml': 'yaml', 'md': 'markdown',
  };
  return langMap[ext] || 'plaintext';
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * VFS-backed workspace analysis hook
 * 
 * @param {Object} options
 * @param {string} options.workspaceId - Unique workspace identifier
 * @param {number} [options.debounceMs=500] - Debounce delay
 * @param {boolean} [options.includeAi=false] - Include AI analysis
 * @param {number} [options.maxDiagnosticsPerFile=30] - Max diagnostics per file
 */
export function useVFSWorkspaceAnalysis({
  workspaceId,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  includeAi = false,
  maxDiagnosticsPerFile = 30,
} = {}) {
  const { clientRef, connectionStatus, clientReady } = useAnalyzerGatewayInternal();
  
  // Get VFS instance
  const vfsRef = useRef(null);
  
  // State
  const [diagnosticsByFile, setDiagnosticsByFile] = useState({});
  const [crossFileDiagnostics, setCrossFileDiagnostics] = useState([]);
  const [suggestions, setSuggestions] = useState([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [lastError, setLastError] = useState(null);
  const [analysisStats, setAnalysisStats] = useState({
    filesAnalyzed: 0,
    filesFromCache: 0,
    totalElapsedMs: 0,
  });
  
  // Refs for tracking
  const pendingChangesRef = useRef(new Map());
  const debounceTimerRef = useRef(null);
  const lastAiAnalysisRef = useRef(0);
  const focusFileRef = useRef(null);
  const analysisVersionRef = useRef(0); // Track analysis versions to discard stale results
  
  // Initialize VFS connection
  useEffect(() => {
    if (!workspaceId) return;
    
    const vfs = getVFS(workspaceId);
    vfsRef.current = vfs;
    
    // Connect if not already
    if (!vfs.connected) {
      vfs.connect().catch(console.error);
    }
    
    // Listen for file changes from VFS
    const handleChange = (event) => {
      if (event.type === 'change' && event.file) {
        // Track the change for next analysis
        pendingChangesRef.current.set(event.path, {
          path: event.path,
          contentHash: event.file.contentHash,
          changeType: 'modified',
          content: event.file.content,
          language: event.file.language,
        });
        
        // Clear stale diagnostics for this file immediately
        setDiagnosticsByFile(prev => {
          if (!prev[event.path]) return prev;
          const updated = { ...prev };
          delete updated[event.path];
          return updated;
        });
      }
    };
    
    vfs.on('change', handleChange);
    
    return () => {
      vfs.off('change', handleChange);
    };
  }, [workspaceId]);
  
  /**
   * Track a file change manually (when VFS isn't being used directly)
   * This updates the VFS and triggers analysis
   */
  const trackFileChange = useCallback(async (path, content, language) => {
    if (!vfsRef.current) return false;
    
    const lang = language || detectLanguage(path);
    
    // Update VFS (this will emit 'change' event which we handle above)
    const file = await vfsRef.current.updateContent(path, content);
    
    // Also track in pending changes for immediate analysis
    pendingChangesRef.current.set(path, {
      path,
      contentHash: file.contentHash,
      changeType: 'modified',
      content: file.content,
      language: lang,
    });
    
    return true;
  }, []);
  
  /**
   * Set the currently focused file for priority analysis
   */
  const setFocusFile = useCallback((path) => {
    focusFileRef.current = path;
  }, []);
  
  /**
   * Build the file context for analysis from VFS
   * This ensures we always send the latest content
   */
  const buildAnalysisContext = useCallback(async () => {
    if (!vfsRef.current) return { changedFiles: [], allFiles: [] };
    
    const vfs = vfsRef.current;
    const changes = Array.from(pendingChangesRef.current.values());
    
    // Get all hot cache files for context
    const allFiles = [];
    for (const [path, file] of vfs.hotCache) {
      allFiles.push({
        path,
        content: file.content,
        language: file.language,
      });
    }
    
    // Ensure focus file is included with latest content
    if (focusFileRef.current) {
      const focusFile = vfs.getFromHotCache(focusFileRef.current);
      if (focusFile && !allFiles.find(f => f.path === focusFileRef.current)) {
        allFiles.unshift({
          path: focusFile.path,
          content: focusFile.content,
          language: focusFile.language,
        });
      }
    }
    
    return { changedFiles: changes, allFiles: allFiles.slice(0, MAX_FILES_PER_ANALYSIS) };
  }, []);
  
  /**
   * Run incremental analysis on changed files
   */
  const runIncrementalAnalysis = useCallback(async (options = {}) => {
    if (!clientRef.current) {
      throw new Error('Gateway client is not ready');
    }
    
    const analysisVersion = ++analysisVersionRef.current;
    
    const { changedFiles, allFiles } = await buildAnalysisContext();
    
    if (changedFiles.length === 0 && !options.force) {
      return null;
    }
    
    // Clear pending changes
    pendingChangesRef.current.clear();
    
    setIsAnalyzing(true);
    setLastError(null);
    
    // Determine if AI should run
    const now = Date.now();
    let shouldIncludeAi = options.includeAi ?? includeAi;
    if (shouldIncludeAi && now - lastAiAnalysisRef.current < AI_RATE_LIMIT_MS) {
      shouldIncludeAi = false;
    }
    if (shouldIncludeAi) {
      lastAiAnalysisRef.current = now;
    }
    
    console.log(`[VFS Analysis] Starting analysis v${analysisVersion}`, {
      changedFiles: changedFiles.length,
      allFiles: allFiles.length,
      focusFile: focusFileRef.current,
      includeAi: shouldIncludeAi,
    });
    
    // Log content hashes for debugging
    for (const f of changedFiles) {
      console.log(`[VFS Analysis]   ${f.path}: hash=${f.contentHash?.substring(0, 8)}, len=${f.content?.length}`);
    }
    
    try {
      const response = await clientRef.current._sendRequest('analyze/workspace/incremental', {
        workspaceId,
        changedFiles,
        allFiles,
        focusFile: focusFileRef.current,
        includeAi: shouldIncludeAi,
        maxDiagnosticsPerFile,
      });
      
      // Discard if a newer analysis has started
      if (analysisVersion !== analysisVersionRef.current) {
        console.log(`[VFS Analysis] Discarding stale results v${analysisVersion} (current: v${analysisVersionRef.current})`);
        return null;
      }
      
      const data = response?.data ?? response;
      
      console.log(`[VFS Analysis] Received results v${analysisVersion}`, {
        files: Object.keys(data?.files || {}).length,
        diagnostics: Object.values(data?.files || {}).reduce((sum, f) => sum + (f.diagnostics?.length || 0), 0),
      });
      
      // Update state
      if (data?.files) {
        setDiagnosticsByFile(prev => ({
          ...prev,
          ...Object.fromEntries(
            Object.entries(data.files).map(([path, fileResult]) => [
              path,
              fileResult.diagnostics || [],
            ])
          ),
        }));
      }
      
      if (data?.crossFileDiagnostics) {
        setCrossFileDiagnostics(data.crossFileDiagnostics);
      }
      
      if (data?.suggestions) {
        setSuggestions(data.suggestions);
      }
      
      if (data?.performance) {
        setAnalysisStats({
          filesAnalyzed: data.performance.filesAnalyzed || 0,
          filesFromCache: data.performance.filesFromCache || 0,
          totalElapsedMs: data.performance.totalElapsedMs || 0,
        });
      }
      
      return data;
    } catch (error) {
      if (analysisVersion === analysisVersionRef.current) {
        setLastError(error);
      }
      throw error;
    } finally {
      if (analysisVersion === analysisVersionRef.current) {
        setIsAnalyzing(false);
      }
    }
  }, [workspaceId, includeAi, maxDiagnosticsPerFile, buildAnalysisContext]);
  
  /**
   * Trigger debounced analysis
   */
  const triggerAnalysis = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    
    debounceTimerRef.current = setTimeout(() => {
      runIncrementalAnalysis().catch(err => {
        console.warn('[VFS Analysis] Failed:', err.message);
      });
    }, debounceMs);
  }, [runIncrementalAnalysis, debounceMs]);
  
  /**
   * Cancel pending analysis
   */
  const cancelAnalysis = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    analysisVersionRef.current++; // Invalidate any in-flight analysis
    setIsAnalyzing(false);
  }, []);
  
  /**
   * Clear all diagnostics
   */
  const clearDiagnostics = useCallback(() => {
    setDiagnosticsByFile({});
    setCrossFileDiagnostics([]);
    setSuggestions([]);
    pendingChangesRef.current.clear();
  }, []);
  
  /**
   * Get diagnostics for a specific file
   */
  const getDiagnosticsForFile = useCallback((path) => {
    return diagnosticsByFile[path] || [];
  }, [diagnosticsByFile]);
  
  /**
   * All diagnostics flattened and sorted
   */
  const allDiagnostics = useMemo(() => {
    const all = [];
    for (const [path, diags] of Object.entries(diagnosticsByFile)) {
      for (const d of diags) {
        all.push({ ...d, filePath: path, primaryFile: path });
      }
    }
    all.push(...crossFileDiagnostics);
    
    const severityOrder = { error: 0, warning: 1, info: 2, hint: 3 };
    all.sort((a, b) => (severityOrder[a.severity] || 4) - (severityOrder[b.severity] || 4));
    
    return all;
  }, [diagnosticsByFile, crossFileDiagnostics]);
  
  /**
   * Summary statistics
   */
  const summary = useMemo(() => {
    const errors = allDiagnostics.filter(d => d.severity === 'error').length;
    const warnings = allDiagnostics.filter(d => d.severity === 'warning').length;
    const filesWithIssues = Object.keys(diagnosticsByFile).filter(
      path => diagnosticsByFile[path].length > 0
    ).length;
    
    return {
      errors,
      warnings,
      total: allDiagnostics.length,
      filesWithIssues,
      suggestionsCount: suggestions.length,
    };
  }, [allDiagnostics, diagnosticsByFile, suggestions]);
  
  // Cleanup
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);
  
  return {
    // VFS integration
    vfs: vfsRef.current,
    
    // File tracking
    trackFileChange,
    setFocusFile,
    
    // Analysis
    runIncrementalAnalysis,
    triggerAnalysis,
    cancelAnalysis,
    
    // State
    diagnosticsByFile,
    crossFileDiagnostics,
    suggestions,
    allDiagnostics,
    summary,
    
    // Status
    isAnalyzing,
    lastError,
    analysisStats,
    
    // Utilities
    clearDiagnostics,
    getDiagnosticsForFile,
    
    // Connection
    connectionStatus,
    clientReady,
  };
}

/**
 * Internal hook to get analyzer gateway client
 */
function useAnalyzerGatewayInternal() {
  const { clientRef, connectionStatus, clientReady } = useAnalyzerGateway();
  return { clientRef, connectionStatus, clientReady };
}

export default useVFSWorkspaceAnalysis;
