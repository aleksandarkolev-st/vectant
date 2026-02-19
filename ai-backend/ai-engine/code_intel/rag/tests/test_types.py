"""Tests for RAG type definitions."""

import pytest
from ..types import (
    DocumentFormat,
    ToCNodeType,
    SectionRelevance,
    DocumentMetadata,
    Document,
    ToCNode,
    ToCTree,
    Section,
    DocumentSummary,
    SectionReference,
    Citation,
    RAGQuery,
    MacroResult,
    MicroResult,
    RAGResult,
)


class TestDocumentMetadata:
    def test_creation(self):
        meta = DocumentMetadata(
            file_path="/test/doc.md",
            file_name="doc.md",
            format=DocumentFormat.MARKDOWN,
            size_bytes=1024,
            content_hash="abc123",
        )
        assert meta.file_path == "/test/doc.md"
        assert meta.format == DocumentFormat.MARKDOWN
        assert meta.content_hash == "abc123"

    def test_serialization_roundtrip(self):
        meta = DocumentMetadata(
            file_path="/test/doc.md",
            file_name="doc.md",
            format=DocumentFormat.MARKDOWN,
            size_bytes=1024,
            content_hash="abc123",
            language="",
            title="Test Doc",
            tags=["test", "docs"],
        )
        d = meta.to_dict()
        restored = DocumentMetadata.from_dict(d)
        assert restored.file_path == meta.file_path
        assert restored.format == meta.format
        assert restored.title == "Test Doc"
        assert restored.tags == ["test", "docs"]

    def test_hash_based_on_content(self):
        meta1 = DocumentMetadata(
            file_path="/a.md", file_name="a.md",
            format=DocumentFormat.MARKDOWN, size_bytes=100, content_hash="hash1",
        )
        meta2 = DocumentMetadata(
            file_path="/b.md", file_name="b.md",
            format=DocumentFormat.MARKDOWN, size_bytes=200, content_hash="hash1",
        )
        assert hash(meta1) == hash(meta2)  # Same content_hash


class TestDocument:
    def test_auto_id_generation(self):
        meta = DocumentMetadata(
            file_path="/test.md", file_name="test.md",
            format=DocumentFormat.MARKDOWN, size_bytes=100,
            content_hash="testhash",
        )
        doc = Document(id="", metadata=meta, content="Hello world")
        assert len(doc.id) == 24

    def test_title_fallback(self):
        meta = DocumentMetadata(
            file_path="/test.md", file_name="test.md",
            format=DocumentFormat.MARKDOWN, size_bytes=100,
            content_hash="hash",
        )
        doc = Document(id="test123", metadata=meta, content="")
        assert doc.title == "test.md"

        meta.title = "Custom Title"
        assert doc.title == "Custom Title"


class TestToCNode:
    def test_leaf_detection(self):
        leaf = ToCNode(id="n1", title="Leaf")
        assert leaf.is_leaf is True

        parent = ToCNode(id="n2", title="Parent", children=[leaf])
        assert parent.is_leaf is False

    def test_descendant_count(self):
        child1 = ToCNode(id="c1", title="C1")
        child2 = ToCNode(id="c2", title="C2")
        grandchild = ToCNode(id="gc1", title="GC1")
        child1.children = [grandchild]
        root = ToCNode(id="r", title="Root", children=[child1, child2])
        assert root.total_descendants == 3

    def test_serialization_roundtrip(self):
        child = ToCNode(
            id="c1", title="Child", depth=2,
            start_line=10, end_line=20,
            keywords=["auth", "login"],
        )
        parent = ToCNode(
            id="p1", title="Parent", depth=1,
            children=[child],
        )
        d = parent.to_dict()
        restored = ToCNode.from_dict(d)
        assert restored.id == "p1"
        assert len(restored.children) == 1
        assert restored.children[0].keywords == ["auth", "login"]


class TestToCTree:
    def _make_tree(self):
        root = ToCNode(id="root", title="Root", node_type=ToCNodeType.ROOT, depth=0)
        h1 = ToCNode(id="h1", title="Introduction", depth=1, parent_id="root")
        h2 = ToCNode(id="h2", title="Architecture", depth=1, parent_id="root")
        h2_1 = ToCNode(id="h2_1", title="Auth", depth=2, parent_id="h2")
        h2_2 = ToCNode(id="h2_2", title="Database", depth=2, parent_id="h2")
        h2.children = [h2_1, h2_2]
        root.children = [h1, h2]
        return ToCTree(document_id="doc1", root=root)

    def test_node_lookup(self):
        tree = self._make_tree()
        assert tree.get_node("h2_1") is not None
        assert tree.get_node("h2_1").title == "Auth"
        assert tree.get_node("nonexistent") is None

    def test_path_to_node(self):
        tree = self._make_tree()
        path = tree.get_path_to_node("h2_1")
        titles = [n.title for n in path]
        assert "Root" in titles
        assert "Architecture" in titles
        assert "Auth" in titles

    def test_siblings(self):
        tree = self._make_tree()
        siblings = tree.get_siblings("h2_1")
        assert len(siblings) == 1
        assert siblings[0].title == "Database"

    def test_flatten(self):
        tree = self._make_tree()
        flat = tree.flatten()
        assert len(flat) == 5  # root + h1 + h2 + h2_1 + h2_2

    def test_format_for_llm(self):
        tree = self._make_tree()
        formatted = tree.format_for_llm()
        assert "Introduction" in formatted
        assert "Architecture" in formatted
        assert "Auth" in formatted

    def test_serialization_roundtrip(self):
        tree = self._make_tree()
        d = tree.to_dict()
        restored = ToCTree.from_dict(d)
        assert restored.document_id == "doc1"
        assert restored.get_node("h2_1") is not None


class TestSection:
    def test_auto_token_count(self):
        section = Section(
            id="s1", document_id="d1", toc_node_id="n1",
            title="Test", content="Hello world this is a test",
        )
        assert section.token_count > 0

    def test_serialization_roundtrip(self):
        section = Section(
            id="s1", document_id="d1", toc_node_id="n1",
            title="Test", content="Content here",
            breadcrumb="Doc > Test",
            keywords=["test", "content"],
        )
        d = section.to_dict()
        restored = Section.from_dict(d, content="Content here")
        assert restored.id == "s1"
        assert restored.breadcrumb == "Doc > Test"


class TestDocumentSummary:
    def test_embed_text(self):
        summary = DocumentSummary(
            document_id="d1",
            title="Test Doc",
            summary_text="This is a test document about auth.",
            key_topics=["auth", "oauth"],
            key_entities=["AuthService"],
            content_hash="hash1",
        )
        text = summary.to_embed_text()
        assert "DOCUMENT: Test Doc" in text
        assert "TOPICS: auth, oauth" in text
        assert "ENTITIES: AuthService" in text

    def test_serialization(self):
        summary = DocumentSummary(
            document_id="d1", title="Doc", summary_text="Summary",
            key_topics=["a"], key_entities=["B"], content_hash="h",
        )
        d = summary.to_dict()
        restored = DocumentSummary.from_dict(d)
        assert restored.document_id == "d1"


class TestRAGResult:
    def test_to_dict(self):
        result = RAGResult(
            answer="The auth uses OAuth 2.0",
            confidence=0.85,
            query="How does auth work?",
            total_time_ms=500.0,
        )
        d = result.to_dict()
        assert d["answer"] == "The auth uses OAuth 2.0"
        assert d["confidence"] == 0.85
        assert d["timing"]["total_ms"] == 500.0
