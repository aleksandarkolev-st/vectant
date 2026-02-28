// src/components/healing/AIConfidenceGate.jsx
// Confidence-gated fix display.
//
// Wraps a fix presentation and shows different UIs based on confidence:
//   ≥ autoAcceptThreshold  → auto-applied (green badge, no prompt)
//   ≥ minConfidence        → normal display with Apply/Dismiss
//   ≥ maybeThreshold       → soft warning: "Low confidence — review carefully"
//   < maybeThreshold       → hidden entirely

import React from 'react';

const DEFAULT_AUTO_ACCEPT = 0.92;
const DEFAULT_MIN         = 0.55;
const DEFAULT_MAYBE       = 0.35;

/**
 * @param {Object}  props
 * @param {Object}  props.fix              – AI fix object
 * @param {number}  [props.autoAccept=0.92]
 * @param {number}  [props.minConfidence=0.55]
 * @param {number}  [props.maybeThreshold=0.35]
 * @param {Function} props.onApply
 * @param {Function} props.onDismiss
 * @param {React.ReactNode} props.children – the fix card to render
 */
export function AIConfidenceGate({
  fix,
  autoAccept  = DEFAULT_AUTO_ACCEPT,
  minConfidence = DEFAULT_MIN,
  maybeThreshold = DEFAULT_MAYBE,
  onApply,
  onDismiss,
  children,
}) {
  const confidence = fix?.confidence ?? 0;

  // Below the "maybe" threshold — hide entirely
  if (confidence < maybeThreshold) return null;

  const isAutoAccepted = confidence >= autoAccept;
  const isLowConfidence = confidence < minConfidence;

  return (
    <div
      className="ai-confidence-gate"
      style={{
        position: 'relative',
        opacity: isLowConfidence ? 0.65 : 1,
      }}
    >
      {/* Auto-accepted badge */}
      {isAutoAccepted && (
        <div
          style={{
            position: 'absolute',
            top: 4,
            right: 4,
            background: '#238636',
            color: '#fff',
            fontSize: 10,
            fontWeight: 700,
            padding: '1px 6px',
            borderRadius: 8,
            zIndex: 2,
          }}
        >
          AUTO
        </div>
      )}

      {/* Low-confidence warning banner */}
      {isLowConfidence && (
        <div
          style={{
            background: 'rgba(227, 179, 65, 0.15)',
            borderLeft: '3px solid #e3b341',
            padding: '4px 8px',
            marginBottom: 4,
            fontSize: 11,
            color: '#e3b341',
            borderRadius: '0 4px 4px 0',
          }}
        >
          ⚠ Low confidence ({Math.round(confidence * 100)}%) — review carefully
        </div>
      )}

      {/* The wrapped fix card */}
      {children}
    </div>
  );
}
