"""
Summary Searcher — Vector similarity search over document summaries.

Uses the SummaryIndex to find documents whose summaries are most
similar to the query embedding. This is the primary signal for
macro-retrieval.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

from ..config import MacroConfig, RAGConfig, get_rag_config
from ..store.summary_index import SummaryIndex, SummarySearchResult
from ..exceptions import MacroRetrievalError

logger = logging.getLogger("code_intel.rag.macro.summary_searcher")


@dataclass
class VectorSearchResult:
    """Result from vector similarity search."""
    document_id: str
    score: float                    # Cosine similarity [0, 1]
    title: str = ""
    summary_text: str = ""

    def __repr__(self) -> str:
        return f"VectorSearchResult(doc={self.document_id}, score={self.score:.4f})"


class SummarySearcher:
    """
    Search document summaries by vector similarity.

    Wraps the SummaryIndex with:
    - Score normalization to [0, 1]
    - Minimum similarity filtering
    - Result enrichment with summary text
    - Performance timing
    """

    def __init__(
        self,
        summary_index: SummaryIndex,
        config: Optional[RAGConfig] = None,
    ):
        """
        Initialize summary searcher.

        Args:
            summary_index: The vector index of document summaries.
            config: RAG configuration.
        """
        self.index = summary_index
        self.config = config or get_rag_config()
        self._macro = self.config.macro

    # =========================================================================
    # Public API
    # =========================================================================

    def search(
        self,
        query_embedding: Any,
        top_k: Optional[int] = None,
        min_similarity: Optional[float] = None,
    ) -> List[VectorSearchResult]:
        """
        Search for similar document summaries.

        Args:
            query_embedding: Embedding vector for the query (list or numpy).
            top_k: Number of results. Defaults to config.vector_top_k.
            min_similarity: Minimum similarity threshold.

        Returns:
            Sorted list of VectorSearchResult (highest score first).
        """
        top_k = top_k or self._macro.vector_top_k
        min_sim = min_similarity if min_similarity is not None else self._macro.min_similarity

        t0 = time.time()

        try:
            raw_results = self.index.search(query_embedding, top_k=top_k)
        except Exception as e:
            raise MacroRetrievalError(f"Vector search failed: {e}") from e

        elapsed = (time.time() - t0) * 1000

        # Convert and filter
        results: List[VectorSearchResult] = []
        for sr in raw_results:
            score = _normalize_score(sr.score)
            if score >= min_sim:
                result = VectorSearchResult(
                    document_id=sr.document_id,
                    score=score,
                    title=sr.summary.title if sr.summary else "",
                    summary_text=sr.summary.summary_text if sr.summary else "",
                )
                results.append(result)

        logger.debug(
            f"Vector search: {len(results)}/{len(raw_results)} results "
            f"above threshold {min_sim:.2f} in {elapsed:.1f}ms"
        )

        return results

    def search_with_text(
        self,
        query_text: str,
        top_k: Optional[int] = None,
        min_similarity: Optional[float] = None,
        embedder: Optional[Any] = None,
    ) -> List[VectorSearchResult]:
        """
        Search using raw text (generates embedding on the fly).

        Convenience method for when you don't have a pre-computed embedding.

        Args:
            query_text: Raw query text.
            top_k: Number of results.
            min_similarity: Minimum similarity.
            embedder: Embedder instance. If None, creates one.

        Returns:
            Sorted list of VectorSearchResult.
        """
        if embedder is None:
            embedder = self._get_embedder()

        if embedder is None:
            raise MacroRetrievalError("No embedder available for text search")

        try:
            embedding = embedder.embed_query(query_text)
        except Exception as e:
            raise MacroRetrievalError(f"Failed to embed query: {e}") from e

        return self.search(
            query_embedding=embedding,
            top_k=top_k,
            min_similarity=min_similarity,
        )

    def get_stats(self) -> Dict[str, Any]:
        """Get index statistics."""
        return {
            "total_documents": self.index.count(),
            "dimension": self.index.dimension,
            "config": {
                "vector_top_k": self._macro.vector_top_k,
                "min_similarity": self._macro.min_similarity,
            },
        }

    # =========================================================================
    # Internal
    # =========================================================================

    def _get_embedder(self) -> Optional[Any]:
        """Lazy-load embedder."""
        try:
            from ...indexer.embedder import Embedder
            return Embedder(
                model=self.config.embedding_model,
                api_key=self.config.embedding_api_key,
            )
        except (ImportError, Exception) as e:
            logger.warning(f"Could not load Embedder: {e}")
            return None


def _normalize_score(raw_score: float) -> float:
    """
    Normalize a raw cosine similarity score to [0, 1].

    The SummaryIndex uses L2-normalized vectors, so cosine similarity
    is already in [-1, 1]. We clamp to [0, 1] since negative similarity
    means anti-correlation (irrelevant).
    """
    return max(0.0, min(1.0, raw_score))
