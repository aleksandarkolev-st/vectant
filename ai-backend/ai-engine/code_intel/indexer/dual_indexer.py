"""
Dual Indexer - Combines vector and structural indexing.

This is the main entry point for indexing code.
Coordinates both indexes and maintains consistency.

THREAD-SAFETY: All reindex operations are protected by file-level locks
to ensure atomic delete-then-insert semantics.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
import time
from contextlib import contextmanager
from typing import Dict, List, Optional, Set

from .vector_index import VectorIndex
from .structural_index import StructuralIndex
from .lexical_index import LexicalIndex
from .embedder import Embedder, get_embedder

from ..core.types import SemanticChunk, ChunkId, FilePath
from ..core.config import get_config
from ..ingestion import FileWalker, ChunkExtractor, WalkedFile


logger = logging.getLogger("code_intel.indexer.dual")


class DualIndexer:
    """
    Combined vector and structural indexer.
    
    This is the main interface for indexing code.
    
    THREAD-SAFETY: File-level locking ensures atomic reindex operations.
    Global lock protects the file locks dict itself.
    
    Key operations:
    - index_repository(path): Full index of a repo
    - index_file(path): Index a single file
    - update_file(path): Update index for a changed file
    - remove_file(path): Remove file from indexes
    """
    
    def __init__(
        self,
        workspace_root: str,
        persist_dir: Optional[str] = None,
        embedder: Optional[Embedder] = None,
    ):
        self.workspace_root = os.path.abspath(workspace_root)
        self.base_dir = persist_dir or os.path.join(
            workspace_root, ".synthi", "code_intel"
        )
        self.pointer_path = f"{self.base_dir}_current_gen.txt"
        self.persist_dir = self._resolve_persist_dir(self.base_dir, self.pointer_path)
        self.config = get_config()
        self.chunking_version = self.config.indexer.chunking_version
        
        # Create persist directory
        os.makedirs(self.persist_dir, exist_ok=True)
        
        # Initialize indexes
        self.vector_index = VectorIndex(
            persist_path=os.path.join(self.persist_dir, "vectors.json")
        )
        self.structural_index = StructuralIndex(
            persist_path=os.path.join(self.persist_dir, "structure.json")
        )
        self.lexical_index = LexicalIndex(
            persist_path=os.path.join(self.persist_dir, "lexical.json")
        )

        # Enforce chunking version invariants
        self._ensure_chunking_version()
        
        # Embedder
        self.embedder = embedder or get_embedder()
        
        # File walker
        self.walker = FileWalker(workspace_root)
        
        # Chunk extractor
        self.extractor = ChunkExtractor()
        
        # File hashes for change detection
        self._file_hashes: Dict[FilePath, str] = {}
        
        # Thread-safety: per-file locks for atomic reindex operations
        self._file_locks: Dict[str, threading.RLock] = {}
        self._lock_dict_lock = threading.Lock()  # Protects _file_locks dict
        
        # Global index lock for batch operations
        self._index_lock = threading.RLock()
        
        # Stats
        self._stats = {
            "files_indexed": 0,
            "chunks_indexed": 0,
            "last_index_time": None,
        }
        self.index_generation = None
        self._rebuild_required = False
        self._pending_generation = None

    def _resolve_persist_dir(self, base_dir: str, pointer_path: str) -> str:
        """Resolve the active generation directory using a pointer file."""
        try:
            if os.path.exists(pointer_path):
                with open(pointer_path, "r", encoding="utf-8") as f:
                    target = f.read().strip()
                if target and os.path.exists(target):
                    return target
        except Exception:
            pass

        # Default to base_dir and set pointer atomically
        os.makedirs(base_dir, exist_ok=True)
        self._atomic_write_pointer(pointer_path, base_dir)
        return base_dir

    def _atomic_write_pointer(self, pointer_path: str, target: str) -> None:
        """Atomically swap the current generation pointer file."""
        try:
            tmp_path = f"{pointer_path}.tmp"
            with open(tmp_path, "w", encoding="utf-8") as f:
                f.write(target)
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp_path, pointer_path)
            # fsync parent dir for durability
            parent_dir = os.path.dirname(pointer_path) or "."
            try:
                dir_fd = os.open(parent_dir, os.O_DIRECTORY)
                try:
                    os.fsync(dir_fd)
                finally:
                    os.close(dir_fd)
            except Exception:
                pass
        except Exception:
            pass

    def _cleanup_orphan_generations(self, keep_dir: str) -> None:
        """Best-effort cleanup of orphaned generation directories."""
        try:
            parent = os.path.dirname(self.base_dir)
            prefix = os.path.basename(self.base_dir) + "_gen_"
            for name in os.listdir(parent):
                if not name.startswith(prefix):
                    continue
                path = os.path.join(parent, name)
                if path == keep_dir:
                    continue
                try:
                    for root, dirs, files in os.walk(path, topdown=False):
                        for file in files:
                            os.remove(os.path.join(root, file))
                        for d in dirs:
                            os.rmdir(os.path.join(root, d))
                    os.rmdir(path)
                except Exception:
                    continue
        except Exception:
            pass

    def _ensure_chunking_version(self) -> None:
        """Ensure persisted indexes match current chunking version."""
        version_path = os.path.join(self.persist_dir, "chunking_version.txt")
        gen_path = os.path.join(self.persist_dir, "index_generation.txt")
        existing = None
        if os.path.exists(version_path):
            try:
                with open(version_path, "r", encoding="utf-8") as f:
                    existing = f.read().strip()
            except Exception:
                existing = None

        if existing and existing != self.chunking_version:
            logger.warning(
                f"Chunking version mismatch: {existing} -> {self.chunking_version}. Clearing indexes."
            )
            self._rebuild_required = True
            self._pending_generation = str(int(time.time() * 1000))
            self.index_generation = None

        try:
            with open(version_path, "w", encoding="utf-8") as f:
                f.write(self.chunking_version)
        except Exception:
            pass

        if os.path.exists(gen_path):
            try:
                with open(gen_path, "r", encoding="utf-8") as f:
                    self.index_generation = f.read().strip()
            except Exception:
                self.index_generation = None
        if not self.index_generation and not self._rebuild_required:
            self.index_generation = str(int(time.time() * 1000))
            try:
                with open(gen_path, "w", encoding="utf-8") as f:
                    f.write(self.index_generation)
            except Exception:
                pass

    def _reset_indexes(self) -> None:
        """Clear persisted index files and reset in-memory indexes."""
        for name in ("vectors.json", "structure.json", "lexical.json", "vectors.npz", "vectors.npz.tmp"):
            try:
                path = os.path.join(self.persist_dir, name)
                if os.path.exists(path):
                    os.remove(path)
            except Exception:
                pass

        self.vector_index = VectorIndex(
            persist_path=os.path.join(self.persist_dir, "vectors.json")
        )
        self.structural_index = StructuralIndex(
            persist_path=os.path.join(self.persist_dir, "structure.json")
        )
        self.lexical_index = LexicalIndex(
            persist_path=os.path.join(self.persist_dir, "lexical.json")
        )
        self._file_hashes.clear()
    
    def _get_file_lock(self, file_path: str) -> threading.RLock:
        """
        Get or create a lock for a specific file.
        
        Thread-safe: Uses a global lock to protect the locks dict.
        """
        with self._lock_dict_lock:
            if file_path not in self._file_locks:
                self._file_locks[file_path] = threading.RLock()
            return self._file_locks[file_path]
    
    @contextmanager
    def _file_transaction(self, file_path: str):
        """
        Context manager for atomic file operations.
        
        Ensures that reindex operations (delete + insert) are atomic.
        """
        lock = self._get_file_lock(file_path)
        lock.acquire()
        try:
            yield
        finally:
            lock.release()
    
    def index_repository(
        self,
        progress_callback: Optional[callable] = None,
        skip_embeddings: bool = False,
    ) -> Dict:
        """
        Index the entire repository.
        
        Args:
            progress_callback: Optional callback(files_done, total_files, current_file)
            skip_embeddings: Skip embedding generation (for fast re-indexing)
            
        Returns:
            Statistics about the indexing
        """
        logger.info(f"Starting repository index: {self.workspace_root}")
        
        # If we need a clean rebuild, build a new generation and swap atomically
        if self._rebuild_required:
            new_gen = self._pending_generation or str(int(time.time() * 1000))
            new_dir = os.path.join(os.path.dirname(self.base_dir), f"{os.path.basename(self.base_dir)}_gen_{new_gen}")
            temp = DualIndexer(self.workspace_root, persist_dir=new_dir, embedder=self.embedder)
            result = temp.index_repository(progress_callback, skip_embeddings)
            # Swap indexes
            self._atomic_write_pointer(self.pointer_path, temp.persist_dir)
            self.persist_dir = temp.persist_dir
            self.vector_index = temp.vector_index
            self.structural_index = temp.structural_index
            self.lexical_index = temp.lexical_index
            self._file_hashes = temp._file_hashes
            self.index_generation = new_gen
            self._rebuild_required = False
            self._pending_generation = None
            self._cleanup_orphan_generations(self.persist_dir)
            return result

        # Walk all files
        files = list(self.walker.walk())
        total_files = len(files)
        
        logger.info(f"Found {total_files} files to index")
        
        all_chunks: List[SemanticChunk] = []
        
        for i, file in enumerate(files):
            if progress_callback:
                progress_callback(i, total_files, file.relative_path)
            
            try:
                chunks = self._index_single_file(file, skip_embeddings)
                all_chunks.extend(chunks)
                self._file_hashes[file.relative_path] = file.content_hash
            except Exception as e:
                logger.warning(f"Failed to index {file.relative_path}: {e}")
        
        # Batch embed if needed
        if not skip_embeddings and all_chunks:
            chunks_without_embedding = [c for c in all_chunks if c.embedding is None]
            if chunks_without_embedding:
                logger.info(f"Generating embeddings for {len(chunks_without_embedding)} chunks")
                self.embedder.embed_chunks(chunks_without_embedding)
        
        # Add to vector index
        for chunk in all_chunks:
            if chunk.embedding:
                self.vector_index.add(chunk)

        # Add to lexical index
        for chunk in all_chunks:
            self.lexical_index.add(chunk)

        # Optional LSP enrichment
        try:
            if self.config.lsp.enable_lsp_import:
                from ..lsp.lsp_importer import ingest_lsp_index
                ingest_lsp_index(self.structural_index, self.config.lsp.lsp_index_path)
        except Exception:
            pass
        
        # Persist
        self.vector_index.persist()
        self.structural_index.persist()
        self.lexical_index.persist()
        
        self._stats["files_indexed"] = total_files
        self._stats["chunks_indexed"] = len(all_chunks)
        
        logger.info(
            f"Indexing complete: {total_files} files, {len(all_chunks)} chunks"
        )
        
        return {
            "files": total_files,
            "chunks": len(all_chunks),
            "vector_stats": self.vector_index.stats(),
            "structural_stats": self.structural_index.stats(),
        }
    
    async def index_repository_async(
        self,
        progress_callback: Optional[callable] = None,
        skip_embeddings: bool = False,
    ) -> Dict:
        """Async version of index_repository."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None, self.index_repository, progress_callback, skip_embeddings
        )
    
    def index_file(
        self,
        relative_path: str,
        skip_embeddings: bool = False,
    ) -> List[SemanticChunk]:
        """
        Index a single file.
        
        Args:
            relative_path: Path relative to workspace root
            skip_embeddings: Skip embedding generation
            
        Returns:
            List of indexed chunks
        """
        file = self.walker.get_file(relative_path)
        if not file:
            logger.warning(f"File not found: {relative_path}")
            return []
        
        chunks = self._index_single_file(file, skip_embeddings)
        
        # Embed and add to vector index
        if not skip_embeddings and chunks:
            self.embedder.embed_chunks(chunks)
            for chunk in chunks:
                if chunk.embedding:
                    self.vector_index.add(chunk)

        # Add to lexical index
        for chunk in chunks:
            self.lexical_index.add(chunk)
        
        self._file_hashes[relative_path] = file.content_hash
        
        return chunks
    
    def update_file(
        self,
        relative_path: str,
        content: Optional[str] = None,
    ) -> List[SemanticChunk]:
        """
        Update index for a changed file.
        
        Args:
            relative_path: Path relative to workspace root
            content: Optional new content (reads from disk if not provided)
            
        Returns:
            List of new chunks
        """
        # INCREMENTAL DELETION SEMANTICS:
        # 1. Delete ALL old chunks for this file
        # 2. Delete all graph edges originating from this file
        # 3. Re-extract and insert new chunks
        self.remove_file(relative_path)
        
        # Re-index
        if content:
            # Create WalkedFile from provided content
            import hashlib
            file = WalkedFile(
                path=os.path.join(self.workspace_root, relative_path),
                relative_path=relative_path,
                content=content,
                content_hash=hashlib.sha256(content.encode()).hexdigest()[:16],
                size_bytes=len(content.encode()),
            )
            chunks = self._index_single_file(file, skip_embeddings=False)
            self.embedder.embed_chunks(chunks)
            for chunk in chunks:
                if chunk.embedding is not None:
                    self.vector_index.add(chunk)
            for chunk in chunks:
                self.lexical_index.add(chunk)
            return chunks
        else:
            return self.index_file(relative_path)
    
    def reindex_file(self, file_path: str) -> List[SemanticChunk]:
        """
        Reindex a file with proper deletion semantics.
        
        ATOMIC + THREAD-SAFE: Uses file-level locking to ensure
        the delete-then-insert sequence is atomic.
        
        This is the CORRECT way to handle incremental updates:
        1. Delete ALL old chunks for this file from vector index
        2. Delete ALL old chunks from structural index
        3. Delete all graph edges originating from this file
        4. Re-extract and insert new chunks
        
        Args:
            file_path: Path relative to workspace root
            
        Returns:
            List of new chunks
        """
        logger.info(f"Reindexing file: {file_path}")
        
        # ATOMIC TRANSACTION: Lock this file for the entire operation
        with self._file_transaction(file_path):
            # Step 1: Get all old chunk IDs for this file
            old_chunk_ids = self.structural_index.get_chunks_for_file(file_path)
            
            # Step 2: Remove all old chunks from vector index
            for chunk_id in old_chunk_ids:
                self.vector_index.remove(chunk_id)
                self.lexical_index.remove(chunk_id)
            
            # Step 3: Remove file from structural index (removes chunks + edges)
            self.structural_index.remove_file(file_path)
            
            # Step 4: Re-extract new chunks
            file = self.walker.get_file(file_path)
            if not file:
                logger.warning(f"File not found for reindex: {file_path}")
                return []
            
            new_chunks = self._index_single_file(file, skip_embeddings=False)
            
            # Step 5: Generate embeddings
            if new_chunks:
                self.embedder.embed_chunks(new_chunks)
            
            # Step 6: Add to vector index
            for chunk in new_chunks:
                if chunk.embedding is not None:
                    self.vector_index.add(chunk)

            # Step 7: Add to lexical index
            for chunk in new_chunks:
                self.lexical_index.add(chunk)
            
            # Update hash
            self._file_hashes[file_path] = file.content_hash
            
            logger.info(f"Reindexed {file_path}: {len(old_chunk_ids)} old -> {len(new_chunks)} new chunks")
            return new_chunks
    
    def remove_file(self, relative_path: str) -> None:
        """
        Remove a file from all indexes with proper deletion semantics.
        
        THREAD-SAFE: Uses file-level locking.
        
        Args:
            relative_path: Path relative to workspace root
        """
        with self._file_transaction(relative_path):
            # Get ALL chunk IDs for this file (not just symbols)
            chunk_ids = self.structural_index.get_chunks_for_file(relative_path)
            
            # Remove from vector index
            for chunk_id in chunk_ids:
                self.vector_index.remove(chunk_id)
                self.lexical_index.remove(chunk_id)
            
            # Remove from structural index (handles edges too)
            self.structural_index.remove_file(relative_path)
            
            # Remove from hash cache
            self._file_hashes.pop(relative_path, None)
    
    def _index_single_file(
        self,
        file: WalkedFile,
        skip_embeddings: bool = False,
    ) -> List[SemanticChunk]:
        """Index a single file without embedding."""
        # Extract chunks
        chunks = self.extractor.extract(file)
        
        if not chunks:
            return []
        
        # Add to structural index
        for chunk in chunks:
            self.structural_index.index_chunk(chunk)
        
        return chunks
    
    def get_chunk(self, chunk_id: ChunkId) -> Optional[SemanticChunk]:
        """Get a chunk by ID."""
        return self.vector_index.get_chunk(chunk_id)
    
    def get_chunks_for_file(self, relative_path: str) -> List[SemanticChunk]:
        """Get all chunks for a file."""
        symbols = self.structural_index.get_file_symbols(relative_path)
        chunks = []
        for symbol in symbols:
            chunk_id = self.structural_index.graph.get_chunk_id(symbol)
            if chunk_id:
                chunk = self.vector_index.get_chunk(chunk_id)
                if chunk:
                    chunks.append(chunk)
        return chunks
    
    def has_file_changed(self, relative_path: str) -> bool:
        """Check if a file has changed since last index."""
        file = self.walker.get_file(relative_path)
        if not file:
            return True
        
        old_hash = self._file_hashes.get(relative_path)
        return old_hash != file.content_hash
    
    def get_changed_files(self) -> List[str]:
        """Get list of files that have changed since last index."""
        changed = []
        
        for file in self.walker.walk():
            old_hash = self._file_hashes.get(file.relative_path)
            if old_hash != file.content_hash:
                changed.append(file.relative_path)
        
        return changed
    
    def reindex_changed(
        self,
        progress_callback: Optional[callable] = None,
    ) -> Dict:
        """
        Re-index only changed files.
        
        Returns:
            Statistics about the reindexing
        """
        changed = self.get_changed_files()

        # Purge deleted files from indices
        current_files = {f.relative_path for f in self.walker.walk()}
        deleted_files = [p for p in list(self._file_hashes.keys()) if p not in current_files]
        for deleted in deleted_files:
            self.remove_file(deleted)
        
        if not changed and not deleted_files:
            return {"files_updated": 0, "chunks_updated": 0}
        
        logger.info(f"Re-indexing {len(changed)} changed files (deleted={len(deleted_files)})")
        
        total_chunks = 0
        for i, path in enumerate(changed):
            if progress_callback:
                progress_callback(i, len(changed), path)
            
            chunks = self.update_file(path)
            total_chunks += len(chunks)
        
        # Persist
        self.vector_index.persist()
        self.structural_index.persist()
        self.lexical_index.persist()
        
        return {
            "files_updated": len(changed),
            "chunks_updated": total_chunks,
            "files_deleted": len(deleted_files),
        }
    
    def persist(self) -> None:
        """Persist both indexes."""
        self.vector_index.persist()
        self.structural_index.persist()
        self.lexical_index.persist()
    
    def stats(self) -> Dict:
        """Get combined statistics."""
        return {
            "vector": self.vector_index.stats(),
            "structural": self.structural_index.stats(),
            "lexical": self.lexical_index.stats(),
            "files_indexed": self._stats["files_indexed"],
            "chunks_indexed": self._stats["chunks_indexed"],
        }


# Global indexer instance
_dual_indexer: Optional[DualIndexer] = None


def get_dual_indexer(
    workspace_root: Optional[str] = None,
    persist_dir: Optional[str] = None,
) -> DualIndexer:
    """
    Get or create the dual indexer.
    
    Args:
        workspace_root: Root directory of the workspace
        persist_dir: Directory for persistence
    """
    global _dual_indexer
    
    if _dual_indexer is None:
        if not workspace_root:
            raise ValueError("workspace_root required for first initialization")
        _dual_indexer = DualIndexer(workspace_root, persist_dir)
    
    return _dual_indexer
