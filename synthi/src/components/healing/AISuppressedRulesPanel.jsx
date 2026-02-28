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
 */
export function AISuppressedRulesPanel({
  getSuppressedRules,
  onUnsuppress,
  onClearAll,
  suppressedCount = 0,
}) {
  const [expanded, setExpanded] = useState(false);

  const rules = useMemo(() => {
    if (!expanded || !getSuppressedRules) return [];
    return getSuppressedRules();
  }, [expanded, getSuppressedRules]);

  const toggleExpand = useCallback(() => setExpanded((e) => !e), []);

  const totalRules = rules.length;

  if (totalRules === 0 && suppressedCount === 0 && !expanded) {
    return null; // nothing to show
  }

  return (
    <div className="rounded-md border border-white/10 bg-white/[0.02] text-xs">
      {/* ── Header ───────────────────────────────────────────────── */}
      <button
        onClick={toggleExpand}
        className="flex items-center justify-between w-full px-3 py-2 hover:bg-white/5 transition-colors"
      >
        <div className="flex items-center gap-2 text-white/50">
          <EyeOff size={12} />
          <span>
            {suppressedCount > 0
              ? `${suppressedCount} fix${suppressedCount === 1 ? '' : 'es'} suppressed`
              : 'Suppressed rules'}
          </span>
          {totalRules > 0 && (
            <span className="bg-white/10 px-1.5 py-0.5 rounded text-[10px] font-mono">
              {totalRules}
            </span>
          )}
        </div>
        {expanded ? <ChevronUp size={12} className="text-white/30" /> : <ChevronDown size={12} className="text-white/30" />}
      </button>

      {/* ── Body ─────────────────────────────────────────────────── */}
      {expanded && (
        <div className="px-3 pb-3 space-y-1.5">
          {rules.length === 0 && (
            <p className="text-white/30 py-2 text-center">No rules suppressed</p>
          )}

          {rules.map((entry) => (
            <div
              key={entry.ruleId}
              className="flex items-start justify-between bg-white/5 rounded px-2 py-1.5 group"
            >
              <div className="flex flex-col gap-0.5 min-w-0">
                <div className="flex items-center gap-2">
                  {entry.mode === 'rule' ? (
                    <ShieldAlert size={11} className="text-red-400/60 shrink-0" title="Blanket rule suppression" />
                  ) : (
                    <Fingerprint size={11} className="text-blue-400/60 shrink-0" title="Fingerprint-based suppression" />
                  )}
                  <span className="font-mono text-white/60 truncate" title={entry.ruleId}>
                    {entry.ruleId}
                  </span>
                  {entry.mode === 'fingerprint' && entry.fingerprintCount > 0 && (
                    <span className="text-[10px] text-white/30">
                      ({entry.fingerprintCount} pattern{entry.fingerprintCount === 1 ? '' : 's'})
                    </span>
                  )}
                </div>

                {/* Reason + escalation */}
                {(entry.reason || entry.escalated) && (
                  <div className="flex items-center gap-1.5 ml-5">
                    {entry.escalated && (
                      <span className="flex items-center gap-0.5 text-[10px] text-amber-400/70" title="Backend escalated — manual-only">
                        <AlertTriangle size={9} />
                        escalated
                      </span>
                    )}
                    {entry.reason && (
                      <span className="text-[10px] text-white/25 truncate" title={entry.reason}>
                        {entry.reason}
                      </span>
                    )}
                  </div>
                )}
              </div>

              <button
                onClick={() => onUnsuppress?.(entry.ruleId)}
                className="flex items-center gap-1 text-white/30 hover:text-green-400 transition-colors opacity-0 group-hover:opacity-100 shrink-0 mt-0.5"
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
              className="flex items-center gap-1 text-white/30 hover:text-red-400 transition-colors mt-2 ml-auto"
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
