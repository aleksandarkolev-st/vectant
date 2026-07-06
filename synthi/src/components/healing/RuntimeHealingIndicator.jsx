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
import { Loader2, CheckCircle2, XCircle, Zap, ZapOff, RotateCcw, X } from 'lucide-react';

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
      <div
        className="vt-command-popover p-3"
        style={{
          borderColor: isError
            ? 'color-mix(in srgb, var(--accent-danger) 42%, var(--border-subtle))'
            : isSuccess
              ? 'color-mix(in srgb, var(--accent-success) 38%, var(--border-subtle))'
              : 'color-mix(in srgb, var(--attention-purple) 34%, var(--border-subtle))',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-3 mb-1">
          <div className="flex items-center gap-2">
            {isHealing && (
              <Loader2 size={16} className="animate-spin text-[var(--attention-purple)]" />
            )}
            {isSuccess && (
              <CheckCircle2 size={16} className="text-[var(--accent-success)]" />
            )}
            {isError && (
              <XCircle size={16} className="text-[var(--accent-danger)]" />
            )}
            <span className="text-sm font-semibold text-[var(--text-primary)]">
              {status === 'healing' && 'AI fixing errors...'}
              {status === 'applying' && 'Applying fix...'}
              {status === 'retrying' && 'Waiting for HMR...'}
              {status === 'success' && `Fixed! ${fixCount} fix${fixCount !== 1 ? 'es' : ''} applied`}
              {status === 'error' && 'Healing failed'}
            </span>
          </div>

          <button
            onClick={() => setDismissed(true)}
            className="vt-icon-button th-focus-ring h-6 min-w-6"
            title="Dismiss"
          >
            <X size={13} />
          </button>
        </div>

        {/* Progress */}
        {isHealing && (
          <div className="mb-2 flex items-center gap-2 text-xs text-[var(--text-muted)]">
            <span>Attempt {attempt}/{maxAttempts}</span>
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--text-primary)_8%,transparent)]">
              <div
                className="h-full rounded-full bg-[var(--attention-purple)] transition-all duration-500"
                style={{ width: `${(attempt / maxAttempts) * 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Error detail */}
        {isError && lastError && (
          <p className="mb-2 line-clamp-2 text-xs text-[var(--accent-danger)]">
            {lastError}
          </p>
        )}

        {/* Success detail */}
        {isSuccess && lastResult && (
          <p className="mb-2 text-xs text-[var(--accent-success)]">
            {lastResult.diagnosticCount} error{lastResult.diagnosticCount !== 1 ? 's' : ''} diagnosed,{' '}
            {fixCount} fix{fixCount !== 1 ? 'es' : ''} applied
          </p>
        )}

        {/* Controls */}
        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={toggleAutoHeal}
            className={`th-focus-ring flex items-center gap-1 rounded-[var(--radius-control)] px-2 py-1 text-xs transition-colors ${isAutoHeal ? 'th-btn-active' : 'th-btn-ghost'}`}
            title={isAutoHeal ? 'Disable auto-heal' : 'Enable auto-heal'}
          >
            {isAutoHeal ? <Zap size={12} /> : <ZapOff size={12} />}
            Auto
          </button>

          {isError && (
            <button
              onClick={() => resetAttempts()}
              className="th-focus-ring th-btn-ghost flex items-center gap-1 rounded-[var(--radius-control)] px-2 py-1 text-xs"
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
