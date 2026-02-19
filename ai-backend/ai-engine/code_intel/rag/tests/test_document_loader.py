"""Tests for document loader."""

import pytest
import tempfile
import os
from ..types import DocumentFormat
from ..ingestion.document_loader import DocumentLoader


class TestDocumentLoader:
    def setup_method(self):
        self.loader = DocumentLoader()

    def test_detect_markdown(self):
        fmt = self.loader.detect_format("README.md")
        assert fmt == DocumentFormat.MARKDOWN

    def test_detect_code(self):
        fmt = self.loader.detect_format("main.py")
        assert fmt == DocumentFormat.CODE

    def test_detect_plain_text(self):
        fmt = self.loader.detect_format("notes.txt")
        assert fmt == DocumentFormat.PLAIN_TEXT

    def test_detect_rst(self):
        fmt = self.loader.detect_format("guide.rst")
        assert fmt == DocumentFormat.RST

    def test_detect_html(self):
        fmt = self.loader.detect_format("page.html")
        assert fmt == DocumentFormat.HTML

    def test_load_markdown_file(self):
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".md", delete=False, encoding="utf-8"
        ) as f:
            f.write("# Test Document\n\nHello world.\n")
            f.flush()
            try:
                doc = self.loader.load_file(f.name)
                assert doc is not None
                assert doc.metadata.format == DocumentFormat.MARKDOWN
                assert doc.content == "# Test Document\n\nHello world.\n"
                assert doc.metadata.title == "Test Document"
            finally:
                os.unlink(f.name)

    def test_load_code_file(self):
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".py", delete=False, encoding="utf-8"
        ) as f:
            f.write('"""Module docstring."""\n\ndef hello():\n    pass\n')
            f.flush()
            try:
                doc = self.loader.load_file(f.name)
                assert doc is not None
                assert doc.metadata.format == DocumentFormat.CODE
                assert doc.metadata.language == "python"
            finally:
                os.unlink(f.name)

    def test_load_nonexistent_file(self):
        doc = self.loader.load_file("/nonexistent/file.md")
        assert doc is None

    def test_load_directory(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            # Create test files
            with open(os.path.join(tmpdir, "doc1.md"), "w") as f:
                f.write("# Doc 1\nContent")
            with open(os.path.join(tmpdir, "doc2.txt"), "w") as f:
                f.write("Plain text doc")

            docs = self.loader.load_directory(tmpdir)
            assert len(docs) >= 2

    def test_ignore_patterns(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            os.makedirs(os.path.join(tmpdir, "node_modules"))
            with open(os.path.join(tmpdir, "node_modules", "pkg.js"), "w") as f:
                f.write("// should be ignored")
            with open(os.path.join(tmpdir, "app.md"), "w") as f:
                f.write("# App\nKeep this")

            docs = self.loader.load_directory(tmpdir)
            paths = [d.metadata.file_name for d in docs]
            assert "pkg.js" not in paths
            assert "app.md" in paths

    def test_title_extraction_markdown(self):
        title = self.loader.extract_title(
            "# My Document Title\n\nContent here.",
            DocumentFormat.MARKDOWN,
        )
        assert title == "My Document Title"

    def test_title_extraction_no_heading(self):
        title = self.loader.extract_title(
            "Some plain content without a heading.",
            DocumentFormat.PLAIN_TEXT,
        )
        assert title == "Some plain content without a heading."
