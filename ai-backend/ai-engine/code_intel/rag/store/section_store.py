"""
Section Store — Persistent storage for document sections.

Stores sections with:
- JSON metadata persistence
- Separate content files for memory efficiency
- Fast lookup by document_id and section_id
- Keyword index for BM25-style searches
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import shutil
from pathlib import Path
from typing import Dict, List, Optional

from ..types import Section
from ..config import StoreConfig
from ..exceptions import StoreError, SectionNotFoundError


logger = logging.getLogger("code_intel.rag.store.section")


class SectionStore:
    """
    Persistent storage for document sections.

    Sections are the atomic retrieval units used by micro-navigation.
    """

    def __init__(
        self,
        storage_dir: str,
        config: Optional[StoreConfig] = None,
    ):
        """
        Initialize section store.

        Args:
            storage_dir: Directory for storage files.
            config: Store configuration.
        """
        self.config = config or StoreConfig()
        self.storage_dir = Path(storage_dir)
        self.storage_dir.mkdir(parents=True, exist_ok=True)

        self._metadata_path = self.storage_dir / self.config.sections_file
        self._content_dir = self.storage_dir / "section_content"
        self._content_dir.mkdir(exist_ok=True)

        # In-memory caches
        self._metadata_cache: Optional[Dict[str, Dict]] = None
        self._doc_to_sections: Dict[str, List[str]] = {}

    # =========================================================================
    # CRUD Operations
    # =========================================================================

    def add_sections(self, sections: List[Section]) -> int:
        """
        Add multiple sections to the store.

        Args:
            sections: List of Section objects.

        Returns:
            Number of sections added.
        """
        metadata = self._load_metadata()
        count = 0

        for section in sections:
            # Store metadata (without content)
            section_meta = section.to_dict()
            metadata[section.id] = section_meta

            # Store content separately
            self._write_content(section.id, section.content)

            # Update doc->sections index
            doc_id = section.document_id
            if doc_id not in self._doc_to_sections:
                self._doc_to_sections[doc_id] = []
            if section.id not in self._doc_to_sections[doc_id]:
                self._doc_to_sections[doc_id].append(section.id)

            count += 1

        self._save_metadata(metadata)
        return count

    def get(self, section_id: str, include_content: bool = True) -> Optional[Section]:
        """
        Get a section by ID.

        Args:
            section_id: Section ID.
            include_content: Whether to load content from disk.

        Returns:
            Section object, or None if not found.
        """
        metadata = self._load_metadata()
        meta = metadata.get(section_id)
        if not meta:
            return None

        content = ""
        if include_content:
            content = self._read_content(section_id)

        return Section.from_dict(meta, content=content)

    def get_by_document(
        self,
        document_id: str,
        include_content: bool = True,
    ) -> List[Section]:
        """
        Get all sections for a document.

        Args:
            document_id: Document ID.
            include_content: Whether to load content.

        Returns:
            List of Section objects.
        """
        metadata = self._load_metadata()
        sections: List[Section] = []

        for section_id, meta in metadata.items():
            if meta.get("document_id") == document_id:
                content = ""
                if include_content:
                    content = self._read_content(section_id)
                sections.append(Section.from_dict(meta, content=content))

        # Sort by start_line for natural ordering
        sections.sort(key=lambda s: s.start_line)
        return sections

    def get_multiple(
        self,
        section_ids: List[str],
        include_content: bool = True,
    ) -> List[Section]:
        """
        Get multiple sections by ID.

        Args:
            section_ids: List of section IDs.
            include_content: Whether to load content.

        Returns:
            List of Section objects (preserves order).
        """
        metadata = self._load_metadata()
        sections: List[Section] = []

        for section_id in section_ids:
            meta = metadata.get(section_id)
            if meta:
                content = ""
                if include_content:
                    content = self._read_content(section_id)
                sections.append(Section.from_dict(meta, content=content))

        return sections

    def remove_by_document(self, document_id: str) -> int:
        """
        Remove all sections for a document.

        Returns:
            Number of sections removed.
        """
        metadata = self._load_metadata()
        to_remove: List[str] = []

        for section_id, meta in metadata.items():
            if meta.get("document_id") == document_id:
                to_remove.append(section_id)

        for section_id in to_remove:
            del metadata[section_id]
            content_path = self._content_dir / f"{section_id}.txt"
            if content_path.exists():
                content_path.unlink()

        self._doc_to_sections.pop(document_id, None)
        self._save_metadata(metadata)
        return len(to_remove)

    def remove(self, section_id: str) -> bool:
        """
        Remove a single section.

        Returns:
            True if section was removed.
        """
        metadata = self._load_metadata()
        if section_id not in metadata:
            return False

        meta = metadata.pop(section_id)
        doc_id = meta.get("document_id", "")
        if doc_id in self._doc_to_sections:
            self._doc_to_sections[doc_id] = [
                sid for sid in self._doc_to_sections[doc_id]
                if sid != section_id
            ]

        content_path = self._content_dir / f"{section_id}.txt"
        if content_path.exists():
            content_path.unlink()

        self._save_metadata(metadata)
        return True

    def search_by_keywords(
        self,
        keywords: List[str],
        max_results: int = 20,
        document_ids: Optional[List[str]] = None,
    ) -> List[Section]:
        """
        Search sections by keyword overlap.

        Simple keyword matching — not a full BM25 implementation,
        but sufficient for the micro-navigation pipeline.

        Args:
            keywords: Query keywords.
            max_results: Maximum results.
            document_ids: Optional filter to specific documents.

        Returns:
            List of matching sections, sorted by match count.
        """
        metadata = self._load_metadata()
        query_words = {kw.lower() for kw in keywords}

        scored: List[tuple] = []
        for section_id, meta in metadata.items():
            if document_ids and meta.get("document_id") not in document_ids:
                continue

            section_keywords = {kw.lower() for kw in meta.get("keywords", [])}
            title_words = set(meta.get("title", "").lower().split())

            # Score: keyword overlap + title match
            keyword_overlap = len(query_words & section_keywords)
            title_overlap = len(query_words & title_words)
            score = keyword_overlap * 2 + title_overlap

            if score > 0:
                scored.append((section_id, score, meta))

        # Sort by score descending
        scored.sort(key=lambda x: x[1], reverse=True)

        sections: List[Section] = []
        for section_id, _, meta in scored[:max_results]:
            content = self._read_content(section_id)
            sections.append(Section.from_dict(meta, content=content))

        return sections

    def count(self) -> int:
        """Get total number of sections."""
        return len(self._load_metadata())

    def count_by_document(self, document_id: str) -> int:
        """Get number of sections for a document."""
        metadata = self._load_metadata()
        return sum(
            1 for meta in metadata.values()
            if meta.get("document_id") == document_id
        )

    def clear(self) -> None:
        """Remove all sections."""
        self._metadata_cache = {}
        self._doc_to_sections.clear()
        self._save_metadata({})

        for f in self._content_dir.iterdir():
            if f.is_file():
                f.unlink()

    # =========================================================================
    # Content I/O
    # =========================================================================

    def _write_content(self, section_id: str, content: str) -> None:
        """Write section content to disk."""
        path = self._content_dir / f"{section_id}.txt"
        if self.config.use_atomic_writes:
            _atomic_write_text(path, content)
        else:
            path.write_text(content, encoding="utf-8")

    def _read_content(self, section_id: str) -> str:
        """Read section content from disk."""
        path = self._content_dir / f"{section_id}.txt"
        if path.exists():
            return path.read_text(encoding="utf-8")
        return ""

    # =========================================================================
    # Metadata Persistence
    # =========================================================================

    def _load_metadata(self) -> Dict[str, Dict]:
        """Load metadata from disk with caching."""
        if self._metadata_cache is not None:
            return self._metadata_cache

        if not self._metadata_path.exists():
            self._metadata_cache = {}
            return self._metadata_cache

        try:
            with open(self._metadata_path, "r", encoding="utf-8") as f:
                self._metadata_cache = json.load(f)

            # Rebuild doc->sections index
            self._doc_to_sections.clear()
            for section_id, meta in self._metadata_cache.items():
                doc_id = meta.get("document_id", "")
                if doc_id not in self._doc_to_sections:
                    self._doc_to_sections[doc_id] = []
                self._doc_to_sections[doc_id].append(section_id)

            return self._metadata_cache

        except (json.JSONDecodeError, KeyError) as e:
            logger.warning(f"Failed to load section metadata: {e}")
            self._metadata_cache = {}
            return self._metadata_cache

    def _save_metadata(self, metadata: Dict[str, Dict]) -> None:
        """Save metadata to disk."""
        self._metadata_cache = metadata
        content = json.dumps(metadata, indent=2, ensure_ascii=False)

        if self.config.use_atomic_writes:
            _atomic_write_text(self._metadata_path, content)
        else:
            with open(self._metadata_path, "w", encoding="utf-8") as f:
                f.write(content)


def _atomic_write_text(path: Path, content: str) -> None:
    """Write content atomically using temp+rename."""
    dir_path = path.parent
    dir_path.mkdir(parents=True, exist_ok=True)

    fd, tmp_path = tempfile.mkstemp(
        dir=str(dir_path),
        prefix=".tmp_sec_",
        suffix=".json",
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(content)
        shutil.move(tmp_path, str(path))
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
