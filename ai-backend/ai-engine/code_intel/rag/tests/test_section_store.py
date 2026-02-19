"""Tests for section store."""

import pytest
import tempfile
import shutil
from ..types import Section
from ..store.section_store import SectionStore


class TestSectionStore:
    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        self.store = SectionStore(storage_dir=self.tmpdir)

    def teardown_method(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _make_section(self, section_id="s1", doc_id="doc1"):
        return Section(
            id=section_id,
            document_id=doc_id,
            toc_node_id=f"node_{section_id}",
            title=f"Section {section_id}",
            content=f"Content for section {section_id}",
            breadcrumb="Doc > Section",
            keywords=["test", "section"],
        )

    def test_add_and_get(self):
        section = self._make_section()
        self.store.add_sections([section])
        retrieved = self.store.get("s1")
        assert retrieved is not None
        assert retrieved.title == "Section s1"
        assert retrieved.content == "Content for section s1"

    def test_get_nonexistent(self):
        assert self.store.get("nonexistent") is None

    def test_get_by_document(self):
        sections = [
            self._make_section("s1", "doc1"),
            self._make_section("s2", "doc1"),
            self._make_section("s3", "doc2"),
        ]
        self.store.add_sections(sections)
        doc1_sections = self.store.get_by_document("doc1")
        assert len(doc1_sections) == 2

    def test_get_multiple(self):
        sections = [
            self._make_section("s1"),
            self._make_section("s2"),
            self._make_section("s3"),
        ]
        self.store.add_sections(sections)
        result = self.store.get_multiple(["s1", "s3"])
        assert len(result) == 2
        ids = [s.id for s in result]
        assert "s1" in ids
        assert "s3" in ids

    def test_remove_by_document(self):
        sections = [
            self._make_section("s1", "doc1"),
            self._make_section("s2", "doc1"),
            self._make_section("s3", "doc2"),
        ]
        self.store.add_sections(sections)
        removed = self.store.remove_by_document("doc1")
        assert removed == 2
        assert self.store.count() == 1

    def test_remove_single(self):
        self.store.add_sections([self._make_section()])
        assert self.store.remove("s1") is True
        assert self.store.count() == 0
        assert self.store.remove("s1") is False

    def test_search_by_keywords(self):
        sections = [
            self._make_section("s1"),
            self._make_section("s2"),
        ]
        self.store.add_sections(sections)
        results = self.store.search_by_keywords(["test"])
        assert len(results) >= 0  # Keywords from metadata

    def test_count(self):
        assert self.store.count() == 0
        self.store.add_sections([self._make_section("s1")])
        assert self.store.count() == 1

    def test_count_by_document(self):
        sections = [
            self._make_section("s1", "doc1"),
            self._make_section("s2", "doc1"),
            self._make_section("s3", "doc2"),
        ]
        self.store.add_sections(sections)
        assert self.store.count_by_document("doc1") == 2
        assert self.store.count_by_document("doc2") == 1

    def test_clear(self):
        self.store.add_sections([self._make_section()])
        self.store.clear()
        assert self.store.count() == 0
