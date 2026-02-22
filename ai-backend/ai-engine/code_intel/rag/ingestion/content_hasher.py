"""
Content Hasher — Deterministic hashing for dedup and change detection.

Provides content-based hashing that is stable across:
- Line ending differences (CRLF vs LF)
- BOM markers
- Trailing whitespace
- Unicode normalization forms
"""

from __future__ import annotations

import hashlib
import unicodedata
from typing import Optional


class ContentHasher:
    """
    Deterministic content hasher for documents.

    All content is normalized before hashing to ensure stability
    across platforms and minor formatting differences.
    """

    def __init__(self, algorithm: str = "sha256"):
        """
        Initialize hasher.

        Args:
            algorithm: Hash algorithm (sha256, md5, sha1).
        """
        if algorithm not in hashlib.algorithms_available:
            raise ValueError(f"Unsupported hash algorithm: {algorithm}")
        self.algorithm = algorithm

    def hash_content(self, content: str) -> str:
        """
        Hash document content after normalization.

        Normalization steps:
        1. Strip BOM markers
        2. Normalize to NFC unicode form
        3. Normalize line endings to LF
        4. Strip trailing whitespace per line
        5. Strip trailing newlines

        Args:
            content: Raw document content.

        Returns:
            Hex digest string.
        """
        normalized = self._normalize(content)
        h = hashlib.new(self.algorithm)
        h.update(normalized.encode("utf-8"))
        return h.hexdigest()

    def hash_file(self, file_path: str, encoding: str = "utf-8") -> str:
        """
        Hash a file's content after normalization.

        Args:
            file_path: Path to file.
            encoding: File encoding.

        Returns:
            Hex digest string.

        Raises:
            FileNotFoundError: If file does not exist.
            UnicodeDecodeError: If file cannot be decoded.
        """
        with open(file_path, "r", encoding=encoding, errors="replace") as f:
            content = f.read()
        return self.hash_content(content)

    def content_changed(
        self,
        content: str,
        previous_hash: str,
    ) -> bool:
        """
        Check if content has changed since previous hash.

        Args:
            content: Current content.
            previous_hash: Previously computed hash.

        Returns:
            True if content has changed.
        """
        current_hash = self.hash_content(content)
        return current_hash != previous_hash

    def _normalize(self, content: str) -> str:
        """
        Normalize content for stable hashing.

        Args:
            content: Raw content string.

        Returns:
            Normalized content string.
        """
        # Strip BOM
        if content.startswith("\ufeff"):
            content = content[1:]

        # Unicode NFC normalization
        content = unicodedata.normalize("NFC", content)

        # Normalize line endings to LF
        content = content.replace("\r\n", "\n").replace("\r", "\n")

        # Strip trailing whitespace per line
        lines = content.split("\n")
        lines = [line.rstrip() for line in lines]
        content = "\n".join(lines)

        # Strip trailing newlines
        content = content.rstrip("\n")

        return content

    @staticmethod
    def quick_hash(content: str) -> str:
        """
        Quick SHA-256 hash without full normalization.

        Use for performance-critical paths where content is already clean.

        Args:
            content: Content to hash.

        Returns:
            32-char hex digest (truncated SHA-256).
        """
        return hashlib.sha256(content.encode("utf-8")).hexdigest()[:32]
