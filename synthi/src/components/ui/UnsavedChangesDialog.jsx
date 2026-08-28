'use client';
import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle } from 'lucide-react';

/**
 * UnsavedChangesDialog — Vectant "Save / Discard / Cancel" modal.
 *
 * Shown when the user attempts to close a tab with unsaved changes while
 * auto-save is disabled.  Uses a focus-trapped portal overlay with keyboard
 * support (Enter = Save, Escape = Cancel).
 *
 * Props:
 *   fileName  — display name of the file (e.g. "index.js")
 *   onSave    — called when the user clicks "Save"
 *   onDiscard — called when the user discards changes
 *   onCancel  — called when the user clicks "Cancel" or presses Escape
 */
export default function UnsavedChangesDialog({ fileName, onSave, onDiscard, onCancel }) {
  const dialogRef = useRef(null);

  // Focus the dialog on mount so keyboard events work immediately
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback((e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
    } else if (e.key === 'Enter') {
      e.stopPropagation();
      onSave();
    }
  }, [onCancel, onSave]);

  // Prevent clicks inside the dialog from bubbling to the backdrop
  const handleDialogClick = useCallback((e) => e.stopPropagation(), []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,var(--bg-app)_72%,transparent)] px-3 backdrop-blur-sm"
      onClick={onCancel}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Save changes to ${fileName}?`}
        className="vt-dialog-surface flex w-[420px] max-w-full flex-col overflow-hidden outline-none"
        onClick={handleDialogClick}
      >
        <div aria-hidden="true" className="h-px w-full" style={{ background: 'var(--brand-gradient-horizontal)' }} />
        {/* Header */}
        <div className="flex items-start gap-3 px-4 py-3">
          <div
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent-warning) 28%, transparent)',
              color: 'var(--accent-warning)',
              background: 'color-mix(in srgb, var(--accent-warning) 8%, var(--bg-app))',
            }}
          >
            <AlertTriangle className="h-3.5 w-3.5" />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="text-[13px] font-semibold" style={{ color: 'var(--text-primary)' }}>
              Save changes to <span className="font-semibold">{fileName}</span>?
            </h2>
            <p className="mt-1 text-[11px] leading-5" style={{ color: 'var(--text-secondary)' }}>
              Unsaved editor changes will be discarded if you continue without saving.
            </p>
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 border-t px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
          <button
            onClick={onDiscard}
            className="th-focus-ring h-8 rounded-md border px-3 text-xs font-medium transition-colors"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent-danger) 36%, var(--border-medium))',
              background: 'color-mix(in srgb, var(--accent-danger) 8%, transparent)',
              color: 'var(--accent-danger)',
            }}
          >
            Discard
          </button>
          <button
            onClick={onCancel}
            className="th-focus-ring h-8 rounded-md border px-3 text-xs font-medium transition-colors"
            style={{ borderColor: 'var(--border-medium)', color: 'var(--text-secondary)', background: 'color-mix(in srgb, var(--bg-panel) 70%, transparent)' }}
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            className="th-focus-ring h-8 rounded-md border px-3 text-xs font-semibold transition-opacity hover:opacity-90 active:scale-[0.97]"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent-primary) 42%, transparent)',
              background: 'var(--brand-gradient)',
              color: 'var(--bg-app)',
            }}
          >
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
