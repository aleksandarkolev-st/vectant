"""
Document Loader — Load documents from various formats into Document objects.

Supports:
- Markdown (.md, .markdown)
- Plain text (.txt)
- reStructuredText (.rst)
- HTML (.html, .htm)
- Code files (Python, TypeScript, etc.)

Each format is detected by file extension and content heuristics.
"""

from __future__ import annotations

import logging
import os
import re
import time
from pathlib import Path
from typing import List, Optional, Set

from ..types import Document, DocumentMetadata, DocumentFormat
from ..config import IngestionConfig
from ..exceptions import IngestionError, DocumentParseError
from .content_hasher import ContentHasher


logger = logging.getLogger("code_intel.rag.ingestion.loader")


# Extension-to-format mapping
_EXTENSION_FORMAT_MAP = {
    ".md": DocumentFormat.MARKDOWN,
    ".markdown": DocumentFormat.MARKDOWN,
    ".txt": DocumentFormat.PLAIN_TEXT,
    ".rst": DocumentFormat.RST,
    ".html": DocumentFormat.HTML,
    ".htm": DocumentFormat.HTML,
}

# Code file extensions
_CODE_EXTENSIONS: Set[str] = {
    ".py", ".ts", ".js", ".tsx", ".jsx", ".java", ".go",
    ".rs", ".cpp", ".c", ".h", ".hpp", ".cs", ".rb",
    ".swift", ".kt", ".scala", ".sh", ".bash", ".zsh",
    ".yaml", ".yml", ".toml", ".json", ".xml",
}

# Language detection by extension
_EXTENSION_LANGUAGE_MAP = {
    ".py": "python",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".java": "java",
    ".go": "go",
    ".rs": "rust",
    ".cpp": "cpp",
    ".c": "c",
    ".h": "c",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".rb": "ruby",
    ".swift": "swift",
    ".kt": "kotlin",
    ".scala": "scala",
}


class DocumentLoader:
    """
    Load documents from the filesystem into Document objects.

    Handles format detection, content normalization, and metadata extraction.
    """

    def __init__(
        self,
        config: Optional[IngestionConfig] = None,
        hasher: Optional[ContentHasher] = None,
    ):
        """
        Initialize document loader.

        Args:
            config: Ingestion configuration.
            hasher: Content hasher instance.
        """
        self.config = config or IngestionConfig()
        self.hasher = hasher or ContentHasher(self.config.hash_algorithm)
        self._supported_extensions = self._build_extension_set()

    def _build_extension_set(self) -> Set[str]:
        """Build set of all supported file extensions."""
        extensions: Set[str] = set()
        for ext in self.config.document_extensions:
            extensions.add(ext if ext.startswith(".") else f".{ext}")
        for ext in self.config.code_extensions:
            extensions.add(ext if ext.startswith(".") else f".{ext}")
        return extensions

    def load_file(self, file_path: str, encoding: str = "utf-8") -> Document:
        """
        Load a single file into a Document.

        Args:
            file_path: Absolute or relative path to file.
            encoding: File encoding.

        Returns:
            Document object with content and metadata.

        Raises:
            IngestionError: If file cannot be loaded.
            DocumentParseError: If file content is invalid.
        """
        path = Path(file_path)

        if not path.exists():
            raise IngestionError(
                f"File not found: {file_path}",
                details={"file_path": file_path},
            )

        if not path.is_file():
            raise IngestionError(
                f"Not a file: {file_path}",
                details={"file_path": file_path},
            )

        stat = path.stat()
        if stat.st_size > self.config.max_file_size:
            raise IngestionError(
                f"File too large: {stat.st_size} bytes (max {self.config.max_file_size})",
                details={"file_path": file_path, "size": stat.st_size},
            )

        try:
            content = path.read_text(encoding=encoding, errors="replace")
        except Exception as e:
            raise DocumentParseError(
                f"Failed to read file: {file_path}",
                details={"file_path": file_path},
                cause=e,
            )

        return self._build_document(path, content, stat)

    def load_directory(
        self,
        directory: str,
        recursive: bool = True,
        file_patterns: Optional[List[str]] = None,
    ) -> List[Document]:
        """
        Load all supported documents from a directory.

        Args:
            directory: Path to directory.
            recursive: Whether to recurse into subdirectories.
            file_patterns: Optional glob patterns to filter files.

        Returns:
            List of Document objects.

        Raises:
            IngestionError: If directory does not exist.
        """
        dir_path = Path(directory)
        if not dir_path.exists():
            raise IngestionError(
                f"Directory not found: {directory}",
                details={"directory": directory},
            )

        documents: List[Document] = []
        errors: List[str] = []

        for file_path in self._walk_directory(dir_path, recursive):
            # Check extension
            ext = file_path.suffix.lower()
            if ext not in self._supported_extensions:
                continue

            # Check ignore patterns
            rel_path = str(file_path.relative_to(dir_path))
            if self._should_ignore(rel_path):
                continue

            # Check file pattern filter
            if file_patterns and not self._matches_patterns(rel_path, file_patterns):
                continue

            try:
                doc = self.load_file(str(file_path))
                documents.append(doc)
            except (IngestionError, DocumentParseError) as e:
                errors.append(f"{file_path}: {e}")
                logger.warning(f"Skipping file: {e}")

        if errors:
            logger.info(
                f"Loaded {len(documents)} documents, {len(errors)} errors"
            )

        return documents

    def load_content(
        self,
        content: str,
        file_name: str = "untitled.md",
        file_path: str = "",
    ) -> Document:
        """
        Load a document from raw content string.

        Args:
            content: Raw document content.
            file_name: Virtual filename for format detection.
            file_path: Optional file path for metadata.

        Returns:
            Document object.
        """
        ext = Path(file_name).suffix.lower()
        doc_format = self._detect_format(ext, content)
        language = _EXTENSION_LANGUAGE_MAP.get(ext, "")
        content_hash = self.hasher.hash_content(content)

        lines = content.split("\n")
        words = content.split()
        title = self._extract_title(content, doc_format)

        metadata = DocumentMetadata(
            file_path=file_path or file_name,
            file_name=file_name,
            format=doc_format,
            size_bytes=len(content.encode("utf-8")),
            content_hash=content_hash,
            language=language,
            title=title,
            created_at=time.time(),
            modified_at=time.time(),
            line_count=len(lines),
            word_count=len(words),
        )

        return Document(id="", metadata=metadata, content=content)

    def _build_document(
        self,
        path: Path,
        content: str,
        stat: os.stat_result,
    ) -> Document:
        """Build a Document from file path and content."""
        ext = path.suffix.lower()
        doc_format = self._detect_format(ext, content)
        language = _EXTENSION_LANGUAGE_MAP.get(ext, "")
        content_hash = self.hasher.hash_content(content)

        lines = content.split("\n")
        words = content.split()
        title = self._extract_title(content, doc_format)

        metadata = DocumentMetadata(
            file_path=str(path),
            file_name=path.name,
            format=doc_format,
            size_bytes=stat.st_size,
            content_hash=content_hash,
            language=language,
            title=title or path.stem,
            created_at=stat.st_ctime,
            modified_at=stat.st_mtime,
            line_count=len(lines),
            word_count=len(words),
        )

        return Document(id="", metadata=metadata, content=content)

    def _detect_format(self, extension: str, content: str = "") -> DocumentFormat:
        """Detect document format from extension and content."""
        # Extension lookup
        if extension in _EXTENSION_FORMAT_MAP:
            return _EXTENSION_FORMAT_MAP[extension]
        if extension in _CODE_EXTENSIONS:
            return DocumentFormat.CODE

        # Content heuristics
        if content:
            first_lines = content[:500]
            if re.search(r"^#{1,6}\s", first_lines, re.MULTILINE):
                return DocumentFormat.MARKDOWN
            if first_lines.strip().startswith("<!DOCTYPE") or first_lines.strip().startswith("<html"):
                return DocumentFormat.HTML
            if re.search(r"^\.\.\s|^={3,}$|^-{3,}$", first_lines, re.MULTILINE):
                return DocumentFormat.RST

        return DocumentFormat.UNKNOWN

    def _extract_title(self, content: str, doc_format: DocumentFormat) -> str:
        """Extract document title from content."""
        if doc_format == DocumentFormat.MARKDOWN:
            # Look for first H1 heading
            match = re.search(r"^#\s+(.+)$", content, re.MULTILINE)
            if match:
                return match.group(1).strip()
            # Look for setext-style H1
            lines = content.split("\n")
            for i, line in enumerate(lines):
                if i + 1 < len(lines) and re.match(r"^={3,}$", lines[i + 1].rstrip()):
                    return line.strip()

        elif doc_format == DocumentFormat.HTML:
            match = re.search(r"<title[^>]*>([^<]+)</title>", content, re.IGNORECASE)
            if match:
                return match.group(1).strip()

        elif doc_format == DocumentFormat.RST:
            lines = content.split("\n")
            for i, line in enumerate(lines):
                if i + 1 < len(lines) and re.match(r"^[=~\-`]{3,}$", lines[i + 1].rstrip()):
                    return line.strip()

        elif doc_format == DocumentFormat.CODE:
            # Look for module docstring or top comment
            lines = content.split("\n")
            for line in lines[:10]:
                stripped = line.strip()
                if stripped.startswith('"""') or stripped.startswith("'''"):
                    # Extract first line of docstring
                    text = stripped.strip("\"'").strip()
                    if text:
                        return text[:100]
                elif stripped.startswith("//") or stripped.startswith("#"):
                    text = stripped.lstrip("/#").strip()
                    if text and len(text) > 5:
                        return text[:100]

        # Fallback: first non-empty line
        for line in content.split("\n")[:5]:
            stripped = line.strip()
            if stripped and len(stripped) > 3:
                return stripped[:100]

        return ""

    def _walk_directory(self, directory: Path, recursive: bool) -> List[Path]:
        """Walk directory and collect file paths."""
        files: List[Path] = []
        if recursive:
            for root, _dirs, filenames in os.walk(directory):
                for fname in sorted(filenames):
                    files.append(Path(root) / fname)
        else:
            for item in sorted(directory.iterdir()):
                if item.is_file():
                    files.append(item)
        return files

    def _should_ignore(self, relative_path: str) -> bool:
        """Check if a file should be ignored based on patterns."""
        # Normalize path separators
        normalized = relative_path.replace("\\", "/")
        for pattern in self.config.ignore_patterns:
            if self._glob_match(normalized, pattern):
                return True
        return False

    def _matches_patterns(
        self,
        relative_path: str,
        patterns: List[str],
    ) -> bool:
        """Check if a file matches any of the given patterns."""
        normalized = relative_path.replace("\\", "/")
        for pattern in patterns:
            if self._glob_match(normalized, pattern):
                return True
        return False

    @staticmethod
    def _glob_match(path: str, pattern: str) -> bool:
        """Simple glob matching (supports * and **)."""
        # Convert glob to regex
        regex_pattern = pattern.replace(".", r"\.")
        regex_pattern = regex_pattern.replace("**", "<<GLOBSTAR>>")
        regex_pattern = regex_pattern.replace("*", r"[^/]*")
        regex_pattern = regex_pattern.replace("<<GLOBSTAR>>", r".*")
        regex_pattern = f"^{regex_pattern}$"

        return bool(re.match(regex_pattern, path))
