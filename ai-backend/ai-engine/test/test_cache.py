"""
Unit tests for the healing result cache.
"""

import time
import pytest
from analyzer.proactive.healing.cache import HealingCache
from analyzer.proactive.healing.types import HealingResult


class TestHealingCache:
    def setup_method(self):
        self.cache = HealingCache(max_size=5, ttl_seconds=2.0)

    def _make_result(self, file_path="test.py", language="python", content_hash="abc123"):
        return HealingResult(
            file_path=file_path,
            language=language,
            content_hash=content_hash,
        )

    def test_put_and_get(self):
        result = self._make_result()
        self.cache.put(result)
        cached = self.cache.get("abc123", "python")
        assert cached is not None
        assert cached.file_path == "test.py"

    def test_cache_miss(self):
        cached = self.cache.get("nonexistent", "python")
        assert cached is None

    def test_lru_eviction(self):
        # Fill cache to capacity
        for i in range(5):
            self.cache.put(self._make_result(content_hash=f"hash_{i}"))

        # All should be present
        for i in range(5):
            assert self.cache.get(f"hash_{i}", "python") is not None

        # Add one more — should evict the least recently used
        self.cache.put(self._make_result(content_hash="hash_new"))
        assert self.cache.size == 5
        # hash_0 was LRU (hash_1-4 were accessed in get loop above)

    def test_ttl_expiry(self):
        result = self._make_result()
        self.cache.put(result)
        time.sleep(2.5)  # Wait for TTL
        cached = self.cache.get("abc123", "python")
        assert cached is None

    def test_invalidate(self):
        result = self._make_result()
        self.cache.put(result)
        removed = self.cache.invalidate("abc123", "python")
        assert removed is True
        assert self.cache.get("abc123", "python") is None

    def test_invalidate_file(self):
        self.cache.put(self._make_result(content_hash="h1", file_path="a.py"))
        self.cache.put(self._make_result(content_hash="h2", file_path="a.py"))
        self.cache.put(self._make_result(content_hash="h3", file_path="b.py"))

        count = self.cache.invalidate_file("a.py")
        assert count == 2
        assert self.cache.size == 1

    def test_clear(self):
        self.cache.put(self._make_result(content_hash="h1"))
        self.cache.put(self._make_result(content_hash="h2"))
        self.cache.clear()
        assert self.cache.size == 0

    def test_hit_rate(self):
        self.cache.put(self._make_result())
        self.cache.get("abc123", "python")  # hit
        self.cache.get("abc123", "python")  # hit
        self.cache.get("missing", "python")  # miss
        assert self.cache.hit_rate == pytest.approx(2 / 3, abs=0.01)

    def test_stats(self):
        stats = self.cache.stats
        assert "size" in stats
        assert "maxSize" in stats
        assert "hits" in stats
        assert "misses" in stats
        assert "hitRate" in stats
        assert "ttlSeconds" in stats

    def test_evict_expired(self):
        self.cache = HealingCache(max_size=10, ttl_seconds=0.5)
        self.cache.put(self._make_result(content_hash="h1"))
        self.cache.put(self._make_result(content_hash="h2"))
        time.sleep(0.6)
        evicted = self.cache.evict_expired()
        assert evicted == 2
        assert self.cache.size == 0
