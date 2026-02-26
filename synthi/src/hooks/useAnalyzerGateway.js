'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AnalyzerGatewayClient,
  GatewayStatus,
} from '@/services/analyzerGatewayClient';
import SynthiException from '@/components/SynthiException';

const DEFAULT_WS_URL =
  process.env.NEXT_PUBLIC_GATEWAY_WS_URL || 'ws://localhost:7070/ws';

export function useAnalyzerGateway({
  url = DEFAULT_WS_URL,
  autoConnect = true,
} = {}) {
  // Static analyzer supports only a small set; skip early to avoid noisy rejections.
  const SUPPORTED_ANALYZER_LANGS = useMemo(() => ['cpp', 'python', 'typescript'], []);
  const clientRef = useRef(null);
  const [connectionStatus, setConnectionStatus] = useState(GatewayStatus.IDLE);
  const [lastResult, setLastResult] = useState(null);
  const [lastError, setLastError] = useState(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }

    const client = new AnalyzerGatewayClient({ url });
    clientRef.current = client;

    const unsubscribeStatus = client.onStatusChange((status) => {
      setConnectionStatus(status);
    });

    if (autoConnect) {
      client.start();
    }

    return () => {
      unsubscribeStatus?.();
      client.dispose();
      clientRef.current = null;
    };
  }, [autoConnect, url]);

  const analyzeCode = useCallback(async ({ code, lang }) => {
    if (!clientRef.current) {
      throw new SynthiException('Gateway client is not ready yet');
    }
    if (typeof code !== 'string') {
      throw new SynthiException('`code` must be a string');
    }
    const normalizedLang = (lang || '').toString().trim().toLowerCase();
    if (!normalizedLang) {
      throw new SynthiException('`lang` is required for analysis');
    }
    if (!SUPPORTED_ANALYZER_LANGS.includes(normalizedLang)) {
      // Skip unsupported languages quietly; prevents repeated unhandled rejections.
      setLastResult(null);
      setLastError(null);
      return { skipped: true, reason: 'unsupported-language', lang: normalizedLang };
    }

    setIsAnalyzing(true);
    setLastError(null);

    try {
      const response = await clientRef.current.analyzeStatic({ code, lang: normalizedLang });
      console.log(`Response is ${JSON.stringify(response)}`)
      let payload = response?.data ?? response;
      setLastResult(payload);
      return payload;
    } catch (error) {
      setLastError(error);
      throw error;
    } finally {
      setIsAnalyzing(false);
    }
  }, [SUPPORTED_ANALYZER_LANGS]);

  const askAi = useCallback(async ({ code, lang, prompt, mode, files, focusPath, onProgress, model, apiKey } = {}) => {
    if (!clientRef.current) {
      throw new SynthiException('Gateway client is not ready yet', 'The analyzer gateway client has not been initialized. Please try again later.');
    }
    if (typeof code !== 'string') {
      throw new SynthiException('`code` must be a string', 'The provided code for AI analysis is invalid.');
    }
    if (!lang) {
      throw new SynthiException('`lang` is required for AI analysis', 'The programming language must be specified for AI analysis.');
    }
    setIsAnalyzing(true);
    setLastError(null);
    try {
      let payload = { code, lang };
      if (typeof prompt === 'string') payload.prompt = prompt;
      if (typeof mode === 'string') payload.mode = mode;
      if (Array.isArray(files) && files.length) payload.files = files;
      if (typeof focusPath === 'string' && focusPath.trim()) {
        payload.focus = focusPath.trim();
      }
      if (typeof model === 'string' && model.trim()) {
        payload.model = model.trim();
      }
      if (typeof apiKey === 'string' && apiKey.trim()) {
        payload.apiKey = apiKey.trim();
      }
      // If the caller provided an onProgress callback, forward it to the client
      const options = {};
      if (typeof onProgress === 'function') options.onStream = (data) => {
        try {
          // Expect `data` to be { partial: '...', final: boolean } or a string chunk
          onProgress(data);
        } catch (e) {}
      };
      const response = await clientRef.current.analyzeAi(payload, options);
      console.log(`AI Response is ${JSON.stringify(response)}`)
      const result = response?.data ?? response;
      setLastResult(result);
      return result;
    } catch (error) {
      setLastError(error);
      throw error;
    } finally {
      setIsAnalyzing(false);
    }
  }, []);

  /**
   * Run proactive analysis (static + semantic + optional AI)
   * Returns diagnostics for potential errors before compilation
   * @param {Object} options - Analysis options
   * @param {string} options.code - The code to analyze
   * @param {string} options.lang - The programming language
   * @param {string} [options.filePath] - The file path
   * @param {boolean} [options.includeAi] - Whether to include AI analysis
   * @param {Array} [options.relatedFiles] - Related files for cross-file analysis (includes, imports)
   * @param {Function} [options.onTierComplete] - Callback when a tier completes
   */
  const analyzeProactive = useCallback(async ({ code, lang, filePath, includeAi = false, relatedFiles, onTierComplete } = {}) => {
    if (!clientRef.current) {
      throw new SynthiException('Gateway client is not ready yet', 'The analyzer gateway client has not been initialized.');
    }
    if (typeof code !== 'string') {
      throw new SynthiException('`code` must be a string', 'The provided code for proactive analysis is invalid.');
    }
    if (!lang) {
      throw new SynthiException('`lang` is required for proactive analysis', 'The programming language must be specified.');
    }
    
    setIsAnalyzing(true);
    setLastError(null);
    
    try {
      const payload = {
        code,
        lang: lang.toLowerCase(),
        filePath: filePath || 'untitled',
        includeAi,
        tiers: includeAi ? ['static', 'semantic', 'ai'] : ['static', 'semantic'],
      };
      
      // Add related files for cross-file analysis (e.g., resolving includes/imports)
      if (Array.isArray(relatedFiles) && relatedFiles.length > 0) {
        payload.relatedFiles = relatedFiles.map(f => ({
          path: f.path || f.name,
          content: f.content,
          language: f.language || lang.toLowerCase(),
        }));
      }
      
      const options = {};
      if (typeof onTierComplete === 'function') {
        options.onTierComplete = onTierComplete;
      }
      
      const response = await clientRef.current.analyzeProactive(payload, options);
      console.log('[analyzeProactive] Raw response:', response);
      const result = response?.data ?? response;
      console.log('[analyzeProactive] Parsed result:', result);
      setLastResult(result);
      return result;
    } catch (error) {
      console.error('[analyzeProactive] Error:', error);
      setLastError(error);
      throw error;
    } finally {
      setIsAnalyzing(false);
    }
  }, []);

  /**
   * Container-First proactive analysis (RECOMMENDED)
   * 
   * This endpoint does NOT send content from the client.
   * The server fetches content directly from the container filesystem,
   * ensuring the AI analyzes exactly what the compiler sees.
   * 
   * @param {Object} options - Analysis options
   * @param {string} options.slug - Workspace slug (container ID)
   * @param {string} options.filePath - File path within workspace
   * @param {string} options.lang - The programming language
   * @param {string[]} [options.relatedPaths] - Related file paths for cross-file analysis
   * @param {boolean} [options.includeAi] - Whether to include AI analysis
   * @param {string[]} [options.tiers] - Analysis tiers: 'static', 'semantic', 'ai'
   * @param {Function} [options.onTierComplete] - Callback when a tier completes
   */
  const analyzeContainer = useCallback(async ({ slug, filePath, lang, relatedPaths, includeAi = false, tiers, onTierComplete, model, apiKey } = {}) => {
    if (!clientRef.current) {
      throw new SynthiException('Gateway client is not ready yet', 'The analyzer gateway client has not been initialized.');
    }
    if (!slug) {
      throw new SynthiException('`slug` is required for container analysis', 'The workspace slug must be specified.');
    }
    if (!filePath) {
      throw new SynthiException('`filePath` is required for container analysis', 'The file path must be specified.');
    }
    if (!lang) {
      throw new SynthiException('`lang` is required for container analysis', 'The programming language must be specified.');
    }
    
    setIsAnalyzing(true);
    setLastError(null);
    
    try {
      const payload = {
        slug,
        filePath,
        lang: lang.toLowerCase(),
        relatedPaths: relatedPaths || [],
        includeAi,
        tiers: tiers || (includeAi ? ['static', 'semantic', 'ai'] : ['static', 'semantic']),
      };
      
      if (model) payload.model = model;
      if (apiKey) payload.apiKey = apiKey;
      
      const options = {};
      if (typeof onTierComplete === 'function') {
        options.onTierComplete = onTierComplete;
      }
      
      const response = await clientRef.current.analyzeContainer(payload, options);
      console.log('[analyzeContainer] Raw response:', response);
      const result = response?.data ?? response;
      console.log('[analyzeContainer] Parsed result:', result);
      setLastResult(result);
      return result;
    } catch (error) {
      console.error('[analyzeContainer] Error:', error);
      setLastError(error);
      throw error;
    } finally {
      setIsAnalyzing(false);
    }
  }, []);

  /**
   * Unified Intelligence Pipeline analysis (RECOMMENDED)
   * 
   * This is the preferred endpoint that combines:
   * - Layer A: Static analysis (syntax patterns)
   * - Layer B: Semantic analysis (CppSemanticAnalyzer, etc.)
   * - Layer C: AI analysis (on-demand, triggered when errors found)
   * 
   * Content is fetched from the container filesystem - the client sends only paths.
   * This ensures the AI analyzes exactly what the compiler sees.
   * 
   * @param {Object} options - Analysis options
   * @param {string} options.slug - Workspace slug (container ID)
   * @param {string} options.filePath - File path within workspace
   * @param {string} options.lang - The programming language
   * @param {string} [options.content] - The file content (optional, for unsaved changes)
   * @param {number} [options.version] - Document version for stale detection
   * @param {string[]} [options.layers] - Analysis layers: 'static', 'semantic', 'ai'
   * @param {boolean} [options.includeAi] - Force include AI layer
   * @param {boolean} [options.triggerAiOnErrors] - Auto-trigger AI if errors found (default: true)
   * @param {Function} [options.onLayerComplete] - Callback when a layer completes
   */
  const analyzeUnified = useCallback(async ({ slug, filePath, lang, content, version, layers, includeAi = false, triggerAiOnErrors = true, onLayerComplete, model, apiKey } = {}) => {
    if (!clientRef.current) {
      throw new SynthiException('Gateway client is not ready yet', 'The analyzer gateway client has not been initialized.');
    }
    if (!slug) {
      throw new SynthiException('`slug` is required for unified analysis', 'The workspace slug must be specified.');
    }
    if (!filePath) {
      throw new SynthiException('`filePath` is required for unified analysis', 'The file path must be specified.');
    }
    if (!lang) {
      throw new SynthiException('`lang` is required for unified analysis', 'The programming language must be specified.');
    }
    
    setIsAnalyzing(true);
    setLastError(null);
    
    try {
      const payload = {
        slug,
        filePath,
        lang: lang.toLowerCase(),
        layers: layers || ['static', 'semantic'],
        includeAi,
        triggerAiOnErrors,
      };
      
      if (content !== undefined) {
        payload.content = content;
      }
      
      // Include version for stale detection
      if (typeof version === 'number' || typeof version === 'string') {
        payload.version = version;
      }
      
      if (model) payload.model = model;
      if (apiKey) payload.apiKey = apiKey;
      
      const options = {};
      if (typeof onLayerComplete === 'function') {
        options.onLayerComplete = onLayerComplete;
      }
      
      const response = await clientRef.current.analyzeUnified(payload, options);
      console.log('[analyzeUnified] Raw response:', response);
      const result = response?.data ?? response;
      console.log('[analyzeUnified] Parsed result:', result);
      setLastResult(result);
      return result;
    } catch (error) {
      console.error('[analyzeUnified] Error:', error);
      setLastError(error);
      throw error;
    } finally {
      setIsAnalyzing(false);
    }
  }, []);
  

  const resetResult = useCallback(() => setLastResult(null), []);
  const resetError = useCallback(() => setLastError(null), []);

  // ==========================================================================
  // Self-Healing API
  // ==========================================================================

  /**
   * Analyze code for auto-healable micro-issues.
   * Returns fixes without applying them (unless autoApply=true).
   * 
   * @param {Object} options - Healing options
   * @param {string} options.code - The code to analyze
   * @param {string} options.lang - The programming language
   * @param {string} [options.filePath] - The file path
   * @param {boolean} [options.autoApply=false] - Auto-apply safe fixes
   * @returns {Promise<Object>} Healing result with fixes
   */
  const healAnalyze = useCallback(async ({ code, lang, filePath, autoApply = false } = {}) => {
    if (!clientRef.current) {
      throw new SynthiException('Gateway client is not ready yet');
    }
    if (typeof code !== 'string') {
      throw new SynthiException('`code` must be a string');
    }
    if (!lang) {
      throw new SynthiException('`lang` is required for healing');
    }

    try {
      const response = await clientRef.current.healAnalyze({
        code,
        lang: lang.toLowerCase(),
        filePath: filePath || 'untitled',
        autoApply,
      });
      return response?.data ?? response;
    } catch (error) {
      console.error('[healAnalyze] Error:', error);
      throw error;
    }
  }, []);

  /**
   * Apply healing fixes to code.
   * 
   * @param {Object} options - Apply options
   * @param {string} options.code - Current code
   * @param {string} options.lang - Programming language
   * @param {string} [options.filePath] - File path
   * @param {string[]} [options.fixIds] - Specific fix IDs (null = all safe)
   * @returns {Promise<Object>} Result with healed code
   */
  const healApply = useCallback(async ({ code, lang, filePath, fixIds } = {}) => {
    if (!clientRef.current) {
      throw new SynthiException('Gateway client is not ready yet');
    }

    try {
      const response = await clientRef.current.healApply({
        code,
        lang: lang.toLowerCase(),
        filePath: filePath || 'untitled',
        fixIds: fixIds || null,
      });
      return response?.data ?? response;
    } catch (error) {
      console.error('[healApply] Error:', error);
      throw error;
    }
  }, []);

  /**
   * Container-first healing.
   * 
   * @param {Object} options - Container healing options
   * @param {string} options.slug - Workspace slug
   * @param {string} options.filePath - File path
   * @param {string} options.lang - Programming language
   * @returns {Promise<Object>} Healing result
   */
  const healContainer = useCallback(async ({ slug, filePath, lang } = {}) => {
    if (!clientRef.current) {
      throw new SynthiException('Gateway client is not ready yet');
    }

    try {
      const response = await clientRef.current.healContainer({
        slug,
        filePath,
        lang: lang.toLowerCase(),
      });
      return response?.data ?? response;
    } catch (error) {
      console.error('[healContainer] Error:', error);
      throw error;
    }
  }, []);

  /**
   * Get or update healing configuration.
   */
  const healConfig = useCallback(async (updates = null) => {
    if (!clientRef.current) {
      throw new SynthiException('Gateway client is not ready yet');
    }
    try {
      const response = await clientRef.current.healConfig(updates);
      return response?.data ?? response;
    } catch (error) {
      console.error('[healConfig] Error:', error);
      throw error;
    }
  }, []);

  /**
   * Get healing statistics.
   */
  const healStats = useCallback(async () => {
    if (!clientRef.current) {
      throw new SynthiException('Gateway client is not ready yet');
    }
    try {
      const response = await clientRef.current.healStats();
      return response?.data ?? response;
    } catch (error) {
      console.error('[healStats] Error:', error);
      throw error;
    }
  }, []);

  const connectionMeta = useMemo(
    () => ({
      status: connectionStatus,
      isConnected: connectionStatus === GatewayStatus.CONNECTED,
    }),
    [connectionStatus]
  );

  return {
    connectionStatus,
    connectionMeta,
    isAnalyzing,
    lastResult,
    lastError,
    analyzeCode,
    askAi,
    analyzeProactive,
    analyzeContainer, // Container-First analysis
    analyzeUnified,   // Unified Intelligence Pipeline (RECOMMENDED)
    // Self-Healing
    healAnalyze,
    healApply,
    healContainer,
    healConfig,
    healStats,
    resetResult,
    resetError,
    clientReady: Boolean(clientRef.current),
    // Expose client for advanced use cases (e.g., workspace analysis)
    client: clientRef.current,
    clientRef,
  };
}
