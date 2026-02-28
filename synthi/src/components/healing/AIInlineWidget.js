// src/components/healing/AIInlineWidget.js
// Monaco inline content widget for AI-detected fixes.
//
// Shows a small inline hint (lightbulb + description) next to the
// affected line.  Clicking the hint opens a popover with the diff
// and Apply/Dismiss buttons.
//
// Usage:
//   import { createAIInlineWidgets, disposeAIInlineWidgets } from './AIInlineWidget';
//   const disposable = createAIInlineWidgets(editor, fixes, { onApply, onDismiss });
//   // later...
//   disposable.dispose();

/**
 * Severity → inline hint styling.
 */
const SEVERITY_STYLE = {
  critical: { color: '#f87171', bg: 'rgba(248,113,113,0.12)', icon: '🔴' },
  high:     { color: '#fb923c', bg: 'rgba(251,146,60,0.12)',  icon: '🟠' },
  moderate: { color: '#facc15', bg: 'rgba(250,204,21,0.12)',  icon: '🟡' },
  low:      { color: '#60a5fa', bg: 'rgba(96,165,250,0.12)',  icon: '🔵' },
  trivial:  { color: '#9ca3af', bg: 'rgba(156,163,175,0.10)', icon: '⚪' },
};

function getSevStyle(severity) {
  return SEVERITY_STYLE[severity] || SEVERITY_STYLE.moderate;
}


/**
 * Create a unique widget ID for a fix.
 */
function widgetId(fix, index) {
  return `ai-inline-${fix.fix_id || fix.id || index}`;
}


/**
 * Create inline content widgets in Monaco for each AI fix.
 *
 * @param {import('monaco-editor').editor.IStandaloneCodeEditor} editor
 * @param {Array}    fixes   – array of AI fix objects
 * @param {Object}   actions
 * @param {Function} actions.onApply   – (fix) => void
 * @param {Function} actions.onDismiss – (fix) => void
 * @returns {{ dispose: () => void }} – disposable
 */
export function createAIInlineWidgets(editor, fixes, { onApply, onDismiss } = {}) {
  if (!editor || !fixes?.length) {
    return { dispose: () => {} };
  }

  const widgets = [];
  const disposables = [];

  for (let i = 0; i < fixes.length; i++) {
    const fix = fixes[i];
    const line = (fix.line ?? fix.start_line ?? fix.startLine ?? 0) + 1;
    const severity = fix.severity || 'moderate';
    const sev = getSevStyle(severity);
    const desc = fix.description || 'AI-detected issue';
    const confidence = Math.round((fix.confidence ?? 0) * 100);
    const id = widgetId(fix, i);

    // Create the DOM node for the inline widget
    const node = document.createElement('div');
    node.className = 'ai-inline-hint';
    node.style.cssText = `
      display: inline-flex;
      align-items: center;
      gap: 4px;
      margin-left: 16px;
      padding: 1px 8px;
      border-radius: 3px;
      font-size: 11px;
      line-height: 18px;
      cursor: pointer;
      background: ${sev.bg};
      color: ${sev.color};
      border: 1px solid ${sev.color}33;
      opacity: 0.85;
      transition: opacity 0.15s;
      white-space: nowrap;
      max-width: 400px;
      overflow: hidden;
      text-overflow: ellipsis;
    `;
    node.title = `${desc}\nConfidence: ${confidence}%\nClick to expand`;
    node.textContent = `${sev.icon} ${desc} (${confidence}%)`;

    // Hover effect
    node.addEventListener('mouseenter', () => { node.style.opacity = '1'; });
    node.addEventListener('mouseleave', () => { node.style.opacity = '0.85'; });

    // Click: show action popover
    node.addEventListener('click', (e) => {
      e.stopPropagation();
      _showFixPopover(editor, fix, node, { onApply, onDismiss });
    });

    // Register as a content widget in Monaco
    const widget = {
      getId: () => id,
      getDomNode: () => node,
      getPosition: () => ({
        position: { lineNumber: line, column: 1 },
        preference: [
          1, // EXACT — after line content
        ],
      }),
    };

    editor.addContentWidget(widget);
    widgets.push(widget);
  }

  return {
    dispose: () => {
      for (const w of widgets) {
        try { editor.removeContentWidget(w); } catch { /* already removed */ }
      }
      for (const d of disposables) {
        try { d(); } catch { /* ok */ }
      }
      widgets.length = 0;
      disposables.length = 0;
    },
  };
}


/**
 * Show a small floating popover with diff + actions.
 */
function _showFixPopover(editor, fix, anchorNode, { onApply, onDismiss }) {
  // Remove any existing popover
  const existingPopover = document.querySelector('.ai-fix-popover');
  if (existingPopover) existingPopover.remove();

  const original = fix.original_text || fix.originalText || '';
  const replacement = fix.replacement_text || fix.replacementText || '';
  const sev = getSevStyle(fix.severity || 'moderate');

  const popover = document.createElement('div');
  popover.className = 'ai-fix-popover';
  popover.style.cssText = `
    position: absolute;
    z-index: 1000;
    background: #1e1e2e;
    border: 1px solid ${sev.color}44;
    border-radius: 6px;
    padding: 10px;
    min-width: 280px;
    max-width: 500px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    font-size: 12px;
    color: #ccc;
  `;

  // Position near the anchor
  const rect = anchorNode.getBoundingClientRect();
  popover.style.left = `${rect.left}px`;
  popover.style.top = `${rect.bottom + 4}px`;

  // Description
  const descEl = document.createElement('div');
  descEl.style.cssText = 'margin-bottom: 8px; color: #eee; font-weight: 500;';
  descEl.textContent = fix.description || 'AI-detected issue';
  popover.appendChild(descEl);

  // Diff
  if (original || replacement) {
    const diffEl = document.createElement('div');
    diffEl.style.cssText = 'font-family: monospace; font-size: 11px; margin-bottom: 8px;';

    if (original) {
      const oldEl = document.createElement('div');
      oldEl.style.cssText = 'background: rgba(239,68,68,0.1); color: #fca5a5; padding: 3px 6px; border-radius: 3px; margin-bottom: 3px; white-space: pre-wrap;';
      oldEl.textContent = `− ${original}`;
      diffEl.appendChild(oldEl);
    }

    if (replacement) {
      const newEl = document.createElement('div');
      newEl.style.cssText = 'background: rgba(34,197,94,0.1); color: #86efac; padding: 3px 6px; border-radius: 3px; white-space: pre-wrap;';
      newEl.textContent = `+ ${replacement}`;
      diffEl.appendChild(newEl);
    }

    popover.appendChild(diffEl);
  }

  // Action buttons
  const btnContainer = document.createElement('div');
  btnContainer.style.cssText = 'display: flex; gap: 6px;';

  const applyBtn = document.createElement('button');
  applyBtn.textContent = '✓ Apply';
  applyBtn.style.cssText = 'background: rgba(34,197,94,0.25); color: #86efac; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 11px;';
  applyBtn.addEventListener('click', () => {
    onApply?.(fix);
    popover.remove();
  });

  const dismissBtn = document.createElement('button');
  dismissBtn.textContent = '✕ Dismiss';
  dismissBtn.style.cssText = 'background: rgba(255,255,255,0.05); color: #999; border: none; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 11px;';
  dismissBtn.addEventListener('click', () => {
    onDismiss?.(fix);
    popover.remove();
  });

  btnContainer.appendChild(applyBtn);
  btnContainer.appendChild(dismissBtn);
  popover.appendChild(btnContainer);

  document.body.appendChild(popover);

  // Close on click outside
  const closeHandler = (e) => {
    if (!popover.contains(e.target) && e.target !== anchorNode) {
      popover.remove();
      document.removeEventListener('mousedown', closeHandler);
    }
  };
  setTimeout(() => {
    document.addEventListener('mousedown', closeHandler);
  }, 0);
}


/**
 * Convenience: dispose all AI inline widgets from an editor.
 *
 * @param {import('monaco-editor').editor.IStandaloneCodeEditor} editor
 */
export function disposeAIInlineWidgets(editor) {
  if (!editor) return;
  // Monaco doesn't expose a "list all content widgets" API,
  // so we rely on the disposable returned by createAIInlineWidgets.
  // This function is a no-op safety net.
}
