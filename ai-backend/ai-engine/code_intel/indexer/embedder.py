"""
Embedder - Generate embeddings for semantic chunks.

Uses Google's text-embedding-004 by default.
Can be swapped for local models or other providers.
"""

from __future__ import annotations

import asyncio
import logging
import os
from typing import List, Optional

from ..core.types import SemanticChunk
from ..core.config import get_config


logger = logging.getLogger("code_intel.indexer.embedder")


class Embedder:
    """
    Generate embeddings for code chunks.
    
    Supports:
    - Google text-embedding-004 (default)
    - Batch processing for efficiency
    - Caching (optional)
    """
    
    def __init__(
        self,
        model: str = "text-embedding-004",
        api_key: Optional[str] = None,
        batch_size: int = 100,
    ):
        self.model = model
        self.api_key = api_key or os.getenv("GEMINI_API_KEY")
        self.batch_size = batch_size
        
        self._client = None
        self._dimension = 768  # text-embedding-004
    
    def _get_client(self):
        """Lazy-load Google GenAI client."""
        if self._client is None:
            try:
                import google.generativeai as genai
                genai.configure(api_key=self.api_key)
                self._client = genai
            except ImportError:
                raise ImportError("google-generativeai package required for embeddings")
        return self._client
    
    def embed_text(self, text: str) -> List[float]:
        """
        Embed a single text string.
        
        Args:
            text: Text to embed
            
        Returns:
            Embedding vector
        """
        client = self._get_client()
        
        # Truncate if too long (model limit is ~10k tokens)
        if len(text) > 30000:
            text = text[:30000]
        
        result = client.embed_content(
            model=f"models/{self.model}",
            content=text,
            task_type="RETRIEVAL_DOCUMENT",
        )
        
        return result['embedding']
    
    def embed_query(self, query: str) -> List[float]:
        """
        Embed a query for retrieval.
        
        Uses RETRIEVAL_QUERY task type for better query embeddings.
        
        Args:
            query: Search query to embed
            
        Returns:
            Embedding vector
        """
        client = self._get_client()
        
        result = client.embed_content(
            model=f"models/{self.model}",
            content=query,
            task_type="RETRIEVAL_QUERY",
        )
        
        return result['embedding']
    
    def embed_texts(self, texts: List[str]) -> List[List[float]]:
        """
        Embed multiple texts in batches.
        
        Args:
            texts: List of texts to embed
            
        Returns:
            List of embedding vectors
        """
        client = self._get_client()
        all_embeddings = []
        
        # Process in batches
        for i in range(0, len(texts), self.batch_size):
            batch = texts[i:i + self.batch_size]
            
            # Truncate long texts
            batch = [t[:30000] if len(t) > 30000 else t for t in batch]
            
            try:
                # Gemini supports batch embedding
                result = client.embed_content(
                    model=f"models/{self.model}",
                    content=batch,
                    task_type="RETRIEVAL_DOCUMENT",
                )
                
                # Extract embeddings in order
                batch_embeddings = result['embedding']
                all_embeddings.extend(batch_embeddings)
                
            except Exception as e:
                logger.error(f"Embedding batch failed: {e}")
                # Fill with None for failed batch
                all_embeddings.extend([None] * len(batch))
    
    def embed_chunk(self, chunk: SemanticChunk) -> SemanticChunk:
        """
        Embed a semantic chunk.
        
        Creates embedding from formatted chunk content.
        
        Args:
            chunk: Chunk to embed
            
        Returns:
            Chunk with embedding set
        """
        # Build text for embedding
        # Include metadata for better semantic matching
        parts = []
        
        if chunk.metadata.docstring:
            parts.append(chunk.metadata.docstring)
        
        if chunk.metadata.signature:
            parts.append(chunk.metadata.signature)
        
        parts.append(chunk.code_body)
        
        text = "\n".join(parts)
        
        try:
            embedding = self.embed_text(text)
            chunk.embedding = embedding
        except Exception as e:
            logger.warning(f"Failed to embed chunk {chunk.id}: {e}")
        
        return chunk
    
    def embed_chunks(self, chunks: List[SemanticChunk]) -> List[SemanticChunk]:
        """
        Embed multiple chunks in batches.
        
        Args:
            chunks: Chunks to embed
            
        Returns:
            Chunks with embeddings set
        """
        # Build texts
        texts = []
        for chunk in chunks:
            parts = []
            if chunk.metadata.docstring:
                parts.append(chunk.metadata.docstring)
            if chunk.metadata.signature:
                parts.append(chunk.metadata.signature)
            parts.append(chunk.code_body)
            texts.append("\n".join(parts))
        
        # Embed
        embeddings = self.embed_texts(texts)
        
        # Assign
        for chunk, embedding in zip(chunks, embeddings):
            if embedding:
                chunk.embedding = embedding
        
        return chunks
    
    async def embed_text_async(self, text: str) -> List[float]:
        """Async version of embed_text."""
        # Run sync version in thread pool
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self.embed_text, text)
    
    async def embed_chunks_async(self, chunks: List[SemanticChunk]) -> List[SemanticChunk]:
        """Async version of embed_chunks."""
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, self.embed_chunks, chunks)
    
    @property
    def dimension(self) -> int:
        """Get embedding dimension."""
        return self._dimension


class LocalEmbedder(Embedder):
    """
    Local embedder using sentence-transformers.
    
    For offline use or when API calls are not desired.
    """
    
    def __init__(
        self,
        model: str = "all-MiniLM-L6-v2",
        batch_size: int = 32,
    ):
        super().__init__(model=model, batch_size=batch_size)
        self._model = None
        self._dimension = 384  # all-MiniLM-L6-v2
    
    def _get_model(self):
        """Lazy-load sentence transformer model."""
        if self._model is None:
            try:
                from sentence_transformers import SentenceTransformer
                self._model = SentenceTransformer(self.model)
                self._dimension = self._model.get_sentence_embedding_dimension()
            except ImportError:
                raise ImportError("sentence-transformers package required")
        return self._model
    
    def embed_text(self, text: str) -> List[float]:
        """Embed text using local model."""
        model = self._get_model()
        embedding = model.encode(text, convert_to_numpy=True)
        return embedding.tolist()
    
    def embed_texts(self, texts: List[str]) -> List[List[float]]:
        """Embed multiple texts using local model."""
        model = self._get_model()
        embeddings = model.encode(texts, convert_to_numpy=True, batch_size=self.batch_size)
        return [e.tolist() for e in embeddings]


# Global embedder instance
_embedder: Optional[Embedder] = None


def get_embedder(
    use_local: bool = False,
    model: Optional[str] = None,
) -> Embedder:
    """
    Get or create the embedder.
    
    Args:
        use_local: Use local model instead of Gemini
        model: Override model name
    """
    global _embedder
    
    if _embedder is None:
        if use_local:
            _embedder = LocalEmbedder(model=model or "all-MiniLM-L6-v2")
        else:
            config = get_config()
            _embedder = Embedder(
                model=model or config.indexer.embedding_model,
                api_key=config.gemini_api_key,
            )
    
    return _embedder
