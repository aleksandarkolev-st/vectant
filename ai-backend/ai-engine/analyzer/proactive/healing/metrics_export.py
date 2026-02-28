"""
Healing metrics exporter.

Exports healing statistics in a Prometheus-compatible format
for monitoring dashboards.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Dict, List


@dataclass
class HealingMetrics:
    """Aggregated metrics for the healing system."""

    # Counters
    rules_executed_total: int = 0
    fixes_detected_total: int = 0
    fixes_applied_total: int = 0
    fixes_rejected_total: int = 0
    fixes_failed_total: int = 0
    cache_hits_total: int = 0
    cache_misses_total: int = 0

    # Gauges
    active_rules_count: int = 0
    cache_size: int = 0

    # Histograms (simplified as lists)
    analysis_latency_ms: List[float] = field(default_factory=list)
    fixes_per_file: List[int] = field(default_factory=list)

    # Per-category counters
    category_counts: Dict[str, int] = field(default_factory=dict)

    # Per-language counters
    language_counts: Dict[str, int] = field(default_factory=dict)

    # Timestamps
    last_analysis_at: float = 0.0
    started_at: float = field(default_factory=time.time)

    def record_analysis(self, language: str, fix_count: int, latency_ms: float):
        """Record a single analysis run."""
        self.rules_executed_total += 1
        self.fixes_detected_total += fix_count
        self.analysis_latency_ms.append(latency_ms)
        self.fixes_per_file.append(fix_count)
        self.last_analysis_at = time.time()

        lang_key = language.lower()
        self.language_counts[lang_key] = self.language_counts.get(lang_key, 0) + 1

        # Keep histogram bounded
        if len(self.analysis_latency_ms) > 1000:
            self.analysis_latency_ms = self.analysis_latency_ms[-500:]
        if len(self.fixes_per_file) > 1000:
            self.fixes_per_file = self.fixes_per_file[-500:]

    def record_fix_applied(self, category: str):
        """Record a fix being applied."""
        self.fixes_applied_total += 1
        self.category_counts[category] = self.category_counts.get(category, 0) + 1

    def record_fix_rejected(self):
        """Record a fix being rejected by the user."""
        self.fixes_rejected_total += 1

    def record_fix_failed(self):
        """Record a fix that failed to apply."""
        self.fixes_failed_total += 1

    @property
    def avg_latency_ms(self) -> float:
        if not self.analysis_latency_ms:
            return 0.0
        return sum(self.analysis_latency_ms) / len(self.analysis_latency_ms)

    @property
    def p95_latency_ms(self) -> float:
        if not self.analysis_latency_ms:
            return 0.0
        sorted_lat = sorted(self.analysis_latency_ms)
        idx = int(len(sorted_lat) * 0.95)
        return sorted_lat[min(idx, len(sorted_lat) - 1)]

    @property
    def avg_fixes_per_file(self) -> float:
        if not self.fixes_per_file:
            return 0.0
        return sum(self.fixes_per_file) / len(self.fixes_per_file)

    @property
    def uptime_seconds(self) -> float:
        return time.time() - self.started_at

    def to_dict(self) -> dict:
        """Export as dictionary for API responses."""
        return {
            "rulesExecuted": self.rules_executed_total,
            "totalDetected": self.fixes_detected_total,
            "totalApplied": self.fixes_applied_total,
            "totalRejected": self.fixes_rejected_total,
            "totalFailed": self.fixes_failed_total,
            "cacheHits": self.cache_hits_total,
            "cacheMisses": self.cache_misses_total,
            "activeRules": self.active_rules_count,
            "cacheSize": self.cache_size,
            "avgLatencyMs": round(self.avg_latency_ms, 2),
            "p95LatencyMs": round(self.p95_latency_ms, 2),
            "avgFixesPerFile": round(self.avg_fixes_per_file, 2),
            "uptimeSeconds": round(self.uptime_seconds),
            "categoryBreakdown": dict(self.category_counts),
            "languageBreakdown": dict(self.language_counts),
            "lastAnalysisAt": self.last_analysis_at,
        }

    def to_prometheus(self) -> str:
        """Export as Prometheus exposition format."""
        lines = [
            f"# HELP healing_rules_executed_total Total number of rule executions",
            f"# TYPE healing_rules_executed_total counter",
            f"healing_rules_executed_total {self.rules_executed_total}",
            f"",
            f"# HELP healing_fixes_detected_total Total fixes detected",
            f"# TYPE healing_fixes_detected_total counter",
            f"healing_fixes_detected_total {self.fixes_detected_total}",
            f"",
            f"# HELP healing_fixes_applied_total Total fixes applied",
            f"# TYPE healing_fixes_applied_total counter",
            f"healing_fixes_applied_total {self.fixes_applied_total}",
            f"",
            f"# HELP healing_analysis_latency_ms Average analysis latency",
            f"# TYPE healing_analysis_latency_ms gauge",
            f"healing_analysis_latency_ms {round(self.avg_latency_ms, 2)}",
            f"",
            f"# HELP healing_cache_hits_total Cache hits",
            f"# TYPE healing_cache_hits_total counter",
            f"healing_cache_hits_total {self.cache_hits_total}",
        ]

        for lang, count in self.language_counts.items():
            lines.append(f'healing_language_analyses{{language="{lang}"}} {count}')

        return "\n".join(lines) + "\n"
