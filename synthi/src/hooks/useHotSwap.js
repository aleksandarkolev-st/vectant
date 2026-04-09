// ============================================================
// useHotSwap.js
// ============================================================
// React hook for consuming dynamic library hot-swap status in
// preview panel components.
// ============================================================

import { useState, useEffect, useCallback } from 'react';
import {
  getDynlibStatus,
  subscribeDynlibStatus,
  isSwapInProgress,
} from '@/lib/dynlib-status';

/**
 * React hook that subscribes to dynamic library swap status.
 *
 * @returns {{
 *   phase: string,
 *   module: string,
 *   elapsedMs: number,
 *   rolledBack: boolean,
 *   error: string|null,
 *   timing: { quiesceMs: number, snapshotMs: number, loadMs: number, restoreMs: number },
 *   isSwapping: boolean,
 *   isIdle: boolean,
 *   isFailed: boolean,
 * }}
 */
export function useHotSwap() {
  const [status, setStatus] = useState(getDynlibStatus);

  useEffect(() => {
    const unsub = subscribeDynlibStatus(setStatus);
    return unsub;
  }, []);

  const isSwapping = isSwapInProgress();
  const isIdle = status.phase === 'idle' || status.phase === 'completed';
  const isFailed = status.phase === 'failed' || status.phase === 'aborted';

  return {
    ...status,
    isSwapping,
    isIdle,
    isFailed,
  };
}
