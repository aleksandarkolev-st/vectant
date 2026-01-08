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
    ├── eviction/       # Token budget and eviction management
    └── editing/        # Safe code modification workflow

Key principle: The AI never has "repo context" - only temporary token context
assembled just-in-time. This system answers: "Given user intent, which exact
pieces of code matter right now?"

Usage:
    from code_intel import create_engine
    
    engine = create_engine("/workspace", openai_api_key="...")
    await engine.index_workspace()
    
    context = await engine.get_context("How does auth work?", max_tokens=8000)
    print(context.assembled_context)
"""

from .core.types import (
    SemanticChunk,
    ChunkType,
    ChunkMetadata,
    SymbolNode,
    SymbolEdge,
    EdgeType,
    FileSummary,
    RepoSummary,
    ContextBudget,
    RetrievalResult,
)

from .core.config import (
    CodeIntelConfig,
    ParserConfig,
    IndexerConfig,
    RetrievalConfig,
    SummaryConfig,
    EditingConfig,
)

from .engine import CodeIntelEngine, create_engine, EngineStats

# Advanced imports for direct access
from .retrieval.retrieval_pipeline import RetrievalPipeline
from .tools.tool_registry import ToolRegistry
from .tools.tool_executor import ToolExecutor
from .editing.edit_session import EditSession, EditSessionManager

__version__ = "1.0.0"

__all__ = [
    # Main API
    "CodeIntelEngine",
    "create_engine",
    "EngineStats",
    # Core types
    "SemanticChunk",
    "ChunkType",
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
    "ParserConfig",
    "IndexerConfig",
    "RetrievalConfig",
    "SummaryConfig",
    "EditingConfig",
    # Advanced
    "RetrievalPipeline",
    "ToolRegistry",
    "ToolExecutor",
    "EditSession",
    "EditSessionManager",
]
