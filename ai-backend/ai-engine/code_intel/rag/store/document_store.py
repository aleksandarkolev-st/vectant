"""
Document Store — Persistent storage for documents and metadata.

Provides CRUD operations for Document objects with:
- JSON persistence with atomic writes
- Content hash dedup
- In-memory cache for fast lookups
- Incremental updates (add/remove without full rewrite)
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import shutil
from pathlib import Path
from typing import Dict, List, Optional

from ..types import Document, DocumentMetadata
from ..config import StoreConfig
from ..exceptions import StoreError, DocumentNotFoundError


logger = logging.getLogger("code_intel.rag.store.document")


class DocumentStore:
    """
    Persistent storage for documents and their metadata.

    Stores metadata in JSON; content is stored separately for memory efficiency.
    """

    def __init__(
        self,
        storage_dir: str,
        config: Optional[StoreConfig] = None,
    ):
        """
        Initialize document store.

        Args:
            storage_dir: Directory for storage files.
            config: Store configuration.
        """
        self.config = config or StoreConfig()
        self.storage_dir = Path(storage_dir)
        self.storage_dir.mkdir(parents=True, exist_ok=True)

        self._metadata_path = self.storage_dir / self.config.documents_file
        self._content_dir = self.storage_dir / "doc_content"
        self._content_dir.mkdir(exist_ok=True)

        # In-memory cache
        self._metadata_cache: Optional[Dict[str, DocumentMetadata]] = None
        self._hash_to_id: Dict[str, str] = {}

    # =========================================================================
    # CRUD Operations
    # =========================================================================

    def add(self, document: Document) -> str:
        """
        Add a document to the store.

        Args:
            document: Document to store.

        Returns:
            Document ID.

        Raises:
            StoreError: If storage fails.
        """
        try:
            metadata = self._load_metadata()
            metadata[document.id] = document.metadata
            self._hash_to_id[document.metadata.content_hash] = document.id

            # Store content separately
            self._write_content(document.id, document.content)

            # Persist metadata
            self._save_metadata(metadata)

            logger.debug(f"Stored document: {document.id} ({document.title})")
            return document.id

        except Exception as e:
            raise StoreError(
                f"Failed to store document: {document.id}",
                details={"document_id": document.id},
                cause=e,
            )

    def get(self, document_id: str, include_content: bool = True) -> Optional[Document]:
        """
        Get a document by ID.

        Args:
            document_id: Document ID.
            include_content: Whether to load content from disk.

        Returns:
            Document object, or None if not found.
        """
        metadata = self._load_metadata()
        meta = metadata.get(document_id)
        if not meta:
            return None

        content = ""
        if include_content:
            content = self._read_content(document_id)

        return Document(id=document_id, metadata=meta, content=content)

    def get_metadata(self, document_id: str) -> Optional[DocumentMetadata]:
        """Get metadata for a document (no content loading)."""
        metadata = self._load_metadata()
        return metadata.get(document_id)

    def get_all_metadata(self) -> Dict[str, DocumentMetadata]:
        """Get all document metadata."""
        return self._load_metadata().copy()

    def get_by_hash(self, content_hash: str) -> Optional[str]:
        """
        Get document ID by content hash.

        Args:
            content_hash: SHA-256 content hash.

        Returns:
            Document ID, or None if not found.
        """
        # Check cache first
        if content_hash in self._hash_to_id:
            return self._hash_to_id[content_hash]

        # Search metadata
        metadata = self._load_metadata()
        for doc_id, meta in metadata.items():
            if meta.content_hash == content_hash:
                self._hash_to_id[content_hash] = doc_id
                return doc_id
        return None

    def get_by_path(self, file_path: str) -> Optional[str]:
        """
        Get document ID by file path.

        Args:
            file_path: File path (absolute or relative).

        Returns:
            Document ID, or None if not found.
        """
        metadata = self._load_metadata()
        normalized = file_path.replace("\\", "/")
        for doc_id, meta in metadata.items():
            stored_path = meta.file_path.replace("\\", "/")
            if stored_path == normalized or stored_path.endswith(normalized):
                return doc_id
        return None

    def remove(self, document_id: str) -> bool:
        """
        Remove a document from the store.

        Args:
            document_id: Document ID.

        Returns:
            True if document was removed.
        """
        metadata = self._load_metadata()
        if document_id not in metadata:
            return False

        meta = metadata.pop(document_id)
        self._hash_to_id.pop(meta.content_hash, None)

        # Remove content file
        content_path = self._content_dir / f"{document_id}.txt"
        if content_path.exists():
            content_path.unlink()

        self._save_metadata(metadata)
        logger.debug(f"Removed document: {document_id}")
        return True

    def update(self, document: Document) -> None:
        """
        Update an existing document (full replace).

        Args:
            document: Updated document.
        """
        metadata = self._load_metadata()

        # Remove old hash mapping if hash changed
        old_meta = metadata.get(document.id)
        if old_meta and old_meta.content_hash != document.metadata.content_hash:
            self._hash_to_id.pop(old_meta.content_hash, None)

        metadata[document.id] = document.metadata
        self._hash_to_id[document.metadata.content_hash] = document.id

        self._write_content(document.id, document.content)
        self._save_metadata(metadata)

    def list_ids(self) -> List[str]:
        """List all document IDs."""
        return list(self._load_metadata().keys())

    def count(self) -> int:
        """Get total number of documents."""
        return len(self._load_metadata())

    def clear(self) -> None:
        """Remove all documents."""
        self._metadata_cache = {}
        self._hash_to_id.clear()
        self._save_metadata({})

        # Remove all content files
        for f in self._content_dir.iterdir():
            if f.is_file():
                f.unlink()

    # =========================================================================
    # Content I/O
    # =========================================================================

    def _write_content(self, document_id: str, content: str) -> None:
        """Write document content to disk."""
        path = self._content_dir / f"{document_id}.txt"
        if self.config.use_atomic_writes:
            self._atomic_write(path, content)
        else:
            path.write_text(content, encoding="utf-8")

    def _read_content(self, document_id: str) -> str:
        """Read document content from disk."""
        path = self._content_dir / f"{document_id}.txt"
        if path.exists():
            return path.read_text(encoding="utf-8")
        return ""

    # =========================================================================
    # Metadata Persistence
    # =========================================================================

    def _load_metadata(self) -> Dict[str, DocumentMetadata]:
        """Load metadata from disk, with caching."""
        if self._metadata_cache is not None:
            return self._metadata_cache

        if not self._metadata_path.exists():
            self._metadata_cache = {}
            return self._metadata_cache

        try:
            with open(self._metadata_path, "r", encoding="utf-8") as f:
                raw = json.load(f)

            self._metadata_cache = {}
            for doc_id, meta_dict in raw.items():
                meta = DocumentMetadata.from_dict(meta_dict)
                self._metadata_cache[doc_id] = meta
                self._hash_to_id[meta.content_hash] = doc_id

            return self._metadata_cache

        except (json.JSONDecodeError, KeyError) as e:
            logger.warning(f"Failed to load metadata, starting fresh: {e}")
            self._metadata_cache = {}
            return self._metadata_cache

    def _save_metadata(self, metadata: Dict[str, DocumentMetadata]) -> None:
        """Save metadata to disk."""
        self._metadata_cache = metadata

        raw = {
            doc_id: meta.to_dict()
            for doc_id, meta in metadata.items()
        }

        content = json.dumps(raw, indent=2, ensure_ascii=False)

        if self.config.use_atomic_writes:
            self._atomic_write(self._metadata_path, content)
        else:
            with open(self._metadata_path, "w", encoding="utf-8") as f:
                f.write(content)

    # =========================================================================
    # Atomic Writes
    # =========================================================================

    @staticmethod
    def _atomic_write(path: Path, content: str) -> None:
        """
        Write content to a file atomically using temp+rename.

        This prevents data corruption from partial writes.
        """
        dir_path = path.parent
        dir_path.mkdir(parents=True, exist_ok=True)

        fd, tmp_path = tempfile.mkstemp(
            dir=str(dir_path),
            prefix=".tmp_",
            suffix=".json",
        )
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(content)
            # Atomic rename
            shutil.move(tmp_path, str(path))
        except Exception:
            # Clean up temp file on failure
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise
