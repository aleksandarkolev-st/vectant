// src/components/healing/aiDiagnostics.js
// Bridge between AI fixes and Monaco's built-in diagnostics system.
//
// This converts AI-detected fixes into Monaco IMarkerData objects,
// which show up as squiggly underlines in the editor — the same
// visual language as TypeScript errors, ESLint warnings, etc.
//
// Why use markers instead of (or in addition to) decorations?
//   - Markers show up in the Problems panel (Ctrl+Shift+M)
//   - Markers have hover tooltips built into Monaco
//   - Users already understand squiggly underlines
//   - Can filter by severity in the minimap

/**
 * Severity mapping: AI severity → Monaco MarkerSeverity.
 *
 * @param {string} severity
 * @returns {number}  monaco.MarkerSeverity value
 */
function toMarkerSeverity(severity) {
  const monaco = window.monaco || globalThis?.monaco;
  if (!monaco) return 4; // Warning fallback

  switch (severity) {
    case 'critical':
    case 'high':
      return monaco.MarkerSeverity.Error;
    case 'moderate':
      return monaco.MarkerSeverity.Warning;
    case 'low':
      return monaco.MarkerSeverity.Info;
    case 'trivial':
      return monaco.MarkerSeverity.Hint;
    default:
      return monaco.MarkerSeverity.Warning;
  }
}


/**
 * Category → human-readable label for the marker message.
 */
const CAT_PREFIX = {
  logic_error:    '[Logic]',
  null_safety:    '[Null Safety]',
  type_mismatch:  '[Type]',
  missing_await:  '[Async]',
  resource_leak:  '[Resource]',
  api_misuse:     '[API]',
  off_by_one:     '[Off-by-one]',
  error_handling: '[Error Handling]',
  variable_misuse:'[Variable]',
  security:       '[Security]',
  concurrency:    '[Concurrency]',
};

function categoryPrefix(category) {
  return CAT_PREFIX[category] || '[AI]';
}


/**
 * Convert an AI fix to a Monaco IMarkerData.
 *
 * @param {Object} fix – AI fix object
 * @returns {import('monaco-editor').editor.IMarkerData}
 */
function fixToMarker(fix) {
  const startLine = (fix.line ?? fix.start_line ?? fix.startLine ?? 0) + 1;
  const endLine = (fix.end_line ?? fix.endLine ?? fix.line ?? 0) + 1;
  const startCol = (fix.column ?? fix.start_col ?? fix.startCol ?? 0) + 1;
  const endCol = (fix.end_column ?? fix.end_col ?? fix.endCol ?? 0) + 1;
  const confidence = Math.round((fix.confidence ?? 0) * 100);
  const cat = fix.category || 'other';
  const prefix = categoryPrefix(cat);

  return {
    severity: toMarkerSeverity(fix.severity || 'moderate'),
    message: `${prefix} ${fix.description || 'AI-detected issue'} (${confidence}% confident)`,
    startLineNumber: startLine,
    startColumn: startCol,
    endLineNumber: endLine,
    endColumn: endCol,
    source: 'AI Healing',
    code: fix.rule_id || fix.ruleId || `AI_${(cat || 'OTHER').toUpperCase()}`,
    tags: fix.is_safe || fix.isSafe
      ? []  // no tag for safe fixes
      : [1], // MarkerTag.Unnecessary — shows as faded (optional)
  };
}


/**
 * Set AI diagnostics markers on a Monaco model.
 *
 * Replaces any existing AI markers (identified by owner = 'ai-healing').
 *
 * @param {import('monaco-editor').editor.ITextModel} model
 * @param {Array}  fixes – array of AI fix objects
 */
export function setAIDiagnostics(model, fixes) {
  const monaco = window.monaco || globalThis?.monaco;
  if (!monaco || !model) return;

  const markers = (fixes || []).map(fixToMarker);
  monaco.editor.setModelMarkers(model, 'ai-healing', markers);
}


/**
 * Clear all AI diagnostics from a model.
 *
 * @param {import('monaco-editor').editor.ITextModel} model
 */
export function clearAIDiagnostics(model) {
  const monaco = window.monaco || globalThis?.monaco;
  if (!monaco || !model) return;

  monaco.editor.setModelMarkers(model, 'ai-healing', []);
}


/**
 * Get the count of AI markers currently set on a model.
 *
 * @param {import('monaco-editor').editor.ITextModel} model
 * @returns {number}
 */
export function getAIDiagnosticCount(model) {
  const monaco = window.monaco || globalThis?.monaco;
  if (!monaco || !model) return 0;

  return monaco.editor
    .getModelMarkers({ owner: 'ai-healing', resource: model.uri })
    .length;
}
