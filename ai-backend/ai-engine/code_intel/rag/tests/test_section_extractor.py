"""Tests for section extractor."""

import pytest
import tempfile
import shutil
from ..types import Section, ToCNode, ToCNodeType
from ..store.section_store import SectionStore
from ..micro.section_extractor import SectionExtractor


class TestSectionExtractor:
    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        self.store = SectionStore(storage_dir=self.tmpdir)
        self.extractor = SectionExtractor(section_store=self.store)

        # Pre-populate store
        for i in range(5):
            section = Section(
                id=f"sec{i}",
                document_id="doc1",
                toc_node_id=f"node{i}",
                title=f"Section {i}",
                content=f"Content of section {i}. " * 20,
                start_line=i * 20 + 1,
                end_line=(i + 1) * 20,
                breadcrumbs=[f"Level {i}"],
            )
            self.store.add(section)

    def teardown_method(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_extract_by_node_ids(self):
        results = self.extractor.extract_by_node_ids(
            document_id="doc1",
            node_ids=["node0", "node1"],
        )
        assert len(results) == 2
        assert results[0].toc_node_id == "node0"

    def test_extract_nonexistent_node(self):
        results = self.extractor.extract_by_node_ids(
            document_id="doc1",
            node_ids=["nonexistent"],
        )
        assert len(results) == 0

    def test_token_budget_trim(self):
        results = self.extractor.extract_by_node_ids(
            document_id="doc1",
            node_ids=["node0", "node1", "node2", "node3", "node4"],
            token_budget=50,  # Very small budget
        )
        # Should return some sections, possibly trimmed
        assert isinstance(results, list)

    def test_empty_node_ids(self):
        results = self.extractor.extract_by_node_ids(
            document_id="doc1",
            node_ids=[],
        )
        assert results == []

    def test_extract_all_for_document(self):
        results = self.extractor.extract_by_node_ids(
            document_id="doc1",
            node_ids=[f"node{i}" for i in range(5)],
        )
        assert len(results) == 5

    def test_wrong_document_id(self):
        results = self.extractor.extract_by_node_ids(
            document_id="wrong_doc",
            node_ids=["node0"],
        )
        assert len(results) == 0
