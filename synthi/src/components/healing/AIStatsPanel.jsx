// src/components/healing/AIStatsPanel.jsx
// Dashboard panel for AI agent statistics and learned-memory overview.
// Shows detection counts, LLM call metrics, acceptance rates, suppressed patterns.
'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  BarChart3,
  Brain,
  RefreshCcw,
  Trash2,
  Zap,
  ShieldCheck,
  Clock,
  AlertTriangle,
  History,
} from 'lucide-react';
import { AIActivityTimeline } from './AIActivityTimeline';


function StatCard({ icon: Icon, label, value, sub, color = 'var(--text-secondary)' }) {
  return (
    <div className="flex items-center gap-2.5 rounded-[var(--radius-control)] p-2.5" style={{ background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)' }}>
      <Icon size={16} style={{ color }} />
      <div className="flex-1 min-w-0">
        <div className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</div>
        <div className="text-sm font-mono" style={{ color }}>{value ?? '-'}</div>
        {sub && <div className="truncate text-[10px]" style={{ color: 'var(--text-muted)' }}>{sub}</div>}
      </div>
    </div>
  );
}


function PatternRow({ ruleId, stats }) {
  const rate = stats?.acceptance_rate ?? stats?.acceptanceRate ?? 0;
  const total = (stats?.accepted ?? 0) + (stats?.rejected ?? 0) + (stats?.modified ?? 0);
  const barWidth = `${Math.round(rate * 100)}%`;
  const suppressed = stats?.suppressed ?? false;

  return (
    <div className="flex items-center gap-2 py-1.5 border-b last:border-0" style={{ borderColor: 'color-mix(in srgb, var(--border-subtle) 72%, transparent)' }}>
      <div className="flex-1 min-w-0">
        <span className="block truncate font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>{ruleId}</span>
        {suppressed && (
          <span className="text-[9px]" style={{ color: 'var(--accent-danger)' }}>(suppressed)</span>
        )}
      </div>
      <div className="w-16 h-1.5 overflow-hidden rounded-full" style={{ background: 'color-mix(in srgb, var(--text-primary) 8%, transparent)' }}>
        <div
          className="h-full rounded-full"
          style={{
            width: barWidth,
            background: rate > 0.6
              ? 'var(--accent-success)'
              : rate > 0.3
                ? 'var(--accent-warning)'
                : 'var(--accent-danger)',
          }}
        />
      </div>
      <span className="w-8 text-right font-mono text-[10px]" style={{ color: 'var(--text-muted)' }}>
        {Math.round(rate * 100)}%
      </span>
      <span className="w-6 text-right text-[10px]" style={{ color: 'var(--text-muted)' }}>{total}</span>
    </div>
  );
}


/**
 * @param {Object}  props
 * @param {Object}  props.aiHealing  – return value of useAIHealing()
 * @param {Object}  props.gateway    – return value of useAnalyzerGateway()
 */
export function AIStatsPanel({ aiHealing, gateway }) {
  const [stats, setStats] = useState(null);
  const [memory, setMemory] = useState(null);
  const [loading, setLoading] = useState(false);

  // ── Fetch both stats and memory ─────────────────────────────────────
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [s, m] = await Promise.all([
        aiHealing?.fetchStats?.() ?? null,
        aiHealing?.fetchMemory?.() ?? null,
      ]);
      setStats(s);
      setMemory(m);
    } catch {
      // non-critical
    } finally {
      setLoading(false);
    }
  }, [aiHealing]);

  // Auto-fetch on mount
  useEffect(() => {
    refresh();
  }, [refresh]);

  // ── Clear memory ────────────────────────────────────────────────────
  const handleClearMemory = useCallback(async () => {
    if (!gateway?.aiMemoryClear) return;
    try {
      await gateway.aiMemoryClear();
      await refresh();
    } catch {
      // non-critical
    }
  }, [gateway, refresh]);

  // ── Derived values ──────────────────────────────────────────────────
  const patterns = memory?.patterns || memory?.pattern_stats || {};
  const patternEntries = Object.entries(patterns).sort(
    ([, a], [, b]) => ((b.accepted ?? 0) + (b.rejected ?? 0)) - ((a.accepted ?? 0) + (a.rejected ?? 0))
  );
  const suppressedCount = memory?.suppressed_count ?? memory?.suppressedCount ?? 0;

  return (
    <div className="flex flex-col h-full">
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="flex items-center justify-between border-b p-3" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center gap-2">
          <BarChart3 size={16} style={{ color: 'var(--attention-purple)' }} />
          <span className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>Fix ledger</span>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="vt-icon-button th-focus-ring h-7 min-w-7 transition-colors disabled:opacity-50"
          title="Refresh"
        >
          <RefreshCcw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* ── Detection stats ─────────────────────────────────────── */}
        <div>
          <h3 className="mb-2 text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>Detection</h3>
          <div className="grid grid-cols-2 gap-2">
            <StatCard
              icon={Zap}
              label="Detections"
              value={stats?.total_detections ?? stats?.totalDetections ?? '-'}
              color="var(--attention-purple)"
            />
            <StatCard
              icon={ShieldCheck}
              label="Fixes proposed"
              value={stats?.total_fixes ?? stats?.totalFixes ?? '-'}
              color="var(--accent-success)"
            />
            <StatCard
              icon={Brain}
              label="Model calls"
              value={stats?.llm_calls ?? stats?.llmCalls ?? '-'}
              color="var(--accent-info)"
            />
            <StatCard
              icon={Clock}
              label="Avg latency"
              value={
                stats?.avg_latency_ms ?? stats?.avgLatencyMs
                  ? `${Math.round(stats.avg_latency_ms ?? stats.avgLatencyMs)}ms`
                  : '-'
              }
              color="var(--accent-warning)"
            />
            <StatCard
              icon={AlertTriangle}
              label="Errors"
              value={stats?.errors ?? '-'}
              color="var(--accent-danger)"
            />
            <StatCard
              icon={BarChart3}
              label="Avg confidence"
              value={
                stats?.avg_confidence ?? stats?.avgConfidence
                  ? `${Math.round((stats.avg_confidence ?? stats.avgConfidence) * 100)}%`
                  : '-'
              }
              color="var(--brand-stop-3)"
            />
          </div>
        </div>

        {/* ── Learned patterns ────────────────────────────────────── */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
              Learned patterns
              {suppressedCount > 0 && (
                <span className="ml-1" style={{ color: 'var(--accent-danger)' }}>
                  ({suppressedCount} suppressed)
                </span>
              )}
            </h3>
            {patternEntries.length > 0 && (
              <button
                onClick={handleClearMemory}
                className="vt-danger-icon-hover th-focus-ring th-btn-ghost flex items-center gap-1 rounded-[var(--radius-control)] px-1.5 py-0.5 text-[10px] transition-colors"
                title="Clear all learned patterns"
              >
                <Trash2 size={10} />
                Reset
              </button>
            )}
          </div>

          {patternEntries.length === 0 ? (
            <div className="py-4 text-center text-xs" style={{ color: 'var(--text-muted)' }}>
              No patterns learned yet.
              <br />
              Apply or dismiss fixes to build memory.
            </div>
          ) : (
            <div className="space-y-0">
              <div className="mb-1 flex items-center border-b pb-1 text-[9px] uppercase tracking-wider" style={{ color: 'var(--text-muted)', borderColor: 'var(--border-subtle)' }}>
                <span className="flex-1">Pattern</span>
                <span className="w-16 text-center">Rate</span>
                <span className="w-8 text-right">%</span>
                <span className="w-6 text-right">n</span>
              </div>
              {patternEntries.map(([ruleId, patternStats]) => (
                <PatternRow key={ruleId} ruleId={ruleId} stats={patternStats} />
              ))}
            </div>
          )}
        </div>

        {/* ── Activity Timeline ────────────────────────────────────── */}
        {aiHealing?.getFixHistory && (
          <div>
            <div className="flex items-center gap-1.5 mb-2">
              <History size={12} style={{ color: 'var(--text-muted)' }} />
              <h3 className="text-xs font-semibold" style={{ color: 'var(--text-secondary)' }}>Recent activity</h3>
            </div>
            <AIActivityTimeline
              entries={aiHealing.getFixHistory?.() ?? []}
              maxItems={10}
            />
          </div>
        )}
      </div>
    </div>
  );
}
