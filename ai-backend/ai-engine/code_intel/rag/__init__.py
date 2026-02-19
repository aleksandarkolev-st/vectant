"""
RAG (Retrieval-Augmented Generation) Subsystem for Code Intelligence.

Implements a 4-step document-aware RAG pipeline:

1. **Dual-Ingestion Pipeline** — Each document is processed twice:
   - Structural ToC tree mapping (headings, sections, pages)
   - High-level summary embedding into a fast vector index

2. **Macro-Retrieval** — Fast filtering via summary vector/keyword index.
   Narrows corpus from N documents → top 3-5 candidates in <50ms.

3. **Micro-Navigation** — Agentic ToC tree traversal using a fast routing
   LLM (e.g., Gemini Flash / Claude Haiku) to pinpoint exact sections
   within the top documents.

4. **Heavy Synthesis** — Extracted sections are passed to a heavy reasoning
   model (e.g., Gemini Pro / GPT-4o) for final answer generation with
   full citation tracking.

Architecture:
    rag/
    ├── ingestion/      # Dual-ingestion: ToC tree + summary embedding
    ├── store/          # Persistent storage: documents, ToCs, summaries, sections
    ├── macro/          # Macro-retrieval: fast summary search + keyword filter
    ├── micro/          # Micro-navigation: agentic ToC tree traversal
    ├── synthesis/      # Heavy synthesis: context building + answer generation
    ├── pipeline.py     # Main orchestrator
    ├── api.py          # FastAPI endpoints
    ├── config.py       # RAG configuration
    ├── types.py        # Core type definitions
    ├── exceptions.py   # Custom exceptions
    └── tests/          # Comprehensive test suite

Usage:
    from code_intel.rag import RAGPipeline, RAGConfig

    pipeline = RAGPipeline.create(
        workspace_root="/path/to/workspace",
        config=RAGConfig(),
    )

    # Ingest documents
    await pipeline.ingest_directory("/path/to/docs")

    # Query
    result = await pipeline.query("How does authentication work?")
    print(result.answer)
    print(result.citations)
"""

from .types import (
    Document,
    DocumentMetadata,
    ToCNode,
    ToCTree,
    Section,
    DocumentSummary,
    RAGQuery,
    RAGResult,
    Citation,
    SectionReference,
)

from .config import RAGConfig

from .exceptions import (
    RAGError,
    IngestionError,
    NavigationError,
    SynthesisError,
    StoreError,
    DocumentNotFoundError,
)

from .pipeline import RAGPipeline

__version__ = "1.0.0"

__all__ = [
    # Pipeline
    "RAGPipeline",
    # Types
    "Document",
    "DocumentMetadata",
    "ToCNode",
    "ToCTree",
    "Section",
    "DocumentSummary",
    "RAGQuery",
    "RAGResult",
    "Citation",
    "SectionReference",
    # Config
    "RAGConfig",
    # Exceptions
    "RAGError",
    "IngestionError",
    "NavigationError",
    "SynthesisError",
    "StoreError",
    "DocumentNotFoundError",
]
