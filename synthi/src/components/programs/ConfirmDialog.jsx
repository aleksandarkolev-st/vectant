'use client';

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, X } from 'lucide-react';

/**
 * Generic confirm dialog — mirrors the terminal's multi-line-paste modal chrome
 * (brand-gradient hairline, icon plate, title + subtitle, Cancel/Confirm footer)
 * WITHOUT the paste-preview box or the "trust pastes" checkbox. Centred, no
 * backdrop dim (the IDE stays visible behind it). Escape cancels.
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

  const accent = tone === 'danger' ? '#ff5757' : 'var(--accent-warning, #fbbf24)';

  return createPortal(
    <div
      data-testid="confirm-dialog"
      className="fixed"
      style={{ left: '50%', top: '50%', transform: 'translate(-50%, -50%)', width: 400, maxWidth: 'calc(100vw - 16px)', zIndex: 2147483646 }}
    >
      <div
        className="flex flex-col overflow-hidden rounded-lg border shadow-none"
        style={{
          background: 'color-mix(in srgb, var(--bg-elevated, #18181b) 92%, var(--bg-app, #0a0b10))',
          borderColor: 'var(--border-medium, #3f3f46)',
          color: 'var(--text-primary, #e4e4e7)',
        }}
      >
        <div aria-hidden="true" className="h-px w-full" style={{ background: 'var(--brand-gradient-horizontal)' }} />
        <div className="flex items-start gap-3 px-3 py-3">
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
            style={{
              borderColor: `color-mix(in srgb, ${accent} 26%, transparent)`,
              color: accent,
              background: `color-mix(in srgb, ${accent} 8%, var(--bg-app, #0a0b10))`,
            }}
          >
            <AlertTriangle className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[12px] font-semibold">{title}</div>
            {message ? (
              <p className="mt-1 text-[11px] leading-5" style={{ color: 'var(--text-secondary, #a1a1aa)' }}>{message}</p>
            ) : null}
          </div>
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="rounded-md p-1 opacity-70 transition-opacity hover:bg-white/5 hover:opacity-100"
            style={{ color: 'var(--text-muted, #6b7089)' }}
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
            className="h-8 rounded-md border px-3 text-xs font-medium transition-colors hover:bg-white/[0.04]"
            style={{ borderColor: 'var(--border-medium, #3f3f46)', color: 'var(--text-secondary, #a1a1aa)' }}
          >
            {cancelLabel}
            <span className="ml-1.5 text-[10px] opacity-60">Esc</span>
          </button>
          <button
            type="button"
            data-testid="confirm-accept"
            onClick={onConfirm}
            className="h-8 rounded-md px-3 text-xs font-semibold transition-opacity hover:opacity-90 active:scale-[0.97]"
            style={{ background: accent, color: '#fff' }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
