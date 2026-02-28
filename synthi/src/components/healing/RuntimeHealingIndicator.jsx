/**
 * RuntimeHealingIndicator — visual feedback for HMR runtime healing.
 * 
 * Shows as a small overlay in the bottom-right when the AI is actively
 * fixing compile errors. Displays:
 * - Healing status (analyzing, applying, retrying, success, error)
 * - Current attempt / max attempts
 * - Fix count
 * - Auto-heal toggle
 * 
 * Complements ErrorOverlay — ErrorOverlay shows the errors, this shows
 * the AI's progress fixing them.
 */
'use client';

import { useState, useEffect, useCallback } from 'react';
import { Wand2, Loader2, CheckCircle2, XCircle, Zap, ZapOff, RotateCcw } from 'lucide-react';

/**
 * @param {Object} props
 * @param {Object} props.healingState — from useRuntimeHealing()
 */
export function RuntimeHealingIndicator({ healingState }) {
  const {
    status,
    attempt,
    maxAttempts,
    lastResult,
    lastError,
    isHealing,
    isSuccess,
    isError,
    isAutoHeal,
    toggleAutoHeal,
    resetAttempts,
  } = healingState;

  const [visible, setVisible] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  // Show when healing starts, hide after success fades
  useEffect(() => {
    if (status === 'idle') {
      setVisible(false);
      setDismissed(false);
      return;
    }
    setVisible(true);
    setDismissed(false);

    // Auto-hide success after 5s
    if (status === 'success') {
      const timer = setTimeout(() => setVisible(false), 5000);
      return () => clearTimeout(timer);
    }
  }, [status]);

  if (!visible || dismissed || status === 'idle') return null;

  const fixCount = lastResult?.appliedFixes?.length || 0;

  return (
    <div className="fixed bottom-4 right-4 z-50 max-w-sm animate-in slide-in-from-bottom-2 fade-in duration-300">
      <div className={`
        rounded-lg border shadow-lg backdrop-blur-sm p-3
        ${isHealing ? 'border-purple-500/40 bg-purple-950/80' : ''}
        ${isSuccess ? 'border-green-500/40 bg-green-950/80' : ''}
        ${isError ? 'border-red-500/40 bg-red-950/80' : ''}
      `}>
        {/* Header */}
        <div className="flex items-center justify-between gap-3 mb-1">
          <div className="flex items-center gap-2">
            {isHealing && (
              <Loader2 size={16} className="text-purple-400 animate-spin" />
            )}
            {isSuccess && (
              <CheckCircle2 size={16} className="text-green-400" />
            )}
            {isError && (
              <XCircle size={16} className="text-red-400" />
            )}
            <span className="text-sm font-medium text-white">
              {status === 'healing' && 'AI fixing errors...'}
              {status === 'applying' && 'Applying fix...'}
              {status === 'retrying' && 'Waiting for HMR...'}
              {status === 'success' && `Fixed! ${fixCount} fix${fixCount !== 1 ? 'es' : ''} applied`}
              {status === 'error' && 'Healing failed'}
            </span>
          </div>

          <button
            onClick={() => setDismissed(true)}
            className="text-gray-500 hover:text-gray-300 text-xs"
            title="Dismiss"
          >
            ✕
          </button>
        </div>

        {/* Progress */}
        {isHealing && (
          <div className="flex items-center gap-2 text-xs text-gray-400 mb-2">
            <span>Attempt {attempt}/{maxAttempts}</span>
            <div className="flex-1 h-1 rounded-full bg-gray-700 overflow-hidden">
              <div
                className="h-full bg-purple-500 rounded-full transition-all duration-500"
                style={{ width: `${(attempt / maxAttempts) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Error detail */}
        {isError && lastError && (
          <p className="text-xs text-red-300/80 mb-2 line-clamp-2">
            {lastError}
          </p>
        )}

        {/* Success detail */}
        {isSuccess && lastResult && (
          <p className="text-xs text-green-300/80 mb-2">
            {lastResult.diagnosticCount} error{lastResult.diagnosticCount !== 1 ? 's' : ''} diagnosed,{' '}
            {fixCount} fix{fixCount !== 1 ? 'es' : ''} applied
          </p>
        )}

        {/* Controls */}
        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={toggleAutoHeal}
            className={`
              flex items-center gap-1 px-2 py-1 rounded text-xs transition-colors
              ${isAutoHeal
                ? 'bg-purple-500/20 text-purple-300 hover:bg-purple-500/30'
                : 'bg-gray-700/50 text-gray-400 hover:bg-gray-700/70'}
            `}
            title={isAutoHeal ? 'Disable auto-heal' : 'Enable auto-heal'}
          >
            {isAutoHeal ? <Zap size={12} /> : <ZapOff size={12} />}
            Auto
          </button>

          {isError && (
            <button
              onClick={() => resetAttempts()}
              className="flex items-center gap-1 px-2 py-1 rounded text-xs
                         bg-gray-700/50 text-gray-400 hover:bg-gray-700/70 transition-colors"
              title="Reset attempt counter"
            >
              <RotateCcw size={12} />
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export default RuntimeHealingIndicator;
