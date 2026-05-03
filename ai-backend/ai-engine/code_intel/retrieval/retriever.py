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
from .fusion import reciprocal_rank_fusion, mmr, cosine_similarity, jaccard_similarity


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

    # Causal path scoring
    causal_distance: float = 0.0

    # Spec alignment
    spec_alignment: float = 0.0

    # Edits-aware scoring
    recency_score: float = 0.0

    # Index kind (tests/interfaces/infra/core/spec)
    index_kind: str = "core"
    
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
        module_scope: Optional[str] = None,
        index_kind: Optional[str] = None,
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
            module_scope=module_scope,
            index_kind=index_kind,
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
                module_scope=module_scope,
                index_kind=index_kind,
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
                module_scope=module_scope,
                index_kind=index_kind,
            )
        
        # Step 4: File path search (if files provided)
        file_results = []
        if query_files:
            file_results = self._file_search(
                query_files,
                top_k,
                folder_scope=folder_scope,
                module_scope=module_scope,
                index_kind=index_kind,
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
        module_scope: Optional[str] = None,
        index_kind: Optional[str] = None,
    ) -> List[RetrievalCandidate]:
        """Perform vector similarity search."""
        if index_kind == "tests":
            exclude_test_files = False
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

            if not self._match_index_kind(chunk, index_kind):
                continue

            if not self._match_module_scope(chunk, module_scope):
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
                index_kind=index_kind or "core",
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
        module_scope: Optional[str] = None,
        index_kind: Optional[str] = None,
    ) -> List[RetrievalCandidate]:
        """Search for chunks using BM25 lexical index."""
        if index_kind == "tests":
            exclude_test_files = False
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
            if not self._match_index_kind(chunk, index_kind):
                continue
            if not self._match_module_scope(chunk, module_scope):
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
                index_kind=index_kind or "core",
            ))

        return candidates

    def _symbol_search(
        self,
        symbols: List[str],
        top_k: int,
        filter_language: Optional[str],
        exclude_test_files: bool,
        folder_scope: Optional[str] = None,
        module_scope: Optional[str] = None,
        index_kind: Optional[str] = None,
    ) -> List[RetrievalCandidate]:
        """Search for chunks by symbol name."""
        if index_kind == "tests":
            exclude_test_files = False
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
                if not self._match_index_kind(chunk, index_kind):
                    continue
                if not self._match_module_scope(chunk, module_scope):
                    continue
                
                candidates.append(RetrievalCandidate(
                    chunk=chunk,
                    keyword_score=score,
                    combined_score=score * 0.8,  # Slightly lower than vector
                    source="symbol",
                    index_kind=index_kind or "core",
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
        module_scope: Optional[str] = None,
        index_kind: Optional[str] = None,
    ) -> List[RetrievalCandidate]:
        """Search for chunks by file path."""
        candidates = []
        
        # Get all chunks
        all_chunks = self.vector_index.get_all_chunks()

        for chunk in all_chunks:
            chunk_path = chunk.file_path.lower()

            if not self._match_index_kind(chunk, index_kind):
                continue
            if not self._match_module_scope(chunk, module_scope):
                continue
            
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
                    index_kind=index_kind or "core",
                ))
                break
        
        # Sort and limit
        candidates.sort(key=lambda c: c.keyword_score, reverse=True)
        return candidates[:top_k]

    def _match_index_kind(self, chunk: SemanticChunk, index_kind: Optional[str]) -> bool:
        if not index_kind or index_kind == "any":
            return True

        file_path = chunk.metadata.file_path.replace("\\", "/").lower()
        is_test = chunk.metadata.is_test or any(p in file_path for p in ["/test", "/tests", "__tests__", "spec", ".test."])
        is_interface = any(p in file_path for p in ["/interface", "/interfaces", "/types", "/schema", "/contract", "/api", ".d.ts"])
        is_infra = any(p in file_path for p in ["/infra", "/infrastructure", "/deploy", "/docker", "/k8s", "/terraform", "/ci", "/.github", "/scripts"])

        if index_kind == "tests":
            return is_test
        if index_kind == "interfaces":
            return is_interface
        if index_kind == "infra":
            return is_infra
        if index_kind == "core":
            return not (is_test or is_interface or is_infra)
        return True

    def _match_module_scope(self, chunk: SemanticChunk, module_scope: Optional[str]) -> bool:
        if not module_scope:
            return True
        mod = chunk.metadata.module_group or ""
        if not mod:
            return True
        if mod == module_scope:
            return True
        # Allow prefix match for nested modules
        return mod.startswith(module_scope + ".") or mod.startswith(module_scope + "/")
    
    def _merge_results(
        self,
        vector_results: List[RetrievalCandidate],
        lexical_results: List[RetrievalCandidate],
        symbol_results: List[RetrievalCandidate],
        file_results: List[RetrievalCandidate],
    ) -> List[RetrievalCandidate]:
        """
        Merge ranked lists from different retrieval sources.

        We use Reciprocal Rank Fusion (RRF) to combine rankings rather than a
        weighted sum of raw scores: cosine similarity, normalised BM25, symbol
        match boost, and file-path heuristics all live on different scales, so
        any fixed weighted-sum is fragile against distribution shift. RRF only
        looks at each item's *rank* within each list, which is robust.

        After fusion we run Maximal Marginal Relevance (MMR) over the top-K to
        diversify — the head of an unfused ranking often piles up near-duplicate
        chunks from the same file/class, which starves the downstream prompt
        on signal. MMR penalises picks that are too similar to already-picked
        candidates so the LLM gets a more representative spread.
        """
        # 1) Collect every candidate keyed by chunk id, accumulating per-source
        #    scores. Source-specific score fields stay populated so downstream
        #    consumers (ranker, budget_enforcer) can read them.
        chunk_map: Dict[str, RetrievalCandidate] = {}
        for source_results in (vector_results, lexical_results, symbol_results, file_results):
            for cand in source_results:
                cid = cand.chunk.id
                if cid not in chunk_map:
                    chunk_map[cid] = cand
                else:
                    existing = chunk_map[cid]
                    existing.vector_score = max(existing.vector_score, cand.vector_score)
                    existing.keyword_score = max(existing.keyword_score, cand.keyword_score)

        if not chunk_map:
            return []

        # 2) Build per-source ranked lists of chunk ids. Each upstream search
        #    already returns results sorted by score descending.
        ranked_lists = [
            [c.chunk.id for c in vector_results],
            [c.chunk.id for c in lexical_results],
            [c.chunk.id for c in symbol_results],
            [c.chunk.id for c in file_results],
        ]
        # Drop empty lists so RRF weights aren't diluted.
        ranked_lists = [r for r in ranked_lists if r]

        # 3) Fuse with RRF. k=60 is the SIGIR-standard damping constant.
        fused: List[Tuple[str, float]] = []
        if ranked_lists:
            fused = reciprocal_rank_fusion(ranked_lists, k=60)

        # 4) Normalise RRF scores into [0, 1] so combined_score stays
        #    comparable with prior code that thresholds against ~0.0..1.0.
        max_fused = fused[0][1] if fused else 1.0
        if max_fused <= 0:
            max_fused = 1.0
        for cid, score in fused:
            cand = chunk_map.get(cid)
            if cand is None:
                continue
            cand.combined_score = score / max_fused

        # Any candidate that somehow never appeared in any input list gets a
        # tiny fallback combined_score so it doesn't disappear silently.
        for cid, cand in chunk_map.items():
            if cand.combined_score <= 0:
                cand.combined_score = 0.4 * cand.vector_score + 0.6 * cand.keyword_score

        # 5) Build the ordered candidate list by RRF rank, then run MMR over
        #    the head of the list to diversify. We diversify only the head
        #    (~32 candidates) because MMR is O(K^2 * D) per call and we don't
        #    need diversity in the long tail.
        ordered = sorted(chunk_map.values(), key=lambda c: c.combined_score, reverse=True)
        head_size = min(len(ordered), max(8, getattr(self.config, "mmr_head_size", 32)))
        head = ordered[:head_size]
        tail = ordered[head_size:]

        diversified = self._mmr_rerank(head)
        return diversified + tail

    def _mmr_rerank(self, candidates: List[RetrievalCandidate]) -> List[RetrievalCandidate]:
        """Apply MMR over a small candidate head for diversity.

        Similarity prefers cosine over chunk embeddings when both candidates
        carry a vector; otherwise falls back to Jaccard over a small token bag
        (symbol name + first identifiers in the chunk body). Both are cheap.
        """
        if len(candidates) <= 1:
            return list(candidates)

        lambda_ = float(getattr(self.config, "mmr_lambda", 0.7))

        # Pre-compute token bags for the Jaccard fallback so we don't redo the
        # work on every similarity comparison inside the MMR loop.
        token_bags: Dict[str, set] = {}
        for c in candidates:
            tokens = set()
            sym = getattr(c.chunk.metadata, "symbol_name", "") or ""
            if sym:
                tokens.add(sym.lower())
            body = getattr(c.chunk, "code_body", None) or getattr(c.chunk, "_code_body", "") or ""
            if body:
                # Cheap token bag — first 200 chars worth of identifier-ish tokens.
                head_text = body[:200]
                for tok in head_text.replace("(", " ").replace(")", " ").replace("{", " ").replace("}", " ").split():
                    t = tok.strip(".,;:[]<>=").lower()
                    if 2 <= len(t) <= 40:
                        tokens.add(t)
            token_bags[c.chunk.id] = tokens

        def _similarity(a: RetrievalCandidate, b: RetrievalCandidate) -> float:
            emb_a = getattr(a.chunk, "embedding", None)
            emb_b = getattr(b.chunk, "embedding", None)
            if emb_a is not None and emb_b is not None:
                try:
                    return cosine_similarity(emb_a, emb_b)
                except Exception:
                    pass
            return jaccard_similarity(token_bags.get(a.chunk.id, set()), token_bags.get(b.chunk.id, set()))

        return mmr(
            candidates,
            relevance_fn=lambda c: float(c.combined_score),
            similarity_fn=_similarity,
            lambda_=lambda_,
            top_k=len(candidates),
        )


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
