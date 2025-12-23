'use client';

/**
 * useProactiveAnalysis Hook
 * 
 * Provides real-time proactive code analysis with:
 * - Debounced analysis triggers (500ms default)
 * - Multi-tier results (static, semantic, AI)
 * - Monaco editor integration for diagnostics markers
 * - Caching awareness (no duplicate requests for unchanged content)
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAnalyzerGateway } from './useAnalyzerGateway';
import SynthiException from '@/components/SynthiException';

/**
 * @typedef {Object} Diagnostic
 * @property {string} message - The diagnostic message
 * @property {'error'|'warning'|'info'|'hint'} severity - Severity level
 * @property {'static'|'semantic'|'ai'} tier - Which analysis tier produced this
 * @property {Object} location - Position in source code
 * @property {number} location.line - 0-indexed line number
 * @property {number} location.column - 0-indexed column
 * @property {number} location.endLine - 0-indexed end line
 * @property {number} location.endColumn - 0-indexed end column
 * @property {string} code - Diagnostic code (e.g., "PY001")
 * @property {string} category - Category (e.g., "logic_error", "security")
 * @property {string} [explanation] - Detailed explanation (AI diagnostics)
 * @property {number} [confidence] - Confidence score 0-1 (AI diagnostics)
 * @property {Array} [fixes] - Suggested fixes
 */

/**
 * @typedef {Object} AnalysisResult
 * @property {string} filePath - Path of analyzed file
 * @property {string} contentHash - Hash of file content
 * @property {string} language - Programming language
 * @property {Diagnostic[]} diagnostics - All diagnostics sorted by severity
 * @property {Object} summary - Summary counts
 * @property {number} summary.errors - Error count
 * @property {number} summary.warnings - Warning count
 * @property {number} summary.total - Total diagnostic count
 * @property {Object} tiers - Per-tier results
 * @property {number} totalElapsedMs - Total analysis time
 */

// Default debounce delay in milliseconds
const DEFAULT_DEBOUNCE_MS = 500;

// Minimum time between AI analysis requests (rate limiting)
const AI_RATE_LIMIT_MS = 5000;

/**
 * Compute simple hash for content comparison
 * @param {string} content 
 * @returns {string}
 */
function computeContentHash(content) {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return hash.toString(16);
}

/**
 * Hook for proactive code analysis
 * 
 * @param {Object} options
 * @param {number} [options.debounceMs=500] - Debounce delay for analysis
 * @param {boolean} [options.autoAnalyze=true] - Auto-analyze on content change
 * @param {boolean} [options.includeAi=false] - Include AI analysis (slower)
 * @param {string[]} [options.tiers=['static', 'semantic']] - Tiers to run
 * @param {number} [options.maxDiagnostics=50] - Max diagnostics to return
 */
export function useProactiveAnalysis({
  debounceMs = DEFAULT_DEBOUNCE_MS,
  autoAnalyze = true,
  includeAi = false,
  tiers = ['static', 'semantic'],
  maxDiagnostics = 50,
} = {}) {
  const { clientRef, connectionStatus, clientReady } = useAnalyzerGatewayInternal();
  
  // State
  const [diagnostics, setDiagnostics] = useState([]);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState(null);
  const [lastError, setLastError] = useState(null);
  const [tierStatus, setTierStatus] = useState({
    static: { status: 'idle', elapsed: 0 },
    semantic: { status: 'idle', elapsed: 0 },
    ai: { status: 'idle', elapsed: 0 },
  });
  
  // Refs for debouncing and caching
  const debounceTimerRef = useRef(null);
  const lastContentHashRef = useRef(null);
  const lastAiRequestRef = useRef(0);
  const abortControllerRef = useRef(null);
  const pendingRequestRef = useRef(null);
  
  /**
   * Perform quick analysis (static + semantic only)
   * This is optimized for real-time feedback during typing
   */
  const analyzeQuick = useCallback(async ({ code, lang, filePath }) => {
    if (!clientRef.current) {
      throw new SynthiException('Gateway client is not ready');
    }
    
    const contentHash = computeContentHash(code);
    
    // Skip if content hasn't changed
    if (contentHash === lastContentHashRef.current) {
      return analysisResult;
    }
    
    lastContentHashRef.current = contentHash;
    setIsAnalyzing(true);
    setLastError(null);
    
    // Update tier statuses
    setTierStatus(prev => ({
      ...prev,
      static: { status: 'running', elapsed: 0 },
      semantic: { status: 'running', elapsed: 0 },
    }));
    
    try {
      const response = await clientRef.current._sendRequest('analyze/proactive/quick', {
        code,
        lang,
        filePath,
      });
      
      const data = response?.data ?? response;
      const newDiagnostics = data?.diagnostics || [];
      
      setDiagnostics(newDiagnostics);
      setAnalysisResult(data);
      
      // Update tier statuses from response
      if (data?.tier) {
        setTierStatus(prev => ({
          ...prev,
          static: { status: 'completed', elapsed: data.elapsedMs || 0 },
          semantic: { status: 'completed', elapsed: 0 },
        }));
      }
      
      return data;
    } catch (error) {
      setLastError(error);
      throw error;
    } finally {
      setIsAnalyzing(false);
    }
  }, [analysisResult]);
  
  /**
   * Perform full proactive analysis (including AI if enabled)
   */
  const analyzeFull = useCallback(async ({ 
    code, 
    lang, 
    filePath,
    relatedFiles,
    model,
    apiKey,
  }) => {
    if (!clientRef.current) {
      throw new SynthiException('Gateway client is not ready');
    }
    
    setIsAnalyzing(true);
    setLastError(null);
    
    // Rate limit AI requests
    const now = Date.now();
    const requestedTiers = [...tiers];
    if (includeAi && !requestedTiers.includes('ai')) {
      if (now - lastAiRequestRef.current < AI_RATE_LIMIT_MS) {
        // Don't include AI tier if rate limited
        console.debug('[ProactiveAnalysis] AI tier rate limited');
      } else {
        requestedTiers.push('ai');
        lastAiRequestRef.current = now;
      }
    }
    
    // Update tier statuses
    const newTierStatus = {};
    for (const tier of requestedTiers) {
      newTierStatus[tier] = { status: 'running', elapsed: 0 };
    }
    setTierStatus(prev => ({ ...prev, ...newTierStatus }));
    
    try {
      const response = await clientRef.current._sendRequest('analyze/proactive', {
        code,
        lang,
        filePath,
        tiers: requestedTiers,
        includeAi,
        maxDiagnostics,
        relatedFiles,
        model,
        apiKey,
      });
      
      const data = response?.data ?? response;
      const newDiagnostics = data?.diagnostics || [];
      
      setDiagnostics(newDiagnostics);
      setAnalysisResult(data);
      
      // Update tier statuses from response
      const responseTiers = data?.tiers || {};
      const updatedTierStatus = {};
      for (const [tierName, tierData] of Object.entries(responseTiers)) {
        updatedTierStatus[tierName] = {
          status: 'completed',
          elapsed: tierData.elapsedMs || 0,
          fromCache: tierData.fromCache || false,
        };
      }
      setTierStatus(prev => ({ ...prev, ...updatedTierStatus }));
      
      return data;
    } catch (error) {
      setLastError(error);
      // Mark all running tiers as error
      setTierStatus(prev => {
        const updated = { ...prev };
        for (const tier of requestedTiers) {
          if (updated[tier]?.status === 'running') {
            updated[tier] = { status: 'error', elapsed: 0 };
          }
        }
        return updated;
      });
      throw error;
    } finally {
      setIsAnalyzing(false);
    }
  }, [includeAi, maxDiagnostics, tiers]);
  
  /**
   * Debounced analysis trigger
   * Call this whenever content changes
   */
  const triggerAnalysis = useCallback(({ code, lang, filePath }) => {
    // Clear existing debounce timer
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    
    // Set new debounce timer
    debounceTimerRef.current = setTimeout(() => {
      analyzeQuick({ code, lang, filePath }).catch(err => {
        console.warn('[ProactiveAnalysis] Quick analysis failed:', err.message);
      });
    }, debounceMs);
  }, [analyzeQuick, debounceMs]);
  
  /**
   * Cancel pending analysis
   */
  const cancelAnalysis = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setIsAnalyzing(false);
  }, []);
  
  /**
   * Clear all diagnostics
   */
  const clearDiagnostics = useCallback(() => {
    setDiagnostics([]);
    setAnalysisResult(null);
    lastContentHashRef.current = null;
  }, []);
  
  /**
   * Remove a specific diagnostic by its location (called after applying a fix)
   * This immediately removes the diagnostic from state without waiting for re-analysis
   */
  const removeDiagnosticByLocation = useCallback((location) => {
    if (!location) return;
    
    setDiagnostics(prev => prev.filter(d => {
      const loc = d.location || {};
      // Remove if exact location match
      const sameStart = loc.line === location.line && loc.column === location.column;
      const sameEnd = loc.endLine === location.endLine && loc.endColumn === location.endColumn;
      return !(sameStart && sameEnd);
    }));
    
    // Also invalidate the content hash so next analysis runs fresh
    lastContentHashRef.current = null;
  }, []);
  
  /**
   * Remove diagnostics that are now stale (original text no longer matches)
   * Called after any code edit to clean up outdated diagnostics
   */
  const removeStaleDignostics = useCallback((currentCode) => {
    if (!currentCode) return;
    
    setDiagnostics(prev => prev.filter(d => {
      // Keep diagnostics without originalText (can't verify staleness)
      if (!d.originalText) return true;
      
      // Check if the original text still exists at the expected location
      const lines = currentCode.split('\n');
      const loc = d.location || {};
      const line = loc.line ?? 0;
      const endLine = loc.endLine ?? line;
      const col = loc.column ?? 0;
      const endCol = loc.endColumn ?? col;
      
      // Extract text at diagnostic location
      let currentText = '';
      try {
        if (line === endLine && line < lines.length) {
          currentText = lines[line].substring(col, endCol);
        } else if (line < lines.length) {
          // Multi-line
          const textParts = [];
          for (let i = line; i <= Math.min(endLine, lines.length - 1); i++) {
            if (i === line) textParts.push(lines[i].substring(col));
            else if (i === endLine) textParts.push(lines[i].substring(0, endCol));
            else textParts.push(lines[i]);
          }
          currentText = textParts.join('\n');
        }
      } catch (e) {
        return true; // Keep on error
      }
      
      // If text changed, diagnostic is stale
      return currentText === d.originalText;
    }));
  }, []);
  
  /**
   * Get diagnostics for a specific line
   */
  const getDiagnosticsForLine = useCallback((lineNumber) => {
    return diagnostics.filter(d => d.location.line === lineNumber);
  }, [diagnostics]);
  
  /**
   * Get diagnostics by severity
   */
  const diagnosticsBySeverity = useMemo(() => {
    return {
      errors: diagnostics.filter(d => d.severity === 'error'),
      warnings: diagnostics.filter(d => d.severity === 'warning'),
      infos: diagnostics.filter(d => d.severity === 'info'),
      hints: diagnostics.filter(d => d.severity === 'hint'),
    };
  }, [diagnostics]);
  
  /**
   * Summary counts
   */
  const summary = useMemo(() => {
    return {
      errors: diagnosticsBySeverity.errors.length,
      warnings: diagnosticsBySeverity.warnings.length,
      infos: diagnosticsBySeverity.infos.length,
      hints: diagnosticsBySeverity.hints.length,
      total: diagnostics.length,
    };
  }, [diagnostics, diagnosticsBySeverity]);
  
  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);
  
  return {
    // State
    diagnostics,
    diagnosticsBySeverity,
    summary,
    isAnalyzing,
    analysisResult,
    lastError,
    tierStatus,
    connectionStatus,
    clientReady,
    
    // Actions
    triggerAnalysis,
    analyzeQuick,
    analyzeFull,
    cancelAnalysis,
    clearDiagnostics,
    removeDiagnosticByLocation,
    removeStaleDignostics,
    
    // Utilities
    getDiagnosticsForLine,
  };
}

/**
 * Internal hook to access gateway client
 * This wraps useAnalyzerGateway to expose the client ref
 */
function useAnalyzerGatewayInternal() {
  const clientRef = useRef(null);
  const [connectionStatus, setConnectionStatus] = useState('idle');
  const [clientReady, setClientReady] = useState(false);
  
  useEffect(() => {
    if (typeof window === 'undefined') return;
    
    // Dynamically import to avoid SSR issues
    import('@/services/analyzerGatewayClient').then(({ AnalyzerGatewayClient, GatewayStatus }) => {
      const client = new AnalyzerGatewayClient();
      clientRef.current = client;
      
      const unsubscribe = client.onStatusChange((status) => {
        setConnectionStatus(status);
        setClientReady(status === GatewayStatus.CONNECTED);
      });
      
      client.start();
      
      return () => {
        unsubscribe?.();
        client.dispose();
        clientRef.current = null;
      };
    });
  }, []);
  
  return { clientRef, connectionStatus, clientReady };
}

export default useProactiveAnalysis;
