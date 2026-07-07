"use client";

import React, { useState } from "react";
import { useHealingStats } from "@/hooks/useHealingStats";
import { ChevronRight, RefreshCw } from "lucide-react";

/**
 * Healing Statistics Dashboard panel.
 *
 * Shows live metrics from the healing engine:
 * - Total rules registered / enabled
 * - Fixes detected / applied / rejected
 * - Cache hit rate and size
 */
export default function HealingStatsDashboard({ slug }) {
  const { stats, cacheStats, loading, refresh } = useHealingStats(slug);
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="healing-stats-dashboard vt-command-surface p-3">
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <button
          onClick={() => setExpanded(!expanded)}
          className="vt-command-item th-focus-ring flex items-center gap-2 rounded-[var(--radius-control)] px-2 py-1 text-sm font-medium"
          style={{ color: 'var(--text-primary)' }}
        >
          <ChevronRight className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} aria-hidden="true" />
          Healing statistics
          {loading && <span className="text-xs" style={{ color: 'var(--text-muted)' }}>(refreshing...)</span>}
        </button>
        <button
          onClick={refresh}
          className="vt-icon-button th-focus-ring h-7 min-w-7"
          title="Refresh stats"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      {expanded && (
        <div className="space-y-3 text-xs">
          {/* Engine stats */}
          {stats && (
            <div className="grid grid-cols-2 gap-2">
              <StatCard label="Rules registered" value={stats.totalRules ?? "-"} />
              <StatCard label="Rules enabled" value={stats.enabledRules ?? "-"} />
              <StatCard label="Fixes detected" value={stats.totalDetected ?? 0} />
              <StatCard label="Fixes applied" value={stats.totalApplied ?? 0} />
              <StatCard label="Fixes rejected" value={stats.totalRejected ?? 0} />
              <StatCard label="Avg latency" value={`${(stats.avgLatencyMs ?? 0).toFixed(1)}ms`} />
            </div>
          )}

          {/* Cache stats */}
          {cacheStats && (
            <div className="mt-2">
              <div className="mb-1 font-medium" style={{ color: 'var(--text-muted)' }}>Cache</div>
              <div className="grid grid-cols-2 gap-2">
                <StatCard label="Size" value={`${cacheStats.size ?? 0} / ${cacheStats.maxSize ?? 0}`} />
                <StatCard label="Hit Rate" value={`${((cacheStats.hitRate ?? 0) * 100).toFixed(1)}%`} />
                <StatCard label="Hits" value={cacheStats.hits ?? 0} />
                <StatCard label="Misses" value={cacheStats.misses ?? 0} />
              </div>
            </div>
          )}

          {!stats && !cacheStats && !loading && (
            <div className="py-2 text-center" style={{ color: 'var(--text-muted)' }}>
              No data available. Healing engine may not be connected.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value }) {
  return (
    <div className="rounded-[var(--radius-control)] px-2 py-1" style={{ background: 'color-mix(in srgb, var(--text-primary) 5%, transparent)' }}>
      <div style={{ color: 'var(--text-muted)' }}>{label}</div>
      <div className="font-mono" style={{ color: 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}
