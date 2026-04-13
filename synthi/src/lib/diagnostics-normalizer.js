/**
 * Diagnostics Normalizer
 *
 * Converts various legacy diagnostic shapes emitted by different
 * compiler backends into the unified CompileDiagnosticsPayload
 * format defined in diagnostics-schema.js.
 *
 * This is the single point of normalization — instead of each
 * consumer parsing different shapes, all diagnostics flow through
 * here first.
 */

import {
  DiagnosticSeverity,
  createDiagnosticsPayload,
} from '@/lib/diagnostics-schema';

/**
 * Attempt to categorize a severity string to a canonical value.
 * @param {string} raw
 * @returns {string}
 */
function normalizeSeverity(raw) {
  if (!raw) return DiagnosticSeverity.ERROR;
  const lower = String(raw).toLowerCase();
  if (lower === 'error' || lower === 'err' || lower === 'fatal') return DiagnosticSeverity.ERROR;
  if (lower === 'warning' || lower === 'warn') return DiagnosticSeverity.WARNING;
  if (lower === 'note') return DiagnosticSeverity.NOTE;
  if (lower === 'help' || lower === 'hint') return DiagnosticSeverity.HELP;
  if (lower === 'info' || lower === 'information') return DiagnosticSeverity.INFO;
  return DiagnosticSeverity.ERROR;
}

/**
 * Normalize a location object from various possible shapes.
 * @param {Object|null} loc
 * @returns {Object|undefined}
 */
function normalizeLocation(loc) {
  if (!loc) return undefined;
  return {
    file: loc.file || loc.filename || loc.path || '',
    line: loc.line || loc.row || 0,
    column: loc.column || loc.col || 0,
    ...(loc.endLine != null && { endLine: loc.endLine || loc.end_line }),
    ...(loc.endColumn != null && { endColumn: loc.endColumn || loc.end_column }),
  };
}

/**
 * Normalize a single diagnostic object from various shapes.
 * @param {Object} raw
 * @returns {import('@/lib/diagnostics-schema').Diagnostic}
 */
function normalizeDiagnostic(raw) {
  return {
    severity: normalizeSeverity(raw.severity || raw.level || raw.type),
    message: raw.message || raw.msg || raw.text || String(raw),
    ...(raw.code && { code: String(raw.code) }),
    ...(raw.location || raw.loc || raw.span
      ? { location: normalizeLocation(raw.location || raw.loc || raw.span) }
      : {}),
    ...(raw.snippet && { snippet: raw.snippet }),
    ...(raw.suggestion && { suggestion: raw.suggestion }),
  };
}

/**
 * Normalize any compile-diagnostics event detail into a unified
 * CompileDiagnosticsPayload.
 *
 * Handles three legacy shapes:
 * 1. Already a unified payload (has `diagnostics` array and `preview_id`)
 * 2. Flat object with `error_count`, `diagnostics`, and `module`
 * 3. Raw array of diagnostic-like objects
 *
 * @param {Object|Array} detail - the event.detail from synthi:compile-diagnostics
 * @param {string} [fallbackPreviewId] - fallback preview ID if not in payload
 * @param {string} [fallbackLanguage] - fallback language
 * @returns {import('@/lib/diagnostics-schema').CompileDiagnosticsPayload}
 */
export function normalizeDiagnosticsPayload(detail, fallbackPreviewId = 'unknown', fallbackLanguage = 'unknown') {
  // Already unified shape
  if (detail && detail.preview_id && Array.isArray(detail.diagnostics)) {
    return {
      ...detail,
      diagnostics: detail.diagnostics.map(normalizeDiagnostic),
    };
  }

  // Flat shape from compilerClient (has `diagnostics` but no `preview_id`)
  if (detail && Array.isArray(detail.diagnostics)) {
    return createDiagnosticsPayload(
      detail.preview_id || detail.session_id || fallbackPreviewId,
      detail.language || fallbackLanguage,
      detail.module || 'main',
      detail.diagnostics.map(normalizeDiagnostic),
    );
  }

  // Raw array
  if (Array.isArray(detail)) {
    return createDiagnosticsPayload(
      fallbackPreviewId,
      fallbackLanguage,
      'main',
      detail.map(normalizeDiagnostic),
    );
  }

  // Fallback — wrap in a single error
  return createDiagnosticsPayload(
    fallbackPreviewId,
    fallbackLanguage,
    'main',
    [{ severity: DiagnosticSeverity.ERROR, message: String(detail || 'Unknown error') }],
  );
}
