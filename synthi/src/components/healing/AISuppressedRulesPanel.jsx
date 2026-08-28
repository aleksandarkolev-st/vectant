// src/components/healing/AISuppressedRulesPanel.jsx
// Panel listing all currently suppressed rules/fingerprints.
// Allows users to unsuppress individual entries or clear all.
'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  EyeOff,
  Eye,
  Trash2,
  ChevronDown,
  ChevronUp,
  ShieldAlert,
  Fingerprint,
  AlertTriangle,
} from 'lucide-react';


/**
 * @param {Object}   props
 * @param {Function} props.getSuppressedRules – () => [{ruleId, mode, fingerprintCount, createdAt, reason?, escalated?, ...}]
 * @param {Function} props.onUnsuppress       – (ruleId) => void
 * @param {Function} props.onClearAll         – () => void
 * @param {number}   [props.suppressedCount=0] – currently hidden fix count
 * @param {Object}   [props.policySummary]     – backend summary: { total, escalated_count, by_mode }
 * @param {Function} [props.onRefresh]         – fetch fresh summary from backend
 */
export function AISuppressedRulesPanel({
  getSuppressedRules,
  onUnsuppress,
  onClearAll,
  suppressedCount = 0,
  policySummary,
  onRefresh,
}) {
  const [expanded, setExpanded] = useState(false);

  const rules = useMemo(() => {
    if (!expanded || !getSuppressedRules) return [];
    return getSuppressedRules();
  }, [expanded, getSuppressedRules]);

  const toggleExpand = useCallback(() => {
    setExpanded((e) => {
      const next = !e;
      // Fetch fresh summary when expanding
      if (next && onRefresh) onRefresh();
      return next;
    });
  }, [onRefresh]);

  // Prefer backend summary counts when available, fall back to local
  const totalRules = policySummary?.total_rules ?? rules.length;
  const escalatedCount = policySummary?.escalated_count ?? 0;
  const byMode = policySummary?.by_mode ?? {};

  if (totalRules === 0 && suppressedCount === 0 && !expanded) {
    return null; // nothing to show
  }

  return (
    <div className="vt-command-surface text-xs">
      {/* ── Header ───────────────────────────────────────────────── */}
      <button
        onClick={toggleExpand}
        className="vt-command-item th-focus-ring flex w-full items-center justify-between px-3 py-2 transition-colors"
      >
        <div className="flex items-center gap-2" style={{ color: 'var(--text-secondary)' }}>
          <EyeOff size={12} />
          <span>
            {suppressedCount > 0
              ? `${suppressedCount} fix${suppressedCount === 1 ? '' : 'es'} suppressed`
              : 'Suppressed rules'}
          </span>
          {totalRules > 0 && (
            <span className="vt-state-pill h-[18px] px-1.5 text-[10px]">
              {totalRules}
            </span>
          )}
          {escalatedCount > 0 && (
            <span
              className="vt-state-pill h-[18px] px-1.5 text-[10px]"
              style={{
                color: 'var(--accent-warning)',
                borderColor: 'color-mix(in srgb, var(--accent-warning) 34%, transparent)',
                background: 'color-mix(in srgb, var(--accent-warning) 10%, transparent)',
              }}
              title={`${escalatedCount} escalated (manual-only)`}
            >
              {escalatedCount} escalated
            </span>
          )}
        </div>
        {expanded ? <ChevronUp size={12} style={{ color: 'var(--text-muted)' }} /> : <ChevronDown size={12} style={{ color: 'var(--text-muted)' }} />}
      </button>

      {/* ── Body ─────────────────────────────────────────────────── */}
      {expanded && (
        <div className="px-3 pb-3 space-y-1.5">
          {rules.length === 0 && (
            <p className="py-2 text-center" style={{ color: 'var(--text-muted)' }}>No rules suppressed</p>
          )}

          {rules.map((entry) => (
            <div
              key={entry.ruleId}
              className="group flex items-start justify-between rounded-[var(--radius-control)] px-2 py-1.5"
              style={{ background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)' }}
            >
              <div className="flex flex-col gap-0.5 min-w-0">
                <div className="flex items-center gap-2">
                  {entry.mode === 'rule' ? (
                    <ShieldAlert size={11} className="shrink-0" style={{ color: 'var(--accent-danger)' }} title="Blanket rule suppression" />
                  ) : (
                    <Fingerprint size={11} className="shrink-0" style={{ color: 'var(--attention-purple)' }} title="Fingerprint-based suppression" />
                  )}
                  <span className="truncate font-mono" style={{ color: 'var(--text-secondary)' }} title={entry.ruleId}>
                    {entry.ruleId}
                  </span>
                  {entry.mode === 'fingerprint' && entry.fingerprintCount > 0 && (
                    <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
                      ({entry.fingerprintCount} pattern{entry.fingerprintCount === 1 ? '' : 's'})
                    </span>
                  )}
                </div>

                {/* Reason + escalation */}
                {(entry.reason || entry.escalated) && (
                  <div className="flex items-center gap-1.5 ml-5">
                    {entry.escalated && (
                      <span className="flex items-center gap-0.5 text-[10px]" style={{ color: 'var(--accent-warning)' }} title="Backend escalated - manual-only">
                        <AlertTriangle size={9} />
                        escalated
                      </span>
                    )}
                    {entry.reason && (
                      <span className="truncate text-[10px]" style={{ color: 'var(--text-muted)' }} title={entry.reason}>
                        {entry.reason}
                      </span>
                    )}
                  </div>
                )}
              </div>

              <button
                onClick={() => onUnsuppress?.(entry.ruleId)}
                className="th-focus-ring th-btn-ghost mt-0.5 flex shrink-0 items-center gap-1 rounded-[var(--radius-control)] px-1.5 py-0.5 opacity-0 transition-colors group-hover:opacity-100"
                title={`Unsuppress ${entry.ruleId}`}
              >
                <Eye size={11} />
                <span>Show</span>
              </button>
            </div>
          ))}

          {/* ── Clear all ──────────────────────────────────────────── */}
          {rules.length > 0 && (
            <button
              onClick={onClearAll}
              className="vt-danger-icon-hover th-focus-ring th-btn-ghost mt-2 ml-auto flex items-center gap-1 rounded-[var(--radius-control)] px-1.5 py-0.5 transition-colors"
              title="Clear all suppressed rules"
            >
              <Trash2 size={11} />
              Clear all
            </button>
          )}
        </div>
      )}
    </div>
  );
}
