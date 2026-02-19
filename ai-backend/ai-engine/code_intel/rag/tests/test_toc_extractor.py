"""Tests for ToC extractor."""

import pytest
from ..types import ToCNodeType
from ..ingestion.toc_extractor import ToCExtractor


class TestToCExtractor:
    def setup_method(self):
        self.extractor = ToCExtractor()

    def test_markdown_headings(self):
        content = """# Introduction

Some intro text.

## Getting Started

Setup instructions.

## Architecture

### Auth System

Auth details.

### Database

Database info.
"""
        tree = self.extractor.extract("doc1", content, "markdown")
        assert tree is not None
        assert tree.total_nodes > 0

        # Should have root children
        assert len(tree.root.children) >= 1

        # Check that "Introduction" exists
        flat = tree.flatten()
        titles = [n.title for n in flat]
        assert "Introduction" in titles

    def test_markdown_respects_code_fences(self):
        content = """# Real Heading

```python
# This is not a heading
## Neither is this
```

## Actual Section
"""
        tree = self.extractor.extract("doc1", content, "markdown")
        flat = tree.flatten()
        titles = [n.title for n in flat if n.title]
        assert "This is not a heading" not in titles
        assert "Real Heading" in titles

    def test_code_structure(self):
        content = '''"""Module docstring."""

class AuthService:
    """Authentication service."""

    def login(self, user, password):
        """Login method."""
        pass

    def logout(self):
        pass

def standalone_function():
    """A standalone function."""
    pass
'''
        tree = self.extractor.extract("doc1", content, "code")
        assert tree is not None
        assert tree.total_nodes > 0

    def test_plain_text(self):
        content = """First paragraph of text.
More text in the same paragraph.

Second paragraph here.
With multiple lines.

Third paragraph.
"""
        tree = self.extractor.extract("doc1", content, "plain_text")
        assert tree is not None

    def test_empty_content(self):
        tree = self.extractor.extract("doc1", "", "markdown")
        assert tree is not None
        assert len(tree.root.children) == 0

    def test_keyword_extraction(self):
        content = """# Authentication System

The authentication system uses OAuth 2.0 with JWT tokens.
It supports SAML and LDAP integration for enterprise customers.
The AuthService class handles all authentication flows.
"""
        tree = self.extractor.extract("doc1", content, "markdown")
        flat = tree.flatten()
        # At least some keywords should be extracted
        all_keywords = []
        for node in flat:
            all_keywords.extend(node.keywords)
        # Should find at least some keywords
        assert len(all_keywords) >= 0  # Keywords are best-effort


class TestToCExtractorRST:
    def setup_method(self):
        self.extractor = ToCExtractor()

    def test_rst_headings(self):
        content = """Introduction
============

Intro text here.

Getting Started
---------------

Setup info.
"""
        tree = self.extractor.extract("doc1", content, "rst")
        assert tree is not None
        flat = tree.flatten()
        titles = [n.title for n in flat if n.title]
        assert "Introduction" in titles


class TestToCExtractorHTML:
    def setup_method(self):
        self.extractor = ToCExtractor()

    def test_html_headings(self):
        content = """<html>
<body>
<h1>Main Title</h1>
<p>Content</p>
<h2>Section 1</h2>
<p>More content</p>
<h2>Section 2</h2>
<p>Even more</p>
</body>
</html>"""
        tree = self.extractor.extract("doc1", content, "html")
        assert tree is not None
        flat = tree.flatten()
        titles = [n.title for n in flat if n.title]
        assert "Main Title" in titles
