/**
 * Unified Diagnostics Schema
 *
 * One shape for compile diagnostics across all compiled languages.
 * The ErrorOverlay, healing service, and AI backend all consume
 * this same schema — no more event-name or field-name drift.
 */

/** @readonly @enum {string} */
export const DiagnosticSeverity = Object.freeze({
  ERROR: 'error',
  WARNING: 'warning',
  NOTE: 'note',
  HELP: 'help',
  INFO: 'info',
});

/**
 * @typedef {Object} DiagnosticLocation
 * @property {string} file
 * @property {number} line   - 1-based
 * @property {number} column - 1-based
 * @property {number} [endLine]
 * @property {number} [endColumn]
 */

/**
 * @typedef {Object} Diagnostic
 * @property {string} severity - one of DiagnosticSeverity values
 * @property {string} message
 * @property {string} [code]
 * @property {DiagnosticLocation} [location]
 * @property {string} [snippet]
 * @property {string} [suggestion]
 */

/**
 * @typedef {Object} CompileDiagnosticsPayload
 * @property {string} preview_id
 * @property {string} language
 * @property {string} module
 * @property {Diagnostic[]} diagnostics
 * @property {number} error_count
 * @property {number} warning_count
 * @property {number} [compile_duration_ms]
 * @property {number} timestamp_ms
 */

/**
 * Create a CompileDiagnosticsPayload from an array of diagnostics.
 *
 * @param {string} previewId
 * @param {string} language
 * @param {string} module
 * @param {Diagnostic[]} diagnostics
 * @returns {CompileDiagnosticsPayload}
 */
export function createDiagnosticsPayload(previewId, language, module, diagnostics) {
  const errorCount = diagnostics.filter(d => d.severity === DiagnosticSeverity.ERROR).length;
  const warningCount = diagnostics.filter(d => d.severity === DiagnosticSeverity.WARNING).length;

  return {
    preview_id: previewId,
    language,
    module,
    diagnostics,
    error_count: errorCount,
    warning_count: warningCount,
    timestamp_ms: Date.now(),
  };
}

/**
 * Returns true when a diagnostics payload contains at least one error.
 * @param {CompileDiagnosticsPayload} payload
 * @returns {boolean}
 */
export function hasErrors(payload) {
  return payload.error_count > 0;
}
