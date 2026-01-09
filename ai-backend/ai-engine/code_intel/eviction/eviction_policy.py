"""
Eviction Policies - Strategies for context eviction.

When the token budget is exceeded, we need to decide
which chunks to remove. Different policies suit different
use cases.
"""

from __future__ import annotations

import logging
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Dict, List, Optional, Set

from ..core.types import SemanticChunk
from .context_tracker import ContextTracker, ChunkHistory


logger = logging.getLogger("code_intel.eviction.policy")


@dataclass
class EvictionResult:
    """Result of an eviction operation."""
    
    evicted_chunk_ids: List[str]
    tokens_freed: int
    reason: str


class EvictionPolicy(ABC):
    """Base class for eviction policies."""
    
    @abstractmethod
    def select_for_eviction(
        self,
        tracker: ContextTracker,
        tokens_to_free: int,
    ) -> List[str]:
        """
        Select chunks for eviction.
        
        Args:
            tracker: Context tracker with state
            tokens_to_free: How many tokens we need to free
            
        Returns:
            List of chunk IDs to evict
        """
        pass
    
    def evict(
        self,
        tracker: ContextTracker,
        tokens_to_free: int,
    ) -> EvictionResult:
        """
        Perform eviction.
        
        Args:
            tracker: Context tracker
            tokens_to_free: Tokens needed
            
        Returns:
            EvictionResult
        """
        selected = self.select_for_eviction(tracker, tokens_to_free)
        
        tokens_freed = 0
        evicted = []
        
        for chunk_id in selected:
            if chunk_id in tracker.state.current_chunks:
                chunk = tracker.state.current_chunks[chunk_id]
                history = tracker.state.chunk_history.get(chunk_id)
                
                tokens = history.estimated_tokens if history else 100
                tokens_freed += tokens
                
                del tracker.state.current_chunks[chunk_id]
                evicted.append(chunk_id)
                
                if tokens_freed >= tokens_to_free:
                    break
        
        return EvictionResult(
            evicted_chunk_ids=evicted,
            tokens_freed=tokens_freed,
            reason=self.__class__.__name__,
        )


class LRUEviction(EvictionPolicy):
    """
    Least Recently Used eviction.
    
    Evict chunks that haven't been shown recently.
    """
    
    def select_for_eviction(
        self,
        tracker: ContextTracker,
        tokens_to_free: int,
    ) -> List[str]:
        """Select least recently used chunks."""
        # Get all chunks with their last shown turn
        chunks_by_age = []
        
        for chunk_id in tracker.state.current_chunks:
            # Skip pinned
            if tracker.is_pinned(chunk_id):
                continue
            
            history = tracker.state.chunk_history.get(chunk_id)
            if history:
                last_shown = history.last_shown or 0
                chunks_by_age.append((chunk_id, last_shown, history.estimated_tokens))
        
        # Sort by last shown (oldest first)
        chunks_by_age.sort(key=lambda x: x[1])
        
        # Select enough to free required tokens
        selected = []
        tokens_accumulated = 0
        
        for chunk_id, _, tokens in chunks_by_age:
            selected.append(chunk_id)
            tokens_accumulated += tokens
            
            if tokens_accumulated >= tokens_to_free:
                break
        
        return selected


class ImportanceEviction(EvictionPolicy):
    """
    Importance-based eviction.
    
    Evict chunks with lowest importance scores.
    Importance is based on:
    - How often referenced by AI
    - How recently referenced
    - Explicit importance boosts
    """
    
    def __init__(
        self,
        recency_weight: float = 0.3,
        reference_weight: float = 0.4,
        frequency_weight: float = 0.3,
    ):
        self.recency_weight = recency_weight
        self.reference_weight = reference_weight
        self.frequency_weight = frequency_weight
    
    def select_for_eviction(
        self,
        tracker: ContextTracker,
        tokens_to_free: int,
    ) -> List[str]:
        """Select least important chunks."""
        chunks_by_importance = []
        
        for chunk_id in tracker.state.current_chunks:
            # Skip pinned
            if tracker.is_pinned(chunk_id):
                continue
            
            history = tracker.state.chunk_history.get(chunk_id)
            if not history:
                continue
            
            importance = self._compute_importance(history, tracker)
            chunks_by_importance.append((
                chunk_id,
                importance,
                history.estimated_tokens,
            ))
        
        # Sort by importance (lowest first)
        chunks_by_importance.sort(key=lambda x: x[1])
        
        # Select enough to free required tokens
        selected = []
        tokens_accumulated = 0
        
        for chunk_id, _, tokens in chunks_by_importance:
            selected.append(chunk_id)
            tokens_accumulated += tokens
            
            if tokens_accumulated >= tokens_to_free:
                break
        
        return selected
    
    def _compute_importance(
        self,
        history: ChunkHistory,
        tracker: ContextTracker,
    ) -> float:
        """Compute importance score for a chunk."""
        # Recency score (0-1, higher = more recent)
        current_turn = tracker.state.current_turn
        last_shown = history.last_shown or 0
        age = current_turn - last_shown
        recency = max(0, 1 - (age * 0.1))
        
        # Reference score (0-1, higher = more referenced)
        reference = min(1.0, history.times_referenced * 0.2)
        
        # Frequency score (0-1, higher = more frequent)
        frequency = min(1.0, len(history.turns_present) * 0.1)
        
        # Combine scores
        importance = (
            self.recency_weight * recency +
            self.reference_weight * reference +
            self.frequency_weight * frequency +
            history.importance_score
        )
        
        return importance


class FIFOEviction(EvictionPolicy):
    """
    First In First Out eviction.
    
    Evict chunks in the order they were first shown.
    """
    
    def select_for_eviction(
        self,
        tracker: ContextTracker,
        tokens_to_free: int,
    ) -> List[str]:
        """Select first-shown chunks."""
        chunks_by_first = []
        
        for chunk_id in tracker.state.current_chunks:
            if tracker.is_pinned(chunk_id):
                continue
            
            history = tracker.state.chunk_history.get(chunk_id)
            if history:
                first_shown = history.first_shown or 0
                chunks_by_first.append((chunk_id, first_shown, history.estimated_tokens))
        
        # Sort by first shown (oldest first)
        chunks_by_first.sort(key=lambda x: x[1])
        
        selected = []
        tokens_accumulated = 0
        
        for chunk_id, _, tokens in chunks_by_first:
            selected.append(chunk_id)
            tokens_accumulated += tokens
            
            if tokens_accumulated >= tokens_to_free:
                break
        
        return selected


class HybridEviction(EvictionPolicy):
    """
    Hybrid eviction combining multiple strategies.
    
    Uses a weighted combination of LRU and importance.
    """
    
    def __init__(
        self,
        lru_weight: float = 0.4,
        importance_weight: float = 0.6,
    ):
        self.lru_weight = lru_weight
        self.importance_weight = importance_weight
        self.lru = LRUEviction()
        self.importance = ImportanceEviction()
    
    def select_for_eviction(
        self,
        tracker: ContextTracker,
        tokens_to_free: int,
    ) -> List[str]:
        """Select chunks using hybrid scoring."""
        chunks_by_score = []
        current_turn = tracker.state.current_turn
        
        for chunk_id in tracker.state.current_chunks:
            if tracker.is_pinned(chunk_id):
                continue
            
            history = tracker.state.chunk_history.get(chunk_id)
            if not history:
                continue
            
            # LRU score (higher = older = more evictable)
            age = current_turn - (history.last_shown or 0)
            lru_score = min(1.0, age * 0.1)
            
            # Importance score (lower importance = more evictable)
            importance_score = self.importance._compute_importance(history, tracker)
            evict_importance = 1 - importance_score
            
            # Combined score (higher = more evictable)
            combined = (
                self.lru_weight * lru_score +
                self.importance_weight * evict_importance
            )
            
            chunks_by_score.append((
                chunk_id,
                combined,
                history.estimated_tokens,
            ))
        
        # Sort by combined score (highest first = most evictable)
        chunks_by_score.sort(key=lambda x: x[1], reverse=True)
        
        selected = []
        tokens_accumulated = 0
        
        for chunk_id, _, tokens in chunks_by_score:
            selected.append(chunk_id)
            tokens_accumulated += tokens
            
            if tokens_accumulated >= tokens_to_free:
                break
        
        return selected


def get_default_policy() -> EvictionPolicy:
    """Get the default eviction policy."""
    return HybridEviction()
