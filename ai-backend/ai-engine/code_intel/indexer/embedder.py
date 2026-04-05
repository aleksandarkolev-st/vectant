"""
Embedder - Generate embeddings for semantic chunks.

Uses Google's text-embedding-004 by default.
Can be swapped for local models or other providers.

CRITICAL FIXES IMPLEMENTED:
1. Structured embed text instead of raw code
2. Key line extraction (returns, raises, external calls)
3. Semantic enrichment for better retrieval
4. Proper handling of long functions
"""

from __future__ import annotations

import asyncio
import logging
import os
import re
from typing import List, Optional, Set

import numpy as np

from ..core.types import SemanticChunk
from ..core.config import get_config


logger = logging.getLogger("code_intel.indexer.embedder")


def resolve_embedding_api_key(api_key: Optional[str] = None) -> Optional[str]:
    return api_key or os.getenv("GEMINI_API_KEY") or os.getenv("GOOGLE_API_KEY")


def extract_key_lines(code: str, max_lines: int = 10) -> str:
    """
    Extract key lines from code for embedding.
    
    Key lines include:
    - Return statements
    - Raise/throw statements
    - External function calls
    - Important assignments
    
    This preserves semantic meaning even when full code is truncated.
    
    Args:
        code: Full code body
        max_lines: Maximum number of key lines to extract
        
    Returns:
        Key lines joined by newlines
    """
    key_lines = []
    lines = code.split('\n')
    
    for line in lines:
        stripped = line.strip()
        if not stripped:
            continue
        
        # Return statements
        if stripped.startswith('return '):
            key_lines.append(stripped)
        # Raise/throw statements
        elif stripped.startswith(('raise ', 'throw ')):
            key_lines.append(stripped)
        # Yield statements
        elif stripped.startswith('yield '):
            key_lines.append(stripped)
        # External calls (function calls with dots or specific patterns)
        elif re.search(r'\w+\.\w+\(', stripped) and not stripped.startswith('#'):
            # Extract just the call part
            match = re.search(r'(\w+\.\w+\([^)]*\))', stripped)
            if match:
                key_lines.append(match.group(1))
        # Important assignments (self., this., const, let, var)
        elif re.match(r'(self\.|this\.|const |let |var )\w+\s*=', stripped):
            key_lines.append(stripped.split('=')[0].strip() + ' = ...')
    
    # Deduplicate while preserving order
    seen: Set[str] = set()
    unique_lines = []
    for line in key_lines:
        if line not in seen:
            seen.add(line)
            unique_lines.append(line)
    
    return '\n'.join(unique_lines[:max_lines])


def build_embed_text(chunk: SemanticChunk) -> str:
    """
    Build structured text for embedding a chunk.
    
    This produces MUCH better embeddings than raw code because:
    1. Symbol identity is explicit
    2. Docstring is prioritized
    3. Key lines preserve semantics even for long functions
    4. Import context provides semantic hints
    
    Format:
        SYMBOL: module.Class.method
        TYPE: method
        SIGNATURE: def method(self, arg1: str) -> bool
        DOC: Method docstring (capped at 500 chars)
        KEY: return statements, raises, external calls
        USES: import1, import2, ...
    
    Args:
        chunk: SemanticChunk to embed
        
    Returns:
        Structured text for embedding
    """
    parts = []
    
    # 1. Symbol identity
    qualified_name = chunk.metadata.qualified_name or chunk.metadata.symbol_name
    if qualified_name:
        parts.append(f"SYMBOL: {qualified_name}")
    
    # 2. Symbol type
    if chunk.metadata.symbol_type:
        parts.append(f"TYPE: {chunk.metadata.symbol_type.value}")
    
    # 3. Signature (critical for API matching)
    if chunk.metadata.signature:
        parts.append(f"SIGNATURE: {chunk.metadata.signature}")
    
    # 4. Docstring (capped to preserve key info)
    if chunk.metadata.docstring:
        doc = chunk.metadata.docstring[:500]
        if len(chunk.metadata.docstring) > 500:
            doc += "..."
        parts.append(f"DOC: {doc}")
    
    # 5. Key lines (semantic essence of the implementation)
    code = chunk._code_body or ""
    if code:
        key_lines = extract_key_lines(code)
        if key_lines:
            parts.append(f"KEY: {key_lines}")
    
    # 6. Imports used (semantic context)
    if chunk.metadata.imports_used:
        imports_list = list(chunk.metadata.imports_used)[:10]
        parts.append(f"USES: {', '.join(imports_list)}")
    
    return "\n".join(parts)


class Embedder:
    """
    Generate embeddings for code chunks.
    
    Supports:
    - Google text-embedding-004 (default)
    - Batch processing for efficiency
    - Query embedding caching for faster repeated queries
    - Request deduplication for concurrent identical requests
    """
    
    # Model dimensions mapping
    MODEL_DIMENSIONS = {
        "text-embedding-004": 768,
        "gemini-embedding-001": 3072,
        "text-embedding-gecko": 768,
    }
    
    def __init__(
        self,
        model: str = "gemini-embedding-001",  # Newer model with better performance
        api_key: Optional[str] = None,
        batch_size: int = 100,
        cache_size: int = 1000,  # Increased cache size for better TTFT
    ):
        self.model = model
        self.api_key = resolve_embedding_api_key(api_key)
        self.batch_size = batch_size
        
        self._client = None
        self._dimension = self.MODEL_DIMENSIONS.get(model, 3072)  # Default to gemini-embedding-001 dimensions
        
        # Query embedding cache for faster repeated queries (primary TTFT optimization)
        self._query_cache: dict = {}
        self._cache_size = cache_size
        
        # In-flight request deduplication to avoid duplicate API calls
        # Maps query -> Future, so concurrent identical requests share one API call
        self._in_flight: dict = {}
        import threading
        self._in_flight_lock = threading.Lock()

    def has_api_key(self) -> bool:
        return bool(self.api_key)
    
    def _get_client(self):
        """Lazy-load Google GenAI client."""
        if self._client is None:
            try:
                if not self.api_key:
                    raise ValueError("Embedding API key is not configured. Set GEMINI_API_KEY or GOOGLE_API_KEY.")
                import google.generativeai as genai
                genai.configure(api_key=self.api_key)
                self._client = genai
            except ImportError:
                raise ImportError("google-generativeai package required for embeddings")
        return self._client

    def has_cached_query_embedding(self, query: str) -> bool:
        """Check if a query embedding is cached."""
        if query in self._query_cache:
            return True
        normalized = query.lower().strip()
        return normalized in self._query_cache

    def get_cached_query_embedding(self, query: str) -> Optional[List[float]]:
        """Get a cached query embedding if present."""
        if query in self._query_cache:
            return self._query_cache.get(query)
        normalized = query.lower().strip()
        return self._query_cache.get(normalized)

    def cache_query_embedding(self, query: str, embedding: List[float]) -> None:
        """Manually cache a query embedding (with LRU eviction)."""
        if not query:
            return
        normalized = query.lower().strip()
        # Evict oldest entry if over limit
        if len(self._query_cache) >= self._cache_size:
            oldest_key = next(iter(self._query_cache))
            del self._query_cache[oldest_key]
        self._query_cache[query] = embedding
        if normalized != query:
            self._query_cache[normalized] = embedding
    
    def embed_text(self, text: str, max_retries: int = 3) -> List[float]:
        """
        Embed a single text string with retry logic for rate limiting.
        
        Args:
            text: Text to embed
            max_retries: Maximum retry attempts for 429 errors
            
        Returns:
            Embedding vector
        """
        import time
        import random
        
        client = self._get_client()
        
        # Truncate if too long (model limit is ~10k tokens)
        if len(text) > 30000:
            text = text[:30000]
        
        last_error = None
        for attempt in range(max_retries + 1):
            try:
                result = client.embed_content(
                    model=f"models/{self.model}",
                    content=text,
                    task_type="RETRIEVAL_DOCUMENT",
                )
                return result['embedding']
            except Exception as e:
                last_error = e
                error_str = str(e).lower()
                # Check for rate limiting (429) or resource exhausted errors
                if '429' in error_str or 'resource' in error_str or 'quota' in error_str:
                    if attempt < max_retries:
                        # Exponential backoff with jitter: 0.5s, 1s, 2s base
                        delay = (0.5 * (2 ** attempt)) + (random.random() * 0.3)
                        logger.warning(f"Rate limited on embed, retry {attempt + 1}/{max_retries} after {delay:.2f}s")
                        time.sleep(delay)
                        continue
                # Non-retryable error
                raise
        
        raise last_error
    
    def embed_query(self, query: str, max_retries: int = 3) -> List[float]:
        """
        Embed a query for retrieval with retry logic for rate limiting.
        
        Uses RETRIEVAL_QUERY task type for better query embeddings.
        Caches results to avoid re-embedding the same queries.
        Deduplicates concurrent identical requests.
        
        Args:
            query: Search query to embed
            max_retries: Maximum retry attempts for 429 errors
            
        Returns:
            Embedding vector
        """
        import time
        import random
        from concurrent.futures import Future
        
        # Check cache first - this is the primary TTFT optimization
        if query in self._query_cache:
            logger.debug(f"Query embedding cache hit: '{query[:50]}...'")
            return self._query_cache[query]
        
        # Also check normalized query (lowercase, stripped)
        normalized = query.lower().strip()
        if normalized in self._query_cache:
            logger.debug(f"Query embedding cache hit (normalized): '{query[:50]}...'")
            return self._query_cache[normalized]
        
        # Request deduplication: if an identical request is in-flight, wait for it
        with self._in_flight_lock:
            if normalized in self._in_flight:
                logger.debug(f"Query embedding in-flight hit: '{query[:50]}...'")
                future = self._in_flight[normalized]
            else:
                # Create a future for this request
                future = Future()
                self._in_flight[normalized] = future
        
        # If we found an in-flight request, wait for it
        if future.done() or (normalized in self._in_flight and self._in_flight[normalized] is not future):
            try:
                return future.result(timeout=10)
            except Exception:
                pass  # Fall through to make our own request
        
        try:
            embedding = self._do_embed_query(query, normalized, max_retries)
            future.set_result(embedding)
            return embedding
        except Exception as e:
            future.set_exception(e)
            raise
        finally:
            # Clean up in-flight tracking
            with self._in_flight_lock:
                if normalized in self._in_flight and self._in_flight[normalized] is future:
                    del self._in_flight[normalized]
    
    def _do_embed_query(self, query: str, normalized: str, max_retries: int) -> List[float]:
        """Internal method to actually perform the embedding request."""
        import time
        import random
        
        client = self._get_client()
        
        last_error = None
        for attempt in range(max_retries + 1):
            try:
                result = client.embed_content(
                    model=f"models/{self.model}",
                    content=query,
                    task_type="RETRIEVAL_QUERY",
                )
                
                embedding = result['embedding']
                
                # Cache both original and normalized query
                if len(self._query_cache) >= self._cache_size:
                    # Remove oldest entry (simple LRU approximation)
                    oldest_key = next(iter(self._query_cache))
                    del self._query_cache[oldest_key]
                self._query_cache[query] = embedding
                self._query_cache[normalized] = embedding
                
                return embedding
                
            except Exception as e:
                last_error = e
                error_str = str(e).lower()
                # Check for rate limiting (429) or resource exhausted errors
                if '429' in error_str or 'resource' in error_str or 'quota' in error_str:
                    if attempt < max_retries:
                        # Exponential backoff with jitter: 0.3s, 0.6s, 1.2s base (faster for queries)
                        delay = (0.3 * (2 ** attempt)) + (random.random() * 0.2)
                        logger.warning(f"Rate limited on query embed, retry {attempt + 1}/{max_retries} after {delay:.2f}s")
                        time.sleep(delay)
                        continue
                # Non-retryable error
                raise
        
        raise last_error
    
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

        return all_embeddings
    
    def embed_chunk(self, chunk: SemanticChunk) -> SemanticChunk:
        """
        Embed a semantic chunk using STRUCTURED embed text.
        
        This does NOT embed raw code. Instead it builds structured text
        that captures the semantic meaning:
        - Symbol identity
        - Type and signature
        - Docstring
        - Key lines (returns, raises, calls)
        - Import context
        
        Args:
            chunk: Chunk to embed
            
        Returns:
            Chunk with embedding set (as numpy array)
        """
        # Build structured text for embedding
        text = build_embed_text(chunk)
        
        try:
            embedding = self.embed_text(text)
            # Store as numpy array for efficiency
            chunk.embedding = np.array(embedding, dtype=np.float32)
        except Exception as e:
            logger.warning(f"Failed to embed chunk {chunk.id}: {e}")
        
        return chunk
    
    def embed_chunks(self, chunks: List[SemanticChunk]) -> List[SemanticChunk]:
        """
        Embed multiple chunks in batches using STRUCTURED embed text.
        
        Args:
            chunks: Chunks to embed
            
        Returns:
            Chunks with embeddings set
        """
        # Build structured texts
        texts = [build_embed_text(chunk) for chunk in chunks]
        
        # Embed
        embeddings = self.embed_texts(texts)
        
        # Assign as numpy arrays
        for chunk, embedding in zip(chunks, embeddings):
            if embedding:
                chunk.embedding = np.array(embedding, dtype=np.float32)
        
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
        use_local: Ignored (Gemini-only policy)
        model: Override model name
    """
    global _embedder
    
    if _embedder is None:
        config = get_config()
        _embedder = Embedder(
            model=model or config.indexer.embedding_model,
            api_key=config.gemini_api_key,
        )
    
    return _embedder
