// src/components/healing/AIFixCard.jsx
// Individual card for a single AI-detected fix.
// Shows the description, category, confidence, and diff preview.
// Actions: Apply, Dismiss.
'use client';

import { useCallback, useState } from 'react';
import {
  Check,
  X,
  ChevronDown,
  ChevronUp,
  ShieldAlert,
  AlertTriangle,
  Info,
  Columns,
  EyeOff,
} from 'lucide-react';
import { AIDiffPreview } from './AIDiffPreview';


// ── Severity config ───────────────────────────────────────────────────
const SEVERITY_META = {
  critical: { icon: ShieldAlert, token: 'var(--accent-danger)', label: 'Critical' },
  high:     { icon: AlertTriangle, token: 'var(--brand-stop-2)', label: 'High' },
  moderate: { icon: AlertTriangle, token: 'var(--accent-warning)', label: 'Medium' },
  low:      { icon: Info, token: 'var(--accent-info)', label: 'Low' },
  trivial:  { icon: Info, token: 'var(--text-muted)', label: 'Trivial' },
};

function getSeverityMeta(severity) {
  return SEVERITY_META[severity] || SEVERITY_META.moderate;
}


// ── Category → human-readable ─────────────────────────────────────────
const CAT_LABEL = {
  logic_error:    'Logic error',
  null_safety:    'Null safety',
  type_mismatch:  'Type mismatch',
  missing_await:  'Missing await',
  resource_leak:  'Resource leak',
  api_misuse:     'API misuse',
  off_by_one:     'Off-by-one',
  error_handling: 'Error handling',
  variable_misuse:'Variable misuse',
  security:       'Security',
  concurrency:    'Concurrency',
  other:          'Other',
};

function formatCategory(cat) {
  return CAT_LABEL[cat] || cat?.replace(/_/g, ' ') || 'Issue';
}


// ── Confidence bar ────────────────────────────────────────────────────
function ConfidenceBadge({ confidence }) {
  const pct = Math.round((confidence ?? 0) * 100);
  const color = pct >= 85
    ? 'var(--accent-success)'
    : pct >= 65
      ? 'var(--accent-warning)'
      : 'var(--accent-danger)';

  return (
    <span className="font-mono text-xs" style={{ color }} title={`Confidence: ${pct}%`}>
      {pct}%
    </span>
  );
}


/**
 * @param {Object}   props
 * @param {Object}   props.fix            – AI fix object
 * @param {Function} props.onApply        – called when user clicks Apply
 * @param {Function} props.onDismiss      – called when user clicks Dismiss
 * @param {Function} [props.onSuppressRule] – called when user clicks Suppress Rule
 * @param {number}   [props.index]        – 0-based position in list
 */
export function AIFixCard({ fix, onApply, onDismiss, onSuppressRule, index }) {
  const [expanded, setExpanded] = useState(false);
  const [richDiff, setRichDiff] = useState(false);
  // `applied` gates the brief celebratory state between user click and
  // parent unmount. The card flashes the brand glow, the Apply button
  // morphs from spinner-ready to a drawn check, then the parent removes
  // the card from the list. We delay the parent call so the animation
  // is visible — total window is ~400ms which is well under the user's
  // "rapid-fire fix" threshold of 500ms per acknowledgement.
  const [applied, setApplied] = useState(false);

  const severity = fix.severity || 'moderate';
  const meta = getSeverityMeta(severity);
  const SevIcon = meta.icon;

  const line = fix.line ?? fix.start_line ?? fix.startLine ?? '?';
  const endLine = fix.end_line ?? fix.endLine ?? fix.line ?? line;
  const lineLabel = line === endLine ? `L${line}` : `L${line}-${endLine}`;
  const confidence = fix.confidence ?? 0;
  const isSafe = fix.is_safe || fix.isSafe;
  const ruleId = fix.rule_id || fix.ruleId || '';
  const originalText = fix.original_text || fix.originalText || '';
  const replacementText = fix.replacement_text || fix.replacementText || '';

  const handleApply = useCallback(() => {
    if (applied) return;
    setApplied(true);
    // Let the check-draw + flash play before the parent removes us.
    window.setTimeout(() => onApply?.(fix), 380);
  }, [applied, fix, onApply]);
  const handleDismiss = useCallback(() => onDismiss?.(fix), [fix, onDismiss]);
  const handleSuppressRule = useCallback(() => {
    if (ruleId) onSuppressRule?.(ruleId, fix);
  }, [ruleId, fix, onSuppressRule]);
  const toggleExpand = useCallback(() => setExpanded((e) => !e), []);

  return (
    <div
      className={`vt-command-surface mb-2 p-3 transition-all ${applied ? 'heal-applied-flash' : ''}`}
      style={{
        borderColor: `color-mix(in srgb, ${meta.token} 30%, var(--border-medium))`,
        background: `linear-gradient(135deg, color-mix(in srgb, ${meta.token} 8%, transparent), transparent 48%), var(--bg-panel)`,
      }}
      role="listitem"
    >
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <SevIcon size={14} style={{ color: meta.token }} />
          <span className="font-mono text-xs" style={{ color: 'var(--text-muted)' }}>{lineLabel}</span>
          <span className="truncate text-sm" style={{ color: 'var(--text-primary)' }}>
            {fix.description || 'Detected issue'}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <ConfidenceBadge confidence={confidence} />
          {isSafe && (
            <span
              className="vt-state-pill h-[18px] px-1.5"
              style={{
                color: 'var(--accent-success)',
                borderColor: 'color-mix(in srgb, var(--accent-success) 34%, transparent)',
                background: 'color-mix(in srgb, var(--accent-success) 10%, transparent)',
              }}
              title="Safe to auto-apply"
            >
              safe
            </span>
          )}
        </div>
      </div>

      {/* ── Category + rule ─────────────────────────────────────── */}
      <div className="flex items-center gap-2 mt-1.5">
        <span
          className="rounded-[var(--radius-control)] px-1.5 py-0.5 text-[10px]"
          style={{
            color: meta.token,
            background: `color-mix(in srgb, ${meta.token} 8%, transparent)`,
          }}
        >
          {formatCategory(fix.category)}
        </span>
        {ruleId && (
          <span className="font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
            {ruleId}
          </span>
        )}
      </div>

      {/* ── Diff toggle ─────────────────────────────────────────── */}
      {(originalText || replacementText) && (
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={toggleExpand}
            className="th-focus-ring th-btn-ghost flex items-center gap-1 rounded-[var(--radius-control)] px-1.5 py-0.5 text-[11px] transition-colors"
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {expanded ? 'Hide diff' : 'Show diff'}
          </button>
          {expanded && (
            <button
              onClick={() => setRichDiff((r) => !r)}
              className="th-focus-ring th-btn-ghost flex items-center gap-1 rounded-[var(--radius-control)] px-1.5 py-0.5 text-[11px] transition-colors"
              title={richDiff ? 'Switch to text diff' : 'Switch to Monaco diff'}
            >
              <Columns size={10} />
              {richDiff ? 'text' : 'rich'}
            </button>
          )}
        </div>
      )}

      {expanded && !richDiff && (
        <div className="mt-2 space-y-1 text-xs font-mono">
          {originalText && (
            <div
              className="overflow-x-auto rounded-[var(--radius-control)] p-1.5"
              style={{
                color: 'var(--accent-danger)',
                background: 'color-mix(in srgb, var(--accent-danger) 9%, transparent)',
              }}
            >
              <span className="mr-1 select-none" style={{ color: 'color-mix(in srgb, var(--accent-danger) 65%, transparent)' }}>-</span>
              {originalText}
            </div>
          )}
          {replacementText && (
            <div
              className="overflow-x-auto rounded-[var(--radius-control)] p-1.5"
              style={{
                color: 'var(--accent-success)',
                background: 'color-mix(in srgb, var(--accent-success) 9%, transparent)',
              }}
            >
              <span className="mr-1 select-none" style={{ color: 'color-mix(in srgb, var(--accent-success) 65%, transparent)' }}>+</span>
              {replacementText}
            </div>
          )}
        </div>
      )}

      {expanded && richDiff && (
        <div className="mt-2">
          <AIDiffPreview
            originalCode={originalText}
            modifiedCode={replacementText}
            language={fix.language || 'plaintext'}
            height={120}
            inline
            title={`Fix L${line}`}
            onApply={handleApply}
            onDismiss={handleDismiss}
          />
        </div>
      )}

      {/* ── Actions ─────────────────────────────────────────────── */}
      <div className="flex items-center gap-2 mt-2">
        <button
          onClick={handleApply}
          disabled={applied}
          className="th-focus-ring flex items-center gap-1 rounded-[var(--radius-control)] border px-2.5 py-1 text-xs transition-colors disabled:cursor-default"
          style={{
            color: 'var(--accent-success)',
            background: 'color-mix(in srgb, var(--accent-success) 12%, transparent)',
            borderColor: 'color-mix(in srgb, var(--accent-success) 28%, transparent)',
          }}
          title="Apply this fix"
        >
          {applied ? (
            /* Drawn check — SVG stroke animates via .heal-check-morph */
            <svg
              className="heal-check-morph"
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M5 12l5 5L20 7" />
            </svg>
          ) : (
            <Check size={12} />
          )}
          {applied ? 'Applied' : 'Apply'}
        </button>
        <button
          onClick={handleDismiss}
          className="th-focus-ring th-btn-ghost flex items-center gap-1 rounded-[var(--radius-control)] px-2.5 py-1 text-xs transition-colors"
          title="Dismiss (reject) this fix"
        >
          <X size={12} />
          Dismiss
        </button>
        {ruleId && onSuppressRule && (
          <button
            onClick={handleSuppressRule}
            className="vt-danger-icon-hover th-focus-ring th-btn-ghost ml-auto flex items-center gap-1 rounded-[var(--radius-control)] px-2.5 py-1 text-xs transition-colors"
            title={`Suppress rule "${ruleId}" - hide all future matches`}
          >
            <EyeOff size={12} />
            Suppress
          </button>
        )}
      </div>
    </div>
  );
}
