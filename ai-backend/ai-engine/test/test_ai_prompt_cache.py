"""
Tests for ai_prompt_cache.py — LRU cache, TTL, eviction, stats.
"""

import time
import pytest

from analyzer.proactive.healing.ai_prompt_cache import (
    AIPromptCache,
    get_prompt_cache,
)


class TestCacheBasics:
    def test_put_and_get(self):
        c = AIPromptCache()
        c.put("x = 1", "python", ["fix1"])
        result = c.get("x = 1", "python")
        assert result == ["fix1"]

    def test_miss_returns_none(self):
        c = AIPromptCache()
        assert c.get("unknown code", "python") is None

    def test_different_lang_is_separate_key(self):
        c = AIPromptCache()
        c.put("code", "python", ["py-fix"])
        c.put("code", "javascript", ["js-fix"])
        assert c.get("code", "python") == ["py-fix"]
        assert c.get("code", "javascript") == ["js-fix"]

    def test_focus_range_is_part_of_key(self):
        c = AIPromptCache()
        c.put("code", "py", ["full"], focus_range=None)
        c.put("code", "py", ["range"], focus_range=(5, 10))
        assert c.get("code", "py") == ["full"]
        assert c.get("code", "py", focus_range=(5, 10)) == ["range"]


class TestTTL:
    def test_expired_entry_is_miss(self):
        c = AIPromptCache(ttl_seconds=0.05)
        c.put("code", "py", ["fix"])
        time.sleep(0.06)
        assert c.get("code", "py") is None

    def test_fresh_entry_is_hit(self):
        c = AIPromptCache(ttl_seconds=10)
        c.put("code", "py", ["fix"])
        assert c.get("code", "py") == ["fix"]


class TestEviction:
    def test_evicts_oldest_when_over_max(self):
        c = AIPromptCache(max_entries=2)
        c.put("a", "py", [1])
        c.put("b", "py", [2])
        c.put("c", "py", [3])  # should evict "a"

        assert c.get("a", "py") is None
        assert c.get("b", "py") == [2]
        assert c.get("c", "py") == [3]
        assert c.size == 2


class TestInvalidateAndClear:
    def test_invalidate_single(self):
        c = AIPromptCache()
        c.put("code", "py", ["fix"])
        c.invalidate("code", "py")
        assert c.get("code", "py") is None

    def test_clear_all(self):
        c = AIPromptCache()
        c.put("a", "py", [1])
        c.put("b", "js", [2])
        c.clear()
        assert c.size == 0


class TestStats:
    def test_hit_and_miss_tracking(self):
        c = AIPromptCache()
        c.put("x", "py", ["fix"])
        c.get("x", "py")    # hit
        c.get("x", "py")    # hit
        c.get("nope", "py") # miss

        s = c.stats()
        assert s["hits"] == 2
        assert s["misses"] == 1
        assert s["hit_rate"] == pytest.approx(0.667, abs=0.01)
        assert s["entries"] == 1

    def test_empty_stats(self):
        c = AIPromptCache()
        s = c.stats()
        assert s["hits"] == 0
        assert s["hit_rate"] == 0.0


class TestSingleton:
    def test_singleton_returns_same(self):
        a = get_prompt_cache()
        b = get_prompt_cache()
        assert a is b
