"""
ai_prompt_cache.py — Short-lived LRU cache for AI detection results.

When the same file content is analysed twice within a short window
(e.g. user triggers analysis, then triggers again before editing),
we return the cached result instead of burning another LLM call.

Cache key = SHA-256(code + lang + focus_range).
Default TTL = 120 s.  Max entries = 64.
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass(slots=True)
class _CacheEntry:
    """One cached detection result."""
    key: str
    result: Any
    created_at: float
    hit_count: int = 0


class AIPromptCache:
    """Thread-safe LRU prompt cache with TTL expiry."""

    def __init__(self, max_entries: int = 64, ttl_seconds: float = 120.0):
        self._max = max_entries
        self._ttl = ttl_seconds
        self._store: Dict[str, _CacheEntry] = {}
        self._hits = 0
        self._misses = 0

    # ── Key construction ───────────────────────────────────────────

    @staticmethod
    def _make_key(code: str, lang: str, focus_range: Optional[tuple] = None) -> str:
        raw = f"{lang}:{focus_range}:{code}"
        return hashlib.sha256(raw.encode()).hexdigest()[:24]

    # ── Public API ─────────────────────────────────────────────────

    def get(
        self,
        code: str,
        lang: str,
        focus_range: Optional[tuple] = None,
    ) -> Optional[Any]:
        """Return cached result or None."""
        key = self._make_key(code, lang, focus_range)
        entry = self._store.get(key)
        if entry is None:
            self._misses += 1
            return None
        if time.time() - entry.created_at > self._ttl:
            del self._store[key]
            self._misses += 1
            return None
        entry.hit_count += 1
        self._hits += 1
        return entry.result

    def put(
        self,
        code: str,
        lang: str,
        result: Any,
        focus_range: Optional[tuple] = None,
    ) -> None:
        """Store a detection result."""
        key = self._make_key(code, lang, focus_range)
        self._store[key] = _CacheEntry(
            key=key,
            result=result,
            created_at=time.time(),
        )
        self._evict()

    def invalidate(self, code: str, lang: str) -> None:
        """Remove any cached entry for this code/lang."""
        key = self._make_key(code, lang)
        self._store.pop(key, None)

    def clear(self) -> None:
        """Flush the entire cache."""
        self._store.clear()

    # ── Stats ──────────────────────────────────────────────────────

    @property
    def size(self) -> int:
        return len(self._store)

    def stats(self) -> Dict[str, Any]:
        total = self._hits + self._misses
        return {
            "entries": self.size,
            "max_entries": self._max,
            "ttl_seconds": self._ttl,
            "hits": self._hits,
            "misses": self._misses,
            "hit_rate": round(self._hits / total, 3) if total else 0.0,
        }

    # ── Internal ───────────────────────────────────────────────────

    def _evict(self) -> None:
        """Evict oldest entries when over capacity."""
        while len(self._store) > self._max:
            oldest_key = min(
                self._store,
                key=lambda k: self._store[k].created_at,
            )
            del self._store[oldest_key]


# Module-level singleton
_cache_instance: Optional[AIPromptCache] = None


def get_prompt_cache() -> AIPromptCache:
    """Get or create the global prompt cache."""
    global _cache_instance
    if _cache_instance is None:
        _cache_instance = AIPromptCache()
    return _cache_instance
