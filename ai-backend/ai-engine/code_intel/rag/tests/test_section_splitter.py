"""Tests for section splitter and summary generator."""

import pytest
from ..types import ToCNode, ToCTree, ToCNodeType
from ..ingestion.section_splitter import SectionSplitter
from ..ingestion.summary_generator import SummaryGenerator


class TestSectionSplitter:
    def setup_method(self):
        self.splitter = SectionSplitter()

    def _make_tree(self, content):
        root = ToCNode(id="root", title="Root", node_type=ToCNodeType.ROOT, depth=0)
        h1 = ToCNode(
            id="h1", title="Section 1", depth=1,
            start_line=1, end_line=5, parent_id="root",
        )
        h2 = ToCNode(
            id="h2", title="Section 2", depth=1,
            start_line=6, end_line=10, parent_id="root",
        )
        root.children = [h1, h2]
        return ToCTree(document_id="doc1", root=root)

    def test_basic_splitting(self):
        content = "# Section 1\n\nContent for section 1.\n\n# Section 2\n\nContent for section 2.\n\nMore content.\n\n"
        tree = self._make_tree(content)
        sections = self.splitter.split("doc1", content, tree)
        assert len(sections) >= 1

    def test_empty_content(self):
        content = ""
        tree = self._make_tree(content)
        sections = self.splitter.split("doc1", content, tree)
        assert isinstance(sections, list)

    def test_section_has_breadcrumb(self):
        content = "# Section 1\n\nContent.\n\n# Section 2\n\nMore.\n\n\n\n"
        tree = self._make_tree(content)
        sections = self.splitter.split("doc1", content, tree)
        for s in sections:
            assert isinstance(s.breadcrumb, str)


class TestSummaryGenerator:
    def setup_method(self):
        self.generator = SummaryGenerator()

    def test_heuristic_summary_markdown(self):
        content = """# Authentication Guide

This document explains how the authentication system works.
It covers OAuth 2.0, JWT tokens, and session management.

## OAuth 2.0

OAuth details here with `AuthService` class.

## JWT Tokens

Token validation and refresh.

## API_KEY Management

Managing API keys.
"""
        from ..types import ToCTree, ToCNode, ToCNodeType

        root = ToCNode(id="root", title="Root", node_type=ToCNodeType.ROOT, depth=0)
        tree = ToCTree(document_id="doc1", root=root)

        summary = self.generator.generate(
            document_id="doc1",
            title="Authentication Guide",
            content=content,
            toc_tree=tree,
            content_hash="hash123",
        )

        assert summary is not None
        assert summary.document_id == "doc1"
        assert len(summary.summary_text) > 0
        assert len(summary.key_topics) >= 0

    def test_heuristic_summary_code(self):
        content = '''"""
Module for handling API authentication.

Provides OAuth2 and API key validation.
"""

class AuthService:
    MAX_RETRIES = 3

    def validate_token(self, token: str) -> bool:
        pass
'''
        summary = self.generator.generate(
            document_id="doc1",
            title="auth_service.py",
            content=content,
            content_hash="hash456",
        )
        assert summary is not None
        assert len(summary.summary_text) > 0

    def test_empty_content(self):
        summary = self.generator.generate(
            document_id="doc1",
            title="Empty",
            content="",
            content_hash="emptyhash",
        )
        assert summary is not None
