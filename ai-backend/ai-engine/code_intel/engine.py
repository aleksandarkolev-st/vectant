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

# RAG (4-step retrieval-augmented generation)
from .rag.pipeline import RAGPipeline
from .rag.api import register_rag_routes, set_rag_workspace


logger = logging.getLogger("code_intel.engine")


@dataclass
class EngineStats:
    """Statistics about engine state."""
    
    files_indexed: int = 0
    chunks_indexed: int = 0
    symbols_tracked: int = 0
    summaries_generated: int = 0
    
    # RAG pipeline stats
    rag_documents: int = 0
    rag_sections: int = 0
    rag_summaries: int = 0
    
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

        # RAG (4-step retrieval-augmented generation)
        self._rag_pipeline: Optional[RAGPipeline] = None
        
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

        # RAG pipeline (4-step retrieval-augmented generation)
        if self.config.enable_rag:
            try:
                from .rag.config import RAGConfig as _RAGConfig
                rag_config = _RAGConfig()
                # Propagate API key from engine config if set explicitly
                if self.config.gemini_api_key:
                    rag_config.embedding_api_key = self.config.gemini_api_key
                    rag_config.micro.routing_api_key = self.config.gemini_api_key
                    rag_config.synthesis.synthesis_api_key = self.config.gemini_api_key

                self._rag_pipeline = RAGPipeline(
                    workspace_root=str(self.workspace_root),
                    config=rag_config,
                )
                set_rag_workspace(str(self.workspace_root))
                logger.info("RAG pipeline initialized")
            except Exception as e:
                logger.warning(f"RAG pipeline initialization failed: {e}")
                self._rag_pipeline = None
        
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
        
        # Sync RAG pipeline stores in a background thread so it doesn't
        # block the HTTP response for index_workspace.
        if self._rag_pipeline:
            import threading

            def _rag_ingest_background():
                try:
                    rag_stats = self._rag_pipeline.ingest_directory(
                        str(self.workspace_root)
                    )
                    self._stats.rag_documents = rag_stats.get('documents_processed', 0)
                    self._stats.rag_sections = rag_stats.get('total_sections', 0)
                    self._stats.rag_summaries = rag_stats.get('documents_processed', 0)
                    logger.info(
                        f"RAG ingestion complete: {self._stats.rag_documents} docs, "
                        f"{self._stats.rag_sections} sections"
                    )
                except Exception as e:
                    logger.warning(f"RAG background ingestion failed: {e}")

            thread = threading.Thread(
                target=_rag_ingest_background,
                name="rag-ingest",
                daemon=True,
            )
            thread.start()
            logger.info("RAG ingestion started in background thread")
        
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
        
        # Sync single file into RAG stores
        try:
            if self._rag_pipeline:
                abs_path = str(self.workspace_root / file_path)
                self._rag_pipeline.ingest_file(abs_path)
        except Exception as e:
            logger.debug(f"RAG single-file ingest failed for {file_path}: {e}")
        
        return len(chunks)
    
    async def delete_file(self, file_path: str) -> Dict[str, Any]:
        """
        Remove a file from all indexes and stores.
        
        Called when a file is deleted from the workspace so that stale data
        is purged from the dual-index, summaries, facts, and RAG stores.
        
        Args:
            file_path: Path to file (relative to workspace)
            
        Returns:
            Dict summarising what was cleaned up
        """
        self._initialize_components()
        
        cleaned: Dict[str, Any] = {"file": file_path}
        
        # 1. Dual indexer (vector + structural + lexical)
        try:
            self._dual_indexer.remove_file(file_path)
            cleaned["dual_index"] = True
        except Exception as e:
            logger.warning(f"DualIndexer remove failed for {file_path}: {e}")
            cleaned["dual_index"] = False
        
        # 2. Summary store
        try:
            if self._summary_store:
                self._summary_store.remove_file_summary(file_path)
                self._summary_store.remove_file_hash(file_path)
            cleaned["summaries"] = True
        except Exception as e:
            logger.warning(f"Summary removal failed for {file_path}: {e}")
            cleaned["summaries"] = False
        
        # 3. Facts store
        try:
            if self._facts_store:
                self._facts_store.remove_facts_for_file(file_path)
            cleaned["facts"] = True
        except Exception as e:
            logger.warning(f"Facts removal failed for {file_path}: {e}")
            cleaned["facts"] = False
        
        # 4. RAG stores
        try:
            if self._rag_pipeline:
                abs_path = str(self.workspace_root / file_path)
                self._rag_pipeline.remove_file(abs_path)
            cleaned["rag"] = True
        except Exception as e:
            logger.warning(f"RAG removal failed for {file_path}: {e}")
            cleaned["rag"] = False
        
        logger.info(f"Deleted file from indexes: {file_path} -> {cleaned}")
        return cleaned
    
    async def rename_file(
        self, old_path: str, new_path: str,
    ) -> Dict[str, Any]:
        """
        Atomically rename a file across all indexes.
        
        Implemented as delete-old + index-new so every store is consistent.
        
        Args:
            old_path: Previous file path (relative to workspace)
            new_path: New file path (relative to workspace)
            
        Returns:
            Dict with cleanup and re-index results
        """
        result: Dict[str, Any] = {"old_path": old_path, "new_path": new_path}
        
        # Remove old entries
        cleanup = await self.delete_file(old_path)
        result["cleanup"] = cleanup
        
        # Re-index under the new path
        try:
            chunks = await self.index_file(new_path)
            result["chunks_indexed"] = chunks
        except Exception as e:
            logger.warning(f"Re-index after rename failed for {new_path}: {e}")
            result["chunks_indexed"] = 0
            result["error"] = str(e)
        
        logger.info(f"Renamed file in indexes: {old_path} -> {new_path}")
        return result
    
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
        Uses the RAG pipeline (Steps 2+3: Macro-Retrieval + Micro-Navigation)
        when available. Falls back to the old retrieval pipeline otherwise.
        
        Args:
            query: User query or intent
            max_tokens: Maximum tokens in context
            conversation_history: Previous messages for stability
            
        Returns:
            RetrievalResult with assembled context and sufficiency indicator
        """
        self._initialize_components()
        
        # ── Try RAG pipeline first (superior retrieval) ──────────────────
        if self._rag_pipeline and self._rag_pipeline.document_store.count() > 0:
            return await self._get_context_via_rag(query, max_tokens)
        
        # ── Fallback: old retrieval pipeline ─────────────────────────────
        return await self._get_context_via_old_pipeline(query, max_tokens)

    async def _get_context_via_rag(
        self,
        query: str,
        max_tokens: int,
    ) -> RetrievalResult:
        """
        Context retrieval using the new 4-step RAG pipeline (Steps 2+3 only).
        
        Runs Macro-Retrieval → Micro-Navigation → ContextBuilder.
        No heavy LLM call — the frontend's Gemini call handles synthesis.
        """
        import asyncio
        
        budget = ContextBudget(max_tokens=max_tokens)
        
        loop = asyncio.get_event_loop()
        rag_ctx = await loop.run_in_executor(
            None,
            lambda: self._rag_pipeline.retrieve_context(query, max_tokens=max_tokens)
        )
        
        context_text = rag_ctx.get("context_text", "")
        sources = rag_ctx.get("sources", [])
        tokens_used = rag_ctx.get("tokens_used", 0)
        timing = rag_ctx.get("timing", {})
        trace = rag_ctx.get("trace", [])
        sufficiency_str = rag_ctx.get("sufficiency", "UNKNOWN")
        
        # Map RAG sufficiency string to controller enum
        sufficiency = ContextSufficiency.SUFFICIENT
        refusal = None
        if sufficiency_str == "EMPTY":
            sufficiency = ContextSufficiency.INSUFFICIENT
            refusal = RefusalReason.NO_RESULTS
        elif sufficiency_str == "INSUFFICIENT":
            sufficiency = ContextSufficiency.INSUFFICIENT
            refusal = RefusalReason.TOPIC_NOT_FOUND
        elif sufficiency_str == "PARTIAL":
            sufficiency = ContextSufficiency.PARTIAL
        
        # Build grounding spans from RAG sources
        grounding_spans = [
            {
                "file": s.get("file", ""),
                "start_line": s.get("start_line", 0),
                "end_line": s.get("end_line", 0),
                "symbol": s.get("symbol", ""),
                "score": s.get("score", 0.0),
                "citation_id": s.get("citation_id", ""),
                "breadcrumb": s.get("breadcrumb", ""),
            }
            for s in sources
        ]
        
        retrieval_result = RetrievalResult(
            chunks=[],
            file_summaries=[],
            repo_summary=None,
            query=query,
            total_tokens=tokens_used,
            budget=budget,
            assembled_context=context_text,
            trace=trace,
            debug={
                "timings_ms": timing,
                "pipeline": "rag",
                "documents_searched": rag_ctx.get("documents_searched", 0),
                "documents_selected": rag_ctx.get("documents_selected", 0),
                "sections_used": rag_ctx.get("sections_used", 0),
            },
            grounding_spans=grounding_spans,
            sufficiency=sufficiency,
            refusal_reason=refusal,
        )
        
        return retrieval_result

    async def _get_context_via_old_pipeline(
        self,
        query: str,
        max_tokens: int,
    ) -> RetrievalResult:
        """
        Context retrieval using the legacy retrieval pipeline.
        
        Used as fallback when RAG stores are empty.
        """
        import asyncio
        
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
                "pipeline": "legacy",
                "counters": self._last_metrics(),
            },
            grounding_spans=pipeline_result.grounding_spans,
            clarifying_question=pipeline_result.clarifying_question,
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
    
    def _get_metrics_collector(self):
        """Get the central metrics collector (lazy import)."""
        if not hasattr(self, '_metrics_collector'):
            self._metrics_collector = None
            try:
                from metrics import get_metrics_collector
                self._metrics_collector = get_metrics_collector()
            except ImportError:
                pass
        return self._metrics_collector

    def get_retrieval_metrics(self, include_all: bool = False) -> Dict[str, Any]:
        """Get retrieval latency and budget metrics.
        
        Args:
            include_all: If True, include comprehensive metrics from the central collector
        
        Returns:
            Dictionary with latency, counters, budgets, and optionally all comprehensive metrics
        """
        self._initialize_components()
        metrics = {}
        counters = {}
        if self._retrieval_pipeline:
            metrics = self._retrieval_pipeline.get_metrics()
            counters = self._retrieval_pipeline.get_counters()
        
        result = {
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
        
        # Include comprehensive metrics if requested
        if include_all:
            collector = self._get_metrics_collector()
            if collector:
                result["all"] = collector.get_all_metrics()
        
        return result
    
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
    # RAG API (4-Step Retrieval-Augmented Generation)
    # =========================================================================
    
    def rag_query(self, query: str, **kwargs) -> Dict[str, Any]:
        """
        Execute a RAG query through the 4-step pipeline.
        
        Steps: Macro-Retrieval → Micro-Navigation → Synthesis → Cited Answer.
        
        Args:
            query: User question.
            **kwargs: Override RAGQuery defaults.
            
        Returns:
            RAGResult as a dictionary.
        """
        self._initialize_components()
        if not self._rag_pipeline:
            return {"error": "RAG pipeline not available", "answer": ""}
        result = self._rag_pipeline.query(query, **kwargs)
        return result.to_dict()
    
    def rag_ingest(
        self,
        directory: Optional[str] = None,
        file_path: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Ingest documents into the RAG pipeline.
        
        Args:
            directory: Directory to ingest. Defaults to workspace root.
            file_path: Single file to ingest.
            
        Returns:
            Ingestion statistics.
        """
        self._initialize_components()
        if not self._rag_pipeline:
            return {"error": "RAG pipeline not available"}
        if file_path:
            return self._rag_pipeline.ingest_file(file_path)
        return self._rag_pipeline.ingest_directory(directory)
    
    def rag_stats(self) -> Dict[str, Any]:
        """Get RAG pipeline statistics."""
        self._initialize_components()
        if not self._rag_pipeline:
            return {"error": "RAG pipeline not available"}
        return self._rag_pipeline.get_stats()
    
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
