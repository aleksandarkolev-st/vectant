// src/components/healing/pendingFixCodeActions.js
// Monaco CodeActionProvider for self-healing "suggest"-bucket fixes.
//
// When the rule engine routes a fix to `suggest`, it lands in
// state.healing.pendingFixes.  This module registers a provider that
// turns those into Monaco lightbulb (Ctrl+.) actions scoped to the
// lines they touch.  Applying an action triggers the textEdit directly;
// the custom command then dispatches removePendingFix so the bulb
// disappears once the fix is used.

const COMMAND_ID = 'synthi.healing.acceptPendingFix';

let _registration = null;
let _commandDisposable = null;

/**
 * Register the Monaco command that clears accepted fixes from Redux.
 * Safe to call multiple times — idempotent via the module-level flag.
 *
 * @param {*} monaco – the monaco-editor module
 * @param {(fixId: string) => void} onAccept – called with the fix id
 */
function ensureCommand(monaco, onAccept) {
  // Dispose any prior command so the latest onAccept closure wins
  if (_commandDisposable) {
    try { _commandDisposable.dispose?.(); } catch { /* ignore */ }
    _commandDisposable = null;
  }
  _commandDisposable = monaco.editor.registerCommand(
    COMMAND_ID,
    (_accessor, fixId) => {
      if (typeof fixId === 'string' && fixId) onAccept?.(fixId);
    }
  );
}

/**
 * Register Monaco code actions for the current file's pending fixes.
 *
 * @param {import('monaco-editor').editor.IStandaloneCodeEditor} editor
 * @param {Array} fixes – pending fixes for the active file
 * @param {Object} callbacks
 * @param {(fixId: string) => void} callbacks.onAccept – dispatched when a
 *   fix is applied via the lightbulb
 * @returns {{ dispose: () => void }}
 */
export function registerPendingFixCodeActions(editor, fixes, { onAccept } = {}) {
  if (!editor || !Array.isArray(fixes)) return { dispose() {} };

  const monaco = window.monaco || globalThis?.monaco;
  if (!monaco) return { dispose() {} };

  const model = editor.getModel();
  if (!model) return { dispose() {} };

  const lang = model.getLanguageId?.() || '*';

  // Always register the command; it's cheap and idempotent.
  ensureCommand(monaco, onAccept);

  disposePendingFixCodeActions();

  if (fixes.length === 0) {
    return { dispose: disposePendingFixCodeActions };
  }

  _registration = monaco.languages.registerCodeActionProvider(lang, {
    provideCodeActions(m, range, _ctx, _token) {
      const actions = [];

      for (const fix of fixes) {
        const fixStartLine = (fix.startLine ?? 0) + 1;
        const fixEndLine = (fix.endLine ?? fix.startLine ?? 0) + 1;

        // Show only when the cursor/selection overlaps the fix range
        if (fixEndLine < range.startLineNumber || fixStartLine > range.endLineNumber) {
          continue;
        }

        const startCol = (fix.startCol ?? 0) + 1;
        const endCol = (fix.endCol ?? fix.endColumn ?? fix.startCol ?? 0) + 1;
        const text = fix.replacementText ?? '';

        const confidence = typeof fix.confidence === 'number'
          ? ` (${Math.round(fix.confidence * 100)}%)`
          : '';

        actions.push({
          title: `Heal: ${fix.description || fix.category || 'Apply suggestion'}${confidence}`,
          kind: 'quickfix',
          diagnostics: [],
          isPreferred: true,
          edit: {
            edits: [{
              resource: m.uri,
              textEdit: {
                range: new monaco.Range(fixStartLine, startCol, fixEndLine, endCol),
                text,
              },
              versionId: m.getVersionId?.(),
            }],
          },
          command: fix.id
            ? {
                id: COMMAND_ID,
                title: 'Clear pending fix',
                arguments: [fix.id],
              }
            : undefined,
        });
      }

      return {
        actions,
        dispose() {},
      };
    },
  });

  return { dispose: disposePendingFixCodeActions };
}

export function disposePendingFixCodeActions() {
  if (_registration) {
    try { _registration.dispose(); } catch { /* ignore */ }
    _registration = null;
  }
}
