'use client';

/**
 * useDockKeyboardShortcuts
 * 
 * Global keyboard shortcuts for the docking system:
 * - Ctrl + Alt + E: Focus/show problems panel
 * - Ctrl + Shift + D: Toggle docked/floating
 * - Escape: Close panel (when floating)
 */

import { useEffect, useCallback } from 'react';

export function useDockKeyboardShortcuts({
  onFocusPanel,
  onToggleDockState,
  onClosePanel,
  isPanelVisible = false,
  isPanelFloating = false,
}) {
  const handleKeyDown = useCallback((e) => {
    // Ctrl + Alt + E - Focus/show problems panel
    if (e.ctrlKey && e.altKey && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      onFocusPanel?.();
      return;
    }
    
    // Ctrl + Shift + D - Toggle docked/floating (only when panel is visible)
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') {
      if (isPanelVisible) {
        e.preventDefault();
        onToggleDockState?.();
      }
      return;
    }
    
    // Escape - Close panel (only when floating and visible)
    if (e.key === 'Escape') {
      if (isPanelVisible && isPanelFloating) {
        e.preventDefault();
        onClosePanel?.();
      }
      return;
    }
  }, [onFocusPanel, onToggleDockState, onClosePanel, isPanelVisible, isPanelFloating]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);
}

export default useDockKeyboardShortcuts;
