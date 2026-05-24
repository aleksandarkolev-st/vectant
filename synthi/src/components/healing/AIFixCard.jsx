// src/components/healing/AIFixCard.jsx
// Individual card for a single AI-detected fix.
// Shows the description, category, confidence, and diff preview.
// Actions: Apply, Dismiss.
'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  Check,
  X,
  ChevronDown,
  ChevronUp,
  Sparkles,
  ShieldAlert,
  AlertTriangle,
  Info,
  Columns,
  EyeOff,
} from 'lucide-react';
import { AIDiffPreview } from './AIDiffPreview';


// ── Severity config ───────────────────────────────────────────────────
const SEVERITY_META = {
  critical: { icon: ShieldAlert, color: 'text-red-500', bg: 'bg-red-500/10', border: 'border-red-500/30', label: 'Critical' },
  high:     { icon: AlertTriangle, color: 'text-orange-400', bg: 'bg-orange-400/10', border: 'border-orange-400/30', label: 'High' },
  moderate: { icon: AlertTriangle, color: 'text-yellow-400', bg: 'bg-yellow-400/10', border: 'border-yellow-400/30', label: 'Medium' },
  low:      { icon: Info, color: 'text-blue-400', bg: 'bg-blue-400/10', border: 'border-blue-400/30', label: 'Low' },
  trivial:  { icon: Info, color: 'text-gray-400', bg: 'bg-gray-400/10', border: 'border-gray-400/30', label: 'Trivial' },
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
  const color =
    pct >= 85 ? 'text-green-400' :
    pct >= 65 ? 'text-yellow-400' :
    'text-red-400';

  return (
    <span className={`text-xs font-mono ${color}`} title={`AI confidence: ${pct}%`}>
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
      className={`rounded-md border ${meta.border} ${meta.bg} p-3 mb-2 transition-all ${applied ? 'heal-applied-flash' : ''}`}
      role="listitem"
    >
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <SevIcon size={14} className={meta.color} />
          <span className="text-xs text-white/50 font-mono">{lineLabel}</span>
          <span className="text-sm text-white/90 truncate">
            {fix.description || 'AI-detected issue'}
          </span>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <ConfidenceBadge confidence={confidence} />
          {isSafe && (
            <span className="text-[10px] bg-green-500/20 text-green-400 px-1.5 py-0.5 rounded" title="Safe to auto-apply">
              safe
            </span>
          )}
        </div>
      </div>

      {/* ── Category + rule ─────────────────────────────────────── */}
      <div className="flex items-center gap-2 mt-1.5">
        <span className={`text-[10px] ${meta.color} bg-white/5 px-1.5 py-0.5 rounded`}>
          {formatCategory(fix.category)}
        </span>
        {ruleId && (
          <span className="text-[10px] text-white/30 font-mono">
            {ruleId}
          </span>
        )}
      </div>

      {/* ── Diff toggle ─────────────────────────────────────────── */}
      {(originalText || replacementText) && (
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={toggleExpand}
            className="flex items-center gap-1 text-[11px] text-white/40 hover:text-white/70 transition-colors"
          >
            {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            {expanded ? 'Hide diff' : 'Show diff'}
          </button>
          {expanded && (
            <button
              onClick={() => setRichDiff((r) => !r)}
              className="flex items-center gap-1 text-[11px] text-white/30 hover:text-white/60 transition-colors"
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
            <div className="bg-red-500/10 text-red-300/80 p-1.5 rounded overflow-x-auto">
              <span className="select-none text-red-500/50 mr-1">−</span>
              {originalText}
            </div>
          )}
          {replacementText && (
            <div className="bg-green-500/10 text-green-300/80 p-1.5 rounded overflow-x-auto">
              <span className="select-none text-green-500/50 mr-1">+</span>
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
          className="flex items-center gap-1 text-xs bg-green-600/30 hover:bg-green-600/50 text-green-300 px-2.5 py-1 rounded transition-colors disabled:cursor-default"
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
          className="flex items-center gap-1 text-xs bg-white/5 hover:bg-white/10 text-white/50 hover:text-white/70 px-2.5 py-1 rounded transition-colors"
          title="Dismiss (reject) this fix"
        >
          <X size={12} />
          Dismiss
        </button>
        {ruleId && onSuppressRule && (
          <button
            onClick={handleSuppressRule}
            className="flex items-center gap-1 text-xs bg-white/5 hover:bg-red-500/20 text-white/30 hover:text-red-300 px-2.5 py-1 rounded transition-colors ml-auto"
            title={`Suppress rule "${ruleId}" — hide all future matches`}
          >
            <EyeOff size={12} />
            Suppress
          </button>
        )}
      </div>
    </div>
  );
}
