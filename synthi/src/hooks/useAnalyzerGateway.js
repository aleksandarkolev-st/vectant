'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AnalyzerGatewayClient,
  GatewayStatus,
} from '@/services/analyzerGatewayClient';

const DEFAULT_WS_URL =
  process.env.NEXT_PUBLIC_GATEWAY_WS_URL || 'ws://localhost:7070/ws';

export function useAnalyzerGateway({
  url = DEFAULT_WS_URL,
  autoConnect = true,
} = {}) {
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
      throw new Error('Gateway client is not ready yet');
    }
    if (typeof code !== 'string') {
      throw new Error('`code` must be a string');
    }
    if (!lang) {
      throw new Error('`lang` is required for analysis');
    }

    setIsAnalyzing(true);
    setLastError(null);

    try {
      const response = await clientRef.current.analyze({ code, lang });
      const payload = response?.data ?? response;
      setLastResult(payload);
      return payload;
    } catch (error) {
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
    resetResult,
    resetError,
    clientReady: Boolean(clientRef.current),
  };
}
