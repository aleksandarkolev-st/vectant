"""
Dual Index Module - Vector + Structural Indexing

This is where most systems fail. Vectors alone are insufficient.

Vector index (semantic):
- Embed each chunk
- Used for intent matching
- Answers "what seems relevant"

Structural index (symbol graph):
- File → symbols
- Symbol → dependencies
- Import graph
- Call graph (best effort)
- Answers "what must also be included"

Rule: Vector search chooses candidates, structure expands them.
"""

from .vector_index import VectorIndex, VectorSearchResult
from .structural_index import (
    StructuralIndex,
    SymbolGraph,
    get_structural_index,
)
from .embedder import Embedder, get_embedder
from .dual_indexer import DualIndexer, get_dual_indexer

__all__ = [
    # Vector
    "VectorIndex",
    "VectorSearchResult",
    # Structural
    "StructuralIndex",
    "SymbolGraph",
    "get_structural_index",
    # Embedding
    "Embedder",
    "get_embedder",
    # Combined
    "DualIndexer",
    "get_dual_indexer",
]
