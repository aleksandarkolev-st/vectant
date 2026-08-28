'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';

/**
 * Generic Vectant confirm dialog. Used by workspace tools for destructive or
 * gated actions so they never fall back to native browser confirm chrome.
 */
export default function ConfirmDialog({
  title,
  message = null,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'danger',
  onConfirm,
  onCancel,
}) {
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); onCancel?.(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  if (typeof document === 'undefined') return null;

  const accent = tone === 'danger'
    ? 'var(--accent-danger)'
    : tone === 'success'
      ? 'var(--accent-success)'
      : 'var(--accent-warning)';

  return createPortal(
    <div
      data-testid="confirm-dialog"
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,black_58%,transparent)] px-3 backdrop-blur-sm"
      role="presentation"
    >
      <div
        className="vt-dialog-surface flex w-[400px] max-w-full flex-col overflow-hidden"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
      >
        <div aria-hidden="true" className="h-px w-full" style={{ background: 'var(--brand-gradient-horizontal)' }} />
        <div className="flex items-start gap-3 px-3 py-3">
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
            style={{
              borderColor: `color-mix(in srgb, ${accent} 26%, transparent)`,
              color: accent,
              background: `color-mix(in srgb, ${accent} 8%, var(--bg-app))`,
            }}
          >
            <AlertTriangle className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div id="confirm-dialog-title" className="text-[12px] font-semibold" style={{ color: 'var(--text-primary)' }}>{title}</div>
            {message ? (
              <p className="mt-1 whitespace-pre-wrap text-[11px] leading-5" style={{ color: 'var(--text-secondary)' }}>{message}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="th-focus-ring rounded-md p-1 opacity-70 transition-opacity hover:opacity-100"
            style={{ color: 'var(--text-muted)', background: 'color-mix(in srgb, var(--text-primary) 0%, transparent)' }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="flex items-center justify-end gap-2 px-3 pb-3">
          <button
            type="button"
            data-testid="confirm-cancel"
            onClick={onCancel}
            autoFocus
            className="th-focus-ring h-8 rounded-md border px-3 text-xs font-medium transition-colors"
            style={{ borderColor: 'var(--border-medium)', color: 'var(--text-secondary)', background: 'color-mix(in srgb, var(--bg-panel) 70%, transparent)' }}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            data-testid="confirm-accept"
            onClick={onConfirm}
            className="th-focus-ring h-8 rounded-md border px-3 text-xs font-semibold transition-opacity hover:opacity-90 active:scale-[0.97]"
            style={{
              borderColor: `color-mix(in srgb, ${accent} 42%, transparent)`,
              background: `color-mix(in srgb, ${accent} 15%, var(--bg-panel))`,
              color: accent,
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
