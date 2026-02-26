"""
Healing result cache.

An LRU-style cache that stores analysis results keyed on
content hash + language. Prevents re-analysing identical content
when the user hasn't changed the file.
"""

from __future__ import annotations

import time
import threading
from collections import OrderedDict
from dataclasses import dataclass
from typing import Optional

from .types import HealingResult

import logging

logger = logging.getLogger("healing.cache")


@dataclass
class CacheEntry:
    """Single cached result."""
    result: HealingResult
    created_at: float
    access_count: int = 0


class HealingCache:
    """
    LRU cache for healing analysis results.

    Cache key = f"{content_hash}:{language}"
    Thread-safe via a reentrant lock.
    """

    def __init__(self, max_size: int = 256, ttl_seconds: float = 300.0):
        self._max_size = max_size
        self._ttl = ttl_seconds
        self._store: OrderedDict[str, CacheEntry] = OrderedDict()
        self._lock = threading.RLock()
        self._hits = 0
        self._misses = 0

    # ── Public API ────────────────────────────────────────────────────

    def get(self, content_hash: str, language: str) -> Optional[HealingResult]:
        """Retrieve a cached result, or None if not present / expired."""
        key = self._make_key(content_hash, language)
        with self._lock:
            entry = self._store.get(key)
            if entry is None:
                self._misses += 1
                return None

            # Check TTL
            if time.time() - entry.created_at > self._ttl:
                del self._store[key]
                self._misses += 1
                return None

            # LRU: move to end
            self._store.move_to_end(key)
            entry.access_count += 1
            self._hits += 1
            return entry.result

    def put(self, result: HealingResult) -> None:
        """Store a result in the cache."""
        key = self._make_key(result.content_hash, result.language)
        with self._lock:
            if key in self._store:
                self._store.move_to_end(key)
                self._store[key] = CacheEntry(result=result, created_at=time.time())
            else:
                self._store[key] = CacheEntry(result=result, created_at=time.time())
                if len(self._store) > self._max_size:
                    self._store.popitem(last=False)

    def invalidate(self, content_hash: str, language: str) -> bool:
        """Remove a specific entry. Returns True if it existed."""
        key = self._make_key(content_hash, language)
        with self._lock:
            if key in self._store:
                del self._store[key]
                return True
            return False

    def invalidate_file(self, file_path: str) -> int:
        """Remove all entries for a given file path."""
        with self._lock:
            to_remove = [
                k for k, v in self._store.items()
                if v.result.file_path == file_path
            ]
            for k in to_remove:
                del self._store[k]
            return len(to_remove)

    def clear(self) -> None:
        """Clear all cached entries."""
        with self._lock:
            self._store.clear()
            self._hits = 0
            self._misses = 0

    def evict_expired(self) -> int:
        """Remove all expired entries. Returns number evicted."""
        now = time.time()
        with self._lock:
            expired = [
                k for k, v in self._store.items()
                if now - v.created_at > self._ttl
            ]
            for k in expired:
                del self._store[k]
            return len(expired)

    # ── Stats ─────────────────────────────────────────────────────────

    @property
    def size(self) -> int:
        return len(self._store)

    @property
    def hit_rate(self) -> float:
        total = self._hits + self._misses
        return self._hits / total if total > 0 else 0.0

    @property
    def stats(self) -> dict:
        return {
            "size": self.size,
            "maxSize": self._max_size,
            "hits": self._hits,
            "misses": self._misses,
            "hitRate": round(self.hit_rate, 3),
            "ttlSeconds": self._ttl,
        }

    # ── Internal ──────────────────────────────────────────────────────

    @staticmethod
    def _make_key(content_hash: str, language: str) -> str:
        return f"{content_hash}:{language.lower()}"
