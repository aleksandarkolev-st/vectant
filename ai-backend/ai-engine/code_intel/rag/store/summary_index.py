"""
Summary Index — Fast vector index for document summaries.

Provides the high-speed vector database for macro-retrieval (Step 2).
Uses numpy for brute-force search on small corpora, with an option
to scale to HNSW for larger collections.

Design mirrors the existing VectorIndex in code_intel.indexer but is
purpose-built for document-level summaries (not code chunks).
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import shutil
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np

from ..types import DocumentSummary
from ..config import StoreConfig
from ..exceptions import StoreError, IndexCorruptionError


logger = logging.getLogger("code_intel.rag.store.summary_index")


class SummarySearchResult:
    """Result from summary vector search."""

    def __init__(
        self,
        document_id: str,
        score: float,
        summary: Optional[DocumentSummary] = None,
    ):
        self.document_id = document_id
        self.score = score
        self.summary = summary

    def __repr__(self) -> str:
        return f"SummarySearchResult(doc={self.document_id}, score={self.score:.4f})"


class SummaryIndex:
    """
    Fast vector index for document summaries.

    Stores document summary embeddings in a numpy matrix for
    efficient cosine similarity search.

    BINARY STORAGE: Uses .npz format for compact, fast persistence.
    VECTORIZED SEARCH: Single matrix multiply (not Python loops).
    L2-NORMALIZED: All vectors normalized on insertion for cosine sim.
    """

    def __init__(
        self,
        dimension: int = 3072,
        storage_dir: str = "",
        config: Optional[StoreConfig] = None,
    ):
        """
        Initialize summary index.

        Args:
            dimension: Embedding vector dimension.
            storage_dir: Directory for persistence files.
            config: Store configuration.
        """
        self.dimension = dimension
        self.config = config or StoreConfig()
        self.storage_dir = Path(storage_dir) if storage_dir else None

        # Vector storage
        self._ids: List[str] = []
        self._matrix: Optional[np.ndarray] = None  # (N, dim) float32
        self._id_to_idx: Dict[str, int] = {}

        # Summary metadata storage
        self._summaries: Dict[str, DocumentSummary] = {}

        # Paths
        self._vectors_path: Optional[Path] = None
        self._summaries_path: Optional[Path] = None
        if self.storage_dir:
            self.storage_dir = Path(storage_dir)
            self.storage_dir.mkdir(parents=True, exist_ok=True)
            self._vectors_path = self.storage_dir / self.config.vectors_file
            self._summaries_path = self.storage_dir / self.config.summaries_file

    # =========================================================================
    # Index Operations
    # =========================================================================

    def add(
        self,
        document_id: str,
        embedding: np.ndarray,
        summary: DocumentSummary,
        auto_save: bool = False,
    ) -> None:
        """
        Add a document summary with its embedding.

        Args:
            document_id: Document ID.
            embedding: Summary embedding vector.
            summary: DocumentSummary object.
            auto_save: If True, persist to disk immediately after adding.

        Raises:
            StoreError: If embedding dimensions don't match.
        """
        if embedding.shape != (self.dimension,):
            raise StoreError(
                f"Embedding dimension mismatch: expected {self.dimension}, "
                f"got {embedding.shape}",
                details={"document_id": document_id},
            )

        # L2 normalize
        norm = np.linalg.norm(embedding)
        if norm > 0:
            embedding = embedding / norm

        embedding = embedding.astype(np.float32)

        # Check if already exists (update)
        if document_id in self._id_to_idx:
            idx = self._id_to_idx[document_id]
            self._matrix[idx] = embedding
        else:
            # Append
            self._ids.append(document_id)
            self._id_to_idx[document_id] = len(self._ids) - 1

            if self._matrix is None:
                self._matrix = embedding.reshape(1, -1)
            else:
                self._matrix = np.vstack([self._matrix, embedding.reshape(1, -1)])

        self._summaries[document_id] = summary

        if auto_save:
            self.save()

    def remove(self, document_id: str) -> bool:
        """
        Remove a document from the index.

        Returns:
            True if document was removed.
        """
        if document_id not in self._id_to_idx:
            return False

        idx = self._id_to_idx[document_id]

        # Remove from arrays
        self._ids.pop(idx)
        self._summaries.pop(document_id, None)

        if self._matrix is not None and len(self._ids) > 0:
            self._matrix = np.delete(self._matrix, idx, axis=0)
        else:
            self._matrix = None

        # Rebuild index mapping
        self._id_to_idx = {did: i for i, did in enumerate(self._ids)}

        return True

    def search(
        self,
        query_embedding: np.ndarray,
        top_k: int = 5,
        min_similarity: float = 0.0,
    ) -> List[SummarySearchResult]:
        """
        Search for similar document summaries.

        Uses vectorized cosine similarity (single matrix multiply).

        Args:
            query_embedding: Query vector (same dimension as index).
            top_k: Maximum results to return.
            min_similarity: Minimum cosine similarity threshold.

        Returns:
            List of SummarySearchResult sorted by score (descending).
        """
        if self._matrix is None or len(self._ids) == 0:
            return []

        # L2 normalize query
        query = np.asarray(query_embedding, dtype=np.float32).reshape(1, -1)
        norm = np.linalg.norm(query)
        if norm > 0:
            query = query / norm

        # Dimension check
        if query.shape[1] != self._matrix.shape[1]:
            logger.warning(
                f"Query dimension {query.shape[1]} != index dimension "
                f"{self._matrix.shape[1]}"
            )
            return []

        # Vectorized cosine similarity (all vectors are L2-normalized)
        scores = (self._matrix @ query.T).flatten()

        # Filter by minimum similarity
        valid_mask = scores >= min_similarity
        valid_indices = np.where(valid_mask)[0]

        if len(valid_indices) == 0:
            return []

        # Get top-k indices
        valid_scores = scores[valid_indices]
        if len(valid_indices) > top_k:
            top_indices = np.argpartition(valid_scores, -top_k)[-top_k:]
            top_indices = top_indices[np.argsort(valid_scores[top_indices])[::-1]]
        else:
            top_indices = np.argsort(valid_scores)[::-1]

        results: List[SummarySearchResult] = []
        for idx in top_indices:
            real_idx = valid_indices[idx]
            doc_id = self._ids[real_idx]
            score = float(scores[real_idx])
            summary = self._summaries.get(doc_id)
            results.append(SummarySearchResult(doc_id, score, summary))

        return results

    def get_summary(self, document_id: str) -> Optional[DocumentSummary]:
        """Get stored summary for a document."""
        return self._summaries.get(document_id)

    def get_all_summaries(self) -> Dict[str, DocumentSummary]:
        """Get all stored summaries."""
        return self._summaries.copy()

    def count(self) -> int:
        """Get number of indexed documents."""
        return len(self._ids)

    def clear(self) -> None:
        """Clear the entire index."""
        self._ids = []
        self._matrix = None
        self._id_to_idx = {}
        self._summaries = {}

    # =========================================================================
    # Persistence
    # =========================================================================

    def save(self) -> None:
        """Save index to disk."""
        if not self.storage_dir:
            return

        try:
            # Save vectors as .npz
            if self._vectors_path and self._matrix is not None:
                self._atomic_save_npz(
                    self._vectors_path,
                    matrix=self._matrix,
                    ids=np.array(self._ids, dtype=object),
                )

            # Save summaries as JSON
            if self._summaries_path:
                raw = {
                    doc_id: summary.to_dict()
                    for doc_id, summary in self._summaries.items()
                }
                content = json.dumps(raw, indent=2, ensure_ascii=False)
                self._atomic_write(self._summaries_path, content)

        except Exception as e:
            raise StoreError(
                "Failed to save summary index",
                cause=e,
            )

    def load(self) -> bool:
        """
        Load index from disk.

        Returns:
            True if loaded successfully.
        """
        if not self.storage_dir:
            return False

        loaded = False

        # Load vectors
        if self._vectors_path and self._vectors_path.exists():
            try:
                data = np.load(str(self._vectors_path), allow_pickle=True)
                self._matrix = data["matrix"].astype(np.float32)
                self._ids = list(data["ids"])
                self._id_to_idx = {did: i for i, did in enumerate(self._ids)}

                # Dimension check
                if self._matrix.shape[1] != self.dimension:
                    logger.warning(
                        f"Index dimension {self._matrix.shape[1]} != "
                        f"configured {self.dimension}. Rebuilding."
                    )
                    self.clear()
                    return False

                loaded = True
            except Exception as e:
                logger.warning(f"Failed to load vectors: {e}")
                self.clear()

        # Load summaries
        if self._summaries_path and self._summaries_path.exists():
            try:
                with open(self._summaries_path, "r", encoding="utf-8") as f:
                    raw = json.load(f)
                self._summaries = {
                    doc_id: DocumentSummary.from_dict(data)
                    for doc_id, data in raw.items()
                }
                loaded = True
            except Exception as e:
                logger.warning(f"Failed to load summaries: {e}")

        return loaded

    @staticmethod
    def _atomic_save_npz(path: Path, **arrays) -> None:
        """Save numpy arrays atomically."""
        dir_path = path.parent
        dir_path.mkdir(parents=True, exist_ok=True)

        fd, tmp_path = tempfile.mkstemp(
            dir=str(dir_path),
            prefix=".tmp_vec_",
            suffix=".npz",
        )
        os.close(fd)
        try:
            np.savez(tmp_path, **arrays)
            shutil.move(tmp_path, str(path))
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise

    @staticmethod
    def _atomic_write(path: Path, content: str) -> None:
        """Write content atomically."""
        dir_path = path.parent
        fd, tmp_path = tempfile.mkstemp(
            dir=str(dir_path),
            prefix=".tmp_sum_",
            suffix=".json",
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(content)
            shutil.move(tmp_path, str(path))
        except Exception:
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
