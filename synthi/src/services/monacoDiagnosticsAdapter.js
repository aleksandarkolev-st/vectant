/**
 * Monaco Diagnostics Adapter
 * 
 * Integrates proactive analysis diagnostics with Monaco editor,
 * providing:
 * - Squiggly underlines for errors/warnings
 * - Hover tooltips with diagnostic info
 * - Gutter icons and decorations
 * - Quick fix suggestions (code actions)
 */

/**
 * Severity to Monaco marker severity mapping
 */
const SEVERITY_TO_MONACO = {
  error: 8,    // MarkerSeverity.Error
  warning: 4,  // MarkerSeverity.Warning
  info: 2,     // MarkerSeverity.Info
  hint: 1,     // MarkerSeverity.Hint
};

/**
 * Tier to decoration class mapping
 */
const TIER_DECORATION_CLASS = {
  static: 'synthi-diagnostic-static',
  semantic: 'synthi-diagnostic-semantic',
  ai: 'synthi-diagnostic-ai',
};

/**
 * Category icons for gutter decorations
 */
const CATEGORY_ICONS = {
  syntax: '❌',
  type_error: '🔷',
  null_reference: '⚠️',
  undefined_variable: '❓',
  unused_code: '💤',
  security: '🔒',
  performance: '⚡',
  style: '✨',
  logic_error: '🐛',
  resource_leak: '💧',
  concurrency: '🔀',
  best_practice: '💡',
};

/**
 * Create Monaco markers from diagnostics
 * 
 * @param {Array} diagnostics - Array of diagnostic objects
 * @param {Object} monaco - Monaco editor module
 * @returns {Array} Array of Monaco marker objects
 */
export function createMonacoMarkers(diagnostics, monaco) {
  if (!diagnostics || !monaco) return [];
  
  return diagnostics.map(diagnostic => {
    const column = diagnostic.location?.column ?? 0;
    const endColumn = diagnostic.location?.endColumn ?? column;
    const startCol = column + 1; // Monaco is 1-indexed
    // Ensure at least 1 character width for the marker
    const endCol = Math.max(endColumn + 1, startCol + 1);
    
    return {
      severity: SEVERITY_TO_MONACO[diagnostic.severity] || SEVERITY_TO_MONACO.info,
      message: formatDiagnosticMessage(diagnostic),
      startLineNumber: (diagnostic.location?.line ?? 0) + 1, // Monaco is 1-indexed
      startColumn: startCol,
      endLineNumber: (diagnostic.location?.endLine ?? diagnostic.location?.line ?? 0) + 1,
      endColumn: endCol,
      source: diagnostic.source || `synthi-${diagnostic.tier}`,
      code: diagnostic.code,
      // Store original diagnostic for quick fixes
      relatedInformation: diagnostic.relatedInformation || [],
      tags: getTags(diagnostic),
    };
  });
}

/**
 * Format diagnostic message for display
 */
function formatDiagnosticMessage(diagnostic) {
  let message = diagnostic.message || 'Unknown issue';
  
  // Add tier badge
  const tierBadge = diagnostic.tier ? `[${diagnostic.tier.toUpperCase()}]` : '';
  
  // Add confidence for AI diagnostics
  const confidence = diagnostic.confidence && diagnostic.confidence < 1.0
    ? ` (${Math.round(diagnostic.confidence * 100)}% confidence)`
    : '';
  
  // Add explanation if available
  const explanation = diagnostic.explanation
    ? `\n\n${diagnostic.explanation}`
    : '';
  
  return `${tierBadge} ${message}${confidence}${explanation}`;
}

/**
 * Get Monaco marker tags based on diagnostic category
 */
function getTags(diagnostic) {
  const tags = [];
  
  // Unused code should be faded
  if (diagnostic.category === 'unused_code') {
    tags.push(1); // MarkerTag.Unnecessary
  }
  
  // Deprecated APIs
  if (diagnostic.category === 'deprecated') {
    tags.push(2); // MarkerTag.Deprecated
  }
  
  return tags;
}

/**
 * Apply diagnostics to a Monaco editor model
 * 
 * @param {Object} monaco - Monaco module
 * @param {Object} model - Monaco text model
 * @param {Array} diagnostics - Diagnostics to apply
 * @param {string} [owner='synthi-proactive'] - Marker owner identifier
 */
export function applyDiagnosticsToModel(monaco, model, diagnostics, owner = 'synthi-proactive') {
  if (!monaco || !model) return;
  
  const markers = createMonacoMarkers(diagnostics, monaco);
  monaco.editor.setModelMarkers(model, owner, markers);
}

/**
 * Clear diagnostics from a Monaco editor model
 */
export function clearDiagnosticsFromModel(monaco, model, owner = 'synthi-proactive') {
  if (!monaco || !model) return;
  monaco.editor.setModelMarkers(model, owner, []);
}

/**
 * Create inline decorations for diagnostics
 * These provide additional visual feedback beyond squiggly lines
 * 
 * @param {Array} diagnostics - Diagnostics to decorate
 * @returns {Array} Monaco decoration objects
 */
export function createDiagnosticDecorations(diagnostics) {
  if (!diagnostics) return [];
  
  return diagnostics.map(diagnostic => {
    const startLine = (diagnostic.location?.line ?? 0) + 1;
    const endLine = (diagnostic.location?.endLine ?? diagnostic.location?.line ?? 0) + 1;
    const column = diagnostic.location?.column ?? 0;
    const endColumn = diagnostic.location?.endColumn ?? column;
    
    // Convert from 0-indexed to 1-indexed for Monaco
    const startCol = column + 1;
    // Ensure the range is at least 1 character wide
    const endCol = Math.max(endColumn + 1, startLine === endLine ? startCol + 1 : 1);
    
    const isAi = diagnostic.tier === 'ai';
    const isMultiLine = endLine > startLine;
    const icon = CATEGORY_ICONS[diagnostic.category] || '⚠️';
    
    return {
      range: {
        startLineNumber: startLine,
        startColumn: startCol,
        endLineNumber: endLine,
        endColumn: endCol,
      },
      options: {
        // Gutter decoration
        glyphMarginClassName: `synthi-glyph-${diagnostic.severity}`,
        glyphMarginHoverMessage: { value: formatDiagnosticMessage(diagnostic) },
        
        // Inline decoration class - use different style for multi-line
        inlineClassName: isAi
          ? (isMultiLine ? 'synthi-ai-diagnostic-block' : 'synthi-ai-diagnostic-inline')
          : `synthi-diagnostic-${diagnostic.severity}`,
        
        // Hover message
        hoverMessage: [
          { value: `**${diagnostic.severity.toUpperCase()}** ${icon}` },
          { value: diagnostic.message },
          ...(diagnostic.explanation ? [{ value: `\n_${diagnostic.explanation}_` }] : []),
          ...(diagnostic.fixes?.length > 0 
            ? [{ value: '\n**Quick Fixes Available**' }]
            : []),
        ],
        
        // Line highlight for errors or multi-line diagnostics
        isWholeLine: isMultiLine || diagnostic.severity === 'error',
        className: isMultiLine 
          ? 'synthi-diagnostic-block-highlight'
          : (diagnostic.severity === 'error' ? 'synthi-error-line-highlight' : undefined),
        
        // Minimap indicator
        minimap: {
          color: getMinimapColor(diagnostic.severity),
          position: 1, // Inline
        },
        
        // Overview ruler indicator
        overviewRuler: {
          color: getOverviewRulerColor(diagnostic.severity),
          position: 4, // Full
        },
      },
    };
  });
}

/**
 * Get minimap color for severity
 */
function getMinimapColor(severity) {
  switch (severity) {
    case 'error': return 'rgba(255, 0, 0, 0.7)';
    case 'warning': return 'rgba(255, 200, 0, 0.7)';
    case 'info': return 'rgba(0, 150, 255, 0.5)';
    case 'hint': return 'rgba(0, 200, 100, 0.4)';
    default: return 'rgba(150, 150, 150, 0.5)';
  }
}

/**
 * Get overview ruler color for severity
 */
function getOverviewRulerColor(severity) {
  switch (severity) {
    case 'error': return 'rgba(255, 80, 80, 0.9)';
    case 'warning': return 'rgba(255, 200, 0, 0.8)';
    case 'info': return 'rgba(100, 180, 255, 0.6)';
    case 'hint': return 'rgba(100, 255, 150, 0.5)';
    default: return 'rgba(150, 150, 150, 0.5)';
  }
}

/**
 * Create code action provider for quick fixes
 * 
 * @param {Object} monaco - Monaco module
 * @param {Map} diagnosticsMap - Map of diagnostics by range
 * @returns {Object} Monaco code action provider
 */
export function createQuickFixProvider(monaco, getDiagnosticsForRange) {
  return {
    provideCodeActions(model, range, context, token) {
      const actions = [];
      
      // Get diagnostics that overlap with the range
      const markers = context.markers || [];
      
      for (const marker of markers) {
        // Look for diagnostics with fixes
        const diagnostic = findDiagnosticForMarker(marker, getDiagnosticsForRange);
        if (!diagnostic?.fixes?.length) continue;
        
        for (const fix of diagnostic.fixes) {
          actions.push({
            title: fix.description || 'Apply fix',
            kind: 'quickfix',
            diagnostics: [marker],
            isPreferred: fix.isPreferred || false,
            edit: {
              edits: [{
                resource: model.uri,
                edit: {
                  range: {
                    startLineNumber: (fix.location?.line ?? marker.startLineNumber - 1) + 1,
                    startColumn: (fix.location?.column ?? marker.startColumn - 1) + 1,
                    endLineNumber: (fix.location?.endLine ?? marker.endLineNumber - 1) + 1,
                    endColumn: (fix.location?.endColumn ?? marker.endColumn - 1) + 1,
                  },
                  text: fix.replacementText,
                },
              }],
            },
          });
        }
      }
      
      return { actions, dispose: () => {} };
    },
  };
}

/**
 * Find diagnostic that matches a marker
 */
function findDiagnosticForMarker(marker, getDiagnosticsForRange) {
  if (typeof getDiagnosticsForRange !== 'function') return null;
  
  const diagnostics = getDiagnosticsForRange(
    marker.startLineNumber - 1,
    marker.startColumn - 1,
    marker.endLineNumber - 1,
    marker.endColumn - 1,
  );
  
  // Return first matching diagnostic with fixes
  // Prioritize diagnostics that have fixes available
  const withFixes = diagnostics.filter(d => d.fixes?.length > 0);
  if (withFixes.length > 0) {
    // Try to match by message content
    const messageMatch = withFixes.find(d => 
      marker.message.includes(d.message) ||
      d.message.includes(marker.message.split(']').pop()?.trim() || '')
    );
    return messageMatch || withFixes[0];
  }
  
  // Fallback to any matching diagnostic
  return diagnostics.find(d => 
    d.message === marker.message.split(']')[1]?.trim() ||
    marker.message.includes(d.message)
  ) || diagnostics[0];
}

/**
 * CSS styles for diagnostic decorations
 * These should be added to your global CSS
 */
export const DIAGNOSTIC_CSS = `
/* Error diagnostics */
.synthi-error-line-highlight {
  background-color: rgba(255, 0, 0, 0.08) !important;
}

.synthi-diagnostic-error {
  background-color: rgba(255, 80, 80, 0.2);
  border-bottom: 2px wavy #ff5555;
}

/* Warning diagnostics */
.synthi-diagnostic-warning {
  background-color: rgba(255, 200, 0, 0.1);
  border-bottom: 2px wavy #ffcc00;
}

/* Info diagnostics */
.synthi-diagnostic-info {
  background-color: rgba(100, 180, 255, 0.08);
  border-bottom: 1px dashed #64b5f6;
}

/* Hint diagnostics */
.synthi-diagnostic-hint {
  border-bottom: 1px dotted #4caf50;
}

/* AI-specific diagnostics (distinct style) */
.synthi-ai-diagnostic-inline {
  background: linear-gradient(90deg, rgba(147, 51, 234, 0.1), rgba(79, 70, 229, 0.1));
  border-bottom: 2px wavy rgba(147, 51, 234, 0.6);
}

/* Glyph margin icons */
.synthi-glyph-error {
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='%23ff5555'/%3E%3Cpath d='M5 5l6 6M11 5l-6 6' stroke='white' stroke-width='1.5'/%3E%3C/svg%3E") center center no-repeat;
  background-size: 14px;
}

.synthi-glyph-warning {
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Cpath d='M8 2L2 14h12L8 2z' fill='%23ffcc00'/%3E%3Cpath d='M8 6v4M8 11.5v.5' stroke='%23333' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E") center center no-repeat;
  background-size: 14px;
}

.synthi-glyph-info {
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='6' fill='%2364b5f6'/%3E%3Cpath d='M8 5v.5M8 7v4' stroke='white' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E") center center no-repeat;
  background-size: 14px;
}

.synthi-glyph-hint {
  background: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ccircle cx='8' cy='8' r='5' fill='none' stroke='%234caf50' stroke-width='1.5'/%3E%3Cpath d='M8 5v4M8 11v.5' stroke='%234caf50' stroke-width='1.5' stroke-linecap='round'/%3E%3C/svg%3E") center center no-repeat;
  background-size: 14px;
}
`;

export default {
  createMonacoMarkers,
  applyDiagnosticsToModel,
  clearDiagnosticsFromModel,
  createDiagnosticDecorations,
  createQuickFixProvider,
  DIAGNOSTIC_CSS,
};
