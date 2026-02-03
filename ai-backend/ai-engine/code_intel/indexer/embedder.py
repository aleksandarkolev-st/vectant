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
