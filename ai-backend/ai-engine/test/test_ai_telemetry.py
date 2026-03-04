"""
Tests for ai_telemetry.py — timing, counters, errors.
"""

import time
import pytest

from analyzer.proactive.healing.ai_telemetry import (
    AITelemetry,
    TimingBucket,
    ErrorCounter,
    get_telemetry,
)


class TestTimingBucket:
    def test_record_and_stats(self):
        b = TimingBucket(name="test_op")
        b.record(100.0)
        b.record(200.0)
        b.record(150.0)

        assert b.count == 3
        assert b.total_ms == 450.0
        assert b.avg_ms == 150.0
        assert b.min_ms == 100.0
        assert b.max_ms == 200.0

    def test_empty_bucket(self):
        b = TimingBucket(name="empty")
        assert b.count == 0
        assert b.avg_ms == 0.0

    def test_to_dict(self):
        b = TimingBucket(name="op")
        b.record(42.5)
        d = b.to_dict()
        assert d["name"] == "op"
        assert d["count"] == 1
        assert d["avg_ms"] == 42.5


class TestErrorCounter:
    def test_record_errors(self):
        ec = ErrorCounter()
        ec.record("timeout")
        ec.record("timeout")
        ec.record("connection")

        assert ec.total == 3
        d = ec.to_dict()
        assert d["by_type"]["timeout"] == 2
        assert d["by_type"]["connection"] == 1

    def test_empty_counter(self):
        ec = ErrorCounter()
        assert ec.total == 0


class TestAITelemetry:
    def test_timer_context_manager(self):
        tel = AITelemetry()
        with tel.timer("test_op"):
            time.sleep(0.01)

        snap = tel.snapshot()
        assert "test_op" in snap["timings"]
        assert snap["timings"]["test_op"]["count"] == 1
        assert snap["timings"]["test_op"]["avg_ms"] > 0

    def test_record_timing(self):
        tel = AITelemetry()
        tel.record_timing("manual", 55.5)
        tel.record_timing("manual", 44.5)

        snap = tel.snapshot()
        assert snap["timings"]["manual"]["count"] == 2
        assert snap["timings"]["manual"]["avg_ms"] == 50.0

    def test_counters(self):
        tel = AITelemetry()
        tel.count("detections")
        tel.count("detections")
        tel.count("fixes", 5)

        snap = tel.snapshot()
        assert snap["counters"]["detections"] == 2
        assert snap["counters"]["fixes"] == 5

    def test_errors(self):
        tel = AITelemetry()
        tel.error("timeout")
        tel.error("auth")
        tel.error("timeout")

        snap = tel.snapshot()
        assert snap["errors"]["total"] == 3
        assert snap["errors"]["by_type"]["timeout"] == 2
        assert snap["counters"]["total_errors"] == 3

    def test_reset(self):
        tel = AITelemetry()
        tel.count("foo")
        tel.error("bar")
        tel.reset()

        snap = tel.snapshot()
        assert snap["counters"] == {}
        assert snap["errors"]["total"] == 0
        assert snap["timings"] == {}

    def test_snapshot_has_uptime(self):
        tel = AITelemetry()
        time.sleep(0.01)
        snap = tel.snapshot()
        assert snap["uptime_seconds"] > 0

    def test_singleton(self):
        t1 = get_telemetry()
        t2 = get_telemetry()
        assert t1 is t2
