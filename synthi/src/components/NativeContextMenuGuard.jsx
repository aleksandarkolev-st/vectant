'use client';

import { useEffect } from 'react';

/**
 * Suppresses the browser's native right-click menu everywhere inside the
 * workspace. Surfaces that wire up their own custom context menu (via
 * `useContextMenu`, Monaco, Radix, etc.) keep working — those handlers
 * preventDefault before this one and render their own UI.
 *
 * The point: when nothing custom is wired up, right-click feels "dead",
 * which is the discovery signal — the user can spam right-click around
 * the IDE to map out where custom menus exist without the browser menu
 * crashing the party.
 *
 * We deliberately exclude text-entry surfaces (input, textarea,
 * contenteditable) so paste / spellcheck suggestions still work where
 * the native menu carries real utility.
 */
export default function NativeContextMenuGuard() {
  useEffect(() => {
    const isTextEntryTarget = (target) => {
      if (!target || target.nodeType !== 1) return false;
      const el = target;
      if (el.isContentEditable) return true;
      const tag = el.tagName;
      if (tag === 'TEXTAREA') return true;
      if (tag === 'INPUT') {
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        // Non-text inputs (checkbox, radio, button, …) have no useful native menu.
        const textyTypes = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number']);
        return textyTypes.has(type);
      }
      return false;
    };

    const onContextMenu = (e) => {
      if (isTextEntryTarget(e.target)) return;
      e.preventDefault();
    };

    window.addEventListener('contextmenu', onContextMenu);
    return () => window.removeEventListener('contextmenu', onContextMenu);
  }, []);

  return null;
}
