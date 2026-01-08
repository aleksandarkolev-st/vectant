"""
Code Intelligence System

A multi-file codebase understanding system that:
1. Parses and indexes code semantically (not by tokens)
2. Maintains dual indices: vector (semantic) + structural (symbol graph)
3. Generates hierarchical summaries for compression
4. Assembles context just-in-time for AI queries
5. Provides tool-driven exploration APIs
6. Manages context eviction and token budgets
7. Supports safe editing workflows

Architecture:
    code_intel/
    ├── ingestion/      # File parsing, normalization, chunk extraction
    ├── indexer/        # Dual index: vector + structure
    ├── summaries/      # Hierarchical summary generation
    ├── retrieval/      # Query-time context assembly
    ├── tools/          # AI-callable exploration tools  
    ├── context/        # Token budget and eviction management
    └── editing/        # Safe code modification workflow

Key principle: The AI never has "repo context" - only temporary token context
assembled just-in-time. This system answers: "Given user intent, which exact
pieces of code matter right now?"
"""

from .core.types import (
    SemanticChunk,
    SymbolType,
    ChunkMetadata,
    SymbolNode,
    SymbolEdge,
    EdgeType,
    FileSummary,
    RepoSummary,
    ContextBudget,
    RetrievalResult,
)

from .core.config import CodeIntelConfig, get_config

__version__ = "1.0.0"

__all__ = [
    # Core types
    "SemanticChunk",
    "SymbolType", 
    "ChunkMetadata",
    "SymbolNode",
    "SymbolEdge",
    "EdgeType",
    "FileSummary",
    "RepoSummary",
    "ContextBudget",
    "RetrievalResult",
    # Config
    "CodeIntelConfig",
    "get_config",
]
