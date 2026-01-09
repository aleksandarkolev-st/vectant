"""
Context Tracker - Track what context has been shown to the AI.

Maintains state about:
- What chunks are in current context
- What has been shown in previous turns
- What the AI has referenced
- Token usage per turn
"""

from __future__ import annotations

import hashlib
import logging
from dataclasses import dataclass, field
from datetime import datetime
from typing import Dict, List, Optional, Set, Tuple

from ..core.types import SemanticChunk


logger = logging.getLogger("code_intel.eviction.tracker")


@dataclass
class ChunkHistory:
    """History of a chunk in context."""
    
    chunk_id: str
    file_path: str
    symbol_name: Optional[str]
    
    # When it was in context
    turns_present: List[int] = field(default_factory=list)
    first_shown: Optional[int] = None
    last_shown: Optional[int] = None
    
    # Usage tracking
    times_referenced: int = 0
    last_referenced: Optional[int] = None
    
    # Token cost
    estimated_tokens: int = 0
    
    # Importance
    importance_score: float = 0.0


@dataclass
class TurnState:
    """State of context at a specific turn."""
    
    turn_number: int
    timestamp: datetime
    
    # What was in context
    chunk_ids: Set[str] = field(default_factory=set)
    file_paths: Set[str] = field(default_factory=set)
    symbols: Set[str] = field(default_factory=set)
    
    # Token budget
    total_tokens: int = 0
    code_tokens: int = 0
    summary_tokens: int = 0
    
    # User intent
    query_hash: str = ""
    intent: str = ""


@dataclass
class ContextState:
    """Current and historical context state."""
    
    current_turn: int = 0
    
    # Current context
    current_chunks: Dict[str, SemanticChunk] = field(default_factory=dict)
    current_tokens: int = 0
    
    # History
    chunk_history: Dict[str, ChunkHistory] = field(default_factory=dict)
    turn_states: List[TurnState] = field(default_factory=list)
    
    # Pinned items
    pinned_chunks: Set[str] = field(default_factory=set)
    
    # Budget
    max_tokens: int = 8000
    
    def get_chunk_age(self, chunk_id: str) -> int:
        """Get how many turns ago a chunk was last shown."""
        history = self.chunk_history.get(chunk_id)
        if not history or history.last_shown is None:
            return float('inf')
        return self.current_turn - history.last_shown
    
    def get_chunk_frequency(self, chunk_id: str) -> int:
        """Get how many turns a chunk has been present."""
        history = self.chunk_history.get(chunk_id)
        if not history:
            return 0
        return len(history.turns_present)


class ContextTracker:
    """
    Track context state across conversation turns.
    
    Responsibilities:
    - Track what context is currently visible
    - Record context history per turn
    - Track chunk references by the AI
    - Compute importance scores
    """
    
    def __init__(
        self,
        max_tokens: int = 8000,
        max_history_turns: int = 20,
    ):
        self.state = ContextState(max_tokens=max_tokens)
        self.max_history_turns = max_history_turns
    
    def start_turn(
        self,
        query: str,
        intent: str = "",
    ) -> int:
        """
        Start a new conversation turn.
        
        Args:
            query: User's query
            intent: Detected intent
            
        Returns:
            Turn number
        """
        self.state.current_turn += 1
        
        # Create turn state
        turn_state = TurnState(
            turn_number=self.state.current_turn,
            timestamp=datetime.now(),
            query_hash=hashlib.md5(query.encode()).hexdigest()[:8],
            intent=intent,
        )
        
        self.state.turn_states.append(turn_state)
        
        # Prune old history
        if len(self.state.turn_states) > self.max_history_turns:
            self.state.turn_states = self.state.turn_states[-self.max_history_turns:]
        
        logger.debug(f"Started turn {self.state.current_turn}")
        return self.state.current_turn
    
    def set_context(
        self,
        chunks: List[SemanticChunk],
        total_tokens: int = 0,
    ) -> None:
        """
        Set the current context.
        
        Args:
            chunks: Chunks in current context
            total_tokens: Total token count
        """
        # Clear current context
        self.state.current_chunks = {}
        self.state.current_tokens = total_tokens
        
        # Update current turn state
        if self.state.turn_states:
            turn_state = self.state.turn_states[-1]
            turn_state.total_tokens = total_tokens
        
        # Add chunks
        for chunk in chunks:
            self._add_chunk_to_context(chunk)
    
    def _add_chunk_to_context(self, chunk: SemanticChunk) -> None:
        """Add a chunk to current context."""
        chunk_id = chunk.id
        
        # Add to current context
        self.state.current_chunks[chunk_id] = chunk
        
        # Update turn state
        if self.state.turn_states:
            turn_state = self.state.turn_states[-1]
            turn_state.chunk_ids.add(chunk_id)
            turn_state.file_paths.add(chunk.file_path)
            if chunk.symbol_name:
                turn_state.symbols.add(chunk.symbol_name)
        
        # Update history
        if chunk_id not in self.state.chunk_history:
            self.state.chunk_history[chunk_id] = ChunkHistory(
                chunk_id=chunk_id,
                file_path=chunk.file_path,
                symbol_name=chunk.symbol_name,
                first_shown=self.state.current_turn,
                estimated_tokens=self._estimate_tokens(chunk),
            )
        
        history = self.state.chunk_history[chunk_id]
        history.turns_present.append(self.state.current_turn)
        history.last_shown = self.state.current_turn
    
    def record_reference(
        self,
        chunk_id: str,
    ) -> None:
        """
        Record that the AI referenced a chunk.
        
        Call this when the AI mentions or uses a piece of code.
        """
        if chunk_id in self.state.chunk_history:
            history = self.state.chunk_history[chunk_id]
            history.times_referenced += 1
            history.last_referenced = self.state.current_turn
            history.importance_score += 0.1  # Boost importance
    
    def record_symbol_reference(
        self,
        symbol_name: str,
    ) -> None:
        """Record reference to a symbol by name."""
        # Find chunk with this symbol
        for chunk_id, history in self.state.chunk_history.items():
            if history.symbol_name == symbol_name:
                self.record_reference(chunk_id)
                break
    
    def get_current_context(self) -> List[SemanticChunk]:
        """Get chunks in current context."""
        return list(self.state.current_chunks.values())
    
    def get_context_summary(self) -> Dict:
        """Get summary of current context state."""
        current = self.state.turn_states[-1] if self.state.turn_states else None
        
        return {
            "turn": self.state.current_turn,
            "chunks": len(self.state.current_chunks),
            "files": len(current.file_paths) if current else 0,
            "symbols": len(current.symbols) if current else 0,
            "tokens": self.state.current_tokens,
            "pinned": len(self.state.pinned_chunks),
        }
    
    def was_in_context(
        self,
        chunk_id: str,
        turns_ago: Optional[int] = None,
    ) -> bool:
        """Check if a chunk was in context."""
        history = self.state.chunk_history.get(chunk_id)
        if not history:
            return False
        
        if turns_ago is None:
            return len(history.turns_present) > 0
        
        target_turn = self.state.current_turn - turns_ago
        return target_turn in history.turns_present
    
    def get_eviction_candidates(self) -> List[str]:
        """
        Get chunks that could be evicted.
        
        Returns chunk IDs sorted by eviction priority
        (highest priority to evict first).
        """
        candidates = []
        
        for chunk_id in self.state.current_chunks:
            # Skip pinned chunks
            if chunk_id in self.state.pinned_chunks:
                continue
            
            history = self.state.chunk_history.get(chunk_id)
            if not history:
                continue
            
            # Compute eviction score (higher = more evictable)
            score = self._compute_eviction_score(history)
            candidates.append((chunk_id, score))
        
        # Sort by score (highest first)
        candidates.sort(key=lambda x: x[1], reverse=True)
        
        return [chunk_id for chunk_id, _ in candidates]
    
    def _compute_eviction_score(self, history: ChunkHistory) -> float:
        """
        Compute eviction score for a chunk.
        
        Higher score = more suitable for eviction.
        """
        score = 0.0
        
        # Age factor (older = more evictable)
        age = self.state.current_turn - (history.last_shown or 0)
        score += min(age * 0.2, 1.0)
        
        # Reference factor (less referenced = more evictable)
        if history.times_referenced == 0:
            score += 0.5
        else:
            score -= min(history.times_referenced * 0.1, 0.5)
        
        # Frequency factor (less frequent = more evictable)
        frequency = len(history.turns_present)
        if frequency <= 1:
            score += 0.3
        
        # Importance factor
        score -= history.importance_score
        
        return max(0.0, score)
    
    def _estimate_tokens(self, chunk: SemanticChunk) -> int:
        """Estimate tokens for a chunk."""
        total = 0
        if chunk.signature:
            total += len(chunk.signature) // 4
        if chunk.docstring:
            total += len(chunk.docstring) // 4
        if chunk.code_body:
            total += len(chunk.code_body) // 4
        return total + 20  # Overhead
    
    def pin(self, chunk_id: str) -> None:
        """Pin a chunk to prevent eviction."""
        self.state.pinned_chunks.add(chunk_id)
    
    def unpin(self, chunk_id: str) -> None:
        """Unpin a chunk."""
        self.state.pinned_chunks.discard(chunk_id)
    
    def is_pinned(self, chunk_id: str) -> bool:
        """Check if a chunk is pinned."""
        return chunk_id in self.state.pinned_chunks
    
    def export_state(self) -> Dict:
        """Export state for persistence."""
        return {
            "current_turn": self.state.current_turn,
            "pinned_chunks": list(self.state.pinned_chunks),
            "chunk_history": {
                chunk_id: {
                    "chunk_id": h.chunk_id,
                    "file_path": h.file_path,
                    "symbol_name": h.symbol_name,
                    "turns_present": h.turns_present,
                    "times_referenced": h.times_referenced,
                    "importance_score": h.importance_score,
                }
                for chunk_id, h in self.state.chunk_history.items()
            },
        }
    
    def import_state(self, data: Dict) -> None:
        """Import state from persistence."""
        self.state.current_turn = data.get("current_turn", 0)
        self.state.pinned_chunks = set(data.get("pinned_chunks", []))
        
        for chunk_id, h_data in data.get("chunk_history", {}).items():
            self.state.chunk_history[chunk_id] = ChunkHistory(
                chunk_id=h_data["chunk_id"],
                file_path=h_data["file_path"],
                symbol_name=h_data.get("symbol_name"),
                turns_present=h_data.get("turns_present", []),
                times_referenced=h_data.get("times_referenced", 0),
                importance_score=h_data.get("importance_score", 0.0),
            )
