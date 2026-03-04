'use client';
import { useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * UnsavedChangesDialog — VSCode-style "Save / Don't Save / Cancel" modal.
 *
 * Shown when the user attempts to close a tab with unsaved changes while
 * auto-save is disabled.  Uses a focus-trapped portal overlay with keyboard
 * support (Enter = Save, Escape = Cancel).
 *
 * Props:
 *   fileName  — display name of the file (e.g. "index.js")
 *   onSave    — called when the user clicks "Save"
 *   onDiscard — called when the user clicks "Don't Save"
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
      className="fixed inset-0 z-[99999] flex items-center justify-center bg-black/50 backdrop-blur-[2px]"
      onClick={onCancel}
      onKeyDown={handleKeyDown}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Save changes to ${fileName}?`}
        className="bg-[#1e1e1e] border border-[#3f3f46] rounded-lg shadow-2xl w-[340px] outline-none"
        onClick={handleDialogClick}
      >
        {/* Header */}
        <div className="px-4 pt-4 pb-2">
          <h2 className="text-sm font-medium text-[#e4e4e7]">
            Do you want to save the changes you made to{' '}
            <span className="font-semibold text-[#f4f4f5]">{fileName}</span>?
          </h2>
          <p className="text-xs text-[#71717a] mt-1">
            Your changes will be lost if you don&apos;t save them.
          </p>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 px-4 pb-4 pt-2">
          <button
            onClick={onDiscard}
            className="px-3 py-1.5 text-xs rounded border border-[#3f3f46] text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#27272a] transition-colors"
          >
            Don&apos;t Save
          </button>
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-xs rounded border border-[#3f3f46] text-[#a1a1aa] hover:text-[#e4e4e7] hover:bg-[#27272a] transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onSave}
            className="px-3 py-1.5 text-xs rounded bg-[#3b82f6] text-white hover:bg-[#2563eb] transition-colors font-medium"
          >
            Save
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
