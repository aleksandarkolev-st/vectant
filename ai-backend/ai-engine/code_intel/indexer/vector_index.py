"""
Vector Index - Semantic similarity search over code chunks.

Uses embeddings to find semantically similar code.
This answers "what seems relevant" but NOT "what must be included".

CRITICAL FIXES IMPLEMENTED:
1. Binary storage (.npz) instead of JSON for vectors
2. ATOMIC WRITES: temp file + rename for crash safety
3. Vectorized search via matrix multiply (no Python loops)
4. float32 storage for efficiency and precision
5. Proper scaling path to FAISS/HNSW for >20k chunks
"""

from __future__ import annotations

import json
import logging
import os
import tempfile
import shutil
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple
import numpy as np

from ..core.types import SemanticChunk, ChunkId


logger = logging.getLogger("code_intel.indexer.vector")


@dataclass
class VectorSearchResult:
    """Result from vector similarity search."""
    chunk_id: ChunkId
    score: float  # Cosine similarity (0-1)
    chunk: Optional[SemanticChunk] = None


# Threshold for switching from brute-force to ANN (HNSW)
HNSW_THRESHOLD = 50_000  # chunks

# Try to import hnswlib for large indexes
try:
    import hnswlib
    HNSWLIB_AVAILABLE = True
except ImportError:
    HNSWLIB_AVAILABLE = False
    hnswlib = None


class VectorIndex:
    """
    Vector index for semantic search over code chunks.
    
    BINARY STORAGE: Uses numpy .npz format for efficient persistence.
    - Stores vectors as (N, dim) float32 matrix
    - Much smaller than JSON
    - Much faster to load/save
    - No float precision loss
    
    VECTORIZED SEARCH: Single matrix multiply instead of Python loop.
    - O(1) in Python, O(N*dim) in numpy/BLAS
    - 10-100x faster than dict iteration
    
    HNSW FALLBACK: For >50k chunks, automatically switch to HNSW if available.
    - Set HNSW_THRESHOLD to control the cutoff
    - Requires: pip install hnswlib
    
    NORMALIZATION: All vectors are L2-normalized on insertion for cosine similarity.
    """
    
    def __init__(
        self,
        dimension: int = 768,
        persist_path: Optional[str] = None,
        hnsw_threshold: int = HNSW_THRESHOLD,
    ):
        """
        Initialize vector index.
        
        Args:
            dimension: Embedding dimension (768 for text-embedding-004)
            persist_path: Optional path for persistence (.npz format)
            hnsw_threshold: Number of chunks at which to switch to HNSW
        """
        self.dimension = dimension
        self.persist_path = persist_path
        self.hnsw_threshold = hnsw_threshold
        
        # Binary storage - ordered list of IDs and stacked matrix
        self._ids: List[str] = []
        self._matrix: Optional[np.ndarray] = None  # (N, dim) float32, L2-normalized
        self._id_to_idx: Dict[str, int] = {}
        
        # Chunk metadata storage (separate from vectors)
        self._chunks: Dict[ChunkId, SemanticChunk] = {}
        
        # HNSW index for large collections
        self._hnsw_index: Optional[Any] = None
        self._using_hnsw: bool = False
        
        # Index state
        self._dirty = False
        
        # Load from disk if exists
        if persist_path and os.path.exists(self._get_vectors_path()):
            self._load()
    
    def _get_vectors_path(self) -> str:
        """Get path for binary vector storage."""
        if not self.persist_path:
            return ""
        # Use .npz extension for numpy compressed
        base = self.persist_path.rsplit(".", 1)[0] if "." in self.persist_path else self.persist_path
        return f"{base}.npz"
    
    def _get_metadata_path(self) -> str:
        """Get path for chunk metadata storage."""
        if not self.persist_path:
            return ""
        base = self.persist_path.rsplit(".", 1)[0] if "." in self.persist_path else self.persist_path
        return f"{base}_meta.json"
    
    def _normalize_embedding(self, embedding: np.ndarray) -> np.ndarray:
        """
        L2-normalize an embedding vector.
        
        CONSISTENCY: All embeddings must be normalized the same way.
        This ensures cosine similarity works correctly via dot product.
        """
        norm = np.linalg.norm(embedding)
        if norm > 1e-8:  # Avoid division by near-zero
            return embedding / norm
        return embedding
    
    def _maybe_switch_to_hnsw(self) -> None:
        """
        Check if we should switch to HNSW for large indexes.
        
        Automatically switches when:
        1. Number of vectors exceeds threshold
        2. hnswlib is available
        3. Not already using HNSW
        """
        if self._using_hnsw:
            return
        
        if len(self._ids) < self.hnsw_threshold:
            return
        
        if not HNSWLIB_AVAILABLE:
            logger.warning(
                f"Index has {len(self._ids)} vectors (threshold: {self.hnsw_threshold}). "
                f"Install hnswlib for faster search: pip install hnswlib"
            )
            return
        
        logger.info(f"Switching to HNSW index ({len(self._ids)} vectors)")
        self._build_hnsw_index()
    
    def _build_hnsw_index(self) -> None:
        """Build HNSW index from current matrix."""
        if not HNSWLIB_AVAILABLE or self._matrix is None:
            return
        
        num_elements = len(self._ids)
        # Create index
        self._hnsw_index = hnswlib.Index(space='ip', dim=self.dimension)  # inner product = cosine for normalized
        self._hnsw_index.init_index(max_elements=num_elements * 2, ef_construction=200, M=16)
        
        # Add all vectors (skip removed ones marked with zero)
        valid_ids = []
        valid_vectors = []
        for i, chunk_id in enumerate(self._ids):
            if chunk_id and np.any(self._matrix[i]):  # Not removed
                valid_ids.append(i)
                valid_vectors.append(self._matrix[i])
        
        if valid_vectors:
            self._hnsw_index.add_items(np.array(valid_vectors), valid_ids)
        
        self._hnsw_index.set_ef(50)  # ef for search
        self._using_hnsw = True
        logger.info(f"HNSW index built with {len(valid_ids)} vectors")
    
    def add(self, chunk: SemanticChunk) -> None:
        """
        Add a chunk to the index.
        
        The chunk must have an embedding set (as numpy array or list).
        All embeddings are L2-normalized for cosine similarity.
        """
        if chunk.embedding is None:
            raise ValueError(f"Chunk {chunk.id} has no embedding")
        
        # Convert to float32 numpy array
        if isinstance(chunk.embedding, np.ndarray):
            embedding = chunk.embedding.astype(np.float32)
        else:
            embedding = np.array(chunk.embedding, dtype=np.float32)
        
        if embedding.shape[0] != self.dimension:
            raise ValueError(
                f"Embedding dimension mismatch: {embedding.shape[0]} vs {self.dimension}"
            )
        
        # ALWAYS normalize for cosine similarity consistency
        embedding = self._normalize_embedding(embedding)
        
        # Check if chunk already exists (update case)
        if chunk.id in self._id_to_idx:
            idx = self._id_to_idx[chunk.id]
            self._matrix[idx] = embedding
            self._chunks[chunk.id] = chunk
            
            # Update HNSW if active
            if self._using_hnsw and self._hnsw_index is not None:
                # hnswlib doesn't support update, need to rebuild periodically
                pass
        else:
            # Add new chunk
            if self._matrix is None:
                self._matrix = embedding.reshape(1, -1)
            else:
                self._matrix = np.vstack([self._matrix, embedding])
            
            idx = len(self._ids)
            self._ids.append(chunk.id)
            self._id_to_idx[chunk.id] = idx
            self._chunks[chunk.id] = chunk
            
            # Add to HNSW if active
            if self._using_hnsw and self._hnsw_index is not None:
                try:
                    self._hnsw_index.add_items(embedding.reshape(1, -1), [idx])
                except Exception as e:
                    logger.warning(f"Failed to add to HNSW: {e}, rebuilding index")
                    self._build_hnsw_index()
        
        self._dirty = True
        
        # Check if we should switch to HNSW
        self._maybe_switch_to_hnsw()
    
    def add_batch(self, chunks: List[SemanticChunk]) -> int:
        """
        Add multiple chunks to the index.
        
        Returns number of chunks added.
        """
        added = 0
        for chunk in chunks:
            try:
                self.add(chunk)
                added += 1
            except ValueError as e:
                logger.warning(f"Failed to add chunk: {e}")
        
        return added
    
    def remove(self, chunk_id: ChunkId) -> bool:
        """
        Remove a chunk from the index.
        
        Note: For efficiency, this marks the slot as removed but doesn't
        compact the matrix. Call compact() periodically to reclaim space.
        
        Returns True if chunk was found and removed.
        """
        if chunk_id not in self._id_to_idx:
            return False
        
        idx = self._id_to_idx[chunk_id]
        
        # Zero out the embedding (will have 0 similarity with everything)
        if self._matrix is not None and idx < len(self._matrix):
            self._matrix[idx] = 0
        
        # Remove from mappings
        del self._id_to_idx[chunk_id]
        self._ids[idx] = ""  # Mark as removed
        
        if chunk_id in self._chunks:
            del self._chunks[chunk_id]
        
        self._dirty = True
        return True
    
    def compact(self) -> None:
        """
        Compact the index by removing empty slots.
        
        Call this periodically after many removes to reclaim memory.
        Also rebuilds HNSW index if active.
        """
        if self._matrix is None:
            return
        
        # Find non-empty slots
        valid_indices = [i for i, cid in enumerate(self._ids) if cid]
        
        if len(valid_indices) == len(self._ids):
            return  # No compaction needed
        
        # Rebuild
        new_ids = [self._ids[i] for i in valid_indices]
        new_matrix = self._matrix[valid_indices] if valid_indices else None
        
        self._ids = new_ids
        self._matrix = new_matrix
        self._id_to_idx = {cid: i for i, cid in enumerate(self._ids)}
        self._dirty = True
        
        # Rebuild HNSW index if we were using it
        if self._using_hnsw:
            self._using_hnsw = False
            self._hnsw_index = None
            self._maybe_switch_to_hnsw()
        
        logger.info(f"Compacted vector index: {len(valid_indices)} vectors")
    
    def search(
        self,
        query_embedding: List[float] | np.ndarray,
        k: int = 10,
        min_score: float = 0.0,
        filter_fn: Optional[callable] = None,
    ) -> List[Tuple[SemanticChunk, float]]:
        """
        Search for similar chunks.
        
        Uses HNSW for large indexes (>threshold), brute-force for small ones.
        
        BRUTE-FORCE: Vectorized matrix multiply - O(1) in Python.
        HNSW: O(log N) approximate nearest neighbor search.
        
        Args:
            query_embedding: Query vector (will be L2-normalized)
            k: Number of results
            min_score: Minimum similarity score (0-1)
            filter_fn: Optional function(chunk) -> bool to filter results
            
        Returns:
            List of (SemanticChunk, score) tuples sorted by score descending
        """
        if self._matrix is None or len(self._ids) == 0:
            return []
        
        # Normalize query (MUST match how we normalize stored vectors)
        if isinstance(query_embedding, np.ndarray):
            query = query_embedding.astype(np.float32)
        else:
            query = np.array(query_embedding, dtype=np.float32)
        
        query = self._normalize_embedding(query)
        
        # Use HNSW for large indexes
        if self._using_hnsw and self._hnsw_index is not None:
            return self._search_hnsw(query, k, min_score, filter_fn)
        
        # VECTORIZED brute-force: Single matrix multiply for all similarities
        # (N, dim) @ (dim,) -> (N,) scores
        scores = self._matrix @ query
        
        # Apply minimum score filter
        if min_score > 0:
            valid_mask = scores >= min_score
            valid_indices = np.where(valid_mask)[0]
            valid_scores = scores[valid_mask]
        else:
            valid_indices = np.arange(len(scores))
            valid_scores = scores
        
        # Get top-k using argpartition (faster than full sort for large N)
        if len(valid_scores) <= k:
            top_k_local_idx = np.argsort(valid_scores)[::-1]
        else:
            # Partial sort - O(N) instead of O(N log N)
            top_k_local_idx = np.argpartition(valid_scores, -k)[-k:]
            # Sort the top-k
            top_k_local_idx = top_k_local_idx[np.argsort(valid_scores[top_k_local_idx])[::-1]]
        
        # Map back to original indices
        top_k_idx = valid_indices[top_k_local_idx]
        
        # Build results
        results = []
        for idx in top_k_idx:
            chunk_id = self._ids[idx]
            if not chunk_id:  # Skip removed slots
                continue
            
            chunk = self._chunks.get(chunk_id)
            if chunk is None:
                continue
            
            if filter_fn and not filter_fn(chunk):
                continue
            
            score = float(scores[idx])
            results.append((chunk, score))
        
        return results[:k]
    
    def _search_hnsw(
        self,
        query: np.ndarray,
        k: int,
        min_score: float,
        filter_fn: Optional[callable],
    ) -> List[Tuple[SemanticChunk, float]]:
        """
        Search using HNSW index.
        
        Note: HNSW uses inner product (cosine for normalized vectors).
        """
        # Request more results to allow for filtering
        fetch_k = k * 3 if filter_fn else k
        
        try:
            labels, distances = self._hnsw_index.knn_query(query.reshape(1, -1), k=fetch_k)
            labels = labels[0]
            distances = distances[0]  # Inner product scores (higher = more similar)
        except Exception as e:
            logger.warning(f"HNSW search failed: {e}, falling back to brute-force")
            self._using_hnsw = False
            return self.search(query, k, min_score, filter_fn)
        
        results = []
        for label, score in zip(labels, distances):
            if label < 0 or label >= len(self._ids):
                continue
            
            chunk_id = self._ids[label]
            if not chunk_id:
                continue
            
            # Score check
            if score < min_score:
                continue
            
            chunk = self._chunks.get(chunk_id)
            if chunk is None:
                continue
            
            if filter_fn and not filter_fn(chunk):
                continue
            
            results.append((chunk, float(score)))
            
            if len(results) >= k:
                break
        
        return results
    
    def get_chunk(self, chunk_id: ChunkId) -> Optional[SemanticChunk]:
        """Get a chunk by ID."""
        return self._chunks.get(chunk_id)
    
    def get_all_chunks(self) -> List[SemanticChunk]:
        """Get all indexed chunks."""
        return list(self._chunks.values())
    
    def get_embedding(self, chunk_id: ChunkId) -> Optional[np.ndarray]:
        """Get embedding vector for a chunk."""
        if chunk_id not in self._id_to_idx:
            return None
        idx = self._id_to_idx[chunk_id]
        if self._matrix is None or idx >= len(self._matrix):
            return None
        return self._matrix[idx].copy()
    
    def __len__(self) -> int:
        """Return number of indexed chunks."""
        return len(self._chunks)
    
    def __contains__(self, chunk_id: ChunkId) -> bool:
        """Check if chunk is indexed."""
        return chunk_id in self._id_to_idx
    
    def clear(self) -> None:
        """Clear all indexed data."""
        self._ids.clear()
        self._matrix = None
        self._id_to_idx.clear()
        self._chunks.clear()
        self._dirty = True
    
    def persist(self) -> None:
        """
        Persist index to disk using BINARY format with ATOMIC writes.
        
        ATOMIC WRITES: Write to temp file, then rename.
        This prevents corruption if process crashes mid-write.
        
        Saves:
        - vectors.npz: Binary numpy compressed (ids + float32 matrix)
        - vectors_meta.json: Chunk metadata (without embeddings)
        """
        if not self.persist_path or not self._dirty:
            return
        
        # Ensure directory exists
        persist_dir = os.path.dirname(self.persist_path) or "."
        os.makedirs(persist_dir, exist_ok=True)
        
        # Save vectors in binary format with ATOMIC write
        vectors_path = self._get_vectors_path()
        if self._matrix is not None and len(self._ids) > 0:
            # Write to temp file first
            fd, temp_path = tempfile.mkstemp(suffix='.npz', dir=persist_dir)
            try:
                os.close(fd)  # Close fd, we'll use numpy to write
                np.savez_compressed(
                    temp_path,
                    ids=np.array(self._ids, dtype=object),
                    vectors=self._matrix.astype(np.float32),
                    dimension=np.array([self.dimension]),
                )
                # Atomic rename (on same filesystem)
                shutil.move(temp_path, vectors_path)
            except Exception:
                # Clean up temp file on failure
                if os.path.exists(temp_path):
                    os.remove(temp_path)
                raise
        
        # Save chunk metadata with ATOMIC write
        meta_path = self._get_metadata_path()
        chunk_data = {}
        for cid, chunk in self._chunks.items():
            chunk_data[cid] = {
                "id": chunk.id,
                "file_path": chunk.metadata.file_path,
                "start_line": chunk.metadata.start_line,
                "end_line": chunk.metadata.end_line,
                "symbol_name": chunk.metadata.symbol_name,
                "qualified_name": chunk.metadata.qualified_name,
                "symbol_type": chunk.metadata.symbol_type.value,
                "signature": chunk.metadata.signature,
                "docstring": chunk.metadata.docstring,
                "language": chunk.metadata.language,
                "is_public": chunk.metadata.is_public,
                "is_test": chunk.metadata.is_test,
                "module_group": chunk.metadata.module_group,
                "token_count": chunk.token_count,
                "content_hash": chunk.content_hash,  # For lazy loading verification
                # Note: code_body not saved - loaded lazily from disk
            }
        
        # Atomic write for metadata JSON
        fd, temp_meta = tempfile.mkstemp(suffix='.json', dir=persist_dir)
        try:
            with os.fdopen(fd, 'w') as f:
                json.dump({"dimension": self.dimension, "chunks": chunk_data}, f)
            shutil.move(temp_meta, meta_path)
        except Exception:
            if os.path.exists(temp_meta):
                os.remove(temp_meta)
            raise
        
        self._dirty = False
        logger.info(f"Persisted vector index: {len(self)} chunks (binary format, atomic)")
    
    def _load(self) -> None:
        """Load index from disk."""
        vectors_path = self._get_vectors_path()
        meta_path = self._get_metadata_path()
        
        # Load vectors
        if os.path.exists(vectors_path):
            try:
                data = np.load(vectors_path, allow_pickle=True)
                self._ids = data['ids'].tolist()
                self._matrix = data['vectors'].astype(np.float32)
                if 'dimension' in data:
                    self.dimension = int(data['dimension'][0])
                self._id_to_idx = {cid: i for i, cid in enumerate(self._ids) if cid}
                logger.info(f"Loaded {len(self._ids)} vectors from binary storage")
            except Exception as e:
                logger.error(f"Failed to load vectors: {e}")
        
        # Load metadata
        if os.path.exists(meta_path):
            try:
                with open(meta_path, "r") as f:
                    data = json.load(f)
                
                self.dimension = data.get("dimension", self.dimension)
                
                from ..core.types import ChunkMetadata, SymbolType
                
                for cid, chunk_data in data.get("chunks", {}).items():
                    metadata = ChunkMetadata(
                        file_path=chunk_data.get("file_path", ""),
                        start_line=chunk_data.get("start_line", 0),
                        end_line=chunk_data.get("end_line", 0),
                        symbol_name=chunk_data.get("symbol_name", ""),
                        qualified_name=chunk_data.get("qualified_name", ""),
                        symbol_type=SymbolType(chunk_data.get("symbol_type", "unknown")),
                        signature=chunk_data.get("signature", ""),
                        docstring=chunk_data.get("docstring", ""),
                        language=chunk_data.get("language", ""),
                        is_public=chunk_data.get("is_public", True),
                        is_test=chunk_data.get("is_test", False),
                        module_group=chunk_data.get("module_group", ""),
                    )
                    
                    # Get embedding from matrix if available
                    embedding = None
                    if cid in self._id_to_idx and self._matrix is not None:
                        idx = self._id_to_idx[cid]
                        if idx < len(self._matrix):
                            embedding = self._matrix[idx]
                    
                    chunk = SemanticChunk(
                        id=cid,
                        metadata=metadata,
                        embedding=embedding,
                        token_count=chunk_data.get("token_count", 0),
                        content_hash=chunk_data.get("content_hash", ""),  # Load hash for verification
                    )
                    self._chunks[cid] = chunk
                
                logger.info(f"Loaded {len(self._chunks)} chunk metadata records")
                
            except Exception as e:
                logger.error(f"Failed to load metadata: {e}")
    
    def stats(self) -> Dict:
        """Get index statistics."""
        matrix_bytes = self._matrix.nbytes if self._matrix is not None else 0
        return {
            "total_chunks": len(self._chunks),
            "total_vectors": len(self._ids),
            "dimension": self.dimension,
            "memory_mb": matrix_bytes / (1024 * 1024),
            "storage_format": "binary_npz",
        }


class VectorIndexBatch:
    """
    Batch operations for vector index.
    
    Use when indexing large numbers of chunks to minimize overhead.
    """
    
    def __init__(self, index: VectorIndex):
        self.index = index
        self._pending: List[SemanticChunk] = []
    
    def add(self, chunk: SemanticChunk) -> None:
        """Add chunk to batch."""
        self._pending.append(chunk)
    
    def flush(self) -> int:
        """Flush all pending chunks to index."""
        added = self.index.add_batch(self._pending)
        self._pending.clear()
        return added
    
    def __enter__(self) -> "VectorIndexBatch":
        return self
    
    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        self.flush()
