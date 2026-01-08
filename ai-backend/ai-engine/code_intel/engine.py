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
from .summaries.summary_store import SummaryStore, IncrementalSummaryManager

# Retrieval
from .retrieval.pipeline import RetrievalPipeline
from .retrieval.query_processor import QueryProcessor
from .retrieval.retriever import ContextRetriever
from .retrieval.graph_expander import GraphExpander
from .retrieval.ranker import ContextRanker
from .retrieval.budget_enforcer import BudgetEnforcer
from .retrieval.context_assembler import ContextAssembler

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
        
        self._retrieval_pipeline: Optional[RetrievalPipeline] = None
        
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
        openai_api_key: Optional[str] = None,
    ) -> "CodeIntelEngine":
        """
        Factory method to create and initialize the engine.
        
        Args:
            workspace_root: Path to workspace
            openai_api_key: API key for embeddings
            
        Returns:
            Initialized CodeIntelEngine
        """
        config = CodeIntelConfig()
        
        if openai_api_key:
            config.indexer.embedding_api_key = openai_api_key
        
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
        self._embedder = Embedder(api_key=self.config.indexer.embedding_api_key)
        self._vector_index = VectorIndex(dimension=self.config.indexer.embedding_dimension)
        self._structural_index = StructuralIndex()
        self._dual_indexer = DualIndexer(
            embedder=self._embedder,
            vector_index=self._vector_index,
            structural_index=self._structural_index,
        )
        
        # Summaries
        self._summary_store = SummaryStore(
            str(self.workspace_root / ".code_intel" / "summaries"),
        )
        self._file_summarizer = FileSummarizer()
        self._repo_summarizer = RepoSummarizer()
        self._summary_manager = IncrementalSummaryManager(
            summary_store=self._summary_store,
            file_summarizer=self._file_summarizer,
            repo_summarizer=self._repo_summarizer,
        )
        
        # Retrieval pipeline
        self._retrieval_pipeline = RetrievalPipeline(
            vector_index=self._vector_index,
            structural_index=self._structural_index,
            embedder=self._embedder,
            summary_store=self._summary_store,
        )
        
        # Tools
        tools = ExplorationTools(
            workspace_root=str(self.workspace_root),
            dual_indexer=self._dual_indexer,
            summary_store=self._summary_store,
        )
        self._tool_registry = ToolRegistry()
        self._tool_registry.register_all(tools)
        self._tool_executor = ToolExecutor(self._tool_registry)
        
        # Eviction
        tracker = ContextTracker()
        policy = EvictionPolicy()
        pinner = ContextPinner()
        self._context_stabilizer = ContextStabilizer(
            tracker=tracker,
            policy=policy,
            pinner=pinner,
        )
        
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
        
        # Walk files
        files = list(self._file_walker.walk())
        logger.info(f"Found {len(files)} files to index")
        
        chunks_indexed = 0
        
        for file_info in files:
            # Detect language
            language = self._language_detector.detect(file_info.path)
            if not language:
                continue
            
            # Extract chunks
            chunks = self._chunk_extractor.extract(
                file_info.path,
                language,
            )
            
            # Normalize
            normalized = [self._normalizer.normalize(c) for c in chunks]
            
            # Index
            await self._dual_indexer.index_chunks(normalized)
            chunks_indexed += len(normalized)
        
        # Generate summaries
        await self._summary_manager.update_all()
        
        # Update stats
        self._stats.files_indexed = len(files)
        self._stats.chunks_indexed = chunks_indexed
        self._stats.symbols_tracked = len(self._structural_index._graph.nodes)
        self._stats.last_index_time_ms = (time.time() - start) * 1000
        
        logger.info(f"Indexed {chunks_indexed} chunks in {self._stats.last_index_time_ms:.0f}ms")
        
        return self._stats
    
    async def index_file(self, file_path: str) -> int:
        """
        Index a single file.
        
        Args:
            file_path: Path to file
            
        Returns:
            Number of chunks indexed
        """
        self._initialize_components()
        
        # Detect language
        language = self._language_detector.detect(file_path)
        if not language:
            return 0
        
        # Extract and index
        chunks = self._chunk_extractor.extract(file_path, language)
        normalized = [self._normalizer.normalize(c) for c in chunks]
        await self._dual_indexer.index_chunks(normalized)
        
        # Update summary
        await self._summary_manager.update_file(file_path)
        
        return len(normalized)
    
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
        
        Args:
            query: User query or intent
            max_tokens: Maximum tokens in context
            conversation_history: Previous messages for stability
            
        Returns:
            RetrievalResult with assembled context
        """
        self._initialize_components()
        
        # Create budget
        budget = ContextBudget(
            max_tokens=max_tokens,
            reserve_for_response=self.config.retrieval.reserve_tokens,
        )
        
        # Use stabilizer for multi-turn
        if conversation_history and self._context_stabilizer:
            # Get stabilized context
            result = await self._retrieval_pipeline.retrieve(
                query=query,
                budget=budget,
            )
            
            # Track for stability
            self._context_stabilizer.track_result(result)
            
            return result
        
        # Single-turn retrieval
        return await self._retrieval_pipeline.retrieve(
            query=query,
            budget=budget,
        )
    
    def get_repo_summary(self) -> Optional[RepoSummary]:
        """Get the repository summary."""
        self._initialize_components()
        return self._summary_store.get_repo_summary()
    
    def get_file_summary(self, file_path: str) -> Optional[FileSummary]:
        """Get summary for a specific file."""
        self._initialize_components()
        return self._summary_store.get_file_summary(file_path)
    
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
    openai_api_key: Optional[str] = None,
) -> CodeIntelEngine:
    """
    Create a code intelligence engine.
    
    Args:
        workspace_root: Path to workspace
        openai_api_key: API key for embeddings
        
    Returns:
        CodeIntelEngine instance
    """
    return CodeIntelEngine.create(workspace_root, openai_api_key)
