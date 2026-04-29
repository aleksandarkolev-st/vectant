"""Tests for incremental ingestion via the content_hash skip path."""
from __future__ import annotations

import os
import tempfile
import time
from pathlib import Path

import pytest

from code_intel.rag.config import RAGConfig
from code_intel.rag.ingestion.document_processor import DocumentProcessor


@pytest.fixture
def workspace():
    with tempfile.TemporaryDirectory() as d:
        # Three small markdown files
        for name, body in [
            ("a.md", "# A\n\nAlpha content paragraph."),
            ("b.md", "# B\n\nBeta content paragraph."),
            ("c.md", "# C\n\nGamma content paragraph."),
        ]:
            (Path(d) / name).write_text(body, encoding="utf-8")
        yield d


class TestIncrementalProcessor:
    def test_first_pass_processes_all(self, workspace):
        cfg = RAGConfig()
        proc = DocumentProcessor(config=cfg)
        result = proc.process_directory(workspace, already_indexed=set())
        assert result.documents_processed >= 1  # all ingested
        assert result.documents_unchanged == 0

    def test_second_pass_skips_unchanged(self, workspace):
        cfg = RAGConfig()
        proc = DocumentProcessor(config=cfg)

        # Run once to collect the hashes that would be indexed.
        first = proc.process_directory(workspace, already_indexed=set())
        hashes = {d.metadata.content_hash for d in first.documents}
        assert hashes  # non-empty

        # Run again; everything should now be classified as unchanged.
        proc2 = DocumentProcessor(config=cfg)
        second = proc2.process_directory(workspace, already_indexed=hashes)
        assert second.documents_unchanged == len(hashes)
        assert second.documents_processed == 0
        assert len(second.documents) == 0

    def test_partial_change_only_reprocesses_modified(self, workspace):
        cfg = RAGConfig()
        proc = DocumentProcessor(config=cfg)

        first = proc.process_directory(workspace, already_indexed=set())
        all_hashes = {d.metadata.content_hash for d in first.documents}

        # Modify one file so its content hash changes.
        target = Path(workspace) / "a.md"
        target.write_text("# A\n\nAlpha content with new addition.", encoding="utf-8")

        proc2 = DocumentProcessor(config=cfg)
        second = proc2.process_directory(workspace, already_indexed=all_hashes)
        # Two were unchanged, one was reprocessed.
        assert second.documents_unchanged == 2
        assert second.documents_processed == 1

    def test_unchanged_paths_reported(self, workspace):
        cfg = RAGConfig()
        proc = DocumentProcessor(config=cfg)

        first = proc.process_directory(workspace, already_indexed=set())
        all_hashes = {d.metadata.content_hash for d in first.documents}

        proc2 = DocumentProcessor(config=cfg)
        second = proc2.process_directory(workspace, already_indexed=all_hashes)
        # Unchanged paths must include all three filenames.
        names = {Path(p).name for p in second.unchanged_paths}
        assert {"a.md", "b.md", "c.md"}.issubset(names)
