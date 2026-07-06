'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export default function PromptDialog({
  title,
  message = '',
  initialValue = '',
  placeholder = '',
  confirmLabel = 'Continue',
  cancelLabel = 'Cancel',
  onSubmit,
  onCancel,
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef(null);

  useEffect(() => {
    const id = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(id);
  }, []);

  const submit = useCallback(() => {
    onSubmit?.(value.trim());
  }, [onSubmit, value]);

  const handleKeyDown = useCallback((event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onCancel?.();
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
    }
  }, [onCancel, submit]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-[color-mix(in_srgb,black_58%,transparent)] px-3 backdrop-blur-sm">
      <div className="vt-dialog-surface flex w-[420px] max-w-full flex-col overflow-hidden" role="dialog" aria-modal="true" aria-labelledby="prompt-dialog-title">
        <div aria-hidden="true" className="h-px w-full" style={{ background: 'var(--brand-gradient-horizontal)' }} />
        <div className="flex items-start gap-3 px-4 py-3">
          <div className="min-w-0 flex-1">
            <h2 id="prompt-dialog-title" className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
              {title}
            </h2>
            {message ? (
              <p className="mt-1 whitespace-pre-wrap text-xs leading-5" style={{ color: 'var(--text-secondary)' }}>
                {message}
              </p>
            ) : null}
          </div>
          <button type="button" className="vt-icon-button th-focus-ring" onClick={onCancel} aria-label="Close dialog">
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="px-4 pb-3">
          <input
            ref={inputRef}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            className="th-focus-ring-inset h-9 w-full rounded-md border px-3 text-sm outline-none"
            style={{
              background: 'var(--bg-editor)',
              borderColor: 'var(--border-medium)',
              color: 'var(--text-primary)',
              caretColor: 'var(--attention-purple)',
            }}
          />
        </div>
        <div className="flex items-center justify-end gap-2 border-t px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
          <button
            type="button"
            className="th-focus-ring h-8 rounded-md border px-3 text-xs font-medium"
            style={{ borderColor: 'var(--border-medium)', color: 'var(--text-secondary)', background: 'color-mix(in srgb, var(--bg-panel) 70%, transparent)' }}
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className="th-focus-ring h-8 rounded-md border px-3 text-xs font-semibold"
            style={{
              borderColor: 'color-mix(in srgb, var(--attention-purple) 42%, transparent)',
              background: 'color-mix(in srgb, var(--attention-purple) 14%, var(--bg-panel))',
              color: 'var(--text-primary)',
            }}
            onClick={submit}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
