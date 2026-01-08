"""Core module for code intelligence types and configuration."""

from .types import (
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
    ChunkId,
    SymbolName,
    FilePath,
    QualifiedName,
)

from .config import CodeIntelConfig, get_config, set_config

__all__ = [
    # Types
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
    # Type aliases
    "ChunkId",
    "SymbolName",
    "FilePath",
    "QualifiedName",
    # Config
    "CodeIntelConfig",
    "get_config",
    "set_config",
]
