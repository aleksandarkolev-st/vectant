"""
Context Retriever - Vector search and initial candidate selection.

This is step 2 of the retrieval pipeline:
1. [QueryProcessor] Embed user request ✓
2. [ContextRetriever] Vector search top-k chunks (k=5-12) ← YOU ARE HERE
3. [GraphExpander] Expand via dependency graph
4. [ContextRanker] Rank by relevance, call distance, file importance
5. [BudgetEnforcer] Enforce hard token budget
6. [ContextAssembler] Assemble final context
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

import numpy as np

from ..core.types import SemanticChunk, ChunkMetadata
from ..core.config import RetrievalConfig


logger = logging.getLogger("code_intel.retrieval.retriever")


@dataclass
class RetrievalCandidate:
    """A candidate chunk from retrieval."""
    
    chunk: SemanticChunk
    
    # Scores
    vector_score: float = 0.0  # Cosine similarity
    keyword_score: float = 0.0  # BM25/keyword match
    combined_score: float = 0.0
    
    # Source
    source: str = "vector"  # "vector", "keyword", "graph", "symbol"
    
    # Expansion info
    expansion_depth: int = 0  # How far from initial results
    expansion_path: List[str] = field(default_factory=list)
    
    def __hash__(self):
        return hash(self.chunk.id)
    
    def __eq__(self, other):
        if isinstance(other, RetrievalCandidate):
            return self.chunk.id == other.chunk.id
        return False


class ContextRetriever:
    """
    Retrieve relevant code chunks via vector search.
    
    Strategy:
    - Primary: Vector similarity search
    - Secondary: Keyword/symbol matching
    - Hybrid: Combine scores
    """
    
    def __init__(
        self,
        vector_index,  # VectorIndex
        config: Optional[RetrievalConfig] = None,
    ):
        self.vector_index = vector_index
        self.config = config or RetrievalConfig()
    
    def retrieve(
        self,
        query_embedding: np.ndarray,
        query_symbols: Optional[List[str]] = None,
        query_files: Optional[List[str]] = None,
        top_k: Optional[int] = None,
        filter_language: Optional[str] = None,
        exclude_test_files: bool = True,
    ) -> List[RetrievalCandidate]:
        """
        Retrieve relevant chunks.
        
        Args:
            query_embedding: Query vector
            query_symbols: Symbol names from query
            query_files: File patterns from query
            top_k: Number of results (default from config)
            filter_language: Only return chunks in this language
            exclude_test_files: Exclude test files
            
        Returns:
            List of retrieval candidates
        """
        top_k = top_k or self.config.top_k
        
        # Step 1: Vector search
        vector_results = self._vector_search(
            query_embedding,
            top_k * 2,  # Over-fetch for filtering
            filter_language,
            exclude_test_files,
        )
        
        # Step 2: Symbol search (if symbols provided)
        symbol_results = []
        if query_symbols:
            symbol_results = self._symbol_search(
                query_symbols,
                top_k,
                filter_language,
                exclude_test_files,
            )
        
        # Step 3: File path search (if files provided)
        file_results = []
        if query_files:
            file_results = self._file_search(
                query_files,
                top_k,
            )
        
        # Step 4: Merge results
        merged = self._merge_results(
            vector_results,
            symbol_results,
            file_results,
        )
        
        # Step 5: Sort by combined score
        merged.sort(key=lambda c: c.combined_score, reverse=True)
        
        return merged[:top_k]
    
    def _vector_search(
        self,
        query_embedding: np.ndarray,
        top_k: int,
        filter_language: Optional[str],
        exclude_test_files: bool,
    ) -> List[RetrievalCandidate]:
        """Perform vector similarity search."""
        # Search with over-fetch
        results = self.vector_index.search(
            query_embedding,
            top_k=top_k * 2,
        )
        
        candidates = []
        for chunk, score in results:
            # Apply filters
            if filter_language and chunk.language != filter_language:
                continue
            
            if exclude_test_files and chunk.metadata.is_test:
                continue
            
            candidates.append(RetrievalCandidate(
                chunk=chunk,
                vector_score=score,
                combined_score=score,
                source="vector",
            ))
        
        return candidates[:top_k]
    
    def _symbol_search(
        self,
        symbols: List[str],
        top_k: int,
        filter_language: Optional[str],
        exclude_test_files: bool,
    ) -> List[RetrievalCandidate]:
        """Search for chunks by symbol name."""
        candidates = []
        
        # Get all chunks from vector index
        # Note: In production, use a separate symbol index
        all_chunks = getattr(self.vector_index, 'chunks', {})
        
        for chunk_id, chunk in all_chunks.items():
            # Check if chunk matches any symbol
            chunk_symbol = chunk.symbol_name.lower()
            
            for query_symbol in symbols:
                query_lower = query_symbol.lower()
                
                # Exact match
                if chunk_symbol == query_lower:
                    score = 1.0
                # Prefix match
                elif chunk_symbol.startswith(query_lower):
                    score = 0.8
                # Contains match
                elif query_lower in chunk_symbol:
                    score = 0.6
                else:
                    continue
                
                # Apply filters
                if filter_language and chunk.language != filter_language:
                    continue
                
                if exclude_test_files and chunk.metadata.is_test:
                    continue
                
                candidates.append(RetrievalCandidate(
                    chunk=chunk,
                    keyword_score=score,
                    combined_score=score * 0.8,  # Slightly lower than vector
                    source="symbol",
                ))
                break
        
        # Sort and limit
        candidates.sort(key=lambda c: c.keyword_score, reverse=True)
        return candidates[:top_k]
    
    def _file_search(
        self,
        file_patterns: List[str],
        top_k: int,
    ) -> List[RetrievalCandidate]:
        """Search for chunks by file path."""
        candidates = []
        
        # Get all chunks
        all_chunks = getattr(self.vector_index, 'chunks', {})
        
        for chunk_id, chunk in all_chunks.items():
            chunk_path = chunk.file_path.lower()
            
            for pattern in file_patterns:
                pattern_lower = pattern.lower()
                
                # Exact match
                if chunk_path.endswith(pattern_lower):
                    score = 1.0
                # Contains
                elif pattern_lower in chunk_path:
                    score = 0.7
                else:
                    continue
                
                candidates.append(RetrievalCandidate(
                    chunk=chunk,
                    keyword_score=score,
                    combined_score=score * 0.7,  # Lower than vector
                    source="file",
                ))
                break
        
        # Sort and limit
        candidates.sort(key=lambda c: c.keyword_score, reverse=True)
        return candidates[:top_k]
    
    def _merge_results(
        self,
        vector_results: List[RetrievalCandidate],
        symbol_results: List[RetrievalCandidate],
        file_results: List[RetrievalCandidate],
    ) -> List[RetrievalCandidate]:
        """
        Merge results from different sources.
        
        Uses Reciprocal Rank Fusion (RRF) to combine rankings.
        """
        # Collect all unique chunks
        chunk_map: Dict[str, RetrievalCandidate] = {}
        
        # Process vector results
        for i, cand in enumerate(vector_results):
            chunk_id = cand.chunk.id
            if chunk_id not in chunk_map:
                chunk_map[chunk_id] = cand
            else:
                # Update scores
                chunk_map[chunk_id].vector_score = max(
                    chunk_map[chunk_id].vector_score,
                    cand.vector_score,
                )
        
        # Process symbol results
        for i, cand in enumerate(symbol_results):
            chunk_id = cand.chunk.id
            if chunk_id not in chunk_map:
                chunk_map[chunk_id] = cand
            else:
                chunk_map[chunk_id].keyword_score = max(
                    chunk_map[chunk_id].keyword_score,
                    cand.keyword_score,
                )
        
        # Process file results
        for i, cand in enumerate(file_results):
            chunk_id = cand.chunk.id
            if chunk_id not in chunk_map:
                chunk_map[chunk_id] = cand
            else:
                chunk_map[chunk_id].keyword_score = max(
                    chunk_map[chunk_id].keyword_score,
                    cand.keyword_score,
                )
        
        # Compute combined scores using weighted sum
        vector_weight = 0.7
        keyword_weight = 0.3
        
        for chunk_id, cand in chunk_map.items():
            cand.combined_score = (
                vector_weight * cand.vector_score +
                keyword_weight * cand.keyword_score
            )
        
        return list(chunk_map.values())


def retrieve_context(
    vector_index,
    query_embedding: np.ndarray,
    query_symbols: Optional[List[str]] = None,
    top_k: int = 10,
) -> List[RetrievalCandidate]:
    """Convenience function for retrieval."""
    retriever = ContextRetriever(vector_index)
    return retriever.retrieve(
        query_embedding=query_embedding,
        query_symbols=query_symbols,
        top_k=top_k,
    )
