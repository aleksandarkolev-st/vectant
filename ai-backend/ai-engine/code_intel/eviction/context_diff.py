"""
Context Diff - Track and communicate context changes.

When context changes between turns, the AI should know:
- What was added
- What was removed
- What changed

This prevents confusion when the AI references code
that's no longer visible.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

from ..core.types import SemanticChunk


logger = logging.getLogger("code_intel.eviction.diff")


@dataclass
class ChunkChange:
    """A change to a specific chunk."""
    
    chunk_id: str
    file_path: str
    symbol_name: Optional[str]
    change_type: str  # "added", "removed", "modified"
    reason: str = ""  # Why it changed


@dataclass
class ContextDiff:
    """Diff between two context states."""
    
    # Changes
    added: List[ChunkChange] = field(default_factory=list)
    removed: List[ChunkChange] = field(default_factory=list)
    modified: List[ChunkChange] = field(default_factory=list)
    
    # Summary
    files_added: Set[str] = field(default_factory=set)
    files_removed: Set[str] = field(default_factory=set)
    
    # Statistics
    tokens_added: int = 0
    tokens_removed: int = 0
    net_tokens: int = 0
    
    @property
    def has_changes(self) -> bool:
        """Check if there are any changes."""
        return bool(self.added or self.removed or self.modified)
    
    def to_notification(self) -> str:
        """
        Generate a notification string about context changes.
        
        This can be injected into the context to inform the AI.
        """
        if not self.has_changes:
            return ""
        
        lines = ["**Context Update:**"]
        
        if self.added:
            lines.append(f"- Added {len(self.added)} code section(s)")
            for change in self.added[:3]:
                name = change.symbol_name or change.file_path.split("/")[-1]
                lines.append(f"  + {name}")
            if len(self.added) > 3:
                lines.append(f"  ... and {len(self.added) - 3} more")
        
        if self.removed:
            lines.append(f"- Removed {len(self.removed)} code section(s)")
            for change in self.removed[:3]:
                name = change.symbol_name or change.file_path.split("/")[-1]
                lines.append(f"  - {name}")
            if len(self.removed) > 3:
                lines.append(f"  ... and {len(self.removed) - 3} more")
        
        if self.files_removed:
            lines.append(f"- Files no longer in context: {', '.join(list(self.files_removed)[:3])}")
        
        return "\n".join(lines)
    
    def get_removed_symbols(self) -> List[str]:
        """Get names of symbols that were removed."""
        return [
            c.symbol_name for c in self.removed
            if c.symbol_name
        ]


def diff_contexts(
    old_chunks: Dict[str, SemanticChunk],
    new_chunks: Dict[str, SemanticChunk],
    estimate_tokens: bool = True,
) -> ContextDiff:
    """
    Compute diff between two context states.
    
    Args:
        old_chunks: Previous context (chunk_id -> chunk)
        new_chunks: New context (chunk_id -> chunk)
        estimate_tokens: Whether to compute token changes
        
    Returns:
        ContextDiff describing changes
    """
    diff = ContextDiff()
    
    old_ids = set(old_chunks.keys())
    new_ids = set(new_chunks.keys())
    
    # Find added
    for chunk_id in new_ids - old_ids:
        chunk = new_chunks[chunk_id]
        diff.added.append(ChunkChange(
            chunk_id=chunk_id,
            file_path=chunk.file_path,
            symbol_name=chunk.symbol_name,
            change_type="added",
        ))
        diff.files_added.add(chunk.file_path)
        
        if estimate_tokens:
            diff.tokens_added += _estimate_tokens(chunk)
    
    # Find removed
    for chunk_id in old_ids - new_ids:
        chunk = old_chunks[chunk_id]
        diff.removed.append(ChunkChange(
            chunk_id=chunk_id,
            file_path=chunk.file_path,
            symbol_name=chunk.symbol_name,
            change_type="removed",
        ))
        
        # Check if file completely removed
        if not any(c.file_path == chunk.file_path for c in new_chunks.values()):
            diff.files_removed.add(chunk.file_path)
        
        if estimate_tokens:
            diff.tokens_removed += _estimate_tokens(chunk)
    
    # Find modified (same ID but different content)
    for chunk_id in old_ids & new_ids:
        old_chunk = old_chunks[chunk_id]
        new_chunk = new_chunks[chunk_id]
        
        if _chunks_differ(old_chunk, new_chunk):
            diff.modified.append(ChunkChange(
                chunk_id=chunk_id,
                file_path=new_chunk.file_path,
                symbol_name=new_chunk.symbol_name,
                change_type="modified",
            ))
    
    # Compute net tokens
    diff.net_tokens = diff.tokens_added - diff.tokens_removed
    
    return diff


def _chunks_differ(a: SemanticChunk, b: SemanticChunk) -> bool:
    """Check if two chunks have different content."""
    return (
        a.code_body != b.code_body or
        a.signature != b.signature or
        a.docstring != b.docstring
    )


def _estimate_tokens(chunk: SemanticChunk) -> int:
    """Estimate token count for a chunk."""
    total = 0
    if chunk.signature:
        total += len(chunk.signature) // 4
    if chunk.docstring:
        total += len(chunk.docstring) // 4
    if chunk.code_body:
        total += len(chunk.code_body) // 4
    return total + 20


class ContextStabilizer:
    """
    Maintain context stability across turns.
    
    Goals:
    - Minimize unnecessary context changes
    - Keep referenced code in context
    - Communicate changes when they happen
    """
    
    def __init__(
        self,
        stability_threshold: float = 0.7,
        max_churn_per_turn: int = 10,
    ):
        self.stability_threshold = stability_threshold
        self.max_churn_per_turn = max_churn_per_turn
        self.previous_chunks: Dict[str, SemanticChunk] = {}
    
    def stabilize(
        self,
        new_chunks: Dict[str, SemanticChunk],
        pinned_ids: Set[str],
    ) -> Tuple[Dict[str, SemanticChunk], ContextDiff]:
        """
        Stabilize context by limiting churn.
        
        Args:
            new_chunks: Proposed new context
            pinned_ids: IDs that must stay
            
        Returns:
            Tuple of (stabilized context, diff)
        """
        if not self.previous_chunks:
            # First turn - no stabilization needed
            self.previous_chunks = new_chunks.copy()
            return new_chunks, ContextDiff()
        
        # Compute what would change
        diff = diff_contexts(self.previous_chunks, new_chunks)
        
        # If changes are minimal, accept them
        total_changes = len(diff.added) + len(diff.removed)
        if total_changes <= self.max_churn_per_turn:
            self.previous_chunks = new_chunks.copy()
            return new_chunks, diff
        
        # Too much churn - stabilize
        stabilized = self.previous_chunks.copy()
        
        # Always add pinned items
        for chunk_id in pinned_ids:
            if chunk_id in new_chunks:
                stabilized[chunk_id] = new_chunks[chunk_id]
        
        # Add most relevant new items up to limit
        items_added = 0
        for change in diff.added[:self.max_churn_per_turn]:
            if change.chunk_id not in stabilized:
                if change.chunk_id in new_chunks:
                    stabilized[change.chunk_id] = new_chunks[change.chunk_id]
                    items_added += 1
        
        # Remove least important old items
        items_to_remove = items_added  # Balance additions with removals
        removed = 0
        for change in diff.removed:
            if removed >= items_to_remove:
                break
            if change.chunk_id in stabilized and change.chunk_id not in pinned_ids:
                del stabilized[change.chunk_id]
                removed += 1
        
        # Compute actual diff
        actual_diff = diff_contexts(self.previous_chunks, stabilized)
        
        self.previous_chunks = stabilized.copy()
        return stabilized, actual_diff
    
    def reset(self) -> None:
        """Reset stabilizer state."""
        self.previous_chunks = {}
