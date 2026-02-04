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
        lexical_index=None,  # LexicalIndex
        config: Optional[RetrievalConfig] = None,
    ):
        self.vector_index = vector_index
        self.lexical_index = lexical_index
        self.config = config or RetrievalConfig()
    
    def retrieve(
        self,
        query_embedding: np.ndarray,
        query_text: Optional[str] = None,
        query_symbols: Optional[List[str]] = None,
        query_files: Optional[List[str]] = None,
        top_k: Optional[int] = None,
        filter_language: Optional[str] = None,
        exclude_test_files: bool = True,
        folder_scope: Optional[str] = None,
    ) -> Tuple[List[RetrievalCandidate], Dict[str, int]]:
        """
        Retrieve relevant chunks.
        
        Args:
            query_embedding: Query vector
            query_symbols: Symbol names from query
            query_files: File patterns from query
            top_k: Number of results (default from config)
            filter_language: Only return chunks in this language
            exclude_test_files: Exclude test files
            folder_scope: If set, restrict results to this folder (e.g., "test-1")
            
        Returns:
            (List of retrieval candidates, stats)
        """
        top_k = top_k or getattr(self.config, "top_k", None) or self.config.top_k_candidates
        
        # Step 1: Vector search
        vector_results = self._vector_search(
            query_embedding,
            top_k * 2,  # Over-fetch for filtering
            filter_language,
            exclude_test_files,
            folder_scope=folder_scope,
        )
        
        # Step 2: Lexical search (BM25) if available
        lexical_results = []
        if self.lexical_index and getattr(self.config, "enable_lexical", True) and query_text:
            lexical_results = self._lexical_search(
                query_text,
                top_k=max(self.config.bm25_top_k, top_k * 3),
                min_score=self.config.bm25_min_score,
                filter_language=filter_language,
                exclude_test_files=exclude_test_files,
                folder_scope=folder_scope,
            )

        # Step 3: Symbol search (if symbols provided)
        symbol_results = []
        if query_symbols:
            symbol_results = self._symbol_search(
                query_symbols,
                top_k,
                filter_language,
                exclude_test_files,
                folder_scope=folder_scope,
            )
        
        # Step 4: File path search (if files provided)
        file_results = []
        if query_files:
            file_results = self._file_search(
                query_files,
                top_k,
                folder_scope=folder_scope,
            )
        
    # Step 5: Merge results
        merged = self._merge_results(
            vector_results,
            lexical_results,
            symbol_results,
            file_results,
        )
        
        # Step 5: Sort by combined score
        merged.sort(key=lambda c: c.combined_score, reverse=True)
        
        stats = {
            "pre_dedup_vector": len(vector_results),
            "pre_dedup_lexical": len(lexical_results),
            "pre_dedup_symbol": len(symbol_results),
            "pre_dedup_file": len(file_results),
            "post_dedup": len(merged),
        }

        return merged[:top_k], stats
    
    def _vector_search(
        self,
        query_embedding: np.ndarray,
        top_k: int,
        filter_language: Optional[str],
        exclude_test_files: bool,
        folder_scope: Optional[str] = None,
    ) -> List[RetrievalCandidate]:
        """Perform vector similarity search."""
        # Search with over-fetch
        results = self.vector_index.search(
            query_embedding,
            k=top_k * 2,
        )
        
        candidates = []
        for chunk, score in results:
            # Apply filters
            if filter_language and chunk.language != filter_language:
                continue
            
            if exclude_test_files and chunk.metadata.is_test:
                continue
            
            # Apply folder scope filter
            if folder_scope:
                chunk_path = chunk.metadata.file_path.replace("\\", "/").lower()
                scope_lower = folder_scope.lower()
                # File must be inside the scoped folder
                if not (chunk_path.startswith(f"{scope_lower}/") or chunk_path.startswith(scope_lower + "/")):
                    continue
            
            candidates.append(RetrievalCandidate(
                chunk=chunk,
                vector_score=score,
                combined_score=score,
                source="vector",
            ))
        
        return candidates[:top_k]
    
    def _lexical_search(
        self,
        query_text: str,
        top_k: int,
        min_score: float,
        filter_language: Optional[str],
        exclude_test_files: bool,
        folder_scope: Optional[str] = None,
    ) -> List[RetrievalCandidate]:
        """Search for chunks using BM25 lexical index."""
        results = self.lexical_index.search(query_text, k=top_k, min_score=min_score)
        if not results:
            return []

        max_score = max(r.score for r in results) or 1.0
        candidates = []
        for r in results:
            chunk = r.chunk or self.vector_index.get_chunk(r.chunk_id)
            if not chunk:
                continue
            if filter_language and chunk.language != filter_language:
                continue
            if exclude_test_files and chunk.metadata.is_test:
                continue
            # Apply folder scope filter
            if folder_scope:
                chunk_path = chunk.metadata.file_path.replace("\\", "/").lower()
                scope_lower = folder_scope.lower()
                if not chunk_path.startswith(f"{scope_lower}/"):
                    continue
            score = r.score / max_score
            candidates.append(RetrievalCandidate(
                chunk=chunk,
                keyword_score=score,
                combined_score=score * 0.9,
                source="lexical",
            ))

        return candidates

    def _symbol_search(
        self,
        symbols: List[str],
        top_k: int,
        filter_language: Optional[str],
        exclude_test_files: bool,
        folder_scope: Optional[str] = None,
    ) -> List[RetrievalCandidate]:
        """Search for chunks by symbol name."""
        candidates = []
        
        # Get all chunks from vector index
        all_chunks = self.vector_index.get_all_chunks()

        for chunk in all_chunks:
            # Apply folder scope filter first
            if folder_scope:
                chunk_path = chunk.metadata.file_path.replace("\\", "/").lower()
                scope_lower = folder_scope.lower()
                if not chunk_path.startswith(f"{scope_lower}/"):
                    continue
            
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
        folder_scope: Optional[str] = None,
    ) -> List[RetrievalCandidate]:
        """Search for chunks by file path."""
        candidates = []
        
        # Get all chunks
        all_chunks = self.vector_index.get_all_chunks()

        for chunk in all_chunks:
            chunk_path = chunk.file_path.lower()
            
            # Apply folder scope filter
            if folder_scope:
                chunk_path_norm = chunk_path.replace("\\", "/")
                scope_lower = folder_scope.lower()
                if not chunk_path_norm.startswith(f"{scope_lower}/"):
                    continue
            
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
        lexical_results: List[RetrievalCandidate],
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

        # Process lexical results
        for i, cand in enumerate(lexical_results):
            chunk_id = cand.chunk.id
            if chunk_id not in chunk_map:
                chunk_map[chunk_id] = cand
            else:
                chunk_map[chunk_id].keyword_score = max(
                    chunk_map[chunk_id].keyword_score,
                    cand.keyword_score,
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
    lexical_index=None,
    query_text: Optional[str] = None,
    query_symbols: Optional[List[str]] = None,
    top_k: int = 10,
) -> List[RetrievalCandidate]:
    """Convenience function for retrieval."""
    retriever = ContextRetriever(vector_index, lexical_index=lexical_index)
    candidates, _ = retriever.retrieve(
        query_embedding=query_embedding,
        query_text=query_text,
        query_symbols=query_symbols,
        top_k=top_k,
    )
    return candidates
