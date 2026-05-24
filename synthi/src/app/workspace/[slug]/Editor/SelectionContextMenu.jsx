'use client';

/**
 * SelectionContextMenu — custom right-click menu for the Monaco code editor.
 *
 * Behaviour: opens ONLY when the user right-clicks *on* an existing,
 * non-empty selection. Right-clicks anywhere else are a no-op (Monaco's
 * built-in menu is already disabled via the `contextmenu: false` option,
 * and the NativeContextMenuGuard suppresses the native browser menu).
 */

import React, { useEffect } from 'react';
import { toast } from 'sonner';
import { ContextMenu, useContextMenu } from '@/components/docking-wm/components/ContextMenu';

export default function SelectionContextMenu({ editor }) {
  const { menuState, openMenu, closeMenu } = useContextMenu();

  useEffect(() => {
    if (!editor) return undefined;
    const dom = editor.getDomNode?.();
    if (!dom) return undefined;

    const handler = (e) => {
      let sel;
      try { sel = editor.getSelection?.(); } catch { return; }
      if (!sel || sel.isEmpty?.()) return; // no selection → no menu

      let target;
      try { target = editor.getTargetAtClientPoint?.(e.clientX, e.clientY); } catch { return; }
      if (!target || !target.position) return;
      // Selection must contain the clicked position. containsPosition is
      // the canonical Monaco check for "is this point inside the range".
      if (!sel.containsPosition?.(target.position)) return;

      let selectedText = '';
      try { selectedText = editor.getModel?.()?.getValueInRange?.(sel) || ''; } catch {}
      if (!selectedText) return;

      e.preventDefault();
      e.stopPropagation();

      const copy = () => navigator.clipboard.writeText(selectedText).then(
        () => toast.success('Copied'),
        () => toast.error('Copy failed'),
      );

      const cut = () => navigator.clipboard.writeText(selectedText).then(
        () => {
          try { editor.executeEdits('selection-context-menu', [{ range: sel, text: '' }]); } catch {}
          toast.success('Cut');
        },
        () => toast.error('Cut failed'),
      );

      const paste = async () => {
        try {
          const text = await navigator.clipboard.readText();
          if (!text) return;
          editor.executeEdits('selection-context-menu', [{ range: sel, text }]);
        } catch {
          toast.error('Paste failed');
        }
      };

      const openInTab = (urlBuilder) => {
        try { window.open(urlBuilder(selectedText), '_blank', 'noopener,noreferrer'); } catch {}
      };

      const trigger = (cmdId) => {
        try { editor.trigger?.('selection-context-menu', cmdId, null); } catch {}
      };

      const askAI = () => {
        let language = '';
        let filePath = '';
        try {
          const model = editor.getModel?.();
          language = model?.getLanguageId?.() || '';
          filePath = model?.uri?.path || '';
        } catch {}
        const startLine = sel.startLineNumber ?? null;
        const endLine = sel.endLineNumber ?? null;
        try {
          window.dispatchEvent(new CustomEvent('synthi:ask-ai', {
            detail: { text: selectedText, language, filePath, startLine, endLine },
          }));
        } catch {}
      };

      openMenu(e, [
        { id: 'copy',  label: 'Copy',  shortcut: 'Ctrl+C', action: copy },
        { id: 'cut',   label: 'Cut',   shortcut: 'Ctrl+X', action: cut },
        { id: 'paste', label: 'Paste', shortcut: 'Ctrl+V', dividerAfter: true, action: paste },
        {
          id: 'google',
          label: 'Search on Google',
          action: () => openInTab((s) => `https://www.google.com/search?q=${encodeURIComponent(s)}`),
        },
        {
          id: 'ask-ai',
          label: 'Ask AI',
          dividerAfter: true,
          action: askAI,
        },
        { id: 'format', label: 'Format Selection', action: () => trigger('editor.action.formatSelection') },
        { id: 'rename', label: 'Rename Symbol', shortcut: 'F2', action: () => trigger('editor.action.rename') },
      ]);
    };

    // CAPTURE phase so we run before any descendant handler that might
    // stopPropagation. Monaco itself doesn't open a menu (option disabled),
    // but its internals do listen for contextmenu events.
    dom.addEventListener('contextmenu', handler, true);
    return () => {
      try { dom.removeEventListener('contextmenu', handler, true); } catch {}
    };
  }, [editor, openMenu]);

  return menuState ? <ContextMenu {...menuState} onClose={closeMenu} /> : null;
}
