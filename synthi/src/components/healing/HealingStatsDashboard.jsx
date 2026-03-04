"use client";

import React, { useState } from "react";
import { useHealingStats } from "@/hooks/useHealingStats";

/**
 * Healing Statistics Dashboard panel.
 *
 * Shows live metrics from the healing engine:
 * - Total rules registered / enabled
 * - Fixes detected / applied / rejected
 * - Cache hit rate and size
 */
export default function HealingStatsDashboard() {
  const { stats, cacheStats, loading, refresh } = useHealingStats(15000);
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="healing-stats-dashboard p-3 bg-[var(--bg-secondary)] rounded-lg border border-[var(--border-color)]">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 text-sm font-medium text-[var(--text-primary)] hover:text-[var(--accent)]"
        >
          <span className={`transform transition-transform ${expanded ? "rotate-90" : ""}`}>
            ▶
          </span>
          Healing Statistics
          {loading && <span className="text-xs text-[var(--text-muted)]">(refreshing…)</span>}
        </button>
        <button
          onClick={refresh}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--accent)] px-2 py-0.5 rounded"
          title="Refresh stats"
        >
          ↻
        </button>
      </div>

      {expanded && (
        <div className="space-y-3 text-xs">
          {/* Engine stats */}
          {stats && (
            <div className="grid grid-cols-2 gap-2">
              <StatCard label="Rules Registered" value={stats.totalRules ?? "—"} />
              <StatCard label="Rules Enabled" value={stats.enabledRules ?? "—"} />
              <StatCard label="Fixes Detected" value={stats.totalDetected ?? 0} />
              <StatCard label="Fixes Applied" value={stats.totalApplied ?? 0} />
              <StatCard label="Fixes Rejected" value={stats.totalRejected ?? 0} />
              <StatCard label="Avg Latency" value={`${(stats.avgLatencyMs ?? 0).toFixed(1)}ms`} />
            </div>
          )}

          {/* Cache stats */}
          {cacheStats && (
            <div className="mt-2">
              <div className="text-[var(--text-muted)] font-medium mb-1">Cache</div>
              <div className="grid grid-cols-2 gap-2">
                <StatCard label="Size" value={`${cacheStats.size ?? 0} / ${cacheStats.maxSize ?? 0}`} />
                <StatCard label="Hit Rate" value={`${((cacheStats.hitRate ?? 0) * 100).toFixed(1)}%`} />
                <StatCard label="Hits" value={cacheStats.hits ?? 0} />
                <StatCard label="Misses" value={cacheStats.misses ?? 0} />
              </div>
            </div>
          )}

          {!stats && !cacheStats && !loading && (
            <div className="text-[var(--text-muted)] text-center py-2">
              No data available — healing engine may not be connected
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="bg-[var(--bg-primary)] rounded px-2 py-1">
      <div className="text-[var(--text-muted)]">{label}</div>
      <div className="text-[var(--text-primary)] font-mono">{value}</div>
    </div>
  );
}
