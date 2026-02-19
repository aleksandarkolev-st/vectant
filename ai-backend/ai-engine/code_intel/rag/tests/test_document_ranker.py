"""Tests for document ranker."""

import pytest
import time
from datetime import datetime, timezone
from ..types import DocumentSummary, DocumentMetadata, DocumentFormat
from ..macro.document_ranker import DocumentRanker, RankedDocument


class TestDocumentRanker:
    def setup_method(self):
        self.ranker = DocumentRanker(
            vector_weight=0.6,
            keyword_weight=0.3,
            recency_weight=0.1,
        )

    def _make_summary(self, doc_id, title="Test", mtime=None):
        return DocumentSummary(
            document_id=doc_id,
            title=title,
            summary_text=f"Summary for {doc_id}",
            key_topics=["test"],
            key_entities=[],
            content_hash=f"hash_{doc_id}",
        )

    def _make_metadata(self, doc_id, path="test.py", mtime=None):
        return DocumentMetadata(
            file_path=path,
            format=DocumentFormat.PYTHON,
            language="python",
            size_bytes=100,
            last_modified=mtime or datetime.now(timezone.utc).isoformat(),
        )

    def test_basic_ranking(self):
        vector_scores = {"doc1": 0.9, "doc2": 0.3}
        keyword_scores = {"doc1": 0.5, "doc2": 0.8}
        summaries = {
            "doc1": self._make_summary("doc1"),
            "doc2": self._make_summary("doc2"),
        }
        metadata = {
            "doc1": self._make_metadata("doc1"),
            "doc2": self._make_metadata("doc2"),
        }
        results = self.ranker.rank(
            vector_scores=vector_scores,
            keyword_scores=keyword_scores,
            summaries=summaries,
            metadata=metadata,
            max_documents=5,
        )
        assert len(results) == 2
        assert isinstance(results[0], RankedDocument)
        # doc1 has higher vector score (0.6 weight), should likely rank first
        assert results[0].document_id == "doc1"
        assert results[0].final_score > results[1].final_score

    def test_max_documents_limit(self):
        vector_scores = {f"doc{i}": 0.5 for i in range(10)}
        keyword_scores = {}
        summaries = {f"doc{i}": self._make_summary(f"doc{i}") for i in range(10)}
        metadata = {f"doc{i}": self._make_metadata(f"doc{i}") for i in range(10)}
        results = self.ranker.rank(
            vector_scores=vector_scores,
            keyword_scores=keyword_scores,
            summaries=summaries,
            metadata=metadata,
            max_documents=3,
        )
        assert len(results) <= 3

    def test_empty_inputs(self):
        results = self.ranker.rank(
            vector_scores={},
            keyword_scores={},
            summaries={},
            metadata={},
            max_documents=5,
        )
        assert results == []

    def test_vector_only(self):
        vector_scores = {"doc1": 0.8}
        summaries = {"doc1": self._make_summary("doc1")}
        metadata = {"doc1": self._make_metadata("doc1")}
        results = self.ranker.rank(
            vector_scores=vector_scores,
            keyword_scores={},
            summaries=summaries,
            metadata=metadata,
            max_documents=5,
        )
        assert len(results) == 1
        assert results[0].document_id == "doc1"

    def test_keyword_only(self):
        keyword_scores = {"doc1": 0.7}
        summaries = {"doc1": self._make_summary("doc1")}
        metadata = {"doc1": self._make_metadata("doc1")}
        results = self.ranker.rank(
            vector_scores={},
            keyword_scores=keyword_scores,
            summaries=summaries,
            metadata=metadata,
            max_documents=5,
        )
        assert len(results) == 1

    def test_scores_in_range(self):
        vector_scores = {"doc1": 1.0, "doc2": 0.0}
        keyword_scores = {"doc1": 1.0, "doc2": 0.0}
        summaries = {
            "doc1": self._make_summary("doc1"),
            "doc2": self._make_summary("doc2"),
        }
        metadata = {
            "doc1": self._make_metadata("doc1"),
            "doc2": self._make_metadata("doc2"),
        }
        results = self.ranker.rank(
            vector_scores=vector_scores,
            keyword_scores=keyword_scores,
            summaries=summaries,
            metadata=metadata,
            max_documents=5,
        )
        for r in results:
            assert 0.0 <= r.final_score <= 1.0
