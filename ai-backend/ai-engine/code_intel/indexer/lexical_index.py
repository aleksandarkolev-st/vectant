"""
BM25 Lexical Index - Exact symbol and file name search.

Vectors alone miss exact symbol/file matches. BM25 provides:
- Exact symbol name lookup
- Partial name matching
- File path search
- Keyword search in docstrings

This complements vector search for better recall.
"""

from __future__ import annotations

import json
import logging
import math
import os
import re
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

from ..core.types import SemanticChunk, ChunkId


logger = logging.getLogger("code_intel.indexer.lexical")


@dataclass
class BM25Config:
    """BM25 configuration parameters."""
    k1: float = 1.5  # Term frequency saturation
    b: float = 0.75  # Document length normalization
    min_term_length: int = 2  # Minimum term length to index


@dataclass 
class LexicalSearchResult:
    """Result from lexical search."""
    chunk_id: ChunkId
    score: float  # BM25 score
    matched_terms: List[str]  # Which query terms matched
    chunk: Optional[SemanticChunk] = None


class LexicalIndex:
    """
    BM25-based lexical index for exact symbol matching.
    
    Indexes:
    - Symbol names (tokenized)
    - Qualified names (tokenized)
    - File paths (tokenized)
    - Docstrings (tokenized)
    - Signatures (tokenized)
    
    Use this alongside vector search for hybrid retrieval.
    """
    
    def __init__(
        self,
        config: Optional[BM25Config] = None,
        persist_path: Optional[str] = None,
    ):
        self.config = config or BM25Config()
        self.persist_path = persist_path
        
        # Inverted index: term -> {doc_id: term_freq}
        self._inverted_index: Dict[str, Dict[str, int]] = defaultdict(dict)
        
        # Document lengths (for normalization)
        self._doc_lengths: Dict[str, int] = {}
        
        # Document frequency: term -> number of docs containing term
        self._doc_freq: Dict[str, int] = defaultdict(int)
        
        # Total number of documents
        self._num_docs: int = 0
        
        # Average document length
        self._avg_doc_length: float = 0.0
        
        # Chunk storage (for returning full chunks)
        self._chunks: Dict[ChunkId, SemanticChunk] = {}
        
        # State
        self._dirty = False
        
        # Load if exists
        if persist_path and os.path.exists(persist_path):
            self._load()
    
    def add(self, chunk: SemanticChunk) -> None:
        """
        Add a chunk to the lexical index.
        
        Indexes symbol name, qualified name, file path, docstring, and signature.
        """
        chunk_id = chunk.id
        
        # Collect all indexable text
        terms: List[str] = []
        
        # Symbol name (high importance - add multiple times)
        if chunk.symbol_name:
            symbol_terms = self._tokenize(chunk.symbol_name)
            terms.extend(symbol_terms * 3)  # Weight symbol name higher
        
        # Qualified name
        if chunk.metadata and chunk.metadata.qualified_name:
            terms.extend(self._tokenize(chunk.metadata.qualified_name))
        
        # File path
        if chunk.file_path:
            terms.extend(self._tokenize(chunk.file_path))
        
        # Docstring
        if chunk.docstring:
            terms.extend(self._tokenize(chunk.docstring))
        
        # Signature
        if chunk.signature:
            terms.extend(self._tokenize(chunk.signature))
        
        # Skip if no terms
        if not terms:
            return
        
        # Update inverted index
        term_counts = defaultdict(int)
        for term in terms:
            term_counts[term] += 1
        
        for term, count in term_counts.items():
            # If chunk already exists, remove old entry first
            if chunk_id in self._inverted_index[term]:
                del self._inverted_index[term][chunk_id]
            else:
                self._doc_freq[term] += 1
            
            self._inverted_index[term][chunk_id] = count
        
        # Update document length
        old_length = self._doc_lengths.get(chunk_id, 0)
        new_length = len(terms)
        self._doc_lengths[chunk_id] = new_length
        
        # Update stats
        if chunk_id not in self._chunks:
            self._num_docs += 1
        
        # Update average document length
        total_length = sum(self._doc_lengths.values())
        self._avg_doc_length = total_length / max(1, self._num_docs)
        
        # Store chunk
        self._chunks[chunk_id] = chunk
        self._dirty = True
    
    def remove(self, chunk_id: ChunkId) -> bool:
        """Remove a chunk from the index."""
        if chunk_id not in self._chunks:
            return False
        
        # Remove from inverted index
        terms_to_remove = []
        for term, doc_dict in self._inverted_index.items():
            if chunk_id in doc_dict:
                del doc_dict[chunk_id]
                self._doc_freq[term] -= 1
                if self._doc_freq[term] <= 0:
                    terms_to_remove.append(term)
        
        # Clean up empty terms
        for term in terms_to_remove:
            del self._inverted_index[term]
            del self._doc_freq[term]
        
        # Remove document metadata
        del self._doc_lengths[chunk_id]
        del self._chunks[chunk_id]
        
        self._num_docs -= 1
        
        # Update average document length
        if self._num_docs > 0:
            total_length = sum(self._doc_lengths.values())
            self._avg_doc_length = total_length / self._num_docs
        else:
            self._avg_doc_length = 0.0
        
        self._dirty = True
        return True
    
    def search(
        self,
        query: str,
        k: int = 10,
        min_score: float = 0.0,
    ) -> List[LexicalSearchResult]:
        """
        Search using BM25.
        
        Args:
            query: Search query
            k: Number of results
            min_score: Minimum BM25 score
            
        Returns:
            List of results sorted by BM25 score
        """
        query_terms = self._tokenize(query)
        
        if not query_terms:
            return []
        
        # Compute BM25 scores for all matching documents
        scores: Dict[str, float] = defaultdict(float)
        matched_terms: Dict[str, List[str]] = defaultdict(list)
        
        for term in query_terms:
            if term not in self._inverted_index:
                continue
            
            # IDF: log((N - n + 0.5) / (n + 0.5))
            n = self._doc_freq.get(term, 0)
            idf = math.log((self._num_docs - n + 0.5) / (n + 0.5) + 1.0)
            
            for chunk_id, tf in self._inverted_index[term].items():
                doc_len = self._doc_lengths.get(chunk_id, 1)
                
                # BM25 term score
                k1 = self.config.k1
                b = self.config.b
                
                numerator = tf * (k1 + 1)
                denominator = tf + k1 * (1 - b + b * (doc_len / max(1, self._avg_doc_length)))
                
                term_score = idf * (numerator / denominator)
                scores[chunk_id] += term_score
                matched_terms[chunk_id].append(term)
        
        # Filter and sort
        results = []
        for chunk_id, score in scores.items():
            if score < min_score:
                continue
            
            chunk = self._chunks.get(chunk_id)
            results.append(LexicalSearchResult(
                chunk_id=chunk_id,
                score=score,
                matched_terms=matched_terms[chunk_id],
                chunk=chunk,
            ))
        
        # Sort by score descending
        results.sort(key=lambda r: r.score, reverse=True)
        
        return results[:k]
    
    def search_exact_symbol(self, symbol_name: str) -> List[LexicalSearchResult]:
        """
        Search for exact symbol name match.
        
        More precise than general search - boosts exact matches.
        """
        results = []
        
        symbol_lower = symbol_name.lower()
        
        for chunk_id, chunk in self._chunks.items():
            chunk_symbol = chunk.symbol_name.lower() if chunk.symbol_name else ""
            
            if chunk_symbol == symbol_lower:
                score = 10.0  # High score for exact match
            elif chunk_symbol.endswith(f".{symbol_lower}"):
                score = 8.0  # Method of searched name
            elif symbol_lower in chunk_symbol:
                score = 5.0  # Partial match
            else:
                continue
            
            results.append(LexicalSearchResult(
                chunk_id=chunk_id,
                score=score,
                matched_terms=[symbol_name],
                chunk=chunk,
            ))
        
        results.sort(key=lambda r: r.score, reverse=True)
        return results
    
    def _tokenize(self, text: str) -> List[str]:
        """
        Tokenize text for indexing/search.
        
        Handles:
        - camelCase splitting
        - snake_case splitting
        - Path separators
        - Common punctuation
        """
        # Convert to lowercase
        text = text.lower()
        
        # Split camelCase
        text = re.sub(r'([a-z])([A-Z])', r'\1 \2', text)
        
        # Replace separators with spaces
        text = re.sub(r'[/_\\.\-:]+', ' ', text)
        
        # Remove non-alphanumeric
        text = re.sub(r'[^a-z0-9 ]', '', text)
        
        # Split and filter
        terms = text.split()
        terms = [t for t in terms if len(t) >= self.config.min_term_length]
        
        return terms
    
    def persist(self) -> None:
        """Save index to disk."""
        if not self.persist_path or not self._dirty:
            return
        
        os.makedirs(os.path.dirname(self.persist_path) or ".", exist_ok=True)
        
        data = {
            "inverted_index": {k: dict(v) for k, v in self._inverted_index.items()},
            "doc_lengths": self._doc_lengths,
            "doc_freq": dict(self._doc_freq),
            "num_docs": self._num_docs,
            "avg_doc_length": self._avg_doc_length,
            "config": {
                "k1": self.config.k1,
                "b": self.config.b,
                "min_term_length": self.config.min_term_length,
            },
        }
        
        with open(self.persist_path, "w") as f:
            json.dump(data, f)
        
        self._dirty = False
        logger.info(f"Persisted lexical index: {self._num_docs} documents")
    
    def _load(self) -> None:
        """Load index from disk."""
        try:
            with open(self.persist_path, "r") as f:
                data = json.load(f)
            
            self._inverted_index = defaultdict(dict)
            for term, doc_dict in data.get("inverted_index", {}).items():
                self._inverted_index[term] = dict(doc_dict)
            
            self._doc_lengths = data.get("doc_lengths", {})
            self._doc_freq = defaultdict(int, data.get("doc_freq", {}))
            self._num_docs = data.get("num_docs", 0)
            self._avg_doc_length = data.get("avg_doc_length", 0.0)
            
            config_data = data.get("config", {})
            self.config = BM25Config(
                k1=config_data.get("k1", 1.5),
                b=config_data.get("b", 0.75),
                min_term_length=config_data.get("min_term_length", 2),
            )
            
            logger.info(f"Loaded lexical index: {self._num_docs} documents")
            
        except Exception as e:
            logger.error(f"Failed to load lexical index: {e}")
    
    def get_chunk(self, chunk_id: ChunkId) -> Optional[SemanticChunk]:
        """Get chunk by ID."""
        return self._chunks.get(chunk_id)
    
    def stats(self) -> Dict:
        """Get index statistics."""
        return {
            "num_documents": self._num_docs,
            "num_terms": len(self._inverted_index),
            "avg_doc_length": self._avg_doc_length,
        }
    
    def __len__(self) -> int:
        return self._num_docs
    
    def __contains__(self, chunk_id: ChunkId) -> bool:
        return chunk_id in self._chunks


class HybridSearcher:
    """
    Combine vector and lexical search for better results.
    
    Hybrid search provides:
    - Semantic similarity from vectors
    - Exact matching from BM25
    """
    
    def __init__(
        self,
        vector_weight: float = 0.6,
        lexical_weight: float = 0.4,
    ):
        """
        Initialize hybrid searcher.
        
        Args:
            vector_weight: Weight for vector search scores (0-1)
            lexical_weight: Weight for lexical search scores (0-1)
        """
        self.vector_weight = vector_weight
        self.lexical_weight = lexical_weight
    
    def combine_results(
        self,
        vector_results: List[Tuple[SemanticChunk, float]],
        lexical_results: List[LexicalSearchResult],
        k: int = 20,
    ) -> List[Tuple[SemanticChunk, float, str]]:
        """
        Combine vector and lexical search results.
        
        Args:
            vector_results: Results from vector search [(chunk, score), ...]
            lexical_results: Results from BM25 search
            k: Number of final results
            
        Returns:
            Combined results [(chunk, combined_score, source), ...]
            source is "vector", "lexical", or "both"
        """
        # Normalize scores to [0, 1]
        max_vector = max((s for _, s in vector_results), default=1.0) or 1.0
        max_lexical = max((r.score for r in lexical_results), default=1.0) or 1.0
        
        # Build score maps
        vector_scores: Dict[str, float] = {}
        vector_chunks: Dict[str, SemanticChunk] = {}
        for chunk, score in vector_results:
            normalized = score / max_vector
            vector_scores[chunk.id] = normalized
            vector_chunks[chunk.id] = chunk
        
        lexical_scores: Dict[str, float] = {}
        lexical_chunks: Dict[str, SemanticChunk] = {}
        for result in lexical_results:
            normalized = result.score / max_lexical
            lexical_scores[result.chunk_id] = normalized
            if result.chunk:
                lexical_chunks[result.chunk_id] = result.chunk
        
        # Combine all chunk IDs
        all_ids = set(vector_scores.keys()) | set(lexical_scores.keys())
        
        # Compute combined scores
        combined = []
        for chunk_id in all_ids:
            v_score = vector_scores.get(chunk_id, 0.0)
            l_score = lexical_scores.get(chunk_id, 0.0)
            
            combined_score = (
                self.vector_weight * v_score +
                self.lexical_weight * l_score
            )
            
            # Determine source
            if chunk_id in vector_scores and chunk_id in lexical_scores:
                source = "both"
                # Bonus for appearing in both
                combined_score += 0.1
            elif chunk_id in vector_scores:
                source = "vector"
            else:
                source = "lexical"
            
            # Get chunk
            chunk = vector_chunks.get(chunk_id) or lexical_chunks.get(chunk_id)
            if chunk:
                combined.append((chunk, combined_score, source))
        
        # Sort by combined score
        combined.sort(key=lambda x: x[1], reverse=True)
        
        return combined[:k]
