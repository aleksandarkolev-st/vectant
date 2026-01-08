"""
Graph Expander - Expand candidates via dependency graph.

This is step 3 of the retrieval pipeline:
1. [QueryProcessor] Embed user request ✓
2. [ContextRetriever] Vector search top-k chunks ✓
3. [GraphExpander] Expand via dependency graph ← YOU ARE HERE
4. [ContextRanker] Rank by relevance, call distance, file importance
5. [BudgetEnforcer] Enforce hard token budget
6. [ContextAssembler] Assemble final context

Key insight: Vector search finds entry points.
Graph expansion finds the supporting code needed to understand them.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Dict, List, Optional, Set, Tuple

from ..core.types import SemanticChunk, EdgeType
from ..core.config import RetrievalConfig
from .retriever import RetrievalCandidate


logger = logging.getLogger("code_intel.retrieval.expander")


@dataclass
class ExpansionRule:
    """Rule for graph expansion."""
    
    edge_type: EdgeType
    direction: str  # "forward", "backward", "both"
    max_hops: int
    score_decay: float  # How much to reduce score per hop


class GraphExpander:
    """
    Expand retrieval candidates via the symbol graph.
    
    Given initial candidates, follow edges to find:
    - Definitions of used symbols
    - Implementations of interfaces
    - Callers/callees
    - Related types
    """
    
    # Default expansion rules
    DEFAULT_RULES = [
        # Find definitions of things we import/use
        ExpansionRule(EdgeType.IMPORTS, "forward", max_hops=1, score_decay=0.7),
        
        # Find what calls our functions (limited)
        ExpansionRule(EdgeType.CALLS, "backward", max_hops=1, score_decay=0.5),
        
        # Find what we call
        ExpansionRule(EdgeType.CALLS, "forward", max_hops=1, score_decay=0.6),
        
        # Find implementations
        ExpansionRule(EdgeType.IMPLEMENTS, "forward", max_hops=1, score_decay=0.8),
        
        # Find parent classes
        ExpansionRule(EdgeType.INHERITS, "forward", max_hops=1, score_decay=0.7),
        
        # Find type definitions
        ExpansionRule(EdgeType.USES_TYPE, "forward", max_hops=1, score_decay=0.6),
    ]
    
    def __init__(
        self,
        symbol_graph,  # SymbolGraph
        structural_index,  # StructuralIndex
        config: Optional[RetrievalConfig] = None,
        rules: Optional[List[ExpansionRule]] = None,
    ):
        self.symbol_graph = symbol_graph
        self.structural_index = structural_index
        self.config = config or RetrievalConfig()
        self.rules = rules or self.DEFAULT_RULES
    
    def expand(
        self,
        candidates: List[RetrievalCandidate],
        max_expanded: Optional[int] = None,
    ) -> List[RetrievalCandidate]:
        """
        Expand candidates via graph traversal.
        
        Args:
            candidates: Initial retrieval candidates
            max_expanded: Max total candidates after expansion
            
        Returns:
            Expanded list of candidates
        """
        max_expanded = max_expanded or (self.config.top_k * 3)
        
        # Track what we've seen
        seen_ids: Set[str] = set()
        all_candidates: Dict[str, RetrievalCandidate] = {}
        
        # Add initial candidates
        for cand in candidates:
            seen_ids.add(cand.chunk.id)
            all_candidates[cand.chunk.id] = cand
        
        # Expand each initial candidate
        for cand in candidates:
            expanded = self._expand_candidate(cand, seen_ids)
            
            for new_cand in expanded:
                chunk_id = new_cand.chunk.id
                
                if chunk_id in all_candidates:
                    # Update with better score if found again
                    if new_cand.combined_score > all_candidates[chunk_id].combined_score:
                        all_candidates[chunk_id] = new_cand
                else:
                    all_candidates[chunk_id] = new_cand
                    seen_ids.add(chunk_id)
                
                # Stop if we have enough
                if len(all_candidates) >= max_expanded:
                    break
            
            if len(all_candidates) >= max_expanded:
                break
        
        # Convert to list and sort
        result = list(all_candidates.values())
        result.sort(key=lambda c: c.combined_score, reverse=True)
        
        return result[:max_expanded]
    
    def _expand_candidate(
        self,
        candidate: RetrievalCandidate,
        seen_ids: Set[str],
    ) -> List[RetrievalCandidate]:
        """Expand a single candidate."""
        expanded = []
        chunk = candidate.chunk
        
        # Get symbol name for this chunk
        symbol_name = chunk.symbol_name
        if not symbol_name:
            return expanded
        
        # Apply each expansion rule
        for rule in self.rules:
            related = self._follow_rule(
                symbol_name,
                rule,
                candidate.combined_score,
                candidate.expansion_depth,
                candidate.expansion_path,
            )
            
            for new_cand in related:
                if new_cand.chunk.id not in seen_ids:
                    expanded.append(new_cand)
        
        return expanded
    
    def _follow_rule(
        self,
        symbol_name: str,
        rule: ExpansionRule,
        base_score: float,
        current_depth: int,
        current_path: List[str],
    ) -> List[RetrievalCandidate]:
        """Follow edges according to a rule."""
        if current_depth >= rule.max_hops:
            return []
        
        candidates = []
        
        # Find edges from this symbol
        if rule.direction in ("forward", "both"):
            edges = self.symbol_graph.get_edges_from(symbol_name)
            for edge in edges:
                if edge.edge_type == rule.edge_type:
                    cand = self._create_candidate_from_symbol(
                        edge.target,
                        base_score * rule.score_decay,
                        current_depth + 1,
                        current_path + [symbol_name],
                        f"graph:{rule.edge_type.value}",
                    )
                    if cand:
                        candidates.append(cand)
        
        # Find edges to this symbol
        if rule.direction in ("backward", "both"):
            edges = self.symbol_graph.get_edges_to(symbol_name)
            for edge in edges:
                if edge.edge_type == rule.edge_type:
                    cand = self._create_candidate_from_symbol(
                        edge.source,
                        base_score * rule.score_decay,
                        current_depth + 1,
                        current_path + [symbol_name],
                        f"graph:{rule.edge_type.value}:inverse",
                    )
                    if cand:
                        candidates.append(cand)
        
        return candidates
    
    def _create_candidate_from_symbol(
        self,
        symbol_name: str,
        score: float,
        depth: int,
        path: List[str],
        source: str,
    ) -> Optional[RetrievalCandidate]:
        """Create a retrieval candidate from a symbol name."""
        # Look up the symbol in structural index
        symbol_node = self.symbol_graph.get_node(symbol_name)
        if not symbol_node:
            return None
        
        # Get the chunk for this symbol
        # Note: This requires linking symbols to chunks
        chunk = self._get_chunk_for_symbol(symbol_name, symbol_node.file_path)
        if not chunk:
            return None
        
        return RetrievalCandidate(
            chunk=chunk,
            vector_score=0.0,
            keyword_score=0.0,
            combined_score=score,
            source=source,
            expansion_depth=depth,
            expansion_path=path,
        )
    
    def _get_chunk_for_symbol(
        self,
        symbol_name: str,
        file_path: str,
    ) -> Optional[SemanticChunk]:
        """
        Get the semantic chunk for a symbol.
        
        Note: This requires a symbol -> chunk mapping.
        In a real implementation, this would be indexed.
        """
        # Get file entry from structural index
        file_entry = self.structural_index.get_file(file_path)
        if not file_entry:
            return None
        
        # Find matching symbol in file
        for symbol in file_entry.symbols:
            if symbol.name == symbol_name:
                # Create a minimal chunk
                # In production, this would look up the actual chunk
                return SemanticChunk(
                    id=f"{file_path}:{symbol_name}",
                    language=file_entry.language,
                    file_path=file_path,
                    symbol_name=symbol_name,
                    symbol_type=symbol.symbol_type,
                    signature=symbol.signature,
                    code_body="",  # Would be populated from chunk store
                )
        
        return None


def expand_via_graph(
    candidates: List[RetrievalCandidate],
    symbol_graph,
    structural_index,
    max_expanded: int = 30,
) -> List[RetrievalCandidate]:
    """Convenience function for graph expansion."""
    expander = GraphExpander(symbol_graph, structural_index)
    return expander.expand(candidates, max_expanded)
