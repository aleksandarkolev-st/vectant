"""Tests for ToC store."""

import pytest
import tempfile
import shutil
from ..types import ToCNode, ToCTree, ToCNodeType
from ..store.toc_store import ToCStore


class TestToCStore:
    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        self.store = ToCStore(storage_dir=self.tmpdir)

    def teardown_method(self):
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _make_tree(self, doc_id="doc1"):
        root = ToCNode(id="root", title="Root", node_type=ToCNodeType.ROOT, depth=0)
        h1 = ToCNode(id="h1", title="Intro", depth=1, parent_id="root")
        h2 = ToCNode(id="h2", title="Details", depth=1, parent_id="root")
        root.children = [h1, h2]
        return ToCTree(document_id=doc_id, root=root)

    def test_add_and_get(self):
        tree = self._make_tree()
        self.store.add("doc1", tree)
        retrieved = self.store.get("doc1")
        assert retrieved is not None
        assert retrieved.document_id == "doc1"
        assert len(retrieved.root.children) == 2

    def test_get_nonexistent(self):
        assert self.store.get("nonexistent") is None

    def test_remove(self):
        tree = self._make_tree()
        self.store.add("doc1", tree)
        assert self.store.count() == 1
        self.store.remove("doc1")
        assert self.store.count() == 0

    def test_count(self):
        assert self.store.count() == 0
        self.store.add("doc1", self._make_tree("doc1"))
        assert self.store.count() == 1
        self.store.add("doc2", self._make_tree("doc2"))
        assert self.store.count() == 2

    def test_get_node(self):
        tree = self._make_tree()
        self.store.add("doc1", tree)
        node = self.store.get_node("doc1", "h1")
        assert node is not None
        assert node.title == "Intro"

    def test_clear(self):
        self.store.add("doc1", self._make_tree())
        self.store.clear()
        assert self.store.count() == 0

    def test_persistence(self):
        self.store.add("doc1", self._make_tree())
        # Create new store from same directory
        store2 = ToCStore(storage_dir=self.tmpdir)
        retrieved = store2.get("doc1")
        assert retrieved is not None
        assert len(retrieved.root.children) == 2
