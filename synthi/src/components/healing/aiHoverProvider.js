// src/components/healing/aiHoverProvider.js
// Monaco hover provider that shows AI fix details on hover.
//
// When a user hovers over a line with an active AI fix, the Monaco hover
// tooltip shows a rich description including severity, confidence, category,
// the proposed replacement, and keyboard shortcuts.
//
// Usage:
//   import { registerAIHoverProvider, disposeAIHoverProvider } from './aiHoverProvider';
//   const disposable = registerAIHoverProvider(monaco, fixes);
//   // later...
//   disposable.dispose();

const SEVERITY_EMOJI = {
  critical: '🔴',
  high: '🟠',
  moderate: '🟡',
  low: '🔵',
  trivial: '⚪',
};

/**
 * Build the Markdown hover content for a single fix.
 */
function buildHoverMarkdown(fix) {
  const severity = fix.severity || 'moderate';
  const emoji = SEVERITY_EMOJI[severity] || '🟡';
  const confidence = Math.round((fix.confidence ?? 0) * 100);
  const category = (fix.category || fix.rule_id || 'unknown').replace(/_/g, ' ');
  const desc = fix.description || 'AI-detected issue';
  const isSafe = fix.is_safe ?? false;

  const lines = [
    `${emoji} **AI Fix** — ${desc}`,
    '',
    `| | |`,
    `|---|---|`,
    `| **Severity** | ${severity} |`,
    `| **Confidence** | ${confidence}% |`,
    `| **Category** | ${category} |`,
    `| **Safe to auto-apply** | ${isSafe ? '✅ yes' : '⚠️ no'} |`,
  ];

  if (fix.original_text) {
    lines.push('', '**Original:**', '```', fix.original_text, '```');
  }
  if (fix.replacement_text) {
    lines.push('', '**Replacement:**', '```', fix.replacement_text, '```');
  }

  lines.push('', '---', '*Ctrl+Shift+H* — toggle panel · *Ctrl+Shift+A* — analyze');

  return lines.join('\n');
}


/**
 * Register a hover provider that surfaces AI fix details.
 *
 * @param {typeof import('monaco-editor')} monaco - Monaco namespace
 * @param {Array} fixes - Current list of AI fix objects
 * @returns {{ dispose: () => void, updateFixes: (newFixes: Array) => void }}
 */
export function registerAIHoverProvider(monaco, fixes = []) {
  let currentFixes = fixes;

  const provider = monaco.languages.registerHoverProvider('*', {
    provideHover(model, position) {
      if (!currentFixes || currentFixes.length === 0) {
        return null;
      }

      const lineIndex = position.lineNumber - 1; // fixes use 0-based lines

      // Find fixes that touch this line
      const matching = currentFixes.filter((fix) => {
        const fixStart = fix.line ?? fix.start_line ?? fix.startLine ?? 0;
        const fixEnd = fix.end_line ?? fix.endLine ?? fixStart;
        return lineIndex >= fixStart && lineIndex <= fixEnd;
      });

      if (matching.length === 0) {
        return null;
      }

      // Build combined hover from all fixes on this line
      const markdownParts = matching.map(buildHoverMarkdown);
      const value = markdownParts.join('\n\n---\n\n');

      // Highlight the range of the first fix
      const first = matching[0];
      const startLine = (first.line ?? first.start_line ?? first.startLine ?? 0) + 1;
      const startCol = (first.column ?? 1);
      const endLine = (first.end_line ?? first.endLine ?? first.line ?? 0) + 1;
      const endCol = (first.end_column ?? model.getLineMaxColumn(endLine));

      return {
        range: new monaco.Range(startLine, startCol, endLine, endCol),
        contents: [{ value, isTrusted: true }],
      };
    },
  });

  return {
    dispose: () => provider.dispose(),
    updateFixes: (newFixes) => {
      currentFixes = newFixes;
    },
  };
}


/**
 * Dispose a previously registered hover provider handle.
 */
export function disposeAIHoverProvider(handle) {
  if (handle && typeof handle.dispose === 'function') {
    handle.dispose();
  }
}
