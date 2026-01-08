"""
Dual Indexer - Combines vector and structural indexing.

This is the main entry point for indexing code.
Coordinates both indexes and maintains consistency.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Dict, List, Optional, Set

from .vector_index import VectorIndex
from .structural_index import StructuralIndex
from .embedder import Embedder, get_embedder

from ..core.types import SemanticChunk, ChunkId, FilePath
from ..core.config import get_config
from ..ingestion import FileWalker, ChunkExtractor, WalkedFile


logger = logging.getLogger("code_intel.indexer.dual")


class DualIndexer:
    """
    Combined vector and structural indexer.
    
    This is the main interface for indexing code.
    
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
        self.persist_dir = persist_dir or os.path.join(
            workspace_root, ".synthi", "code_intel"
        )
        
        # Create persist directory
        os.makedirs(self.persist_dir, exist_ok=True)
        
        # Initialize indexes
        self.vector_index = VectorIndex(
            persist_path=os.path.join(self.persist_dir, "vectors.json")
        )
        self.structural_index = StructuralIndex(
            persist_path=os.path.join(self.persist_dir, "structure.json")
        )
        
        # Embedder
        self.embedder = embedder or get_embedder()
        
        # File walker
        self.walker = FileWalker(workspace_root)
        
        # Chunk extractor
        self.extractor = ChunkExtractor()
        
        # File hashes for change detection
        self._file_hashes: Dict[FilePath, str] = {}
        
        # Stats
        self._stats = {
            "files_indexed": 0,
            "chunks_indexed": 0,
            "last_index_time": None,
        }
    
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
        
        # Persist
        self.vector_index.persist()
        self.structural_index.persist()
        
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
        # Remove old entries
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
                if chunk.embedding:
                    self.vector_index.add(chunk)
            return chunks
        else:
            return self.index_file(relative_path)
    
    def remove_file(self, relative_path: str) -> None:
        """
        Remove a file from all indexes.
        
        Args:
            relative_path: Path relative to workspace root
        """
        # Get symbols to remove
        symbols = self.structural_index.get_file_symbols(relative_path)
        
        # Remove from vector index
        for symbol in symbols:
            chunk_id = self.structural_index.graph.get_chunk_id(symbol)
            if chunk_id:
                self.vector_index.remove(chunk_id)
        
        # Remove from structural index
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
        
        if not changed:
            return {"files_updated": 0, "chunks_updated": 0}
        
        logger.info(f"Re-indexing {len(changed)} changed files")
        
        total_chunks = 0
        for i, path in enumerate(changed):
            if progress_callback:
                progress_callback(i, len(changed), path)
            
            chunks = self.update_file(path)
            total_chunks += len(chunks)
        
        # Persist
        self.vector_index.persist()
        self.structural_index.persist()
        
        return {
            "files_updated": len(changed),
            "chunks_updated": total_chunks,
        }
    
    def persist(self) -> None:
        """Persist both indexes."""
        self.vector_index.persist()
        self.structural_index.persist()
    
    def stats(self) -> Dict:
        """Get combined statistics."""
        return {
            "vector": self.vector_index.stats(),
            "structural": self.structural_index.stats(),
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
