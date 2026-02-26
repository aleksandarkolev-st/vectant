// src/components/healing/healingDecorations.js
// Monaco editor decorations for self-healing.
// Shows subtle visual indicators on lines that were auto-healed,
// giving the user awareness of what changed without being intrusive.

/**
 * Create decorations for recently healed lines.
 * Shows a small gutter icon and a faint line highlight that fades
 * after a short time.
 *
 * @param {import('monaco-editor').editor.IStandaloneCodeEditor} editor
 * @param {Array<{startLine: number, endLine?: number}>} healedRanges – 1-indexed lines
 * @param {number} [fadeDurationMs=3000] – how long the decoration stays visible
 * @returns {{ dispose: () => void }} disposable
 */
export function showHealingDecorations(editor, healedRanges, fadeDurationMs = 3000) {
  if (!editor || !healedRanges?.length) return { dispose: () => {} };

  const monaco = window.monaco || globalThis?.monaco;
  if (!monaco) return { dispose: () => {} };

  const model = editor.getModel();
  if (!model) return { dispose: () => {} };

  // Build decoration descriptors
  const decorations = healedRanges.map(({ startLine, endLine }) => ({
    range: new monaco.Range(startLine, 1, endLine || startLine, 1),
    options: {
      isWholeLine: true,
      className: 'self-healing-line-highlight',
      glyphMarginClassName: 'self-healing-glyph',
      glyphMarginHoverMessage: { value: '🩹 Auto-healed by Self-Healing' },
      overviewRuler: {
        color: 'rgba(74, 222, 128, 0.4)', // green tint
        position: monaco.editor.OverviewRulerLane.Right,
      },
      minimap: {
        color: 'rgba(74, 222, 128, 0.3)',
        position: monaco.editor.MinimapPosition.Inline,
      },
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  }));

  // Apply decorations
  const decorationIds = editor.deltaDecorations([], decorations);

  // Auto-fade after duration
  const timer = setTimeout(() => {
    try {
      editor.deltaDecorations(decorationIds, []);
    } catch {
      // editor may be disposed
    }
  }, fadeDurationMs);

  return {
    dispose: () => {
      clearTimeout(timer);
      try {
        editor.deltaDecorations(decorationIds, []);
      } catch {
        // editor may be disposed
      }
    },
  };
}

/**
 * CSS that should be injected into the page for healing decorations.
 * Call once when the editor mounts.
 */
export function injectHealingStyles() {
  if (typeof document === 'undefined') return;
  const STYLE_ID = 'self-healing-decorations-css';
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    .self-healing-line-highlight {
      background: rgba(74, 222, 128, 0.06) !important;
      border-left: 2px solid rgba(74, 222, 128, 0.4);
      transition: opacity 0.5s ease-out;
    }
    .self-healing-glyph {
      background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 16 16'%3E%3Ctext x='2' y='13' font-size='12'%3E🩹%3C/text%3E%3C/svg%3E") center center no-repeat;
      background-size: 14px 14px;
    }
  `;
  document.head.appendChild(style);
}

/**
 * Remove the injected CSS for healing decorations.
 */
export function removeHealingStyles() {
  if (typeof document === 'undefined') return;
  const el = document.getElementById('self-healing-decorations-css');
  if (el) el.remove();
}
