"""Tests for page resolver."""

import pytest
import tempfile
import shutil
from ..types import Section, SectionReference
from ..store.section_store import SectionStore
from ..micro.page_resolver import PageResolver, ResolvedLocation


class TestPageResolver:
    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        self.store = SectionStore(storage_dir=self.tmpdir)
        self.resolver = PageResolver(section_store=self.store)

        section = Section(
            id="sec1",
            document_id="doc1",
            toc_node_id="node1",
            title="Installation Guide",
            content="Step 1: Download.\nStep 2: Install.\nStep 3: Configure.",
            start_line=10,
            end_line=30,
            breadcrumbs=["Getting Started", "Installation Guide"],
        )
        self.store.add(section)

    def teardown_method(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_resolve_reference(self):
        ref = SectionReference(
            document_id="doc1",
            section_id="sec1",
            relevance_score=0.9,
        )
        loc = self.resolver.resolve_reference(ref)
        assert loc is not None
        assert isinstance(loc, ResolvedLocation)
        assert loc.section_id == "sec1"
        assert loc.title == "Installation Guide"
        assert loc.start_line == 10
        assert loc.end_line == 30

    def test_resolve_nonexistent(self):
        ref = SectionReference(
            document_id="doc1",
            section_id="nonexistent",
            relevance_score=0.5,
        )
        loc = self.resolver.resolve_reference(ref)
        assert loc is None

    def test_resolve_multiple(self):
        # Add a second section
        section2 = Section(
            id="sec2",
            document_id="doc1",
            toc_node_id="node2",
            title="Usage",
            content="Use like this.",
            start_line=31,
            end_line=40,
            breadcrumbs=["Usage"],
        )
        self.store.add(section2)

        refs = [
            SectionReference(document_id="doc1", section_id="sec1", relevance_score=0.9),
            SectionReference(document_id="doc1", section_id="sec2", relevance_score=0.7),
        ]
        locations = self.resolver.resolve_references(refs)
        assert len(locations) == 2

    def test_resolve_node_ids(self):
        locations = self.resolver.resolve_node_ids("doc1", ["node1"])
        assert len(locations) >= 1
        assert locations[0].title == "Installation Guide"

    def test_breadcrumbs_preserved(self):
        ref = SectionReference(
            document_id="doc1",
            section_id="sec1",
            relevance_score=0.9,
        )
        loc = self.resolver.resolve_reference(ref)
        assert loc.breadcrumbs == ["Getting Started", "Installation Guide"]
