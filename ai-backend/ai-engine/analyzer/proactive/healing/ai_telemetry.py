"""
AI Agent telemetry and metrics.

Collects timing, error, and usage metrics for monitoring the AI
healing agent in production. Designed to be lightweight — all data
stays in-memory with periodic snapshots.

NOT a replacement for real APM (Datadog, Grafana, etc.) — this is
a pragmatic "good enough" layer for early-stage observability.
"""

from __future__ import annotations

import time
import logging
from typing import Any, Dict, List, Optional
from dataclasses import dataclass, field
from collections import defaultdict

logger = logging.getLogger("healing.ai_telemetry")


@dataclass
class TimingBucket:
    """Accumulates timing samples for a named operation."""
    name: str
    count: int = 0
    total_ms: float = 0.0
    min_ms: float = float("inf")
    max_ms: float = 0.0

    def record(self, duration_ms: float) -> None:
        self.count += 1
        self.total_ms += duration_ms
        if duration_ms < self.min_ms:
            self.min_ms = duration_ms
        if duration_ms > self.max_ms:
            self.max_ms = duration_ms

    @property
    def avg_ms(self) -> float:
        return self.total_ms / self.count if self.count > 0 else 0.0

    def to_dict(self) -> Dict:
        return {
            "name": self.name,
            "count": self.count,
            "total_ms": round(self.total_ms, 1),
            "avg_ms": round(self.avg_ms, 1),
            "min_ms": round(self.min_ms, 1) if self.count > 0 else 0,
            "max_ms": round(self.max_ms, 1),
        }


@dataclass
class ErrorCounter:
    """Counts errors by type."""
    counts: Dict[str, int] = field(default_factory=lambda: defaultdict(int))

    def record(self, error_type: str) -> None:
        self.counts[error_type] += 1

    @property
    def total(self) -> int:
        return sum(self.counts.values())

    def to_dict(self) -> Dict:
        return {
            "total": self.total,
            "by_type": dict(self.counts),
        }


class AITelemetry:
    """
    In-memory telemetry collector.

    Usage:
        tel = AITelemetry()

        with tel.timer("llm_call"):
            result = await llm.call(...)

        tel.count("detection_success")
        tel.error("timeout")
    """

    def __init__(self):
        self._timings: Dict[str, TimingBucket] = {}
        self._counters: Dict[str, int] = defaultdict(int)
        self._errors = ErrorCounter()
        self._start_time = time.time()

    def timer(self, operation: str) -> "TimerContext":
        """Context manager that records duration of an operation."""
        if operation not in self._timings:
            self._timings[operation] = TimingBucket(name=operation)
        return TimerContext(self._timings[operation])

    def record_timing(self, operation: str, duration_ms: float) -> None:
        """Manually record a timing sample."""
        if operation not in self._timings:
            self._timings[operation] = TimingBucket(name=operation)
        self._timings[operation].record(duration_ms)

    def count(self, event: str, n: int = 1) -> None:
        """Increment a named counter."""
        self._counters[event] += n

    def error(self, error_type: str) -> None:
        """Record an error by type."""
        self._errors.record(error_type)
        self._counters["total_errors"] += 1

    def snapshot(self) -> Dict:
        """Return a full snapshot of all metrics."""
        uptime_s = time.time() - self._start_time
        return {
            "uptime_seconds": round(uptime_s, 1),
            "timings": {
                name: bucket.to_dict()
                for name, bucket in self._timings.items()
            },
            "counters": dict(self._counters),
            "errors": self._errors.to_dict(),
        }

    def reset(self) -> None:
        """Reset all metrics."""
        self._timings.clear()
        self._counters.clear()
        self._errors = ErrorCounter()
        self._start_time = time.time()


class TimerContext:
    """Context manager returned by AITelemetry.timer()."""

    def __init__(self, bucket: TimingBucket):
        self._bucket = bucket
        self._start: Optional[float] = None

    def __enter__(self):
        self._start = time.time()
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self._start is not None:
            elapsed_ms = (time.time() - self._start) * 1000
            self._bucket.record(elapsed_ms)
        return False  # don't suppress exceptions


# ── Module singleton ──────────────────────────────────────────────────

_instance: Optional[AITelemetry] = None


def get_telemetry() -> AITelemetry:
    """Get or create the module-level telemetry singleton."""
    global _instance
    if _instance is None:
        _instance = AITelemetry()
    return _instance
