"""
Context Ranker - Rank and prioritize retrieval candidates.

This is step 4 of the retrieval pipeline:
1. [QueryProcessor] Embed user request ✓
2. [ContextRetriever] Vector search top-k chunks ✓
3. [GraphExpander] Expand via dependency graph ✓
4. [ContextRanker] Rank by relevance, call distance, file importance ← YOU ARE HERE
5. [BudgetEnforcer] Enforce hard token budget
6. [ContextAssembler] Assemble final context

Ranking factors:
- Vector similarity score
- Symbol match quality
- Graph distance from initial results
- File importance (entry points > utils)
- Recency (recent files may be more relevant)
- Public API preference
"""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set

from ..core.types import SemanticChunk
from ..core.config import RetrievalConfig
from .retriever import RetrievalCandidate


logger = logging.getLogger("code_intel.retrieval.ranker")


@dataclass
class RankingFactors:
    """Individual ranking factors for a candidate."""
    
    # Primary
    semantic_relevance: float = 0.0  # Vector similarity
    symbol_match: float = 0.0  # Direct symbol name match
    
    # Graph-based
    graph_distance: float = 0.0  # Proximity to initial results
    
    # Importance
    file_importance: float = 0.0  # Entry point vs utility
    public_api_bonus: float = 0.0  # Public > private
    
    # Penalties
    test_penalty: float = 0.0  # Tests usually less relevant
    size_penalty: float = 0.0  # Very large chunks may be noisy
    
    # Final
    final_score: float = 0.0


class ContextRanker:
    """
    Rank retrieval candidates by multiple factors.
    
    Uses weighted combination of relevance signals.
    """
    
    # Ranking weights (sum to 1.0)
    WEIGHTS = {
        "semantic_relevance": 0.35,
        "symbol_match": 0.15,
        "graph_distance": 0.15,
        "file_importance": 0.15,
        "public_api_bonus": 0.10,
        "test_penalty": -0.05,
        "size_penalty": -0.05,
    }
    
    # File importance patterns
    IMPORTANT_PATTERNS = [
        "main", "app", "index", "server", "handler",
        "controller", "service", "api", "route",
    ]
    
    UTILITY_PATTERNS = [
        "util", "helper", "common", "shared", "lib",
        "constant", "config", "type", "interface",
    ]
    
    def __init__(
        self,
        config: Optional[RetrievalConfig] = None,
    ):
        self.config = config or RetrievalConfig()
    
    def rank(
        self,
        candidates: List[RetrievalCandidate],
        query_symbols: Optional[List[str]] = None,
        file_importance_map: Optional[Dict[str, float]] = None,
    ) -> List[RetrievalCandidate]:
        """
        Rank candidates by relevance.
        
        Args:
            candidates: Retrieval candidates
            query_symbols: Symbols from user query
            file_importance_map: Pre-computed file importance scores
            
        Returns:
            Ranked list of candidates
        """
        query_symbols = query_symbols or []
        file_importance_map = file_importance_map or {}
        
        # Compute factors for each candidate
        ranked = []
        for cand in candidates:
            factors = self._compute_factors(
                cand,
                query_symbols,
                file_importance_map,
            )
            cand.combined_score = factors.final_score
            ranked.append(cand)
        
        # Sort by final score
        ranked.sort(key=lambda c: c.combined_score, reverse=True)
        
        return ranked
    
    def _compute_factors(
        self,
        candidate: RetrievalCandidate,
        query_symbols: List[str],
        file_importance_map: Dict[str, float],
    ) -> RankingFactors:
        """Compute ranking factors for a candidate."""
        chunk = candidate.chunk
        factors = RankingFactors()
        
        # 1. Semantic relevance (from vector search)
        factors.semantic_relevance = candidate.vector_score
        
        # 2. Symbol match
        factors.symbol_match = self._compute_symbol_match(
            chunk.symbol_name,
            query_symbols,
        )
        
        # 3. Graph distance (inverse - closer is better)
        if candidate.expansion_depth == 0:
            factors.graph_distance = 1.0
        else:
            factors.graph_distance = 1.0 / (1 + candidate.expansion_depth)
        
        # 4. File importance
        if chunk.file_path in file_importance_map:
            factors.file_importance = file_importance_map[chunk.file_path]
        else:
            factors.file_importance = self._estimate_file_importance(
                chunk.file_path,
            )
        
        # 5. Public API bonus
        if chunk.metadata and chunk.metadata.is_public:
            factors.public_api_bonus = 1.0
        elif self._looks_public(chunk):
            factors.public_api_bonus = 0.5
        
        # 6. Test penalty
        if chunk.metadata and chunk.metadata.is_test:
            factors.test_penalty = 1.0
        elif self._looks_like_test(chunk.file_path):
            factors.test_penalty = 0.5
        
        # 7. Size penalty (for very large chunks)
        code_length = len(chunk.code_body) if chunk.code_body else 0
        if code_length > 2000:
            factors.size_penalty = min(1.0, (code_length - 2000) / 5000)
        
        # Compute final score
        factors.final_score = self._combine_factors(factors)
        
        return factors
    
    def _compute_symbol_match(
        self,
        symbol_name: str,
        query_symbols: List[str],
    ) -> float:
        """Compute symbol name match score."""
        if not symbol_name or not query_symbols:
            return 0.0
        
        symbol_lower = symbol_name.lower()
        best_match = 0.0
        
        for query_symbol in query_symbols:
            query_lower = query_symbol.lower()
            
            # Exact match
            if symbol_lower == query_lower:
                return 1.0
            
            # Prefix match
            if symbol_lower.startswith(query_lower):
                best_match = max(best_match, 0.8)
            
            # Contains match
            elif query_lower in symbol_lower:
                best_match = max(best_match, 0.5)
            
            # Partial overlap (for camelCase/snake_case)
            else:
                # Split into parts
                symbol_parts = self._split_identifier(symbol_lower)
                query_parts = self._split_identifier(query_lower)
                
                overlap = len(set(symbol_parts) & set(query_parts))
                if overlap > 0:
                    score = overlap / max(len(symbol_parts), len(query_parts))
                    best_match = max(best_match, score * 0.4)
        
        return best_match
    
    def _split_identifier(self, name: str) -> List[str]:
        """Split identifier into parts."""
        # Handle camelCase
        import re
        parts = re.sub(r'([a-z])([A-Z])', r'\1_\2', name)
        # Split on underscores
        return [p.lower() for p in parts.split('_') if p]
    
    def _estimate_file_importance(self, file_path: str) -> float:
        """Estimate file importance from path."""
        path_lower = file_path.lower()
        
        # Check for important patterns
        for pattern in self.IMPORTANT_PATTERNS:
            if pattern in path_lower:
                return 0.8
        
        # Check for utility patterns
        for pattern in self.UTILITY_PATTERNS:
            if pattern in path_lower:
                return 0.4
        
        # Default
        return 0.5
    
    def _looks_public(self, chunk: SemanticChunk) -> bool:
        """Check if chunk looks like public API."""
        # Check for public indicators
        if chunk.docstring:
            return True
        
        symbol_name = chunk.symbol_name
        if symbol_name and not symbol_name.startswith('_'):
            return True
        
        return False
    
    def _looks_like_test(self, file_path: str) -> bool:
        """Check if file looks like a test."""
        path_lower = file_path.lower()
        indicators = ['test', 'spec', '__tests__', '_test.', '.test.']
        return any(ind in path_lower for ind in indicators)
    
    def _combine_factors(self, factors: RankingFactors) -> float:
        """Combine factors into final score."""
        score = 0.0
        
        score += self.WEIGHTS["semantic_relevance"] * factors.semantic_relevance
        score += self.WEIGHTS["symbol_match"] * factors.symbol_match
        score += self.WEIGHTS["graph_distance"] * factors.graph_distance
        score += self.WEIGHTS["file_importance"] * factors.file_importance
        score += self.WEIGHTS["public_api_bonus"] * factors.public_api_bonus
        score += self.WEIGHTS["test_penalty"] * factors.test_penalty
        score += self.WEIGHTS["size_penalty"] * factors.size_penalty
        
        # Normalize to 0-1 range
        return max(0.0, min(1.0, score))


def rank_chunks(
    candidates: List[RetrievalCandidate],
    query_symbols: Optional[List[str]] = None,
) -> List[RetrievalCandidate]:
    """Convenience function for ranking."""
    ranker = ContextRanker()
    return ranker.rank(candidates, query_symbols)
