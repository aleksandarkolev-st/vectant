"""Tests for content hasher."""

import pytest
import tempfile
import os
from ..ingestion.content_hasher import ContentHasher


class TestContentHasher:
    def setup_method(self):
        self.hasher = ContentHasher()

    def test_consistent_hashing(self):
        content = "Hello, world!"
        h1 = self.hasher.hash_content(content)
        h2 = self.hasher.hash_content(content)
        assert h1 == h2

    def test_normalization_crlf(self):
        h1 = self.hasher.hash_content("line1\nline2")
        h2 = self.hasher.hash_content("line1\r\nline2")
        assert h1 == h2

    def test_normalization_trailing_whitespace(self):
        h1 = self.hasher.hash_content("line1  \nline2  ")
        h2 = self.hasher.hash_content("line1\nline2")
        assert h1 == h2

    def test_different_content_different_hash(self):
        h1 = self.hasher.hash_content("content A")
        h2 = self.hasher.hash_content("content B")
        assert h1 != h2

    def test_hash_file(self):
        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False) as f:
            f.write("test content")
            f.flush()
            try:
                h = self.hasher.hash_file(f.name)
                assert len(h) == 64  # SHA-256 hex length
            finally:
                os.unlink(f.name)

    def test_content_changed(self):
        h1 = self.hasher.hash_content("version 1")
        assert self.hasher.content_changed("version 2", h1) is True
        assert self.hasher.content_changed("version 1", h1) is False

    def test_quick_hash(self):
        h = self.hasher.quick_hash("quick test")
        assert isinstance(h, str)
        assert len(h) > 0

    def test_empty_content(self):
        h = self.hasher.hash_content("")
        assert isinstance(h, str)
        assert len(h) == 64
