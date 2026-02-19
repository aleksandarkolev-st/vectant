"""Tests for document store."""

import pytest
import tempfile
import os
from ..types import DocumentFormat, DocumentMetadata, Document
from ..store.document_store import DocumentStore


class TestDocumentStore:
    def setup_method(self):
        self.tmpdir = tempfile.mkdtemp()
        self.store = DocumentStore(storage_dir=self.tmpdir)

    def teardown_method(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def _make_doc(self, doc_id="doc1", content="Hello world"):
        meta = DocumentMetadata(
            file_path="/test/doc.md",
            file_name="doc.md",
            format=DocumentFormat.MARKDOWN,
            size_bytes=len(content),
            content_hash=f"hash_{doc_id}",
            title="Test Doc",
        )
        return Document(id=doc_id, metadata=meta, content=content)

    def test_add_and_get(self):
        doc = self._make_doc()
        self.store.add(doc)
        retrieved = self.store.get("doc1")
        assert retrieved is not None
        assert retrieved.content == "Hello world"
        assert retrieved.metadata.title == "Test Doc"

    def test_get_nonexistent(self):
        result = self.store.get("nonexistent")
        assert result is None

    def test_get_metadata(self):
        doc = self._make_doc()
        self.store.add(doc)
        meta = self.store.get_metadata("doc1")
        assert meta is not None
        assert meta.title == "Test Doc"

    def test_remove(self):
        doc = self._make_doc()
        self.store.add(doc)
        assert self.store.count() == 1
        self.store.remove("doc1")
        assert self.store.count() == 0

    def test_list_ids(self):
        self.store.add(self._make_doc("doc1"))
        self.store.add(self._make_doc("doc2"))
        ids = self.store.list_ids()
        assert set(ids) == {"doc1", "doc2"}

    def test_count(self):
        assert self.store.count() == 0
        self.store.add(self._make_doc("a"))
        assert self.store.count() == 1
        self.store.add(self._make_doc("b"))
        assert self.store.count() == 2

    def test_clear(self):
        self.store.add(self._make_doc("a"))
        self.store.add(self._make_doc("b"))
        self.store.clear()
        assert self.store.count() == 0

    def test_content_hash_dedup(self):
        doc = self._make_doc()
        self.store.add(doc)
        by_hash = self.store.get_by_hash("hash_doc1")
        assert by_hash is not None
        assert by_hash.id == "doc1"

    def test_update(self):
        doc = self._make_doc("doc1", "original")
        self.store.add(doc)

        updated = self._make_doc("doc1", "updated content")
        self.store.update(updated)

        retrieved = self.store.get("doc1")
        assert retrieved.content == "updated content"
