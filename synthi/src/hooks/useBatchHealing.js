"use client";

import { useCallback, useRef, useState } from "react";
import { useDispatch, useSelector } from "react-redux";
import { useAnalyzerGateway } from "@/hooks/useAnalyzerGateway";

/**
 * Hook for batch-healing multiple files at once.
 *
 * Sends all open/changed files to the backend for concurrent analysis,
 * then surfaces aggregated results in Redux state.
 */
export function useBatchHealing() {
  const dispatch = useDispatch();
  const { healBatch, clientReady } = useAnalyzerGateway();
  const [isRunning, setIsRunning] = useState(false);
  const [batchResult, setBatchResult] = useState(null);
  const [error, setError] = useState(null);
  const abortRef = useRef(false);

  /**
   * Run batch analysis on the given files.
   * @param {Array<{filePath: string, language: string, code: string, priority?: number}>} files
   */
  const runBatch = useCallback(
    async (files) => {
      if (!clientReady || isRunning || !files?.length) return null;

      setIsRunning(true);
      setError(null);
      abortRef.current = false;

      try {
        const result = await healBatch({ files });

        if (abortRef.current) return null;

        setBatchResult(result);
        return result;
      } catch (err) {
        console.error("[BatchHealing] error:", err);
        setError(err.message || "Batch healing failed");
        return null;
      } finally {
        setIsRunning(false);
      }
    },
    [healBatch, clientReady, isRunning]
  );

  /**
   * Cancel the current batch run.
   */
  const cancelBatch = useCallback(() => {
    abortRef.current = true;
  }, []);

  /**
   * Clear the batch result state.
   */
  const clearResult = useCallback(() => {
    setBatchResult(null);
    setError(null);
  }, []);

  return {
    runBatch,
    cancelBatch,
    clearResult,
    isRunning,
    batchResult,
    error,
  };
}
