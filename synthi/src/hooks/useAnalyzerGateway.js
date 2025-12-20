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
   */
  const analyzeProactive = useCallback(async ({ code, lang, filePath, includeAi = false, onTierComplete } = {}) => {
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
  

  const resetResult = useCallback(() => setLastResult(null), []);
  const resetError = useCallback(() => setLastError(null), []);

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
    resetResult,
    resetError,
    clientReady: Boolean(clientRef.current),
    // Expose client for advanced use cases (e.g., workspace analysis)
    client: clientRef.current,
    clientRef,
  };
}
