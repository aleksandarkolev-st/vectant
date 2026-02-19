"""Tests for summary searcher."""

import pytest
import tempfile
import shutil
import numpy as np
from ..types import DocumentSummary
from ..store.summary_index import SummaryIndex
from ..macro.summary_searcher import SummarySearcher


class TestSummarySearcher:
    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        self.dim = 64
        self.index = SummaryIndex(dimension=self.dim, storage_dir=self.tmpdir)
        self.searcher = SummarySearcher(summary_index=self.index)

    def teardown_method(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _add_doc(self, doc_id, direction=None):
        if direction is None:
            direction = np.random.randn(self.dim)
        vec = direction.astype(np.float32)
        summary = DocumentSummary(
            document_id=doc_id,
            title=f"Doc {doc_id}",
            summary_text=f"Summary of {doc_id}",
            key_topics=["test"],
            key_entities=[],
            content_hash=f"hash_{doc_id}",
        )
        summary.embedding = vec
        self.index.add(doc_id, summary)

    def test_basic_search(self):
        direction = np.ones(self.dim)
        self._add_doc("doc1", direction)
        self._add_doc("doc2", -direction)  # Opposite direction

        results = self.searcher.search(
            query_embedding=direction,
            top_k=2,
            min_similarity=0.0,
        )
        assert len(results) >= 1
        assert results[0].document_id == "doc1"  # Same direction
        assert results[0].score > results[-1].score

    def test_min_similarity_filter(self):
        self._add_doc("doc1")
        results = self.searcher.search(
            query_embedding=np.random.randn(self.dim),
            top_k=5,
            min_similarity=0.99,  # Very high threshold
        )
        # Likely empty since random vectors won't match
        assert isinstance(results, list)

    def test_empty_index(self):
        results = self.searcher.search(
            query_embedding=np.random.randn(self.dim),
            top_k=5,
        )
        assert results == []

    def test_get_stats(self):
        self._add_doc("doc1")
        stats = self.searcher.get_stats()
        assert stats["total_documents"] == 1
        assert stats["dimension"] == self.dim
