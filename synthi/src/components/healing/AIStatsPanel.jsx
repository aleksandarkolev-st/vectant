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
} from 'lucide-react';


function StatCard({ icon: Icon, label, value, sub, color = 'text-white/70' }) {
  return (
    <div className="flex items-center gap-2.5 bg-white/5 rounded-md p-2.5">
      <Icon size={16} className={color} />
      <div className="flex-1 min-w-0">
        <div className="text-xs text-white/40">{label}</div>
        <div className={`text-sm font-mono ${color}`}>{value ?? '—'}</div>
        {sub && <div className="text-[10px] text-white/25 truncate">{sub}</div>}
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
    <div className="flex items-center gap-2 py-1.5 border-b border-white/5 last:border-0">
      <div className="flex-1 min-w-0">
        <span className="text-xs font-mono text-white/60 truncate block">{ruleId}</span>
        {suppressed && (
          <span className="text-[9px] text-red-400/70">(suppressed)</span>
        )}
      </div>
      <div className="w-16 h-1.5 bg-white/10 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full ${
            rate > 0.6 ? 'bg-green-500' : rate > 0.3 ? 'bg-yellow-500' : 'bg-red-500'
          }`}
          style={{ width: barWidth }}
        />
      </div>
      <span className="text-[10px] text-white/40 font-mono w-8 text-right">
        {Math.round(rate * 100)}%
      </span>
      <span className="text-[10px] text-white/25 w-6 text-right">{total}</span>
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
      <div className="flex items-center justify-between p-3 border-b border-white/10">
        <div className="flex items-center gap-2">
          <BarChart3 size={16} className="text-blue-400" />
          <span className="text-sm font-medium text-white/90">AI Agent Stats</span>
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="p-1 rounded hover:bg-white/10 text-white/40 hover:text-white/70 transition-colors"
          title="Refresh"
        >
          <RefreshCcw size={14} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-4">
        {/* ── Detection stats ─────────────────────────────────────── */}
        <div>
          <h3 className="text-xs text-white/50 uppercase tracking-wider mb-2">Detection</h3>
          <div className="grid grid-cols-2 gap-2">
            <StatCard
              icon={Zap}
              label="Detections"
              value={stats?.total_detections ?? stats?.totalDetections ?? '—'}
              color="text-purple-400"
            />
            <StatCard
              icon={ShieldCheck}
              label="Fixes proposed"
              value={stats?.total_fixes ?? stats?.totalFixes ?? '—'}
              color="text-green-400"
            />
            <StatCard
              icon={Brain}
              label="LLM calls"
              value={stats?.llm_calls ?? stats?.llmCalls ?? '—'}
              color="text-blue-400"
            />
            <StatCard
              icon={Clock}
              label="Avg latency"
              value={
                stats?.avg_latency_ms ?? stats?.avgLatencyMs
                  ? `${Math.round(stats.avg_latency_ms ?? stats.avgLatencyMs)}ms`
                  : '—'
              }
              color="text-yellow-400"
            />
            <StatCard
              icon={AlertTriangle}
              label="Errors"
              value={stats?.errors ?? '—'}
              color="text-red-400"
            />
            <StatCard
              icon={BarChart3}
              label="Avg confidence"
              value={
                stats?.avg_confidence ?? stats?.avgConfidence
                  ? `${Math.round((stats.avg_confidence ?? stats.avgConfidence) * 100)}%`
                  : '—'
              }
              color="text-cyan-400"
            />
          </div>
        </div>

        {/* ── Learned patterns ────────────────────────────────────── */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-xs text-white/50 uppercase tracking-wider">
              Learned patterns
              {suppressedCount > 0 && (
                <span className="text-red-400/60 ml-1">
                  ({suppressedCount} suppressed)
                </span>
              )}
            </h3>
            {patternEntries.length > 0 && (
              <button
                onClick={handleClearMemory}
                className="flex items-center gap-1 text-[10px] text-white/30 hover:text-red-400 transition-colors"
                title="Clear all learned patterns"
              >
                <Trash2 size={10} />
                Reset
              </button>
            )}
          </div>

          {patternEntries.length === 0 ? (
            <div className="text-xs text-white/25 text-center py-4">
              No patterns learned yet.
              <br />
              Apply or dismiss AI fixes to build memory.
            </div>
          ) : (
            <div className="space-y-0">
              <div className="flex items-center text-[9px] text-white/25 uppercase tracking-wider pb-1 mb-1 border-b border-white/5">
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
      </div>
    </div>
  );
}
