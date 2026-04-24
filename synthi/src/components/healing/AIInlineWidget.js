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
 * Severity rank — higher = more important.  Used to pick the "face"
 * of a grouped hint when multiple fixes share a line.
 */
const SEVERITY_RANK = {
  critical: 5,
  high:     4,
  moderate: 3,
  low:      2,
  trivial:  1,
};

function highestSeverity(groupFixes) {
  let best = 'trivial';
  for (const f of groupFixes) {
    const s = f.severity || 'moderate';
    if ((SEVERITY_RANK[s] || 0) > (SEVERITY_RANK[best] || 0)) best = s;
  }
  return best;
}


/**
 * Create inline content widgets in Monaco for each AI fix.
 *
 * Multiple fixes on the same line are merged into a single pill ("N issues")
 * so hints never stack on top of each other.  Clicking a merged pill opens
 * a popover listing each individual fix with per-row Apply/Dismiss.
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

  // Group fixes by 1-based line number so only one widget renders per line.
  const byLine = new Map();
  for (const fix of fixes) {
    const line = (fix.line ?? fix.start_line ?? fix.startLine ?? 0) + 1;
    const bucket = byLine.get(line) || [];
    bucket.push(fix);
    byLine.set(line, bucket);
  }

  const widgets = [];
  const disposables = [];

  for (const [line, groupFixes] of byLine.entries()) {
    const severity = highestSeverity(groupFixes);
    const sev = getSevStyle(severity);
    const count = groupFixes.length;
    const primary = groupFixes[0];
    const desc = count === 1
      ? (primary.description || 'AI-detected issue')
      : `${count} issues on this line`;
    const confidence = Math.round((primary.confidence ?? 0) * 100);
    const id = `ai-inline-L${line}`;

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
    if (count === 1) {
      node.title = `${desc}\nConfidence: ${confidence}%\nClick to expand`;
      node.textContent = `${sev.icon} ${desc} (${confidence}%)`;
    } else {
      node.title = `${count} AI-detected issues on this line — click to review`;
      node.textContent = `${sev.icon} ${count} issues — click to review`;
    }

    node.addEventListener('mouseenter', () => { node.style.opacity = '1'; });
    node.addEventListener('mouseleave', () => { node.style.opacity = '0.85'; });

    node.addEventListener('click', (e) => {
      e.stopPropagation();
      if (count === 1) {
        _showFixPopover(editor, primary, node, { onApply, onDismiss });
      } else {
        _showGroupPopover(editor, groupFixes, node, { onApply, onDismiss });
      }
    });

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
 * Show a popover listing every fix that shares a line.  Each row has its
 * own Apply / Dismiss buttons; clicking a row expands the diff.
 */
function _showGroupPopover(editor, groupFixes, anchorNode, { onApply, onDismiss }) {
  const existingPopover = document.querySelector('.ai-fix-popover');
  if (existingPopover) existingPopover.remove();

  const popover = document.createElement('div');
  popover.className = 'ai-fix-popover';
  popover.style.cssText = `
    position: absolute;
    z-index: 1000;
    background: #1e1e2e;
    border: 1px solid rgba(255,255,255,0.12);
    border-radius: 6px;
    padding: 8px;
    min-width: 320px;
    max-width: 560px;
    max-height: 400px;
    overflow-y: auto;
    box-shadow: 0 8px 24px rgba(0,0,0,0.5);
    font-size: 12px;
    color: #ccc;
  `;

  const rect = anchorNode.getBoundingClientRect();
  popover.style.left = `${rect.left}px`;
  popover.style.top = `${rect.bottom + 4}px`;

  const header = document.createElement('div');
  header.style.cssText = 'font-weight: 500; color: #eee; margin-bottom: 6px;';
  header.textContent = `${groupFixes.length} AI-detected issues on this line`;
  popover.appendChild(header);

  for (const fix of groupFixes) {
    const sev = getSevStyle(fix.severity || 'moderate');
    const confidence = Math.round((fix.confidence ?? 0) * 100);

    const row = document.createElement('div');
    row.style.cssText = `
      border: 1px solid ${sev.color}22;
      background: ${sev.bg};
      border-radius: 4px;
      padding: 6px 8px;
      margin-bottom: 4px;
    `;

    const top = document.createElement('div');
    top.style.cssText = 'display: flex; justify-content: space-between; gap: 8px; align-items: center;';
    const label = document.createElement('div');
    label.style.cssText = `color: ${sev.color}; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;`;
    label.textContent = `${sev.icon} ${fix.description || 'AI-detected issue'} (${confidence}%)`;
    top.appendChild(label);

    const btns = document.createElement('div');
    btns.style.cssText = 'display: flex; gap: 4px; flex-shrink: 0;';
    const apply = document.createElement('button');
    apply.textContent = '✓';
    apply.title = 'Apply';
    apply.style.cssText = 'background: rgba(34,197,94,0.25); color: #86efac; border: none; padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 11px;';
    apply.addEventListener('click', (e) => {
      e.stopPropagation();
      onApply?.(fix);
      row.remove();
      if (popover.querySelectorAll('.ai-fix-row').length === 0) popover.remove();
    });
    const dismiss = document.createElement('button');
    dismiss.textContent = '✕';
    dismiss.title = 'Dismiss';
    dismiss.style.cssText = 'background: rgba(255,255,255,0.05); color: #999; border: none; padding: 2px 8px; border-radius: 3px; cursor: pointer; font-size: 11px;';
    dismiss.addEventListener('click', (e) => {
      e.stopPropagation();
      onDismiss?.(fix);
      row.remove();
      if (popover.querySelectorAll('.ai-fix-row').length === 0) popover.remove();
    });
    btns.appendChild(apply);
    btns.appendChild(dismiss);
    top.appendChild(btns);
    row.appendChild(top);
    row.classList.add('ai-fix-row');

    popover.appendChild(row);
  }

  document.body.appendChild(popover);

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
