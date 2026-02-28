"""
Tests for ai_streaming.py — SSE event generation.

We mock the AIHealingAgent.detect() call so no real LLM is needed.
"""

import asyncio
import json
import pytest
from unittest.mock import AsyncMock, patch, MagicMock

from analyzer.proactive.healing.ai_streaming import stream_ai_analysis
from analyzer.proactive.healing.types import (
    HealingFix,
    HealingCategory,
    HealingSeverity,
    HealingAction,
)


def _make_fix(line=0, desc="test fix"):
    return HealingFix(
        category=HealingCategory.TRAILING_WHITESPACE,
        severity=HealingSeverity.LOW,
        action=HealingAction.REPLACE,
        description=desc,
        line=line,
        column=0,
        end_line=line,
        end_column=10,
        original_text="x = 1   ",
        replacement_text="x = 1",
        confidence=0.85,
        is_safe=True,
        affects_logic=False,
        rule_id="AI_TEST",
    )


def _parse_sse_events(raw_lines):
    """Parse SSE strings into event dicts."""
    events = []
    for line in raw_lines:
        if line.startswith("data: "):
            payload = json.loads(line[len("data: "):].strip())
            events.append(payload)
    return events


async def _collect_stream(gen):
    """Collect all yielded strings from an async generator."""
    result = []
    async for chunk in gen:
        result.append(chunk)
    return result


class TestStreamAIAnalysis:
    @pytest.mark.asyncio
    async def test_emits_progress_and_complete(self):
        """Stream should emit progress events + complete event."""
        mock_fixes = [_make_fix(0, "issue A"), _make_fix(5, "issue B")]

        with patch(
            "analyzer.proactive.healing.ai_streaming.AIHealingAgent"
        ) as MockAgent:
            instance = MockAgent.return_value
            instance.detect = AsyncMock(return_value=mock_fixes)
            instance.get_stats = MagicMock(return_value={"total_detections": 1})

            raw = await _collect_stream(
                stream_ai_analysis("x = 1\n", "python", "test.py")
            )

        events = _parse_sse_events(raw)

        # Should have progress events
        progress_events = [e for e in events if e["event"] == "progress"]
        assert len(progress_events) >= 4  # context, context_done, detecting, detection_done, finalizing, done

        # Should have partial_fix events
        partial_events = [e for e in events if e["event"] == "partial_fix"]
        assert len(partial_events) == 2

        # Should have a complete event
        complete_events = [e for e in events if e["event"] == "complete"]
        assert len(complete_events) == 1
        assert complete_events[0]["data"]["fixCount"] == 2

    @pytest.mark.asyncio
    async def test_no_fixes_still_completes(self):
        """Stream should complete gracefully with zero fixes."""
        with patch(
            "analyzer.proactive.healing.ai_streaming.AIHealingAgent"
        ) as MockAgent:
            instance = MockAgent.return_value
            instance.detect = AsyncMock(return_value=[])
            instance.get_stats = MagicMock(return_value={})

            raw = await _collect_stream(
                stream_ai_analysis("x = 1\n", "python")
            )

        events = _parse_sse_events(raw)
        complete = [e for e in events if e["event"] == "complete"]
        assert len(complete) == 1
        assert complete[0]["data"]["fixCount"] == 0

    @pytest.mark.asyncio
    async def test_detection_error_emits_error_event(self):
        """If the agent raises, stream should emit an error event."""
        with patch(
            "analyzer.proactive.healing.ai_streaming.AIHealingAgent"
        ) as MockAgent:
            instance = MockAgent.return_value
            instance.detect = AsyncMock(side_effect=RuntimeError("LLM timeout"))

            raw = await _collect_stream(
                stream_ai_analysis("code", "python")
            )

        events = _parse_sse_events(raw)
        error_events = [e for e in events if e["event"] == "error"]
        assert len(error_events) == 1
        assert "LLM timeout" in error_events[0]["data"]["message"]

    @pytest.mark.asyncio
    async def test_context_error_emits_error_event(self):
        """If context collection fails, should emit an error event."""
        with patch(
            "analyzer.proactive.healing.ai_streaming.collect_context",
            side_effect=ValueError("bad context"),
        ):
            raw = await _collect_stream(
                stream_ai_analysis("code", "python")
            )

        events = _parse_sse_events(raw)
        error_events = [e for e in events if e["event"] == "error"]
        assert len(error_events) == 1
        assert "bad context" in error_events[0]["data"]["message"]

    @pytest.mark.asyncio
    async def test_complete_includes_elapsed_ms(self):
        """Complete event should include elapsed time."""
        with patch(
            "analyzer.proactive.healing.ai_streaming.AIHealingAgent"
        ) as MockAgent:
            instance = MockAgent.return_value
            instance.detect = AsyncMock(return_value=[])
            instance.get_stats = MagicMock(return_value={})

            raw = await _collect_stream(
                stream_ai_analysis("x", "py")
            )

        events = _parse_sse_events(raw)
        complete = [e for e in events if e["event"] == "complete"][0]
        assert "elapsedMs" in complete["data"]
        assert complete["data"]["elapsedMs"] >= 0
