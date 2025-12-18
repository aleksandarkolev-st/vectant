"""
Analysis cache using content-hash based caching.

This provides fast lookups for previously analyzed code,
avoiding redundant work when the same code is analyzed again.
"""

from __future__ import annotations

import asyncio
import hashlib
import time
from collections import OrderedDict
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from .types import AnalysisTier, TierResult


@dataclass
class CacheEntry:
    """A cached analysis result."""
    content_hash: str
    tier: AnalysisTier
    result: TierResult
    created_at: float
    access_count: int = 0
    last_accessed: float = 0.0
    
    def __post_init__(self):
        if self.last_accessed == 0.0:
            self.last_accessed = self.created_at


class AnalysisCache:
    """
    LRU cache for analysis results.
    
    Uses content-hash as the key, so identical code produces cache hits
    regardless of file path or timing.
    """
    
    def __init__(
        self,
        max_entries: int = 1000,
        max_age_seconds: float = 3600.0,  # 1 hour
        cleanup_interval: float = 300.0,   # 5 minutes
    ):
        self._max_entries = max_entries
        self._max_age_seconds = max_age_seconds
        self._cleanup_interval = cleanup_interval
        
        # LRU cache: (content_hash, tier) -> CacheEntry
        self._cache: OrderedDict[Tuple[str, AnalysisTier], CacheEntry] = OrderedDict()
        self._lock = asyncio.Lock()
        self._last_cleanup = time.time()
        
        # Statistics
        self._hits = 0
        self._misses = 0
    
    @staticmethod
    def compute_hash(content: str, language: str) -> str:
        """Compute content hash for caching."""
        key = f"{language}:{content}"
        return hashlib.sha256(key.encode()).hexdigest()[:24]
    
    async def get(
        self,
        content_hash: str,
        tier: AnalysisTier,
    ) -> Optional[TierResult]:
        """
        Get cached result if available and not expired.
        
        Returns None if not cached or expired.
        """
        async with self._lock:
            key = (content_hash, tier)
            entry = self._cache.get(key)
            
            if entry is None:
                self._misses += 1
                return None
            
            # Check if expired
            age = time.time() - entry.created_at
            if age > self._max_age_seconds:
                del self._cache[key]
                self._misses += 1
                return None
            
            # Update access statistics and move to end (LRU)
            entry.access_count += 1
            entry.last_accessed = time.time()
            self._cache.move_to_end(key)
            self._hits += 1
            
            # Mark as from cache
            cached_result = TierResult(
                tier=entry.result.tier,
                diagnostics=entry.result.diagnostics,
                elapsed_ms=entry.result.elapsed_ms,
                from_cache=True,
            )
            
            return cached_result
    
    async def put(
        self,
        content_hash: str,
        tier: AnalysisTier,
        result: TierResult,
    ) -> None:
        """Store a result in the cache."""
        async with self._lock:
            # Maybe run cleanup
            await self._maybe_cleanup()
            
            key = (content_hash, tier)
            now = time.time()
            
            entry = CacheEntry(
                content_hash=content_hash,
                tier=tier,
                result=result,
                created_at=now,
            )
            
            # Remove old entry if exists
            if key in self._cache:
                del self._cache[key]
            
            self._cache[key] = entry
            
            # Evict oldest if over limit
            while len(self._cache) > self._max_entries:
                self._cache.popitem(last=False)
    
    async def invalidate(self, content_hash: str) -> int:
        """
        Invalidate all cached results for a content hash.
        
        Returns number of entries removed.
        """
        async with self._lock:
            removed = 0
            keys_to_remove = [
                key for key in self._cache 
                if key[0] == content_hash
            ]
            for key in keys_to_remove:
                del self._cache[key]
                removed += 1
            return removed
    
    async def clear(self) -> None:
        """Clear all cached entries."""
        async with self._lock:
            self._cache.clear()
            self._hits = 0
            self._misses = 0
    
    async def _maybe_cleanup(self) -> None:
        """Run cleanup if enough time has passed."""
        now = time.time()
        if now - self._last_cleanup < self._cleanup_interval:
            return
        
        self._last_cleanup = now
        cutoff = now - self._max_age_seconds
        
        keys_to_remove = [
            key for key, entry in self._cache.items()
            if entry.created_at < cutoff
        ]
        
        for key in keys_to_remove:
            del self._cache[key]
    
    @property
    def stats(self) -> Dict[str, any]:
        """Get cache statistics."""
        total = self._hits + self._misses
        hit_rate = self._hits / total if total > 0 else 0.0
        return {
            "entries": len(self._cache),
            "hits": self._hits,
            "misses": self._misses,
            "hitRate": round(hit_rate, 3),
            "maxEntries": self._max_entries,
        }
