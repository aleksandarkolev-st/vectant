"""
Symbol-Level Diffs - NOT Line Diffs.

This module provides symbol-level diffing for code changes.
When the AI modifies code, we track changes at the symbol level,
not line level. This enables:

1. Semantic understanding of what changed
2. Index updates only for affected symbols
3. Precise conflict detection
4. Better undo/redo semantics

Design principle: "Change the function authenticate_user" not "Change lines 45-78"
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Set, Tuple, Any

from ..core.types import SymbolType, ChunkMetadata, SemanticChunk


logger = logging.getLogger("code_intel.editing.symbol_diff")


class SymbolChangeType(Enum):
    """Type of change to a symbol."""
    
    ADDED = "added"           # New symbol created
    REMOVED = "removed"       # Symbol deleted
    MODIFIED = "modified"     # Symbol body changed
    SIGNATURE_CHANGED = "signature_changed"  # Signature changed (breaking)
    RENAMED = "renamed"       # Symbol renamed (requires reference updates)
    MOVED = "moved"           # Symbol moved to different file/location
    UNCHANGED = "unchanged"   # No change
    
    @property
    def is_breaking(self) -> bool:
        """Check if this change type could break callers."""
        return self in (
            SymbolChangeType.REMOVED,
            SymbolChangeType.SIGNATURE_CHANGED,
            SymbolChangeType.RENAMED,
        )


@dataclass
class SymbolChange:
    """
    Represents a change to a single symbol.
    
    This is the fundamental unit of our diff system.
    NOT lines. SYMBOLS.
    """
    
    # Identity
    symbol_name: str
    qualified_name: str  # module.Class.method
    symbol_type: SymbolType
    
    # Change info
    change_type: SymbolChangeType
    
    # Location (before and after)
    file_path: str
    old_location: Optional[Tuple[int, int]] = None  # (start_line, end_line)
    new_location: Optional[Tuple[int, int]] = None
    
    # Content (for modified/added)
    old_signature: str = ""
    new_signature: str = ""
    old_body_hash: str = ""  # Hash of body, not the body itself
    new_body_hash: str = ""
    
    # For renames
    old_name: str = ""
    new_name: str = ""
    
    # For moves
    old_file: str = ""
    new_file: str = ""
    
    # Impact analysis
    callers_affected: List[str] = field(default_factory=list)
    imports_affected: List[str] = field(default_factory=list)
    
    def is_breaking(self) -> bool:
        """Check if this change could break other code."""
        return self.change_type.is_breaking
    
    def requires_index_update(self) -> bool:
        """Check if index needs to be updated for this change."""
        return self.change_type != SymbolChangeType.UNCHANGED
    
    def get_affected_chunks(self) -> List[str]:
        """Get chunk IDs that need re-indexing."""
        affected = []
        if self.callers_affected:
            affected.extend(self.callers_affected)
        if self.imports_affected:
            affected.extend(self.imports_affected)
        return affected


@dataclass
class SymbolDiff:
    """
    Complete diff between two versions of code.
    
    This is what gets stored in provenance and used for index updates.
    """
    
    # Metadata
    file_path: str
    old_version_hash: str
    new_version_hash: str
    
    # Changes
    added_symbols: List[SymbolChange] = field(default_factory=list)
    removed_symbols: List[SymbolChange] = field(default_factory=list)
    modified_symbols: List[SymbolChange] = field(default_factory=list)
    renamed_symbols: List[SymbolChange] = field(default_factory=list)
    
    # Statistics
    total_changes: int = 0
    breaking_changes: int = 0
    
    def is_empty(self) -> bool:
        """Check if there are no changes."""
        return self.total_changes == 0
    
    def has_breaking_changes(self) -> bool:
        """Check if any changes could break callers."""
        return self.breaking_changes > 0
    
    def get_all_changes(self) -> List[SymbolChange]:
        """Get all changes in one list."""
        return (
            self.added_symbols +
            self.removed_symbols +
            self.modified_symbols +
            self.renamed_symbols
        )
    
    def get_symbols_to_reindex(self) -> Set[str]:
        """Get qualified names of symbols that need re-indexing."""
        return {c.qualified_name for c in self.get_all_changes()}
    
    def get_affected_files(self) -> Set[str]:
        """Get all files affected by this diff."""
        files = {self.file_path}
        for change in self.get_all_changes():
            if change.old_file:
                files.add(change.old_file)
            if change.new_file:
                files.add(change.new_file)
        return files
    
    def to_summary(self) -> str:
        """Get human-readable summary."""
        lines = [f"Symbol diff for {self.file_path}:"]
        
        if self.added_symbols:
            lines.append(f"  + {len(self.added_symbols)} added")
            for s in self.added_symbols[:3]:
                lines.append(f"    + {s.symbol_name} ({s.symbol_type.value})")
        
        if self.removed_symbols:
            lines.append(f"  - {len(self.removed_symbols)} removed")
            for s in self.removed_symbols[:3]:
                lines.append(f"    - {s.symbol_name}")
        
        if self.modified_symbols:
            lines.append(f"  ~ {len(self.modified_symbols)} modified")
            for s in self.modified_symbols[:3]:
                breaking = " [BREAKING]" if s.is_breaking() else ""
                lines.append(f"    ~ {s.symbol_name}{breaking}")
        
        if self.renamed_symbols:
            lines.append(f"  → {len(self.renamed_symbols)} renamed")
            for s in self.renamed_symbols[:3]:
                lines.append(f"    → {s.old_name} → {s.new_name}")
        
        if self.breaking_changes > 0:
            lines.append(f"\n  ⚠️  {self.breaking_changes} breaking change(s)")
        
        return "\n".join(lines)


class SymbolDiffer:
    """
    Compute symbol-level diffs between code versions.
    
    This is NOT a line-based diff. We:
    1. Parse both versions to extract symbols
    2. Match symbols by qualified name
    3. Detect additions, removals, modifications
    4. Detect renames using signature/body similarity
    5. Track signature changes separately (breaking)
    """
    
    def __init__(self):
        # Similarity threshold for rename detection
        self.rename_threshold = 0.8
        # Cache for parsed symbols
        self._symbol_cache: Dict[str, Dict[str, Any]] = {}
    
    def compute_diff(
        self,
        file_path: str,
        old_content: str,
        new_content: str,
        old_symbols: List[Dict[str, Any]],
        new_symbols: List[Dict[str, Any]],
    ) -> SymbolDiff:
        """
        Compute symbol-level diff between two versions.
        
        Args:
            file_path: Path to file being diffed
            old_content: Previous file content
            new_content: New file content
            old_symbols: Parsed symbols from old version
            new_symbols: Parsed symbols from new version
            
        Returns:
            SymbolDiff with all changes
        """
        import hashlib
        
        old_hash = hashlib.sha256(old_content.encode()).hexdigest()[:12]
        new_hash = hashlib.sha256(new_content.encode()).hexdigest()[:12]
        
        diff = SymbolDiff(
            file_path=file_path,
            old_version_hash=old_hash,
            new_version_hash=new_hash,
        )
        
        # Index symbols by qualified name
        old_by_name = {s["qualified_name"]: s for s in old_symbols}
        new_by_name = {s["qualified_name"]: s for s in new_symbols}
        
        old_names = set(old_by_name.keys())
        new_names = set(new_by_name.keys())
        
        # Detect additions
        for name in new_names - old_names:
            sym = new_by_name[name]
            change = self._create_addition(name, sym, file_path)
            diff.added_symbols.append(change)
        
        # Detect removals (but check for renames first)
        removed_names = old_names - new_names
        added_names = new_names - old_names
        
        # Try to match removed with added (rename detection)
        rename_matches = self._detect_renames(
            [old_by_name[n] for n in removed_names],
            [new_by_name[n] for n in added_names],
        )
        
        for old_sym, new_sym in rename_matches:
            change = self._create_rename(old_sym, new_sym, file_path)
            diff.renamed_symbols.append(change)
            diff.breaking_changes += 1  # Renames are always breaking
            
            # Remove from added/removed
            removed_names.discard(old_sym["qualified_name"])
            added_names.discard(new_sym["qualified_name"])
        
        # Remaining removed symbols
        for name in removed_names:
            sym = old_by_name[name]
            change = self._create_removal(name, sym, file_path)
            diff.removed_symbols.append(change)
            diff.breaking_changes += 1  # Removals are always breaking
        
        # Update added symbols list (minus renames)
        diff.added_symbols = [
            c for c in diff.added_symbols
            if c.qualified_name in added_names
        ]
        
        # Detect modifications
        for name in old_names & new_names:
            old_sym = old_by_name[name]
            new_sym = new_by_name[name]
            
            change = self._detect_modification(name, old_sym, new_sym, file_path)
            if change and change.change_type != SymbolChangeType.UNCHANGED:
                diff.modified_symbols.append(change)
                if change.is_breaking():
                    diff.breaking_changes += 1
        
        # Update totals
        diff.total_changes = (
            len(diff.added_symbols) +
            len(diff.removed_symbols) +
            len(diff.modified_symbols) +
            len(diff.renamed_symbols)
        )
        
        return diff
    
    def _create_addition(
        self,
        qualified_name: str,
        symbol: Dict[str, Any],
        file_path: str,
    ) -> SymbolChange:
        """Create change record for added symbol."""
        return SymbolChange(
            symbol_name=symbol.get("name", ""),
            qualified_name=qualified_name,
            symbol_type=SymbolType(symbol.get("type", "unknown")),
            change_type=SymbolChangeType.ADDED,
            file_path=file_path,
            new_location=(symbol.get("start_line", 0), symbol.get("end_line", 0)),
            new_signature=symbol.get("signature", ""),
        )
    
    def _create_removal(
        self,
        qualified_name: str,
        symbol: Dict[str, Any],
        file_path: str,
    ) -> SymbolChange:
        """Create change record for removed symbol."""
        return SymbolChange(
            symbol_name=symbol.get("name", ""),
            qualified_name=qualified_name,
            symbol_type=SymbolType(symbol.get("type", "unknown")),
            change_type=SymbolChangeType.REMOVED,
            file_path=file_path,
            old_location=(symbol.get("start_line", 0), symbol.get("end_line", 0)),
            old_signature=symbol.get("signature", ""),
        )
    
    def _create_rename(
        self,
        old_symbol: Dict[str, Any],
        new_symbol: Dict[str, Any],
        file_path: str,
    ) -> SymbolChange:
        """Create change record for renamed symbol."""
        return SymbolChange(
            symbol_name=new_symbol.get("name", ""),
            qualified_name=new_symbol.get("qualified_name", ""),
            symbol_type=SymbolType(new_symbol.get("type", "unknown")),
            change_type=SymbolChangeType.RENAMED,
            file_path=file_path,
            old_location=(old_symbol.get("start_line", 0), old_symbol.get("end_line", 0)),
            new_location=(new_symbol.get("start_line", 0), new_symbol.get("end_line", 0)),
            old_name=old_symbol.get("name", ""),
            new_name=new_symbol.get("name", ""),
            old_signature=old_symbol.get("signature", ""),
            new_signature=new_symbol.get("signature", ""),
        )
    
    def _detect_modification(
        self,
        qualified_name: str,
        old_symbol: Dict[str, Any],
        new_symbol: Dict[str, Any],
        file_path: str,
    ) -> Optional[SymbolChange]:
        """Detect and classify modification to a symbol."""
        old_sig = old_symbol.get("signature", "")
        new_sig = new_symbol.get("signature", "")
        old_body = old_symbol.get("body_hash", "")
        new_body = new_symbol.get("body_hash", "")
        
        # Check for signature change (breaking)
        if old_sig != new_sig:
            return SymbolChange(
                symbol_name=new_symbol.get("name", ""),
                qualified_name=qualified_name,
                symbol_type=SymbolType(new_symbol.get("type", "unknown")),
                change_type=SymbolChangeType.SIGNATURE_CHANGED,
                file_path=file_path,
                old_location=(old_symbol.get("start_line", 0), old_symbol.get("end_line", 0)),
                new_location=(new_symbol.get("start_line", 0), new_symbol.get("end_line", 0)),
                old_signature=old_sig,
                new_signature=new_sig,
                old_body_hash=old_body,
                new_body_hash=new_body,
            )
        
        # Check for body change (non-breaking)
        if old_body != new_body:
            return SymbolChange(
                symbol_name=new_symbol.get("name", ""),
                qualified_name=qualified_name,
                symbol_type=SymbolType(new_symbol.get("type", "unknown")),
                change_type=SymbolChangeType.MODIFIED,
                file_path=file_path,
                old_location=(old_symbol.get("start_line", 0), old_symbol.get("end_line", 0)),
                new_location=(new_symbol.get("start_line", 0), new_symbol.get("end_line", 0)),
                old_signature=old_sig,
                new_signature=new_sig,
                old_body_hash=old_body,
                new_body_hash=new_body,
            )
        
        # No change
        return SymbolChange(
            symbol_name=new_symbol.get("name", ""),
            qualified_name=qualified_name,
            symbol_type=SymbolType(new_symbol.get("type", "unknown")),
            change_type=SymbolChangeType.UNCHANGED,
            file_path=file_path,
        )
    
    def _detect_renames(
        self,
        removed: List[Dict[str, Any]],
        added: List[Dict[str, Any]],
    ) -> List[Tuple[Dict[str, Any], Dict[str, Any]]]:
        """
        Detect potential renames by matching removed and added symbols.
        
        Uses body similarity to match symbols that were renamed.
        """
        matches = []
        used_added = set()
        
        for old_sym in removed:
            old_type = old_sym.get("type", "")
            old_body = old_sym.get("body_hash", "")
            
            best_match = None
            best_score = 0.0
            
            for i, new_sym in enumerate(added):
                if i in used_added:
                    continue
                
                # Must be same type
                if new_sym.get("type", "") != old_type:
                    continue
                
                # Calculate similarity score
                score = self._similarity_score(old_sym, new_sym)
                
                if score > self.rename_threshold and score > best_score:
                    best_match = (i, new_sym)
                    best_score = score
            
            if best_match:
                idx, new_sym = best_match
                matches.append((old_sym, new_sym))
                used_added.add(idx)
        
        return matches
    
    def _similarity_score(
        self,
        old_sym: Dict[str, Any],
        new_sym: Dict[str, Any],
    ) -> float:
        """Calculate similarity between two symbols."""
        score = 0.0
        
        # Body hash match (high weight)
        if old_sym.get("body_hash") == new_sym.get("body_hash"):
            score += 0.6
        
        # Signature similarity
        old_sig = old_sym.get("signature", "")
        new_sig = new_sym.get("signature", "")
        if old_sig and new_sig:
            # Simple character-level similarity
            common = len(set(old_sig) & set(new_sig))
            total = len(set(old_sig) | set(new_sig))
            if total > 0:
                score += 0.2 * (common / total)
        
        # Location proximity
        old_line = old_sym.get("start_line", 0)
        new_line = new_sym.get("start_line", 0)
        if abs(old_line - new_line) < 10:
            score += 0.2
        elif abs(old_line - new_line) < 50:
            score += 0.1
        
        return score


class IndexUpdater:
    """
    Update index based on symbol diffs.
    
    After editing, we don't re-index everything.
    We use the symbol diff to:
    1. Remove old symbols from index
    2. Add new symbols to index
    3. Update modified symbols
    4. Cascade updates to affected symbols
    """
    
    def __init__(
        self,
        structural_index: Any,  # StructuralIndex
        vector_index: Any,  # VectorIndex
        embedder: Any,  # Embedder
    ):
        self.structural_index = structural_index
        self.vector_index = vector_index
        self.embedder = embedder
    
    async def apply_diff(
        self,
        diff: SymbolDiff,
        new_chunks: List[SemanticChunk],
    ) -> Dict[str, int]:
        """
        Apply symbol diff to update indices.
        
        Args:
            diff: Symbol-level diff
            new_chunks: Newly parsed chunks from modified file
            
        Returns:
            Statistics about updates made
        """
        stats = {
            "symbols_removed": 0,
            "symbols_added": 0,
            "symbols_updated": 0,
            "vectors_updated": 0,
        }
        
        # Remove deleted symbols
        for change in diff.removed_symbols:
            await self._remove_symbol(change.qualified_name)
            stats["symbols_removed"] += 1
        
        # Remove old versions of renamed symbols
        for change in diff.renamed_symbols:
            await self._remove_symbol(change.old_name if change.old_name else change.qualified_name)
            stats["symbols_removed"] += 1
        
        # Add new symbols (including renamed)
        for change in diff.added_symbols + diff.renamed_symbols:
            chunk = self._find_chunk_for_symbol(change.qualified_name, new_chunks)
            if chunk:
                await self._add_symbol(change, chunk)
                stats["symbols_added"] += 1
        
        # Update modified symbols
        for change in diff.modified_symbols:
            chunk = self._find_chunk_for_symbol(change.qualified_name, new_chunks)
            if chunk:
                await self._update_symbol(change, chunk)
                stats["symbols_updated"] += 1
        
        # Update vector index for all affected chunks
        affected_chunks = [
            c for c in new_chunks
            if c.metadata.symbol_name in diff.get_symbols_to_reindex()
        ]
        
        if affected_chunks:
            await self._update_vectors(affected_chunks)
            stats["vectors_updated"] = len(affected_chunks)
        
        logger.info(f"Index update: {stats}")
        return stats
    
    async def _remove_symbol(self, qualified_name: str) -> None:
        """Remove a symbol from structural index."""
        if hasattr(self.structural_index, "remove_symbol"):
            self.structural_index.remove_symbol(qualified_name)
    
    async def _add_symbol(self, change: SymbolChange, chunk: SemanticChunk) -> None:
        """Add a symbol to structural index."""
        if hasattr(self.structural_index, "add_symbol"):
            self.structural_index.add_symbol(
                name=change.qualified_name,
                symbol_type=change.symbol_type,
                file_path=change.file_path,
                start_line=change.new_location[0] if change.new_location else 0,
                end_line=change.new_location[1] if change.new_location else 0,
                signature=change.new_signature,
            )
    
    async def _update_symbol(self, change: SymbolChange, chunk: SemanticChunk) -> None:
        """Update a symbol in structural index."""
        # Remove old, add new
        await self._remove_symbol(change.qualified_name)
        await self._add_symbol(change, chunk)
    
    async def _update_vectors(self, chunks: List[SemanticChunk]) -> None:
        """Update vector embeddings for chunks."""
        if not chunks or not self.embedder:
            return
        
        # Generate new embeddings
        texts = [c.content for c in chunks]
        embeddings = await self.embedder.embed_batch(texts)
        
        # Update vector index
        if hasattr(self.vector_index, "update_batch"):
            ids = [c.id for c in chunks]
            self.vector_index.update_batch(ids, embeddings)
    
    def _find_chunk_for_symbol(
        self,
        qualified_name: str,
        chunks: List[SemanticChunk],
    ) -> Optional[SemanticChunk]:
        """Find chunk containing a symbol."""
        for chunk in chunks:
            # Check if this chunk contains the symbol
            if chunk.metadata.symbol_name == qualified_name:
                return chunk
            # Also check unqualified match
            if "." in qualified_name:
                unqualified = qualified_name.rsplit(".", 1)[-1]
                if chunk.metadata.symbol_name == unqualified:
                    return chunk
        return None


# Export for convenience
def compute_symbol_diff(
    file_path: str,
    old_content: str,
    new_content: str,
    old_symbols: List[Dict[str, Any]],
    new_symbols: List[Dict[str, Any]],
) -> SymbolDiff:
    """Convenience function to compute symbol diff."""
    differ = SymbolDiffer()
    return differ.compute_diff(file_path, old_content, new_content, old_symbols, new_symbols)
