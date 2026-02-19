"""Tests for keyword filter (BM25)."""

import pytest
import tempfile
import shutil
from ..macro.keyword_filter import KeywordFilter


class TestKeywordFilter:
    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        self.kf = KeywordFilter(storage_dir=self.tmpdir)

    def teardown_method(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_add_and_search(self):
        self.kf.add_document("doc1", "Python is a programming language")
        self.kf.add_document("doc2", "JavaScript is used for web development")
        results = self.kf.search("Python programming", top_k=5)
        assert len(results) > 0
        assert results[0][0] == "doc1"

    def test_empty_search(self):
        results = self.kf.search("anything", top_k=5)
        assert results == []

    def test_remove_document(self):
        self.kf.add_document("doc1", "test content here")
        self.kf.remove_document("doc1")
        results = self.kf.search("test content", top_k=5)
        assert results == []

    def test_persistence(self):
        self.kf.add_document("doc1", "persistent data check")
        self.kf.save()
        kf2 = KeywordFilter(storage_dir=self.tmpdir)
        kf2.load()
        results = kf2.search("persistent data", top_k=5)
        assert len(results) > 0
        assert results[0][0] == "doc1"

    def test_multiple_term_match(self):
        self.kf.add_document("doc1", "alpha beta gamma")
        self.kf.add_document("doc2", "alpha delta epsilon")
        self.kf.add_document("doc3", "zeta eta theta")
        results = self.kf.search("alpha beta", top_k=5)
        assert len(results) >= 1
        doc_ids = [r[0] for r in results]
        assert "doc1" in doc_ids

    def test_get_stats(self):
        self.kf.add_document("doc1", "some words here")
        stats = self.kf.get_stats()
        assert stats["total_documents"] == 1
        assert stats["vocabulary_size"] > 0

    def test_clear(self):
        self.kf.add_document("doc1", "data to clear")
        self.kf.clear()
        assert self.kf.get_stats()["total_documents"] == 0
