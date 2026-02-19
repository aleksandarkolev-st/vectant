"""Tests for summary index."""

import pytest
import tempfile
import shutil
import numpy as np
from ..types import DocumentSummary
from ..store.summary_index import SummaryIndex, SummarySearchResult


class TestSummaryIndex:
    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        self.dim = 64  # Small dimension for tests
        self.index = SummaryIndex(dimension=self.dim, storage_dir=self.tmpdir)

    def teardown_method(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _make_summary(self, doc_id, embedding=None):
        if embedding is None:
            embedding = np.random.randn(self.dim).astype(np.float32)
        summary = DocumentSummary(
            document_id=doc_id,
            title=f"Doc {doc_id}",
            summary_text=f"Summary for {doc_id}",
            key_topics=["test"],
            key_entities=[],
            content_hash=f"hash_{doc_id}",
        )
        summary.embedding = embedding
        return summary

    def test_add_and_search(self):
        s1 = self._make_summary("doc1")
        s2 = self._make_summary("doc2")
        self.index.add("doc1", s1)
        self.index.add("doc2", s2)

        assert self.index.count() == 2

        # Search with doc1's embedding should find doc1
        results = self.index.search(s1.embedding, top_k=2)
        assert len(results) > 0
        assert results[0].document_id == "doc1"
        assert results[0].score >= results[-1].score

    def test_empty_search(self):
        query = np.random.randn(self.dim)
        results = self.index.search(query, top_k=5)
        assert len(results) == 0

    def test_remove(self):
        self.index.add("doc1", self._make_summary("doc1"))
        assert self.index.count() == 1
        self.index.remove("doc1")
        assert self.index.count() == 0

    def test_save_and_load(self):
        self.index.add("doc1", self._make_summary("doc1"))
        self.index.add("doc2", self._make_summary("doc2"))
        self.index.save()

        # Create new index from same directory
        index2 = SummaryIndex(dimension=self.dim, storage_dir=self.tmpdir)
        index2.load()
        assert index2.count() == 2

    def test_dimension_validation(self):
        summary = self._make_summary("doc1")
        summary.embedding = np.random.randn(self.dim + 10)  # Wrong dimension
        with pytest.raises(Exception):
            self.index.add("doc1", summary)

    def test_l2_normalization(self):
        """Vectors should be L2-normalized on insertion."""
        vec = np.array([3.0, 4.0] + [0.0] * (self.dim - 2))
        summary = self._make_summary("doc1", embedding=vec)
        self.index.add("doc1", summary)

        # The stored vector should be normalized
        results = self.index.search(vec, top_k=1)
        assert results[0].score == pytest.approx(1.0, abs=0.01)

    def test_clear(self):
        self.index.add("doc1", self._make_summary("doc1"))
        self.index.clear()
        assert self.index.count() == 0
