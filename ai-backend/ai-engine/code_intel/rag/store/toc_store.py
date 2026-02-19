"""
ToC Store — Persistent storage for Table of Contents trees.

Stores serialized ToC trees with:
- JSON persistence
- Fast node lookup by document_id
- Atomic writes for safety
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import shutil
from pathlib import Path
from typing import Dict, List, Optional

from ..types import ToCTree, ToCNode
from ..config import StoreConfig
from ..exceptions import StoreError


logger = logging.getLogger("code_intel.rag.store.toc")


class ToCStore:
    """
    Persistent storage for Table of Contents trees.

    Each document has exactly one ToC tree.
    """

    def __init__(
        self,
        storage_dir: str,
        config: Optional[StoreConfig] = None,
    ):
        """
        Initialize ToC store.

        Args:
            storage_dir: Directory for storage files.
            config: Store configuration.
        """
        self.config = config or StoreConfig()
        self.storage_dir = Path(storage_dir)
        self.storage_dir.mkdir(parents=True, exist_ok=True)

        self._toc_path = self.storage_dir / self.config.toc_file

        # In-memory cache
        self._cache: Optional[Dict[str, ToCTree]] = None

    def set(self, document_id: str, toc: ToCTree) -> None:
        """
        Store a ToC tree for a document.

        Args:
            document_id: Document ID.
            toc: ToC tree to store.
        """
        trees = self._load()
        trees[document_id] = toc
        self._save(trees)

    def get(self, document_id: str) -> Optional[ToCTree]:
        """
        Get ToC tree for a document.

        Args:
            document_id: Document ID.

        Returns:
            ToCTree, or None if not found.
        """
        trees = self._load()
        return trees.get(document_id)

    def get_all(self) -> Dict[str, ToCTree]:
        """Get all ToC trees."""
        return self._load().copy()

    def remove(self, document_id: str) -> bool:
        """
        Remove ToC tree for a document.

        Returns:
            True if tree was removed.
        """
        trees = self._load()
        if document_id not in trees:
            return False
        del trees[document_id]
        self._save(trees)
        return True

    def clear(self) -> None:
        """Remove all ToC trees."""
        self._cache = {}
        self._save({})

    def count(self) -> int:
        """Get number of stored ToC trees."""
        return len(self._load())

    def get_node(self, document_id: str, node_id: str) -> Optional[ToCNode]:
        """
        Get a specific node from a document's ToC tree.

        Args:
            document_id: Document ID.
            node_id: Node ID within the tree.

        Returns:
            ToCNode, or None if not found.
        """
        tree = self.get(document_id)
        if tree:
            return tree.get_node(node_id)
        return None

    def list_document_ids(self) -> List[str]:
        """List all document IDs that have ToC trees."""
        return list(self._load().keys())

    # =========================================================================
    # Persistence
    # =========================================================================

    def _load(self) -> Dict[str, ToCTree]:
        """Load ToC trees from disk with caching."""
        if self._cache is not None:
            return self._cache

        if not self._toc_path.exists():
            self._cache = {}
            return self._cache

        try:
            with open(self._toc_path, "r", encoding="utf-8") as f:
                raw = json.load(f)

            self._cache = {}
            for doc_id, tree_dict in raw.items():
                try:
                    tree = ToCTree.from_dict(tree_dict)
                    self._cache[doc_id] = tree
                except Exception as e:
                    logger.warning(f"Failed to deserialize ToC for {doc_id}: {e}")

            return self._cache

        except (json.JSONDecodeError, KeyError) as e:
            logger.warning(f"Failed to load ToC store, starting fresh: {e}")
            self._cache = {}
            return self._cache

    def _save(self, trees: Dict[str, ToCTree]) -> None:
        """Save ToC trees to disk."""
        self._cache = trees

        raw = {
            doc_id: tree.to_dict()
            for doc_id, tree in trees.items()
        }

        content = json.dumps(raw, indent=2, ensure_ascii=False)

        if self.config.use_atomic_writes:
            self._atomic_write(self._toc_path, content)
        else:
            with open(self._toc_path, "w", encoding="utf-8") as f:
                f.write(content)

    @staticmethod
    def _atomic_write(path: Path, content: str) -> None:
        """Write content atomically using temp+rename."""
        dir_path = path.parent
        dir_path.mkdir(parents=True, exist_ok=True)

        fd, tmp_path = tempfile.mkstemp(
            dir=str(dir_path),
            prefix=".tmp_toc_",
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
