"""
Document Ranker — Hybrid scorer combining vector + keyword + recency signals.

Orchestrates the final macro-retrieval ranking:
1. Collect vector similarity scores from SummarySearcher
2. Collect BM25 keyword scores from KeywordFilter
3. Apply recency bonus for recently-modified documents
4. Combine signals with configurable weights
5. Select top-K documents for micro-navigation
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

from ..config import MacroConfig, RAGConfig, get_rag_config
from ..types import MacroResult, RAGQuery, DocumentSummary
from ..store.summary_index import SummaryIndex
from ..store.document_store import DocumentStore
from .summary_searcher import SummarySearcher, VectorSearchResult
from .keyword_filter import KeywordFilter, KeywordSearchResult
from .query_analyzer import QueryAnalyzer, AnalyzedQuery
from ..exceptions import MacroRetrievalError

logger = logging.getLogger("code_intel.rag.macro.document_ranker")


@dataclass
class RankedDocument:
    """A document with its composite relevance score."""
    document_id: str
    final_score: float
    vector_score: float = 0.0
    keyword_score: float = 0.0
    recency_score: float = 0.0
    matched_keywords: List[str] = field(default_factory=list)
    title: str = ""

    def __repr__(self) -> str:
        return (
            f"RankedDocument(doc={self.document_id}, "
            f"final={self.final_score:.4f}, "
            f"vec={self.vector_score:.4f}, "
            f"kw={self.keyword_score:.4f})"
        )


class DocumentRanker:
    """
    Hybrid ranker combining vector, keyword, and recency signals.

    This is the main orchestrator for macro-retrieval (Step 2).
    """

    def __init__(
        self,
        summary_searcher: SummarySearcher,
        keyword_filter: KeywordFilter,
        query_analyzer: QueryAnalyzer,
        document_store: Optional[DocumentStore] = None,
        config: Optional[RAGConfig] = None,
    ):
        """
        Initialize document ranker.

        Args:
            summary_searcher: Vector similarity searcher.
            keyword_filter: BM25 keyword searcher.
            query_analyzer: Query analyzer for keyword extraction.
            document_store: Optional doc store (for recency scoring).
            config: RAG configuration.
        """
        self.searcher = summary_searcher
        self.keyword = keyword_filter
        self.analyzer = query_analyzer
        self.doc_store = document_store
        self.config = config or get_rag_config()
        self._macro = self.config.macro

    # =========================================================================
    # Public API
    # =========================================================================

    def rank(self, query: RAGQuery) -> MacroResult:
        """
        Execute full macro-retrieval pipeline.

        Steps:
            1. Analyze query → keywords + embedding
            2. Vector search over summary index
            3. Keyword search over keyword index
            4. Combine scores with hybrid weights
            5. Select top-K documents

        Args:
            query: RAG query.

        Returns:
            MacroResult with top document IDs and scores.
        """
        t0 = time.time()

        # Step 1: Analyze query
        analyzed = self.analyzer.analyze(query.text, generate_embedding=True)

        # Step 2: Vector search
        vector_results = self._vector_search(analyzed, query)

        # Step 3: Keyword search
        keyword_results = self._keyword_search(analyzed, query)

        # Step 4: Combine and rank
        ranked = self._combine_scores(
            vector_results,
            keyword_results,
            analyzed,
        )

        # Step 5: Select top-K
        max_docs = min(
            query.max_documents,
            self._macro.max_documents,
        )
        top_docs = ranked[:max_docs]

        # Ensure minimum documents if available
        if len(top_docs) < self._macro.min_documents and ranked:
            top_docs = ranked[:self._macro.min_documents]

        elapsed = (time.time() - t0) * 1000

        result = MacroResult(
            document_ids=[d.document_id for d in top_docs],
            scores={d.document_id: d.final_score for d in top_docs},
            total_candidates=len(ranked),
            time_ms=elapsed,
        )

        logger.info(
            f"Macro-retrieval: {len(result.document_ids)} docs selected "
            f"from {result.total_candidates} candidates in {elapsed:.1f}ms"
        )

        return result

    def rank_with_analyzed(
        self,
        analyzed: AnalyzedQuery,
        query: RAGQuery,
    ) -> MacroResult:
        """
        Rank using pre-analyzed query.

        Useful when the caller has already run QueryAnalyzer.
        """
        t0 = time.time()

        vector_results = self._vector_search(analyzed, query)
        keyword_results = self._keyword_search(analyzed, query)
        ranked = self._combine_scores(vector_results, keyword_results, analyzed)

        max_docs = min(query.max_documents, self._macro.max_documents)
        top_docs = ranked[:max_docs]

        if len(top_docs) < self._macro.min_documents and ranked:
            top_docs = ranked[:self._macro.min_documents]

        elapsed = (time.time() - t0) * 1000

        return MacroResult(
            document_ids=[d.document_id for d in top_docs],
            scores={d.document_id: d.final_score for d in top_docs},
            total_candidates=len(ranked),
            time_ms=elapsed,
        )

    # =========================================================================
    # Internal: Search Phases
    # =========================================================================

    def _vector_search(
        self,
        analyzed: AnalyzedQuery,
        query: RAGQuery,
    ) -> List[VectorSearchResult]:
        """Execute vector similarity search."""
        if analyzed.embedding is None:
            logger.debug("No query embedding; skipping vector search")
            return []

        try:
            return self.searcher.search(
                query_embedding=analyzed.embedding,
                top_k=self._macro.vector_top_k,
                min_similarity=self._macro.min_similarity,
            )
        except Exception as e:
            logger.warning(f"Vector search failed: {e}")
            return []

    def _keyword_search(
        self,
        analyzed: AnalyzedQuery,
        query: RAGQuery,
    ) -> List[KeywordSearchResult]:
        """Execute keyword BM25 search."""
        if not self._macro.enable_keyword:
            return []

        keywords = analyzed.all_keywords
        if not keywords:
            return []

        try:
            return self.keyword.search(
                query_keywords=keywords,
                top_k=self._macro.keyword_top_k,
                document_ids=query.document_ids,
            )
        except Exception as e:
            logger.warning(f"Keyword search failed: {e}")
            return []

    # =========================================================================
    # Internal: Score Combination
    # =========================================================================

    def _combine_scores(
        self,
        vector_results: List[VectorSearchResult],
        keyword_results: List[KeywordSearchResult],
        analyzed: AnalyzedQuery,
    ) -> List[RankedDocument]:
        """
        Combine vector, keyword, and recency scores.

        Two strategies, switched via `MacroConfig.fusion_method`:

        - "weighted" (legacy): max-normalize keyword scores then take a
          weighted sum:  final = w_vec*vec + w_kw*kw_norm + w_rec*recency
          Fragile when score distributions differ across signals.

        - "rrf" (default, Wave 4 RAG follow-up): Reciprocal Rank Fusion
          over (vector ranking, keyword ranking, recency ranking).
          Robust across distribution shift; doesn't require score
          normalization. Cormack et al., SIGIR 2009.
        """
        # Collect all candidate document IDs
        all_doc_ids: Set[str] = set()
        vec_scores: Dict[str, float] = {}
        kw_scores: Dict[str, float] = {}
        kw_terms: Dict[str, List[str]] = {}
        titles: Dict[str, str] = {}

        for vr in vector_results:
            all_doc_ids.add(vr.document_id)
            vec_scores[vr.document_id] = vr.score
            if vr.title:
                titles[vr.document_id] = vr.title

        for kr in keyword_results:
            all_doc_ids.add(kr.document_id)
            kw_scores[kr.document_id] = kr.score
            kw_terms[kr.document_id] = kr.matched_terms

        if not all_doc_ids:
            return []

        recency_scores = self._compute_recency_scores(all_doc_ids)

        method = (getattr(self._macro, "fusion_method", "weighted") or "weighted").lower()
        if method == "rrf":
            final_scores = self._fuse_rrf(
                all_doc_ids, vec_scores, kw_scores, recency_scores,
            )
        else:
            final_scores = self._fuse_weighted(
                all_doc_ids, vec_scores, kw_scores, recency_scores,
            )

        ranked: List[RankedDocument] = []
        for doc_id in all_doc_ids:
            ranked.append(RankedDocument(
                document_id=doc_id,
                final_score=final_scores.get(doc_id, 0.0),
                vector_score=vec_scores.get(doc_id, 0.0),
                keyword_score=kw_scores.get(doc_id, 0.0),
                recency_score=recency_scores.get(doc_id, 0.0),
                matched_keywords=kw_terms.get(doc_id, []),
                title=titles.get(doc_id, ""),
            ))
        ranked.sort(key=lambda d: d.final_score, reverse=True)
        return ranked

    def _fuse_weighted(
        self,
        all_doc_ids: Set[str],
        vec_scores: Dict[str, float],
        kw_scores: Dict[str, float],
        recency_scores: Dict[str, float],
    ) -> Dict[str, float]:
        max_kw = max(kw_scores.values()) if kw_scores else 1.0
        kw_norm = (
            {d: s / max_kw for d, s in kw_scores.items()}
            if max_kw > 0 else dict(kw_scores)
        )
        w_vec = self._macro.vector_weight
        w_kw = self._macro.keyword_weight
        w_rec = self._macro.recency_weight
        return {
            d: w_vec * vec_scores.get(d, 0.0)
                + w_kw * kw_norm.get(d, 0.0)
                + w_rec * recency_scores.get(d, 0.0)
            for d in all_doc_ids
        }

    def _fuse_rrf(
        self,
        all_doc_ids: Set[str],
        vec_scores: Dict[str, float],
        kw_scores: Dict[str, float],
        recency_scores: Dict[str, float],
    ) -> Dict[str, float]:
        from ...retrieval.fusion import reciprocal_rank_fusion

        # Build the three ranked lists, descending by score.
        vec_rank = sorted(vec_scores.items(), key=lambda kv: -kv[1])
        kw_rank = sorted(kw_scores.items(), key=lambda kv: -kv[1])
        rec_rank = sorted(recency_scores.items(), key=lambda kv: -kv[1])
        weights = [
            self._macro.vector_weight,
            self._macro.keyword_weight,
            getattr(self._macro, "rrf_recency_weight", self._macro.recency_weight),
        ]
        fused = reciprocal_rank_fusion(
            ranked_lists=[
                [d for d, _ in vec_rank],
                [d for d, _ in kw_rank],
                [d for d, _ in rec_rank],
            ],
            k=getattr(self._macro, "rrf_k", 60),
            weights=weights,
        )
        scores: Dict[str, float] = {d: 0.0 for d in all_doc_ids}
        for doc_id, fused_score in fused:
            scores[doc_id] = fused_score
        return scores

    def _compute_recency_scores(
        self,
        doc_ids: Set[str],
    ) -> Dict[str, float]:
        """
        Compute recency scores for documents.

        More recently modified documents get higher scores.
        Score decays exponentially with age.
        """
        if not self.doc_store or self._macro.recency_weight == 0:
            return {}

        now = time.time()
        scores: Dict[str, float] = {}

        for doc_id in doc_ids:
            meta = self.doc_store.get_metadata(doc_id)
            if not meta:
                continue

            age_hours = max(0, (now - meta.modified_at) / 3600)

            # Exponential decay: score = exp(-age_hours / 720)
            # Half-life of ~500 hours (about 3 weeks)
            import math
            scores[doc_id] = math.exp(-age_hours / 720)

        return scores
