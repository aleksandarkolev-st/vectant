'use client';

/**
 * useWorkspaceAnalysis Hook
 * 
 * Provides workspace-level multi-file code analysis with:
 * - Incremental analysis (only changed files + dependents)
 * - Cross-file issue detection
 * - Multi-file suggestions and batch fixes
 * - Efficient content hashing to avoid unnecessary analysis
 * - Smart AI batching to avoid sending all files constantly
 * 
 * Key optimizations:
 * 1. Content hash tracking - only analyze files that actually changed
 * 2. Dependency-aware - when a file changes, also re-analyze its dependents
 * 3. Debounced updates - batch multiple rapid changes into single analysis
 * 4. AI rate limiting - don't overwhelm the AI with every keystroke
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAnalyzerGateway } from './useAnalyzerGateway';

// ============================================================================
// Types
// ============================================================================

/**
 * @typedef {Object} FileChange
 * @property {string} path - File path
 * @property {string} contentHash - Hash of content
 * @property {'added'|'modified'|'deleted'} changeType
 * @property {string} [content] - File content (for added/modified)
 * @property {string} [language] - Programming language
 */

/**
 * @typedef {Object} WorkspaceFile
 * @property {string} path - File path
 * @property {string} content - File content
 * @property {string} language - Programming language
 */

/**
 * @typedef {Object} CrossFileRef
 * @property {string} filePath - Related file path
 * @property {Object} location - Position in file
 * @property {string} message - Description of the relationship
 */

/**
 * @typedef {Object} MultiFileDiagnostic
 * @property {string} primaryFile - Main file for this diagnostic
 * @property {string} message - Diagnostic message
 * @property {'error'|'warning'|'info'|'hint'} severity
 * @property {'static'|'semantic'|'ai'} tier
 * @property {Object} location - Position in source
 * @property {string} code - Diagnostic code
 * @property {string} category - Issue category
 * @property {CrossFileRef[]} [crossFileRefs] - Related locations in other files
 * @property {Object[]} [fixes] - Suggested fixes (may span multiple files)
 * @property {string} [explanation] - Detailed explanation (AI diagnostics)
 * @property {number} [confidence] - Confidence score (AI diagnostics)
 */

/**
 * @typedef {Object} WorkspaceSuggestion
 * @property {string} id - Unique identifier
 * @property {string} title - Short title
 * @property {string} description - Detailed description
 * @property {string} category - 'refactor' | 'fix' | 'improvement' | 'cleanup'
 * @property {string[]} affectedFiles - Files affected by this suggestion
 * @property {Object} [fix] - Multi-file fix to apply
 * @property {number} [confidence] - Confidence score
 */

/**
 * @typedef {Object} WorkspaceAnalysisResult
 * @property {string} workspaceId
 * @property {Object.<string, Object>} files - Per-file results
 * @property {MultiFileDiagnostic[]} crossFileDiagnostics
 * @property {WorkspaceSuggestion[]} suggestions
 * @property {Object} summary
 * @property {Object} performance
 */

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_DEBOUNCE_MS = 800;  // Longer debounce for workspace analysis
const AI_RATE_LIMIT_MS = 10000;   // Rate limit AI analysis
const MAX_FILES_PER_ANALYSIS = 50; // Limit files sent per request

// ============================================================================
// Utilities
// ============================================================================

/**
 * Compute content hash for change detection
 * @param {string} content 
 * @returns {string}
 */
function computeContentHash(content) {
  if (!content || typeof content !== 'string') return '';
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return hash.toString(16);
}

/**
 * Detect language from file extension
 * @param {string} path 
 * @returns {string}
 */
function detectLanguage(path) {
  if (!path) return 'plaintext';
  const ext = path.split('.').pop()?.toLowerCase();
  const langMap = {
    'js': 'javascript',
    'jsx': 'javascriptreact',
    'ts': 'typescript',
    'tsx': 'typescriptreact',
    'py': 'python',
    'rs': 'rust',
    'go': 'go',
    'java': 'java',
    'c': 'c',
    'cpp': 'cpp',
    'h': 'c',
    'hpp': 'cpp',
    'css': 'css',
    'scss': 'scss',
    'html': 'html',
    'json': 'json',
    'yaml': 'yaml',
    'yml': 'yaml',
    'md': 'markdown',
  };
  return langMap[ext] || 'plaintext';
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * Hook for workspace-level multi-file analysis
 * 
 * @param {Object} options
 * @param {string} options.workspaceId - Unique workspace identifier
 * @param {number} [options.debounceMs=800] - Debounce delay
 * @param {boolean} [options.includeAi=false] - Include AI analysis
 * @param {number} [options.maxDiagnosticsPerFile=30] - Max diagnostics per file
 */
export function useWorkspaceAnalysis({
  workspaceId,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  includeAi = false,
  maxDiagnosticsPerFile = 30,
} = {}) {
  const { clientRef, connectionStatus, clientReady } = useAnalyzerGatewayInternal();
  
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
  
  // Refs for tracking state
  const fileHashesRef = useRef(new Map());  // path -> contentHash
  const pendingChangesRef = useRef(new Map());  // path -> FileChange
  const debounceTimerRef = useRef(null);
  const lastAiAnalysisRef = useRef(0);
  const workspaceFilesRef = useRef([]);  // All files in workspace
  const focusFileRef = useRef(null);
  
  /**
   * Update a file's content and track the change
   * Call this whenever a file is modified in the workspace
   */
  const trackFileChange = useCallback((path, content, language) => {
    const newHash = computeContentHash(content);
    const oldHash = fileHashesRef.current.get(path);
    const lang = language || detectLanguage(path);
    
    // Check if content actually changed
    if (oldHash === newHash) {
      return false; // No change
    }
    
    // Track the change
    const changeType = oldHash ? 'modified' : 'added';
    pendingChangesRef.current.set(path, {
      path,
      contentHash: newHash,
      changeType,
      content,
      language: lang,
    });
    
    // Update hash map
    fileHashesRef.current.set(path, newHash);
    
    // Update workspace files cache
    const existingIdx = workspaceFilesRef.current.findIndex(f => f.path === path);
    if (existingIdx >= 0) {
      workspaceFilesRef.current[existingIdx] = { path, content, language: lang };
    } else {
      workspaceFilesRef.current.push({ path, content, language: lang });
    }
    
    return true; // Change detected
  }, []);
  
  /**
   * Track multiple files at once (e.g., on initial workspace load)
   */
  const trackFiles = useCallback((files) => {
    for (const file of files) {
      const path = file.path || file.name;
      if (path && file.content) {
        trackFileChange(path, file.content, file.language);
      }
    }
  }, [trackFileChange]);
  
  /**
   * Track file deletion
   */
  const trackFileDeletion = useCallback((path) => {
    const oldHash = fileHashesRef.current.get(path);
    if (oldHash) {
      pendingChangesRef.current.set(path, {
        path,
        contentHash: '',
        changeType: 'deleted',
        content: null,
        language: null,
      });
      fileHashesRef.current.delete(path);
      workspaceFilesRef.current = workspaceFilesRef.current.filter(f => f.path !== path);
    }
  }, []);
  
  /**
   * Set the currently focused/edited file
   * This file gets priority in AI analysis
   */
  const setFocusFile = useCallback((path) => {
    focusFileRef.current = path;
  }, []);
  
  /**
   * Run incremental analysis on changed files
   */
  const runIncrementalAnalysis = useCallback(async (options = {}) => {
    if (!clientRef.current) {
      throw new Error('Gateway client is not ready');
    }
    
    const changes = Array.from(pendingChangesRef.current.values());
    
    if (changes.length === 0) {
      return null; // No changes to analyze
    }
    
    // Clear pending changes
    pendingChangesRef.current.clear();
    
    setIsAnalyzing(true);
    setLastError(null);
    
    // Determine if we should include AI
    const now = Date.now();
    let shouldIncludeAi = options.includeAi ?? includeAi;
    if (shouldIncludeAi && now - lastAiAnalysisRef.current < AI_RATE_LIMIT_MS) {
      shouldIncludeAi = false; // Rate limited
    }
    
    if (shouldIncludeAi) {
      lastAiAnalysisRef.current = now;
    }
    
    try {
      const response = await clientRef.current._sendRequest('analyze/workspace/incremental', {
        workspaceId,
        changedFiles: changes,
        allFiles: workspaceFilesRef.current.slice(0, MAX_FILES_PER_ANALYSIS),
        focusFile: focusFileRef.current,
        includeAi: shouldIncludeAi,
        maxDiagnosticsPerFile,
      });
      
      const data = response?.data ?? response;
      
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
      setLastError(error);
      throw error;
    } finally {
      setIsAnalyzing(false);
    }
  }, [workspaceId, includeAi, maxDiagnosticsPerFile]);
  
  /**
   * Run full workspace analysis
   */
  const runFullAnalysis = useCallback(async (options = {}) => {
    if (!clientRef.current) {
      throw new Error('Gateway client is not ready');
    }
    
    setIsAnalyzing(true);
    setLastError(null);
    
    try {
      const response = await clientRef.current._sendRequest('analyze/workspace', {
        workspaceId,
        allFiles: workspaceFilesRef.current.slice(0, MAX_FILES_PER_ANALYSIS),
        focusFile: focusFileRef.current,
        includeAi: options.includeAi ?? includeAi,
        maxDiagnosticsPerFile,
        incremental: false,
      });
      
      const data = response?.data ?? response;
      
      // Update state
      if (data?.files) {
        setDiagnosticsByFile(
          Object.fromEntries(
            Object.entries(data.files).map(([path, fileResult]) => [
              path,
              fileResult.diagnostics || [],
            ])
          )
        );
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
      setLastError(error);
      throw error;
    } finally {
      setIsAnalyzing(false);
    }
  }, [workspaceId, includeAi, maxDiagnosticsPerFile]);
  
  /**
   * Trigger debounced incremental analysis
   * Call this whenever content changes
   */
  const triggerAnalysis = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    
    debounceTimerRef.current = setTimeout(() => {
      runIncrementalAnalysis().catch(err => {
        console.warn('[WorkspaceAnalysis] Incremental analysis failed:', err.message);
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
    setIsAnalyzing(false);
  }, []);
  
  /**
   * Clear all diagnostics and state
   */
  const clearDiagnostics = useCallback(() => {
    setDiagnosticsByFile({});
    setCrossFileDiagnostics([]);
    setSuggestions([]);
    fileHashesRef.current.clear();
    pendingChangesRef.current.clear();
    workspaceFilesRef.current = [];
  }, []);
  
  /**
   * Get diagnostics for a specific file
   */
  const getDiagnosticsForFile = useCallback((path) => {
    return diagnosticsByFile[path] || [];
  }, [diagnosticsByFile]);
  
  /**
   * Get all diagnostics flattened
   */
  const allDiagnostics = useMemo(() => {
    const all = [];
    for (const [path, diags] of Object.entries(diagnosticsByFile)) {
      for (const d of diags) {
        // Ensure filePath is set so consumers can filter correctly
        all.push({ ...d, filePath: path, primaryFile: path });
      }
    }
    all.push(...crossFileDiagnostics);
    
    // Sort by severity
    const severityOrder = { error: 0, warning: 1, info: 2, hint: 3 };
    all.sort((a, b) => (severityOrder[a.severity] || 4) - (severityOrder[b.severity] || 4));
    
    return all;
  }, [diagnosticsByFile, crossFileDiagnostics]);
  
  /**
   * Summary of diagnostics
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
  
  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);
  
  return {
    // File tracking
    trackFileChange,
    trackFiles,
    trackFileDeletion,
    setFocusFile,
    
    // Analysis
    runIncrementalAnalysis,
    runFullAnalysis,
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
 * Extracts client access from useAnalyzerGateway
 */
function useAnalyzerGatewayInternal() {
  // Use the analyzer gateway hook
  const { clientRef, connectionStatus, clientReady } = useAnalyzerGateway();
  
  return {
    clientRef,
    connectionStatus,
    clientReady,
  };
}

export default useWorkspaceAnalysis;
