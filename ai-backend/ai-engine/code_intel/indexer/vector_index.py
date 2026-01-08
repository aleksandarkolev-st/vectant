"""
Vector Index - Semantic similarity search over code chunks.

Uses embeddings to find semantically similar code.
This answers "what seems relevant" but NOT "what must be included".
"""

from __future__ import annotations

import json
import logging
import os
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple
import numpy as np

from ..core.types import SemanticChunk, ChunkId


logger = logging.getLogger("code_intel.indexer.vector")


@dataclass
class VectorSearchResult:
    """Result from vector similarity search."""
    chunk_id: ChunkId
    score: float  # Cosine similarity (0-1)
    chunk: Optional[SemanticChunk] = None


class VectorIndex:
    """
    Vector index for semantic search over code chunks.
    
    Uses in-memory numpy for simplicity. For production scale,
    replace with Pinecone, Weaviate, FAISS, etc.
    
    Key operations:
    - add(chunk): Index a chunk's embedding
    - search(query_embedding, k): Find top-k similar chunks
    - remove(chunk_id): Remove a chunk from index
    """
    
    def __init__(
        self,
        dimension: int = 1536,
        persist_path: Optional[str] = None,
    ):
        """
        Initialize vector index.
        
        Args:
            dimension: Embedding dimension (1536 for text-embedding-3-small)
            persist_path: Optional path for persistence
        """
        self.dimension = dimension
        self.persist_path = persist_path
        
        # Storage
        self._embeddings: Dict[ChunkId, np.ndarray] = {}
        self._chunks: Dict[ChunkId, SemanticChunk] = {}
        
        # Index state
        self._dirty = False
        
        # Load from disk if exists
        if persist_path and os.path.exists(persist_path):
            self._load()
    
    def add(self, chunk: SemanticChunk) -> None:
        """
        Add a chunk to the index.
        
        The chunk must have an embedding set.
        """
        if chunk.embedding is None:
            raise ValueError(f"Chunk {chunk.id} has no embedding")
        
        embedding = np.array(chunk.embedding, dtype=np.float32)
        if embedding.shape[0] != self.dimension:
            raise ValueError(
                f"Embedding dimension mismatch: {embedding.shape[0]} vs {self.dimension}"
            )
        
        # Normalize for cosine similarity
        norm = np.linalg.norm(embedding)
        if norm > 0:
            embedding = embedding / norm
        
        self._embeddings[chunk.id] = embedding
        self._chunks[chunk.id] = chunk
        self._dirty = True
    
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
        
        Returns True if chunk was found and removed.
        """
        if chunk_id in self._embeddings:
            del self._embeddings[chunk_id]
            del self._chunks[chunk_id]
            self._dirty = True
            return True
        return False
    
    def search(
        self,
        query_embedding: List[float],
        k: int = 10,
        min_score: float = 0.0,
        filter_fn: Optional[callable] = None,
    ) -> List[VectorSearchResult]:
        """
        Search for similar chunks.
        
        Args:
            query_embedding: Query vector
            k: Number of results
            min_score: Minimum similarity score
            filter_fn: Optional function(chunk) -> bool to filter results
            
        Returns:
            List of VectorSearchResult sorted by score descending
        """
        if not self._embeddings:
            return []
        
        # Normalize query
        query = np.array(query_embedding, dtype=np.float32)
        norm = np.linalg.norm(query)
        if norm > 0:
            query = query / norm
        
        # Compute all similarities (brute force - fine for <100k chunks)
        results = []
        for chunk_id, embedding in self._embeddings.items():
            score = float(np.dot(query, embedding))
            
            if score < min_score:
                continue
            
            chunk = self._chunks.get(chunk_id)
            if filter_fn and chunk and not filter_fn(chunk):
                continue
            
            results.append(VectorSearchResult(
                chunk_id=chunk_id,
                score=score,
                chunk=chunk,
            ))
        
        # Sort by score descending
        results.sort(key=lambda r: r.score, reverse=True)
        
        return results[:k]
    
    def get_chunk(self, chunk_id: ChunkId) -> Optional[SemanticChunk]:
        """Get a chunk by ID."""
        return self._chunks.get(chunk_id)
    
    def get_all_chunks(self) -> List[SemanticChunk]:
        """Get all indexed chunks."""
        return list(self._chunks.values())
    
    def __len__(self) -> int:
        """Return number of indexed chunks."""
        return len(self._embeddings)
    
    def __contains__(self, chunk_id: ChunkId) -> bool:
        """Check if chunk is indexed."""
        return chunk_id in self._embeddings
    
    def clear(self) -> None:
        """Clear all indexed data."""
        self._embeddings.clear()
        self._chunks.clear()
        self._dirty = True
    
    def persist(self) -> None:
        """Persist index to disk."""
        if not self.persist_path or not self._dirty:
            return
        
        os.makedirs(os.path.dirname(self.persist_path), exist_ok=True)
        
        # Serialize
        data = {
            "dimension": self.dimension,
            "embeddings": {
                cid: emb.tolist() for cid, emb in self._embeddings.items()
            },
            "chunks": {
                cid: chunk.to_dict() for cid, chunk in self._chunks.items()
            },
        }
        
        with open(self.persist_path, "w") as f:
            json.dump(data, f)
        
        self._dirty = False
        logger.info(f"Persisted vector index: {len(self)} chunks")
    
    def _load(self) -> None:
        """Load index from disk."""
        if not self.persist_path or not os.path.exists(self.persist_path):
            return
        
        try:
            with open(self.persist_path, "r") as f:
                data = json.load(f)
            
            self.dimension = data.get("dimension", self.dimension)
            
            # Load embeddings
            for cid, emb_list in data.get("embeddings", {}).items():
                self._embeddings[cid] = np.array(emb_list, dtype=np.float32)
            
            # Load chunks (simplified - in production, deserialize properly)
            # For now, we only store embeddings and reconstruct chunks during indexing
            
            logger.info(f"Loaded vector index: {len(self._embeddings)} embeddings")
            
        except Exception as e:
            logger.error(f"Failed to load vector index: {e}")
    
    def stats(self) -> Dict:
        """Get index statistics."""
        return {
            "total_chunks": len(self._embeddings),
            "dimension": self.dimension,
            "memory_mb": sum(
                emb.nbytes for emb in self._embeddings.values()
            ) / (1024 * 1024),
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
