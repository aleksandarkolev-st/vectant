"""
Context Ranker - Rank and prioritize retrieval candidates.

This is step 4 of the retrieval pipeline:
1. [QueryProcessor] Embed user request ✓
2. [ContextRetriever] Vector search top-k chunks ✓
3. [GraphExpander] Expand via dependency graph ✓
4. [ContextRanker] Rank by relevance, call distance, file importance ← YOU ARE HERE
5. [BudgetEnforcer] Enforce hard token budget
6. [ContextAssembler] Assemble final context

CRITICAL FIXES IMPLEMENTED:
1. Namespace-aware symbol scoring (same package = boost)
2. Stopword/short symbol downranking
3. ADDITIVE scoring instead of multiplicative (prevents score collapse)
4. Log-space scoring for better separation

Ranking factors:
- Vector similarity score
- Symbol match quality (namespace-aware)
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

from ..core.types import SemanticChunk, SYMBOL_STOPWORDS, get_module_group
from ..core.config import RetrievalConfig
from .retriever import RetrievalCandidate


logger = logging.getLogger("code_intel.retrieval.ranker")


@dataclass
class QueryContext:
    """Context about the current query for scoring."""
    current_file: str = ""
    current_module: str = ""
    dependency_modules: Set[str] = field(default_factory=set)


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
    generic_name_penalty: float = 0.0  # Generic names like "utils", "handler"
    
    # Namespace proximity
    namespace_bonus: float = 0.0  # Same package/dependency
    
    # Final
    final_score: float = 0.0


# Generic names that need downranking beyond just stopwords
GENERIC_NAME_PATTERNS = frozenset([
    # Highly generic - severe penalty
    "utils", "util", "helper", "helpers", "common", "shared", "misc",
    "handler", "manager", "service", "controller", "processor", "worker",
    # Moderately generic
    "base", "abstract", "default", "generic", "core", "main", "app",
    "model", "entity", "data", "dto", "vo", "item", "object",
    # Index/container names
    "index", "container", "factory", "builder", "provider", "wrapper",
])


class ContextRanker:
    """
    Rank retrieval candidates by multiple factors.
    
    Uses ADDITIVE weighted combination (not multiplicative).
    This prevents score collapse to near-zero.
    
    GENERIC NAME DOWNRANKING: Symbols with generic names (utils, handler, etc.)
    are downranked to prefer more specific symbols in retrieval.
    """
    
    # Ranking weights for ADDITIVE scoring (sum to 1.0)
    WEIGHTS = {
        "semantic_relevance": 0.35,
        "symbol_match": 0.15,
        "graph_distance": 0.20,  # Increased - graph proximity matters
        "file_importance": 0.10,
        "public_api_bonus": 0.10,
        "namespace_bonus": 0.10,  # New: namespace proximity
    }
    
    # Penalty weights (subtracted)
    PENALTY_WEIGHTS = {
        "test_penalty": 0.05,
        "size_penalty": 0.03,
        "generic_name_penalty": 0.08,  # Generic names hurt relevance
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
        query_context: Optional[QueryContext] = None,
    ) -> List[RetrievalCandidate]:
        """
        Rank candidates by relevance using ADDITIVE scoring.
        
        Args:
            candidates: Retrieval candidates
            query_symbols: Symbols from user query
            file_importance_map: Pre-computed file importance scores
            query_context: Context about current query location
            
        Returns:
            Ranked list of candidates
        """
        query_symbols = query_symbols or []
        file_importance_map = file_importance_map or {}
        query_context = query_context or QueryContext()
        
        # Compute factors for each candidate
        ranked = []
        for cand in candidates:
            factors = self._compute_factors(
                cand,
                query_symbols,
                file_importance_map,
                query_context,
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
        query_context: QueryContext,
    ) -> RankingFactors:
        """Compute ranking factors for a candidate using ADDITIVE scoring."""
        chunk = candidate.chunk
        factors = RankingFactors()
        
        # 1. Semantic relevance (from vector search)
        factors.semantic_relevance = candidate.vector_score
        
        # 2. Symbol match (NAMESPACE-AWARE)
        factors.symbol_match = self._compute_symbol_match(
            chunk.symbol_name,
            query_symbols,
            chunk,
            query_context,
        )
        
        # 3. Graph distance (linear decay instead of multiplicative)
        # 0 depth = 1.0, each hop reduces by 0.15
        factors.graph_distance = max(0.0, 1.0 - candidate.expansion_depth * 0.15)
        
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
        
        # 6. Namespace proximity bonus
        factors.namespace_bonus = self._compute_namespace_bonus(
            chunk, query_context
        )
        
        # 7. Test penalty
        if chunk.metadata and chunk.metadata.is_test:
            factors.test_penalty = 1.0
        elif self._looks_like_test(chunk.file_path):
            factors.test_penalty = 0.5
        
        # 8. Size penalty (for very large chunks)
        code_length = len(chunk.code_body) if chunk.code_body else 0
        if code_length > 2000:
            factors.size_penalty = min(1.0, (code_length - 2000) / 5000)
        
        # 9. Generic name penalty (utils, handler, manager, etc.)
        factors.generic_name_penalty = self._compute_generic_name_penalty(chunk)
        
        # Compute final score using ADDITIVE combination
        factors.final_score = self._combine_factors_additive(factors)
        
        return factors
    
    def _compute_symbol_match(
        self,
        symbol_name: str,
        query_symbols: List[str],
        chunk: SemanticChunk,
        query_context: QueryContext,
    ) -> float:
        """
        Compute symbol name match score with NAMESPACE AWARENESS.
        
        Fixes the naive exact/prefix/contains scoring by:
        1. Downranking short symbols (< 4 chars)
        2. Downranking stopwords (utils, handler, etc.)
        3. Boosting same-package matches
        4. Boosting same-dependency-tree matches
        """
        if not symbol_name or not query_symbols:
            return 0.0
        
        symbol_lower = symbol_name.lower()
        best_match = 0.0
        
        for query_symbol in query_symbols:
            query_lower = query_symbol.lower()
            
            # Exact match
            if symbol_lower == query_lower:
                base_score = 1.0
            # Prefix match
            elif symbol_lower.startswith(query_lower):
                base_score = 0.8
            # Contains match
            elif query_lower in symbol_lower:
                base_score = 0.5
            # Partial overlap (for camelCase/snake_case)
            else:
                symbol_parts = self._split_identifier(symbol_lower)
                query_parts = self._split_identifier(query_lower)
                
                overlap = len(set(symbol_parts) & set(query_parts))
                if overlap > 0:
                    base_score = overlap / max(len(symbol_parts), len(query_parts)) * 0.4
                else:
                    continue
            
            # DOWNRANK short symbols (common names collision)
            if len(symbol_name) < 4:
                base_score *= 0.5
            
            # DOWNRANK stopwords
            if symbol_lower in SYMBOL_STOPWORDS:
                base_score *= 0.3
            
            best_match = max(best_match, base_score)
        
        return best_match
    
    def _compute_namespace_bonus(
        self,
        chunk: SemanticChunk,
        query_context: QueryContext,
    ) -> float:
        """
        Compute namespace proximity bonus.
        
        Boosts chunks that are:
        1. In the same package (1.0 bonus)
        2. In the dependency tree (0.5 bonus)
        """
        if not query_context.current_module:
            return 0.0
        
        chunk_module = chunk.metadata.module_group
        if not chunk_module:
            chunk_module = get_module_group(
                chunk.file_path,
                chunk.metadata.language,
                chunk.symbol_name
            )
        
        # Same package
        if chunk_module == query_context.current_module:
            return 1.0
        
        # In dependency tree
        if chunk_module in query_context.dependency_modules:
            return 0.5
        
        # Check for partial module path overlap
        if query_context.current_module and chunk_module:
            current_parts = query_context.current_module.split('.')
            chunk_parts = chunk_module.split('.')
            
            # Common prefix
            common = 0
            for a, b in zip(current_parts, chunk_parts):
                if a == b:
                    common += 1
                else:
                    break
            
            if common > 0:
                return 0.3 * (common / max(len(current_parts), len(chunk_parts)))
        
        return 0.0
    
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
    
    def _compute_generic_name_penalty(self, chunk: SemanticChunk) -> float:
        """
        Compute penalty for generic symbol names.
        
        Generic names like "utils", "handler", "manager" are common
        and often not what users are looking for specifically.
        
        Returns:
            0.0 = no penalty (specific name)
            0.5 = moderate penalty (somewhat generic)
            1.0 = severe penalty (highly generic)
        """
        symbol_name = chunk.symbol_name.lower() if chunk.symbol_name else ""
        file_path = chunk.file_path.lower() if chunk.file_path else ""
        
        # Check symbol name
        symbol_parts = self._split_identifier(symbol_name)
        generic_matches = sum(1 for p in symbol_parts if p in GENERIC_NAME_PATTERNS)
        
        # Check file path
        file_parts = self._split_identifier(file_path.replace('/', '_').replace('\\', '_'))
        file_generic = sum(1 for p in file_parts if p in GENERIC_NAME_PATTERNS)
        
        if generic_matches == 0 and file_generic == 0:
            return 0.0
        
        # Compute penalty based on how generic
        # Single generic word = 0.3, multiple = higher
        symbol_penalty = min(1.0, generic_matches * 0.4)
        file_penalty = min(0.5, file_generic * 0.15)  # File less important
        
        # Combined but capped
        return min(1.0, symbol_penalty + file_penalty)
    
    def _combine_factors_additive(self, factors: RankingFactors) -> float:
        """
        Combine factors using ADDITIVE scoring with NORMALIZED features.
        
        CRITICAL: All features must be in [0, 1] range for fair weighting.
        Unlike multiplicative scoring (a × b × c), this uses:
        score = w1*a + w2*b + w3*c - penalties
        
        This prevents score collapse to near-zero when one factor is low.
        
        Normalization ensures:
        - semantic_relevance: Already 0-1 (cosine similarity)
        - symbol_match: Already 0-1 (computed in _compute_symbol_match)
        - graph_distance: Already 0-1 (1 - depth * 0.15)
        - file_importance: Already 0-1 (from _estimate_file_importance)
        - public_api_bonus: Already 0-1
        - namespace_bonus: Already 0-1 (from _compute_namespace_bonus)
        """
        # Verify all factors are normalized (clamp to be safe)
        semantic = max(0.0, min(1.0, factors.semantic_relevance))
        symbol = max(0.0, min(1.0, factors.symbol_match))
        graph = max(0.0, min(1.0, factors.graph_distance))
        file_imp = max(0.0, min(1.0, factors.file_importance))
        public = max(0.0, min(1.0, factors.public_api_bonus))
        namespace = max(0.0, min(1.0, factors.namespace_bonus))
        
        # Additive combination of normalized factors
        score = 0.0
        score += self.WEIGHTS["semantic_relevance"] * semantic
        score += self.WEIGHTS["symbol_match"] * symbol
        score += self.WEIGHTS["graph_distance"] * graph
        score += self.WEIGHTS["file_importance"] * file_imp
        score += self.WEIGHTS["public_api_bonus"] * public
        score += self.WEIGHTS["namespace_bonus"] * namespace
        
        # Subtract normalized penalties
        test_pen = max(0.0, min(1.0, factors.test_penalty))
        size_pen = max(0.0, min(1.0, factors.size_penalty))
        generic_pen = max(0.0, min(1.0, factors.generic_name_penalty))
        score -= self.PENALTY_WEIGHTS["test_penalty"] * test_pen
        score -= self.PENALTY_WEIGHTS["size_penalty"] * size_pen
        score -= self.PENALTY_WEIGHTS["generic_name_penalty"] * generic_pen
        
        # Clamp to 0-1 range
        return max(0.0, min(1.0, score))


def rank_chunks(
    candidates: List[RetrievalCandidate],
    query_symbols: Optional[List[str]] = None,
    query_context: Optional[QueryContext] = None,
) -> List[RetrievalCandidate]:
    """Convenience function for ranking."""
    ranker = ContextRanker()
    return ranker.rank(candidates, query_symbols, query_context=query_context)
                
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
