"""Tests for RAG pipeline."""

import pytest
import tempfile
import shutil
import os
from unittest.mock import patch, MagicMock
from ..pipeline import RAGPipeline
from ..config import RAGConfig
from ..types import RAGResult


class TestRAGPipeline:
    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        self.config = RAGConfig()
        self.config.store.storage_dir = self.tmpdir
        self.pipeline = RAGPipeline(config=self.config)

    def teardown_method(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_initialization(self):
        assert self.pipeline is not None
        assert self.pipeline._config == self.config

    def test_get_stats_empty(self):
        stats = self.pipeline.get_stats()
        assert isinstance(stats, dict)
        assert stats.get("documents", 0) == 0

    def test_ingest_single_file(self):
        # Create a test markdown file
        test_file = os.path.join(self.tmpdir, "test.md")
        with open(test_file, "w", encoding="utf-8") as f:
            f.write("# Hello World\n\nThis is a test document.\n\n## Section A\n\nContent A here.\n")

        self.pipeline.ingest_file(test_file)
        stats = self.pipeline.get_stats()
        assert stats.get("documents", 0) >= 1

    def test_ingest_directory(self):
        # Create test files
        for i in range(3):
            fpath = os.path.join(self.tmpdir, f"doc{i}.md")
            with open(fpath, "w", encoding="utf-8") as f:
                f.write(f"# Document {i}\n\nContent of document {i}.\n")

        self.pipeline.ingest_directory(self.tmpdir)
        stats = self.pipeline.get_stats()
        assert stats.get("documents", 0) >= 1

    def test_clear(self):
        test_file = os.path.join(self.tmpdir, "test.md")
        with open(test_file, "w", encoding="utf-8") as f:
            f.write("# Test\n\nContent.\n")
        self.pipeline.ingest_file(test_file)
        self.pipeline.clear()
        stats = self.pipeline.get_stats()
        assert stats.get("documents", 0) == 0

    def test_query_empty_index(self):
        result = self.pipeline.query("What is Python?")
        assert isinstance(result, RAGResult)
        # Should handle empty index gracefully
        assert result.answer is not None

    def test_lazy_component_init(self):
        """Components should be lazily initialized."""
        # Before any operation, internal instances should be None
        assert self.pipeline._document_store_instance is None
        assert self.pipeline._toc_store_instance is None

    def test_double_ingest_dedup(self):
        """Ingesting the same file twice should not duplicate."""
        test_file = os.path.join(self.tmpdir, "test.md")
        with open(test_file, "w", encoding="utf-8") as f:
            f.write("# Test\n\nContent here.\n")
        self.pipeline.ingest_file(test_file)
        self.pipeline.ingest_file(test_file)
        stats = self.pipeline.get_stats()
        assert stats.get("documents", 0) == 1
