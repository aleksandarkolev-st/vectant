"""
Observability-Based Healing Triggers.

Bridges observability signals (metrics, logs, traces) to the healing pipeline.
Instead of only reacting to compiler errors, this module watches for:

1. Error rate spikes (e.g., 500s from dev server)
2. Build time regressions
3. Memory/CPU anomalies in dev tools
4. Test flakiness patterns
5. HMR failure cascades
6. Log pattern anomalies

Each signal type has a detector that emits HealingTrigger events
when thresholds are breached.
"""

from __future__ import annotations

import logging
import math
import re
import time
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Deque, Dict, List, Optional, Tuple

logger = logging.getLogger("healing.observability")


# ── Types ─────────────────────────────────────────────────────────────

class SignalType(str, Enum):
    """Types of observability signals."""
    ERROR_RATE = "error_rate"
    BUILD_TIME = "build_time"
    MEMORY_USAGE = "memory_usage"
    CPU_USAGE = "cpu_usage"
    TEST_FLAKINESS = "test_flakiness"
    HMR_FAILURES = "hmr_failures"
    LOG_ANOMALY = "log_anomaly"
    RESPONSE_TIME = "response_time"
    CRASH_LOOP = "crash_loop"
    DEPENDENCY_HEALTH = "dependency_health"


class TriggerSeverity(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class TriggerAction(str, Enum):
    """What to do when a trigger fires."""
    NOTIFY = "notify"          # Just inform the user
    DIAGNOSE = "diagnose"      # Run diagnosis only
    HEAL = "heal"              # Full healing pipeline
    RESTART = "restart"        # Restart the affected service
    ESCALATE = "escalate"      # Flag for human review


@dataclass
class HealingTrigger:
    """An event emitted when an observability threshold is breached."""
    trigger_id: str
    signal_type: SignalType
    severity: TriggerSeverity
    action: TriggerAction
    description: str
    metric_value: float = 0.0
    threshold: float = 0.0
    file_path: str = ""
    workspace_id: str = ""
    timestamp: float = field(default_factory=time.time)
    metadata: Dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "triggerId": self.trigger_id,
            "signalType": self.signal_type.value,
            "severity": self.severity.value,
            "action": self.action.value,
            "description": self.description,
            "metricValue": round(self.metric_value, 3),
            "threshold": round(self.threshold, 3),
            "filePath": self.file_path,
            "timestamp": self.timestamp,
            "metadata": self.metadata,
        }


@dataclass
class MetricSample:
    """A single metric data point."""
    value: float
    timestamp: float = field(default_factory=time.time)
    labels: Dict[str, str] = field(default_factory=dict)


# ── Sliding Window Stats ─────────────────────────────────────────────

class SlidingWindow:
    """
    Time-based sliding window for metric aggregation.

    Maintains a deque of (timestamp, value) and computes
    stats over the window.
    """

    def __init__(self, window_sec: float = 60.0, max_samples: int = 1000):
        self._window = window_sec
        self._max = max_samples
        self._samples: Deque[Tuple[float, float]] = deque(maxlen=max_samples)

    def add(self, value: float, timestamp: Optional[float] = None) -> None:
        ts = timestamp or time.time()
        self._samples.append((ts, value))
        self._evict()

    def _evict(self) -> None:
        cutoff = time.time() - self._window
        while self._samples and self._samples[0][0] < cutoff:
            self._samples.popleft()

    @property
    def count(self) -> int:
        self._evict()
        return len(self._samples)

    @property
    def values(self) -> List[float]:
        self._evict()
        return [v for _, v in self._samples]

    @property
    def mean(self) -> float:
        vals = self.values
        return sum(vals) / len(vals) if vals else 0.0

    @property
    def rate(self) -> float:
        """Events per second over the window."""
        self._evict()
        if len(self._samples) < 2:
            return 0.0
        span = self._samples[-1][0] - self._samples[0][0]
        return len(self._samples) / span if span > 0 else 0.0

    @property
    def stddev(self) -> float:
        vals = self.values
        if len(vals) < 2:
            return 0.0
        m = self.mean
        variance = sum((v - m) ** 2 for v in vals) / len(vals)
        return math.sqrt(variance)

    @property
    def p95(self) -> float:
        vals = sorted(self.values)
        if not vals:
            return 0.0
        idx = int(len(vals) * 0.95)
        return vals[min(idx, len(vals) - 1)]

    @property
    def max_val(self) -> float:
        vals = self.values
        return max(vals) if vals else 0.0


# ── Signal Detectors ──────────────────────────────────────────────────

class BaseDetector:
    """Base class for signal detectors."""

    signal_type: SignalType = SignalType.ERROR_RATE

    def __init__(self, enabled: bool = True):
        self.enabled = enabled
        self._last_trigger: float = 0.0
        self._cooldown_sec: float = 30.0

    def _can_trigger(self) -> bool:
        return time.time() - self._last_trigger > self._cooldown_sec

    def _make_trigger(
        self,
        severity: TriggerSeverity,
        action: TriggerAction,
        description: str,
        metric_value: float = 0.0,
        threshold: float = 0.0,
        **kwargs,
    ) -> HealingTrigger:
        self._last_trigger = time.time()
        return HealingTrigger(
            trigger_id=f"trig_{self.signal_type.value}_{int(time.time() * 1000)}",
            signal_type=self.signal_type,
            severity=severity,
            action=action,
            description=description,
            metric_value=metric_value,
            threshold=threshold,
            **kwargs,
        )


class ErrorRateDetector(BaseDetector):
    """Detects error rate spikes."""

    signal_type = SignalType.ERROR_RATE

    def __init__(
        self,
        window_sec: float = 60.0,
        threshold_per_sec: float = 0.5,
        critical_per_sec: float = 2.0,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._window = SlidingWindow(window_sec)
        self._threshold = threshold_per_sec
        self._critical = critical_per_sec

    def record_error(self) -> Optional[HealingTrigger]:
        """Record an error occurrence, return trigger if threshold breached."""
        self._window.add(1.0)

        if not self._can_trigger():
            return None

        rate = self._window.rate

        if rate >= self._critical:
            return self._make_trigger(
                TriggerSeverity.CRITICAL,
                TriggerAction.HEAL,
                f"Critical error rate: {rate:.1f}/s (threshold: {self._critical})",
                metric_value=rate,
                threshold=self._critical,
            )
        elif rate >= self._threshold:
            return self._make_trigger(
                TriggerSeverity.MEDIUM,
                TriggerAction.DIAGNOSE,
                f"Elevated error rate: {rate:.1f}/s (threshold: {self._threshold})",
                metric_value=rate,
                threshold=self._threshold,
            )
        return None


class BuildTimeDetector(BaseDetector):
    """Detects build time regressions."""

    signal_type = SignalType.BUILD_TIME

    def __init__(
        self,
        window_sec: float = 300.0,
        regression_factor: float = 2.0,
        min_samples: int = 3,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._window = SlidingWindow(window_sec, max_samples=50)
        self._regression_factor = regression_factor
        self._min_samples = min_samples
        self._baseline_mean: float = 0.0

    def record_build(self, duration_sec: float) -> Optional[HealingTrigger]:
        """Record a build duration, return trigger if regression detected."""
        self._window.add(duration_sec)

        if self._window.count < self._min_samples:
            self._baseline_mean = self._window.mean
            return None

        if not self._can_trigger():
            return None

        current = duration_sec
        baseline = self._baseline_mean or self._window.mean

        if baseline > 0 and current > baseline * self._regression_factor:
            severity = (
                TriggerSeverity.HIGH
                if current > baseline * 3
                else TriggerSeverity.MEDIUM
            )
            return self._make_trigger(
                severity,
                TriggerAction.DIAGNOSE,
                f"Build time regression: {current:.1f}s vs baseline {baseline:.1f}s "
                f"({current / baseline:.1f}x slower)",
                metric_value=current,
                threshold=baseline * self._regression_factor,
            )

        # Update rolling baseline
        self._baseline_mean = self._window.mean
        return None


class HMRFailureDetector(BaseDetector):
    """Detects HMR failure cascades."""

    signal_type = SignalType.HMR_FAILURES

    def __init__(
        self,
        window_sec: float = 30.0,
        threshold: int = 3,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._window = SlidingWindow(window_sec, max_samples=100)
        self._threshold = threshold

    def record_hmr_failure(
        self,
        file_path: str = "",
    ) -> Optional[HealingTrigger]:
        """Record an HMR failure, return trigger if cascade detected."""
        self._window.add(1.0)

        if not self._can_trigger():
            return None

        count = self._window.count

        if count >= self._threshold:
            return self._make_trigger(
                TriggerSeverity.HIGH,
                TriggerAction.HEAL,
                f"HMR failure cascade: {count} failures in "
                f"{self._window._window}s (threshold: {self._threshold})",
                metric_value=float(count),
                threshold=float(self._threshold),
                file_path=file_path,
            )
        return None


class TestFlakinessDetector(BaseDetector):
    """Detects test flakiness patterns."""

    signal_type = SignalType.TEST_FLAKINESS

    def __init__(
        self,
        window_sec: float = 600.0,
        flakiness_threshold: float = 0.3,
        min_runs: int = 5,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._window = SlidingWindow(window_sec, max_samples=100)
        self._threshold = flakiness_threshold
        self._min_runs = min_runs
        # test_name -> deque of (timestamp, passed: bool)
        self._test_results: Dict[str, Deque[Tuple[float, bool]]] = {}

    def record_test(
        self,
        test_name: str,
        passed: bool,
        file_path: str = "",
    ) -> Optional[HealingTrigger]:
        """Record a test result, detect flakiness."""
        if test_name not in self._test_results:
            self._test_results[test_name] = deque(maxlen=20)
        self._test_results[test_name].append((time.time(), passed))

        results = self._test_results[test_name]
        if len(results) < self._min_runs:
            return None

        if not self._can_trigger():
            return None

        # Compute flakiness (alternation rate)
        changes = sum(
            1 for i in range(1, len(results))
            if results[i][1] != results[i - 1][1]
        )
        flakiness = changes / (len(results) - 1) if len(results) > 1 else 0.0

        if flakiness >= self._threshold:
            return self._make_trigger(
                TriggerSeverity.MEDIUM,
                TriggerAction.DIAGNOSE,
                f"Flaky test detected: {test_name} "
                f"(flakiness={flakiness:.0%}, {len(results)} runs)",
                metric_value=flakiness,
                threshold=self._threshold,
                file_path=file_path,
                metadata={"testName": test_name},
            )
        return None


class CrashLoopDetector(BaseDetector):
    """Detects process crash loops."""

    signal_type = SignalType.CRASH_LOOP

    def __init__(
        self,
        window_sec: float = 60.0,
        threshold: int = 3,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._window = SlidingWindow(window_sec, max_samples=50)
        self._threshold = threshold
        self._cooldown_sec = 60.0

    def record_crash(
        self,
        process_name: str = "",
    ) -> Optional[HealingTrigger]:
        """Record a process crash, detect crash loops."""
        self._window.add(1.0)

        if not self._can_trigger():
            return None

        count = self._window.count
        if count >= self._threshold:
            return self._make_trigger(
                TriggerSeverity.CRITICAL,
                TriggerAction.HEAL,
                f"Crash loop detected: {process_name or 'process'} "
                f"crashed {count}x in {self._window._window}s",
                metric_value=float(count),
                threshold=float(self._threshold),
                metadata={"processName": process_name},
            )
        return None


class LogAnomalyDetector(BaseDetector):
    """Detects unusual log patterns."""

    signal_type = SignalType.LOG_ANOMALY

    def __init__(
        self,
        error_patterns: Optional[List[re.Pattern]] = None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self._patterns = error_patterns or [
            re.compile(r"FATAL|PANIC|OOM|OutOfMemory", re.I),
            re.compile(r"segfault|segmentation fault|SIGSEGV", re.I),
            re.compile(r"deadlock|dead.?lock", re.I),
            re.compile(r"corrupted|corruption", re.I),
            re.compile(r"disk full|no space left", re.I),
        ]

    def scan_log(
        self,
        log_line: str,
        source: str = "",
    ) -> Optional[HealingTrigger]:
        """Scan a log line for anomalies."""
        if not self._can_trigger():
            return None

        for pattern in self._patterns:
            match = pattern.search(log_line)
            if match:
                return self._make_trigger(
                    TriggerSeverity.HIGH,
                    TriggerAction.ESCALATE,
                    f"Log anomaly: '{match.group(0)}' in {source or 'log'}",
                    metadata={"logLine": log_line[:200], "source": source},
                )
        return None


# ── Observability Hub ─────────────────────────────────────────────────

class ObservabilityHub:
    """
    Central hub that aggregates all signal detectors and dispatches
    healing triggers to registered callbacks.
    """

    def __init__(
        self,
        on_trigger: Optional[Callable] = None,
    ):
        self._on_trigger = on_trigger

        # Built-in detectors
        self.error_rate = ErrorRateDetector()
        self.build_time = BuildTimeDetector()
        self.hmr_failures = HMRFailureDetector()
        self.test_flakiness = TestFlakinessDetector()
        self.crash_loop = CrashLoopDetector()
        self.log_anomaly = LogAnomalyDetector()

        self._custom_detectors: Dict[str, BaseDetector] = {}
        self._trigger_history: Deque[HealingTrigger] = deque(maxlen=200)
        self._stats = {
            "total_triggers": 0,
            "triggers_by_type": defaultdict(int),
            "triggers_by_severity": defaultdict(int),
        }

    def register_detector(self, name: str, detector: BaseDetector) -> None:
        """Register a custom signal detector."""
        self._custom_detectors[name] = detector

    def _dispatch(self, trigger: Optional[HealingTrigger]) -> Optional[HealingTrigger]:
        """Dispatch a trigger if non-None."""
        if trigger is None:
            return None

        self._trigger_history.append(trigger)
        self._stats["total_triggers"] += 1
        self._stats["triggers_by_type"][trigger.signal_type.value] += 1
        self._stats["triggers_by_severity"][trigger.severity.value] += 1

        logger.info(
            f"Trigger [{trigger.severity.value}] {trigger.signal_type.value}: "
            f"{trigger.description}"
        )

        if self._on_trigger:
            try:
                self._on_trigger(trigger)
            except Exception as e:
                logger.error(f"Trigger callback failed: {e}")

        return trigger

    # ── Convenience methods that record + dispatch ────────────────────

    def record_error(self) -> Optional[HealingTrigger]:
        return self._dispatch(self.error_rate.record_error())

    def record_build(self, duration_sec: float) -> Optional[HealingTrigger]:
        return self._dispatch(self.build_time.record_build(duration_sec))

    def record_hmr_failure(self, file_path: str = "") -> Optional[HealingTrigger]:
        return self._dispatch(self.hmr_failures.record_hmr_failure(file_path))

    def record_test(
        self, test_name: str, passed: bool, file_path: str = ""
    ) -> Optional[HealingTrigger]:
        return self._dispatch(
            self.test_flakiness.record_test(test_name, passed, file_path)
        )

    def record_crash(self, process_name: str = "") -> Optional[HealingTrigger]:
        return self._dispatch(self.crash_loop.record_crash(process_name))

    def scan_log(self, log_line: str, source: str = "") -> Optional[HealingTrigger]:
        return self._dispatch(self.log_anomaly.scan_log(log_line, source))

    # ── Status ────────────────────────────────────────────────────────

    @property
    def recent_triggers(self) -> List[Dict[str, Any]]:
        return [t.to_dict() for t in self._trigger_history]

    @property
    def stats(self) -> Dict[str, Any]:
        return {
            "totalTriggers": self._stats["total_triggers"],
            "triggersByType": dict(self._stats["triggers_by_type"]),
            "triggersBySeverity": dict(self._stats["triggers_by_severity"]),
            "detectors": {
                "errorRate": self.error_rate.enabled,
                "buildTime": self.build_time.enabled,
                "hmrFailures": self.hmr_failures.enabled,
                "testFlakiness": self.test_flakiness.enabled,
                "crashLoop": self.crash_loop.enabled,
                "logAnomaly": self.log_anomaly.enabled,
                "custom": list(self._custom_detectors.keys()),
            },
        }


# ── Module-level singleton ────────────────────────────────────────────

_hub: Optional[ObservabilityHub] = None


def get_observability_hub(**kwargs) -> ObservabilityHub:
    global _hub
    if _hub is None:
        _hub = ObservabilityHub(**kwargs)
    return _hub


def reset_observability_hub() -> None:
    global _hub
    _hub = None
