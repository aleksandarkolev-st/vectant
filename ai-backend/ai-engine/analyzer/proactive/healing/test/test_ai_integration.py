"""
test_ai_integration.py

Integration tests for the AI agent pipeline.

These tests mock the LLM provider but exercise the full pipeline:
  context collection → prompt building → (mock) LLM call →
  response parsing → confidence calibration → validation → output.

This verifies that all the pieces connect correctly.
"""

import asyncio
import json
import os
import tempfile
import pytest
from unittest.mock import AsyncMock, patch, MagicMock

from analyzer.proactive.healing.ai_agent import (
    AIHealingAgent,
    AIAgentConfig,
)
from analyzer.proactive.healing.ai_memory import AIAgentMemory
from analyzer.proactive.healing.ai_rate_limiter import (
    AsyncTokenBucket,
    RateLimiterConfig,
    RateLimitExceeded,
)
from analyzer.proactive.healing.ai_retry import with_retry, is_retryable_http_status


# ══════════════════════════════════════════════════════════════════════
# Helpers
# ══════════════════════════════════════════════════════════════════════

SAMPLE_PYTHON_CODE = """\
import os
import json

def get_user(user_id):
    users = {"alice": 1, "bob": 2}
    result = users.get(user_id)
    return result.upper()
"""

MOCK_DETECTION_RESPONSE = json.dumps([
    {
        "line": 7,
        "end_line": 7,
        "original": "    return result.upper()",
        "replacement": "    return result.upper() if result else None",
        "description": "result can be None when user_id is not found, calling .upper() on None raises AttributeError",
        "category": "null_safety",
        "severity": "high",
        "confidence": 0.88,
    }
])

MOCK_VALIDATION_RESPONSE = json.dumps({
    "is_valid": True,
    "confidence": 0.92,
    "reason": "The fix correctly handles the None case from dict.get()",
    "improved_replacement": None,
})


def make_mock_provider(detection_response=None, validation_response=None):
    """Create a mock LLM provider that returns canned responses."""
    provider = MagicMock()
    responses = []

    if detection_response is not None:
        responses.append(detection_response)
    if validation_response is not None:
        responses.append(validation_response)

    call_count = 0

    async def mock_ask_llm(**kwargs):
        nonlocal call_count
        idx = min(call_count, len(responses) - 1)
        call_count += 1
        return responses[idx] if responses else "[]"

    provider.ask_llm = mock_ask_llm
    return provider


# ══════════════════════════════════════════════════════════════════════
# Integration: Full pipeline
# ══════════════════════════════════════════════════════════════════════

class TestFullPipeline:
    """End-to-end tests for detect() with a mock LLM."""

    @pytest.fixture
    def agent(self):
        config = AIAgentConfig(
            validate_fixes=False,
            min_confidence=0.3,
            confidence_discount=0.85,
            llm_timeout=10.0,
        )
        agent = AIHealingAgent(config=config)
        # Use a fresh rate limiter to avoid cross-test contamination
        agent._provider = make_mock_provider(
            detection_response=MOCK_DETECTION_RESPONSE,
        )
        return agent

    @pytest.fixture
    def agent_with_validation(self):
        config = AIAgentConfig(
            validate_fixes=True,
            min_confidence=0.3,
            confidence_discount=0.85,
        )
        agent = AIHealingAgent(config=config)
        agent._provider = make_mock_provider(
            detection_response=MOCK_DETECTION_RESPONSE,
            validation_response=MOCK_VALIDATION_RESPONSE,
        )
        return agent

    def test_detect_finds_null_safety_issue(self, agent):
        fixes = asyncio.get_event_loop().run_until_complete(
            agent.detect(
                file_path="app/users.py",
                source_code=SAMPLE_PYTHON_CODE,
                language="python",
            )
        )

        assert len(fixes) >= 1
        fix = fixes[0]
        assert "null_safety" in fix.category.value.lower() or "null" in (fix.rule_id or "").lower()
        assert fix.confidence > 0
        assert fix.description
        assert fix.replacement_text is not None

    def test_detect_calibrates_confidence(self, agent):
        fixes = asyncio.get_event_loop().run_until_complete(
            agent.detect(
                file_path="app/users.py",
                source_code=SAMPLE_PYTHON_CODE,
                language="python",
            )
        )

        assert len(fixes) >= 1
        # Confidence should be discounted (0.88 × 0.85 ≈ 0.748)
        fix = fixes[0]
        assert fix.confidence < 0.88, "Confidence should be discounted"
        assert fix.confidence > 0.5, "But not too much"

    def test_detect_with_validation(self, agent_with_validation):
        fixes = asyncio.get_event_loop().run_until_complete(
            agent_with_validation.detect(
                file_path="app/users.py",
                source_code=SAMPLE_PYTHON_CODE,
                language="python",
            )
        )

        # Validation blends confidence, so result should differ from non-validated
        assert len(fixes) >= 1
        assert agent_with_validation.stats.total_detections == 1

    def test_detect_empty_code_returns_empty(self, agent):
        agent._provider = make_mock_provider(detection_response="[]")
        fixes = asyncio.get_event_loop().run_until_complete(
            agent.detect(
                file_path="empty.py",
                source_code="",
                language="python",
            )
        )
        assert fixes == []

    def test_detect_llm_failure_returns_empty(self, agent):
        """When the LLM returns None, detect() should return []."""
        agent._provider = make_mock_provider(detection_response=None)
        # Make ask_llm raise an exception
        async def failing_llm(**kwargs):
            raise ConnectionError("Network error")
        agent._provider.ask_llm = failing_llm

        fixes = asyncio.get_event_loop().run_until_complete(
            agent.detect(
                file_path="broken.py",
                source_code=SAMPLE_PYTHON_CODE,
                language="python",
            )
        )
        assert fixes == []
        assert agent.stats.total_llm_errors >= 1

    def test_detect_updates_stats(self, agent):
        asyncio.get_event_loop().run_until_complete(
            agent.detect(
                file_path="app/users.py",
                source_code=SAMPLE_PYTHON_CODE,
                language="python",
            )
        )

        assert agent.stats.total_detections == 1
        assert agent.stats.total_llm_calls >= 1
        assert agent.stats.total_latency_ms > 0


# ══════════════════════════════════════════════════════════════════════
# Integration: Batch detection
# ══════════════════════════════════════════════════════════════════════

class TestBatchPipeline:
    """Batch detection integration tests."""

    def test_batch_detect_multiple_files(self):
        batch_response = json.dumps({
            "app/users.py": [
                {
                    "line": 7,
                    "original": "    return result.upper()",
                    "replacement": "    return result.upper() if result else None",
                    "description": "Null safety",
                    "category": "null_safety",
                    "severity": "high",
                    "confidence": 0.85,
                }
            ],
            "app/utils.py": [],
        })

        config = AIAgentConfig(validate_fixes=False, min_confidence=0.3)
        agent = AIHealingAgent(config=config)
        agent._provider = make_mock_provider(detection_response=batch_response)

        results = asyncio.get_event_loop().run_until_complete(
            agent.detect_batch(
                files={
                    "app/users.py": SAMPLE_PYTHON_CODE,
                    "app/utils.py": "def add(a, b):\n    return a + b\n",
                },
                language="python",
            )
        )

        assert "app/users.py" in results
        assert len(results["app/users.py"]) >= 1


# ══════════════════════════════════════════════════════════════════════
# Rate limiter
# ══════════════════════════════════════════════════════════════════════

class TestRateLimiter:
    """Tests for the async token bucket."""

    def test_acquire_when_tokens_available(self):
        bucket = AsyncTokenBucket(RateLimiterConfig(max_tokens=5))
        result = bucket.try_acquire()
        assert result is True
        assert bucket.total_acquired == 1

    def test_acquire_depletes_bucket(self):
        bucket = AsyncTokenBucket(RateLimiterConfig(max_tokens=2, refill_rate=0.001))
        assert bucket.try_acquire() is True
        assert bucket.try_acquire() is True
        assert bucket.try_acquire() is False
        assert bucket.total_rejected == 1

    def test_async_acquire_waits(self):
        """Async acquire should wait for refill."""
        bucket = AsyncTokenBucket(RateLimiterConfig(
            max_tokens=1,
            refill_rate=100.0,  # very fast refill for testing
            wait_timeout=2.0,
        ))
        # Drain the bucket
        bucket.try_acquire()

        # Should succeed after a short wait
        asyncio.get_event_loop().run_until_complete(bucket.acquire())
        assert bucket.total_acquired == 2

    def test_async_acquire_timeout(self):
        """Should raise RateLimitExceeded on timeout."""
        bucket = AsyncTokenBucket(RateLimiterConfig(
            max_tokens=1,
            refill_rate=0.001,  # very slow refill
            wait_timeout=0.1,
        ))
        bucket.try_acquire()  # drain

        with pytest.raises(RateLimitExceeded):
            asyncio.get_event_loop().run_until_complete(bucket.acquire())

    def test_stats(self):
        bucket = AsyncTokenBucket(RateLimiterConfig(max_tokens=2))
        bucket.try_acquire()
        bucket.try_acquire()
        bucket.try_acquire()  # rejected

        stats = bucket.stats
        assert stats["total_acquired"] == 2
        assert stats["total_rejected"] == 1
        assert stats["max_tokens"] == 2

    def test_reset(self):
        bucket = AsyncTokenBucket(RateLimiterConfig(max_tokens=3))
        bucket.try_acquire()
        bucket.try_acquire()
        bucket.reset()

        assert bucket.total_acquired == 0
        assert bucket.available_tokens == 3.0


# ══════════════════════════════════════════════════════════════════════
# Retry logic
# ══════════════════════════════════════════════════════════════════════

class TestRetry:
    """Tests for the retry decorator."""

    def test_succeeds_on_first_try(self):
        call_count = 0

        async def success():
            nonlocal call_count
            call_count += 1
            return "ok"

        result = asyncio.get_event_loop().run_until_complete(
            with_retry(success, max_retries=2)
        )
        assert result == "ok"
        assert call_count == 1

    def test_retries_on_transient_failure(self):
        call_count = 0

        async def flaky():
            nonlocal call_count
            call_count += 1
            if call_count < 3:
                raise ConnectionError("Network down")
            return "recovered"

        result = asyncio.get_event_loop().run_until_complete(
            with_retry(flaky, max_retries=3, base_delay=0.01)
        )
        assert result == "recovered"
        assert call_count == 3

    def test_exhausts_retries(self):
        async def always_fail():
            raise TimeoutError("Always times out")

        with pytest.raises(TimeoutError):
            asyncio.get_event_loop().run_until_complete(
                with_retry(always_fail, max_retries=2, base_delay=0.01)
            )

    def test_does_not_retry_non_retryable(self):
        call_count = 0

        async def bad_input():
            nonlocal call_count
            call_count += 1
            raise ValueError("Bad input")

        with pytest.raises(ValueError):
            asyncio.get_event_loop().run_until_complete(
                with_retry(bad_input, max_retries=3, base_delay=0.01)
            )
        assert call_count == 1  # no retries for ValueError

    def test_on_retry_callback(self):
        retries = []

        async def flaky():
            if len(retries) < 1:
                raise ConnectionError("Oops")
            return "ok"

        def on_retry(attempt, exc, delay):
            retries.append((attempt, str(exc)))

        asyncio.get_event_loop().run_until_complete(
            with_retry(flaky, max_retries=2, base_delay=0.01, on_retry=on_retry)
        )
        assert len(retries) == 1
        assert "Oops" in retries[0][1]


class TestRetryableStatus:
    """Tests for is_retryable_http_status."""

    def test_retryable_codes(self):
        for code in [429, 500, 502, 503, 504]:
            assert is_retryable_http_status(code) is True

    def test_non_retryable_codes(self):
        for code in [200, 201, 400, 401, 403, 404]:
            assert is_retryable_http_status(code) is False


# ══════════════════════════════════════════════════════════════════════
# Memory integration
# ══════════════════════════════════════════════════════════════════════

class TestMemoryIntegration:
    """Test that memory affects agent behavior."""

    def test_suppressed_pattern_blocks_fix(self):
        """When a pattern is suppressed, the agent should skip it."""
        config = AIAgentConfig(
            validate_fixes=False,
            min_confidence=0.1,
            confidence_discount=1.0,  # no discount for clarity
        )
        agent = AIHealingAgent(config=config)
        agent._provider = make_mock_provider(
            detection_response=MOCK_DETECTION_RESPONSE,
        )

        # Suppress the rule
        memory = agent._memory
        for _ in range(5):
            memory.record_feedback("AI_NULL_SAFETY", "rejected")

        assert memory.is_suppressed("AI_NULL_SAFETY")

        # Now detect — should return 0 fixes because the pattern is suppressed
        fixes = asyncio.get_event_loop().run_until_complete(
            agent.detect(
                file_path="app/users.py",
                source_code=SAMPLE_PYTHON_CODE,
                language="python",
            )
        )

        assert len(fixes) == 0

    def test_accepted_pattern_boosts_confidence(self):
        """Accepted patterns should have higher confidence."""
        config = AIAgentConfig(
            validate_fixes=False,
            min_confidence=0.1,
            confidence_discount=1.0,
        )
        agent = AIHealingAgent(config=config)
        agent._provider = make_mock_provider(
            detection_response=MOCK_DETECTION_RESPONSE,
        )

        # Record acceptances
        memory = agent._memory
        for _ in range(5):
            memory.record_feedback("AI_NULL_SAFETY", "accepted")

        fixes = asyncio.get_event_loop().run_until_complete(
            agent.detect(
                file_path="app/users.py",
                source_code=SAMPLE_PYTHON_CODE,
                language="python",
            )
        )

        # With 100% acceptance rate, multiplier should be > 1.0
        assert len(fixes) >= 1
        # Original confidence was 0.88, with boost it should be higher
        assert fixes[0].confidence >= 0.88


# ══════════════════════════════════════════════════════════════════════
# Context collection integration
# ══════════════════════════════════════════════════════════════════════

class TestContextIntegration:
    """Test context collection in a real file system."""

    def test_detect_with_real_files(self):
        """Create a temp directory with related files and run detection."""
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create a Python file
            main_path = os.path.join(tmpdir, "main.py")
            with open(main_path, "w") as f:
                f.write(SAMPLE_PYTHON_CODE)

            # Create a related file
            utils_path = os.path.join(tmpdir, "utils.py")
            with open(utils_path, "w") as f:
                f.write("def helper():\n    return 42\n")

            config = AIAgentConfig(
                validate_fixes=False,
                min_confidence=0.1,
                use_cross_file_context=True,
            )
            agent = AIHealingAgent(config=config)
            agent._provider = make_mock_provider(
                detection_response=MOCK_DETECTION_RESPONSE,
            )

            fixes = asyncio.get_event_loop().run_until_complete(
                agent.detect(
                    file_path=main_path,
                    source_code=SAMPLE_PYTHON_CODE,
                    language="python",
                    workspace_root=tmpdir,
                )
            )

            assert len(fixes) >= 1
            assert agent.stats.total_detections == 1
