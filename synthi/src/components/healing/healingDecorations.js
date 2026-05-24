// src/components/healing/healingDecorations.js
// Monaco editor decorations for self-healing.
// On each fix, we add a brand-tinted sweep across the healed line range
// and a matching gutter glow. Both auto-decay so the editor returns to
// calm — no permanent visual debt. Animations and colours live in
// globals.css under .heal-line-sweep / .heal-gutter-glow.

/**
 * Create decorations for recently healed lines.
 *
 * @param {import('monaco-editor').editor.IStandaloneCodeEditor} editor
 * @param {Array<{startLine: number, endLine?: number}>} healedRanges – 1-indexed lines
 * @param {number} [fadeDurationMs=2500] – how long the decoration stays visible.
 *   Aligned with the 2400ms CSS animation so the decoration is removed
 *   right as the opacity hits zero, no flash.
 * @returns {{ dispose: () => void }} disposable
 */
export function showHealingDecorations(editor, healedRanges, fadeDurationMs = 2500) {
  if (!editor || !healedRanges?.length) return { dispose: () => {} };

  const monaco = window.monaco || globalThis?.monaco;
  if (!monaco) return { dispose: () => {} };

  const model = editor.getModel();
  if (!model) return { dispose: () => {} };

  // Build decoration descriptors. We use BOTH className (for the line
  // background sweep) and linesDecorationsClassName (for the gutter
  // glow column) so the eye gets a coordinated signal from two surfaces
  // without us touching the gutter rendering pipeline directly.
  const decorations = healedRanges.map(({ startLine, endLine }) => ({
    range: new monaco.Range(startLine, 1, endLine || startLine, 1),
    options: {
      isWholeLine: true,
      className: 'heal-line-sweep',
      linesDecorationsClassName: 'heal-gutter-glow',
      overviewRuler: {
        color: 'rgba(162, 61, 255, 0.45)', // --brand-stop-3
        position: monaco.editor.OverviewRulerLane.Right,
      },
      minimap: {
        color: 'rgba(162, 61, 255, 0.32)',
        position: monaco.editor.MinimapPosition.Inline,
      },
      stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
    },
  }));

  const decorationIds = editor.deltaDecorations([], decorations);

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
 * No-op kept for callers — animations and styling now live in
 * globals.css (`.heal-line-sweep`, `.heal-gutter-glow`). Retained so
 * existing import sites don't break.
 */
export function injectHealingStyles() {
  // Styles are bundled with the app's globals.css; nothing to inject.
}

/**
 * No-op kept for callers — see injectHealingStyles.
 */
export function removeHealingStyles() {
  // Styles are bundled with the app's globals.css; nothing to remove.
}
