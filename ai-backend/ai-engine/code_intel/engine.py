"""
Code Intelligence System - Main Integration Module.

This module provides the unified API that ties together all seven subsystems:
1. Code Ingestion & Normalization
2. Dual Index (Vector + Structural)
3. Hierarchical Summaries
4. Query-time Context Assembly
5. Tool-driven Exploration
6. Context Eviction & Stability
7. Editing Workflow

Usage:
    engine = CodeIntelEngine.create("/path/to/workspace")
    await engine.index_workspace()
    
    # Get context for a query
    context = await engine.get_context(
        query="How does user authentication work?",
        max_tokens=8000,
    )
    
    # Use tools
    result = engine.execute_tool(
        "find_callers",
        {"symbol_name": "authenticate_user"},
    )
    
    # Edit files
    session = engine.create_edit_session()
    plan = session.create_plan()
    plan.add_replace(...)
    result = session.execute()
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional

from .core.config import (
    CodeIntelConfig,
    ParserConfig,
    IndexerConfig,
    RetrievalConfig,
    SummaryConfig,
    EditingConfig,
)
from .core.types import (
    SemanticChunk,
    FileSummary,
    RepoSummary,
    ContextBudget,
    RetrievalResult,
)

# Ingestion
from .ingestion.file_walker import FileWalker
from .ingestion.language_detector import LanguageDetector
from .ingestion.chunk_extractor import ChunkExtractor
from .ingestion.normalizer import Normalizer

# Indexing
from .indexer.dual_indexer import DualIndexer
from .indexer.embedder import Embedder
from .indexer.vector_index import VectorIndex
from .indexer.structural_index import StructuralIndex

# Summaries
from .summaries.file_summarizer import FileSummarizer
from .summaries.repo_summarizer import RepoSummarizer
from .summaries.module_summarizer import ModuleSummarizer
from .summaries.summary_store import SummaryStore, IncrementalSummaryManager
from .summaries.facts_store import FactsStore

# Retrieval
from .retrieval.pipeline import RetrievalPipeline
from .retrieval.query_processor import QueryProcessor
from .retrieval.retriever import ContextRetriever
from .retrieval.graph_expander import GraphExpander
from .retrieval.ranker import ContextRanker
from .retrieval.budget_enforcer import BudgetEnforcer
from .retrieval.context_assembler import ContextAssembler
from .retrieval.controller import RetrievalController, ContextSufficiency, RefusalReason
from .routing.router import QueryRouter

# Tools
from .tools.tools import ExplorationTools
from .tools.tool_registry import ToolRegistry
from .tools.tool_executor import ToolExecutor

# Eviction
from .eviction.context_diff import ContextStabilizer
from .eviction.context_tracker import ContextTracker
from .eviction.eviction_policy import EvictionPolicy
from .eviction.context_pinner import ContextPinner

# Editing
from .editing.edit_session import EditSession, EditSessionManager
from .editing.edit_planner import EditPlan


logger = logging.getLogger("code_intel.engine")


@dataclass
class EngineStats:
    """Statistics about engine state."""
    
    files_indexed: int = 0
    chunks_indexed: int = 0
    symbols_tracked: int = 0
    summaries_generated: int = 0
    
    # Memory usage
    vector_index_size_mb: float = 0.0
    structural_index_size_mb: float = 0.0
    
    # Performance
    last_index_time_ms: float = 0.0
    avg_query_time_ms: float = 0.0


class CodeIntelEngine:
    """
    Main entry point for the code intelligence system.
    
    Provides a unified API over all subsystems.
    """
    
    def __init__(
        self,
        workspace_root: str,
        config: Optional[CodeIntelConfig] = None,
    ):
        self.workspace_root = Path(workspace_root)
        self.config = config or CodeIntelConfig()
        
        # Initialize components (lazy loading)
        self._file_walker: Optional[FileWalker] = None
        self._language_detector: Optional[LanguageDetector] = None
        self._chunk_extractor: Optional[ChunkExtractor] = None
        self._normalizer: Optional[Normalizer] = None
        
        self._embedder: Optional[Embedder] = None
        self._vector_index: Optional[VectorIndex] = None
        self._structural_index: Optional[StructuralIndex] = None
        self._dual_indexer: Optional[DualIndexer] = None
        
        self._file_summarizer: Optional[FileSummarizer] = None
        self._repo_summarizer: Optional[RepoSummarizer] = None
        self._summary_store: Optional[SummaryStore] = None
        self._summary_manager: Optional[IncrementalSummaryManager] = None
        self._facts_store: Optional[FactsStore] = None
        
        self._retrieval_pipeline: Optional[RetrievalPipeline] = None
        self._retrieval_controller: Optional[RetrievalController] = None
        
        self._tool_registry: Optional[ToolRegistry] = None
        self._tool_executor: Optional[ToolExecutor] = None
        
        self._context_stabilizer: Optional[ContextStabilizer] = None
        
        self._edit_session_manager: Optional[EditSessionManager] = None
        
        # State
        self._initialized = False
        self._stats = EngineStats()
    
    @classmethod
    def create(
        cls,
        workspace_root: str,
        gemini_api_key: Optional[str] = None,
    ) -> "CodeIntelEngine":
        """
        Factory method to create and initialize the engine.
        
        Args:
            workspace_root: Path to workspace
            gemini_api_key: API key for embeddings
            
        Returns:
            Initialized CodeIntelEngine
        """
        config = CodeIntelConfig()
        
        if gemini_api_key:
            config.indexer.embedding_api_key = gemini_api_key
        
        engine = cls(workspace_root, config)
        engine._initialize_components()
        
        return engine
    
    def _initialize_components(self) -> None:
        """Initialize all components lazily."""
        if self._initialized:
            return
        
        # Ingestion
        self._file_walker = FileWalker(str(self.workspace_root))
        self._language_detector = LanguageDetector()
        self._chunk_extractor = ChunkExtractor()
        self._normalizer = Normalizer()
        
        # Indexing
        self._embedder = Embedder(
            api_key=self.config.indexer.embedding_api_key,
            batch_size=self.config.indexer.embedding_batch_size,
        )
        self._dual_indexer = DualIndexer(
            workspace_root=str(self.workspace_root),
            persist_dir=str(self.workspace_root / ".code_intel"),
            embedder=self._embedder,
        )
        # Expose indexes from dual indexer for retrieval pipeline
        self._vector_index = self._dual_indexer.vector_index
        self._structural_index = self._dual_indexer.structural_index
        self._lexical_index = self._dual_indexer.lexical_index
        
        # Summaries
        self._summary_store = SummaryStore(
            str(self.workspace_root / ".code_intel" / "summaries"),
        )
        self._facts_store = FactsStore(
            str(self.workspace_root / ".code_intel" / "summaries"),
        )
        self._file_summarizer = FileSummarizer()
        self._repo_summarizer = RepoSummarizer(str(self.workspace_root))
        self._module_summarizer = ModuleSummarizer()
        self._summary_manager = IncrementalSummaryManager(
            store=self._summary_store,
            file_summarizer=self._file_summarizer,
            repo_summarizer=self._repo_summarizer,
            module_summarizer=self._module_summarizer,
            file_reader=self._file_walker,
            facts_store=self._facts_store,
        )
        
        # Retrieval pipeline
        self._retrieval_pipeline = RetrievalPipeline(
            vector_index=self._vector_index,
            structural_index=self._structural_index,
            lexical_index=self._lexical_index,
            embedder=self._embedder,
            file_reader=self._file_walker,
                router=QueryRouter(
                    structural_index=self._structural_index,
                    lexical_index=self._lexical_index,
                    vector_index=self._vector_index,
                    file_reader=self._file_walker,
                ),
        )
        
        # Deterministic retrieval controller
        # This decides what context goes into the prompt - NOT the LLM
        self._retrieval_controller = RetrievalController()
        
        # Tools
        self._exploration_tools = ExplorationTools(
            workspace_root=str(self.workspace_root),
            vector_index=self._vector_index,
            structural_index=self._structural_index,
            file_reader=self._file_walker,
        )
        self._tool_registry = ToolRegistry()
        self._tool_executor = ToolExecutor(
            tools=self._exploration_tools,
            registry=self._tool_registry,
        )
        
        # Eviction
        self._context_stabilizer = ContextStabilizer()
        
        # Editing
        self._edit_session_manager = EditSessionManager(str(self.workspace_root))
        
        self._initialized = True
        logger.info(f"CodeIntelEngine initialized for: {self.workspace_root}")
    
    # =========================================================================
    # Indexing API
    # =========================================================================
    
    async def index_workspace(
        self,
        incremental: bool = True,
    ) -> EngineStats:
        """
        Index the entire workspace.
        
        Args:
            incremental: If True, only index changed files
            
        Returns:
            EngineStats with indexing results
        """
        import time
        start = time.time()
        
        self._initialize_components()
        
        # Use DualIndexer's index_repository method
        if incremental:
            # For incremental, only reindex changed files
            if getattr(self._dual_indexer, "_rebuild_required", False):
                result = await self._dual_indexer.index_repository_async()
            else:
                result = self._dual_indexer.reindex_changed()
            files_count = result.get("files_updated", 0)
            chunks_count = result.get("chunks_updated", 0)
        else:
            # Full reindex
            result = await self._dual_indexer.index_repository_async()
            files_count = result.get("files", 0)
            chunks_count = result.get("chunks", 0)
        
        # Update stats
        self._stats.files_indexed = files_count
        self._stats.chunks_indexed = chunks_count
        
        # Get symbol count from structural index
        try:
            structural_stats = self._structural_index.stats()
            self._stats.symbols_tracked = structural_stats.get("nodes", 0)
        except Exception:
            self._stats.symbols_tracked = 0
        
        self._stats.last_index_time_ms = (time.time() - start) * 1000
        
        logger.info(f"Indexed {self._stats.chunks_indexed} chunks in {self._stats.last_index_time_ms:.0f}ms")

        # Sync summaries and facts store
        try:
            if self._summary_manager:
                file_hashes = self._file_walker.get_all_hashes()
                file_chunks = {}
                for file_path in file_hashes.keys():
                    chunk_ids = self._structural_index.get_chunks_for_file(file_path)
                    chunks = []
                    for cid in chunk_ids:
                        chunk = self._vector_index.get_chunk(cid)
                        if chunk:
                            chunks.append(chunk)
                    if not chunks:
                        try:
                            file_obj = self._file_walker.get_file(file_path)
                            if file_obj:
                                chunks = self._dual_indexer.extractor.extract(file_obj)
                        except Exception:
                            chunks = []
                    if chunks:
                        file_chunks[file_path] = chunks
                self._summary_manager.sync(file_hashes=file_hashes, file_chunks=file_chunks)
        except Exception as e:
            logger.warning(f"Summary sync failed: {e}")
        
        return self._stats
    
    async def index_file(self, file_path: str) -> int:
        """
        Index a single file.
        
        Args:
            file_path: Path to file (relative to workspace)
            
        Returns:
            Number of chunks indexed
        """
        self._initialize_components()
        
        # Use DualIndexer's index_file method
        chunks = self._dual_indexer.index_file(file_path)

        # Update summaries for this file so metadata exists even without full indexing
        try:
            if self._summary_store:
                # Ensure metadata file exists
                self._summary_store.get_metadata()

            if self._file_walker and self._summary_store and self._file_summarizer:
                file_obj = self._file_walker.get_file(file_path)
                if file_obj:
                    file_chunks = []
                    if self._structural_index and self._vector_index:
                        chunk_ids = self._structural_index.get_chunks_for_file(file_path)
                        for cid in chunk_ids:
                            chunk = self._vector_index.get_chunk(cid)
                            if chunk:
                                file_chunks.append(chunk)

                    if file_chunks:
                        summary = self._file_summarizer.summarize_from_chunks(
                            file_path=file_path,
                            language=file_obj.language or "",
                            content=file_obj.content,
                            content_hash=file_obj.content_hash,
                            chunks=file_chunks,
                        )
                        if self._facts_store:
                            self._facts_store.update_facts_for_file(file_path, file_chunks)
                    else:
                        summary = self._file_summarizer.summarize(file_obj)

                    self._summary_store.set_file_summary(file_path, summary)
                    self._summary_store.update_file_hash(file_path, file_obj.content_hash)

                    # Lazily create repo summary if missing
                    if self._repo_summarizer and not self._summary_store.get_repo_summary():
                        repo_summary = self._repo_summarizer.summarize()
                        self._summary_store.set_repo_summary(repo_summary)
        except Exception as e:
            logger.debug(f"Index-file summary update failed: {e}")
        
        return len(chunks)
    
    # =========================================================================
    # Context Retrieval API
    # =========================================================================
    
    async def get_context(
        self,
        query: str,
        max_tokens: int = 8000,
        conversation_history: Optional[List[Dict[str, str]]] = None,
    ) -> RetrievalResult:
        """
        Get relevant context for a query.
        
        This is the main API for context assembly.
        Uses deterministic controller to decide what context to include.
        
        Args:
            query: User query or intent
            max_tokens: Maximum tokens in context
            conversation_history: Previous messages for stability
            
        Returns:
            RetrievalResult with assembled context and sufficiency indicator
        """
        self._initialize_components()
        
        # Create budget
        budget = ContextBudget(max_tokens=max_tokens)

        # Refresh summaries for retrieval
        try:
            if self._summary_store and self._retrieval_pipeline:
                repo_summary = self._summary_store.get_repo_summary()
                file_summaries = self._summary_store.get_all_file_summaries()
                module_summaries = self._summary_store.get_all_module_summaries()
                self._retrieval_pipeline.update_summaries(
                    repo_summary=repo_summary,
                    file_summaries=file_summaries,
                    module_summaries=module_summaries,
                )
            if self._facts_store and self._file_walker:
                try:
                    self._facts_store.purge_stale(
                        self._file_walker,
                        self.config.indexer.chunking_version,
                        max_scan=200,
                    )
                except Exception:
                    pass
        except Exception as e:
            logger.debug(f"Failed to update summaries for retrieval: {e}")
        
        # Run retrieval pipeline (synchronous, so run in executor)
        import asyncio
        loop = asyncio.get_event_loop()
        pipeline_result = await loop.run_in_executor(
            None,
            lambda: self._retrieval_pipeline.retrieve(query=query, budget=budget)
        )
        
        # Extract data from pipeline result
        context = pipeline_result.context

        # Build included chunks list for coverage + trace
        included_chunks = []
        for item in pipeline_result.trace:
            if item.get("reason") == "included" and item.get("chunk_id"):
                chunk = self._vector_index.get_chunk(item.get("chunk_id"))
                if chunk:
                    included_chunks.append(chunk)

        # Convert pipeline result to RetrievalResult
        retrieval_result = RetrievalResult(
            chunks=included_chunks,
            file_summaries=[],
            repo_summary=None,
            query=query,
            total_tokens=context.total_tokens,
            budget=budget,
            assembled_context=context.content,
            trace=pipeline_result.trace,
            debug={
                "timings_ms": {
                    "query": pipeline_result.query_time_ms,
                    "retrieval": pipeline_result.retrieval_time_ms,
                    "expansion": pipeline_result.expansion_time_ms,
                    "ranking": pipeline_result.ranking_time_ms,
                    "assembly": pipeline_result.assembly_time_ms,
                    "total": pipeline_result.total_time_ms,
                },
                "counters": self._last_metrics(),
            },
        )

        required_symbols = list(pipeline_result.parsed_query.symbol_names or [])
        required_files = list(pipeline_result.parsed_query.file_patterns or [])

        sufficiency, refusal = self._retrieval_controller.assess_coverage(
            included_chunks=included_chunks,
            required_files=required_files,
            required_symbols=required_symbols,
            had_exclusions=pipeline_result.candidates_excluded > 0,
        )

        retrieval_result.sufficiency = sufficiency
        retrieval_result.refusal_reason = refusal
        
        return retrieval_result

    def _last_metrics(self) -> Dict[str, Any]:
        try:
            return self._retrieval_pipeline._last_counters if self._retrieval_pipeline else {}
        except Exception:
            return {}
    
    def _build_context_string(
        self,
        chunks: List[SemanticChunk],
        sufficiency: ContextSufficiency,
        refusal_reason: Optional[RefusalReason],
    ) -> str:
        """Build context string with sufficiency indicator."""
        parts = []
        
        # Group chunks by file
        by_file = {}
        for chunk in chunks:
            path = chunk.metadata.file_path
            if path not in by_file:
                by_file[path] = []
            by_file[path].append(chunk)
        
        # Build context
        for file_path, file_chunks in by_file.items():
            parts.append(f"### {file_path}")
            for chunk in sorted(file_chunks, key=lambda c: c.metadata.start_line):
                parts.append(f"# Lines {chunk.metadata.start_line}-{chunk.metadata.end_line}")
                parts.append(chunk.content)
                parts.append("")
        
        context = "\n".join(parts)
        
        # Add sufficiency warning if needed
        if sufficiency == ContextSufficiency.INSUFFICIENT:
            reason_text = refusal_reason.value if refusal_reason else "Unknown reason"
            context += f"\n\n[CONTEXT INCOMPLETE: {reason_text}]"
        elif sufficiency == ContextSufficiency.PARTIAL:
            context += "\n\n[CONTEXT MAY BE PARTIAL]"
        
        return context
    
    def get_repo_summary(self) -> Optional[RepoSummary]:
        """Get the repository summary."""
        self._initialize_components()
        return self._summary_store.get_repo_summary()
    
    def get_file_summary(self, file_path: str) -> Optional[FileSummary]:
        """Get summary for a specific file."""
        self._initialize_components()
        return self._summary_store.get_file_summary(file_path)

    def get_retrieval_metrics(self) -> Dict[str, Any]:
        """Get retrieval latency and budget metrics."""
        self._initialize_components()
        metrics = {}
        counters = {}
        if self._retrieval_pipeline:
            metrics = self._retrieval_pipeline.get_metrics()
            counters = self._retrieval_pipeline.get_counters()
        return {
            "latency": metrics,
            "counters": counters,
            "budgets": {
                "bm25_top_k": self.config.retrieval.bm25_top_k,
                "vector_top_k": self.config.retrieval.vector_top_k,
                "rerank_top_k": self.config.retrieval.rerank_top_k,
                "final_max_chunks": self.config.retrieval.final_max_chunks,
            },
            "index_generation": getattr(self._dual_indexer, "index_generation", None),
        }
    
    # =========================================================================
    # Tools API
    # =========================================================================
    
    def get_tool_definitions(
        self,
        format: str = "openai",
    ) -> List[Dict[str, Any]]:
        """
        Get tool definitions for LLM.
        
        Args:
            format: "openai" or "anthropic"
            
        Returns:
            Tool definitions in requested format
        """
        self._initialize_components()
        return self._tool_registry.get_definitions(format)
    
    async def execute_tool(
        self,
        tool_name: str,
        arguments: Dict[str, Any],
    ) -> Dict[str, Any]:
        """
        Execute an exploration tool.
        
        Args:
            tool_name: Name of tool to execute
            arguments: Tool arguments
            
        Returns:
            Tool result
        """
        self._initialize_components()
        return await self._tool_executor.execute(tool_name, arguments)
    
    async def execute_tool_calls(
        self,
        tool_calls: List[Dict[str, Any]],
    ) -> List[Dict[str, Any]]:
        """
        Execute multiple tool calls from LLM response.
        
        Args:
            tool_calls: Tool calls from LLM
            
        Returns:
            List of results
        """
        self._initialize_components()
        return await self._tool_executor.execute_batch(tool_calls)
    
    # =========================================================================
    # Editing API
    # =========================================================================
    
    def create_edit_session(
        self,
        session_id: Optional[str] = None,
    ) -> EditSession:
        """
        Create a new edit session.
        
        Args:
            session_id: Optional custom ID
            
        Returns:
            EditSession for planning edits
        """
        self._initialize_components()
        return self._edit_session_manager.create_session(session_id)
    
    def get_edit_session(self, session_id: str) -> Optional[EditSession]:
        """Get an existing edit session."""
        self._initialize_components()
        return self._edit_session_manager.get_session(session_id)
    
    # =========================================================================
    # Persistence API
    # =========================================================================
    
    async def save(self) -> None:
        """Save all indexes and state to disk."""
        self._initialize_components()
        
        cache_dir = self.workspace_root / ".code_intel"
        cache_dir.mkdir(parents=True, exist_ok=True)
        
        # Save indexes
        self._vector_index.save(str(cache_dir / "vector_index.json"))
        self._structural_index.save(str(cache_dir / "structural_index.json"))
        
        # Summary store auto-saves
        
        logger.info("Engine state saved")
    
    async def load(self) -> bool:
        """Load indexes and state from disk."""
        self._initialize_components()
        
        cache_dir = self.workspace_root / ".code_intel"
        
        if not cache_dir.exists():
            return False
        
        try:
            # Load indexes
            self._vector_index.load(str(cache_dir / "vector_index.json"))
            self._structural_index.load(str(cache_dir / "structural_index.json"))
            
            logger.info("Engine state loaded")
            return True
        except Exception as e:
            logger.warning(f"Failed to load engine state: {e}")
            return False
    
    # =========================================================================
    # Statistics
    # =========================================================================
    
    def get_stats(self) -> EngineStats:
        """Get current engine statistics."""
        return self._stats


# Convenience function
def create_engine(
    workspace_root: str,
    gemini_api_key: Optional[str] = None,
) -> CodeIntelEngine:
    """
    Create a code intelligence engine.
    
    Args:
        workspace_root: Path to workspace
        gemini_api_key: API key for embeddings
        
    Returns:
        CodeIntelEngine instance
    """
    return CodeIntelEngine.create(workspace_root, gemini_api_key)
