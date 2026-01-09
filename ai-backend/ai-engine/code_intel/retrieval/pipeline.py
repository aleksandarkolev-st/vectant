"""
Retrieval Pipeline - Orchestrate the complete context assembly flow.

This is the main entry point for query-time context assembly.

Pipeline:
1. Process query → Extract intent, symbols, patterns
2. Retrieve candidates → Vector search + keyword matching
3. Expand via graph → Follow dependencies
4. Rank candidates → Multi-factor scoring
5. Enforce budget → Fit within token limits
6. Assemble context → Format for LLM

Usage:
    pipeline = RetrievalPipeline(vector_index, structural_index, ...)
    result = pipeline.retrieve("How does the auth middleware work?")
    print(result.content)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional

import numpy as np

from ..core.types import RepoSummary, FileSummary, ContextBudget, RetrievalResult
from ..core.config import CodeIntelConfig
from ..indexer import Embedder

from .query_processor import QueryProcessor, ParsedQuery
from .retriever import ContextRetriever, RetrievalCandidate
from .graph_expander import GraphExpander
from .ranker import ContextRanker
from .budget_enforcer import BudgetEnforcer, BudgetAllocation
from .context_assembler import ContextAssembler, AssembledContext


logger = logging.getLogger("code_intel.retrieval.pipeline")


@dataclass
class RetrievalPipelineResult:
    """Result from the retrieval pipeline."""
    
    # The assembled context (ready for LLM)
    context: AssembledContext
    
    # Query analysis
    parsed_query: ParsedQuery
    
    # Pipeline metrics
    candidates_found: int = 0
    candidates_expanded: int = 0
    candidates_included: int = 0
    candidates_excluded: int = 0
    
    # Timing (ms)
    query_time_ms: float = 0.0
    retrieval_time_ms: float = 0.0
    expansion_time_ms: float = 0.0
    ranking_time_ms: float = 0.0
    assembly_time_ms: float = 0.0
    total_time_ms: float = 0.0


class RetrievalPipeline:
    """
    Complete retrieval pipeline for code context assembly.
    
    Orchestrates all pipeline stages to produce LLM-ready context.
    """
    
    def __init__(
        self,
        vector_index,  # VectorIndex
        structural_index,  # StructuralIndex
        embedder: Optional[Embedder] = None,
        repo_summary: Optional[RepoSummary] = None,
        file_summaries: Optional[Dict[str, FileSummary]] = None,
        config: Optional[CodeIntelConfig] = None,
    ):
        self.vector_index = vector_index
        self.structural_index = structural_index
        self.embedder = embedder or Embedder()
        self.repo_summary = repo_summary
        self.file_summaries = file_summaries or {}
        self.config = config or CodeIntelConfig()
        
        # Initialize components
        self.query_processor = QueryProcessor()
        self.retriever = ContextRetriever(
            vector_index,
            config=self.config.retrieval,
        )
        
        # Get symbol graph from structural index
        symbol_graph = getattr(structural_index, 'symbol_graph', None)
        self.graph_expander = GraphExpander(
            symbol_graph,
            structural_index,
            config=self.config.retrieval,
        ) if symbol_graph else None
        
        self.ranker = ContextRanker(config=self.config.retrieval)
        self.budget_enforcer = BudgetEnforcer(config=self.config.context)
        self.assembler = ContextAssembler()
    
    def retrieve(
        self,
        query: str,
        budget: Optional[ContextBudget] = None,
        filter_language: Optional[str] = None,
        include_tests: bool = False,
    ) -> RetrievalPipelineResult:
        """
        Execute the retrieval pipeline.
        
        Args:
            query: User's natural language query
            budget: Token budget constraints
            filter_language: Only include chunks in this language
            include_tests: Whether to include test files
            
        Returns:
            RetrievalPipelineResult with assembled context
        """
        import time
        total_start = time.time()
        
        # Set default budget
        if budget is None:
            budget = ContextBudget(
                max_tokens=self.config.context.max_context_tokens,
                reserved_for_response=self.config.context.response_reserve_tokens,
            )
        
        # Stage 1: Process Query
        query_start = time.time()
        parsed_query = self.query_processor.process(query)
        
        # Get embedding for query
        query_embedding = self.embedder.embed_query(parsed_query.search_text)
        parsed_query.embedding = query_embedding
        
        query_time = (time.time() - query_start) * 1000
        
        # Stage 2: Retrieve Candidates
        retrieval_start = time.time()
        candidates = self.retriever.retrieve(
            query_embedding=query_embedding,
            query_symbols=parsed_query.symbol_names,
            query_files=parsed_query.file_patterns,
            top_k=self.config.retrieval.top_k,
            filter_language=filter_language,
            exclude_test_files=not include_tests,
        )
        retrieval_time = (time.time() - retrieval_start) * 1000
        candidates_found = len(candidates)
        
        # Stage 3: Graph Expansion
        expansion_start = time.time()
        if self.graph_expander and candidates:
            candidates = self.graph_expander.expand(
                candidates,
                max_expanded=self.config.retrieval.top_k * 3,
            )
        expansion_time = (time.time() - expansion_start) * 1000
        candidates_expanded = len(candidates)
        
        # Stage 4: Ranking
        ranking_start = time.time()
        candidates = self.ranker.rank(
            candidates,
            query_symbols=parsed_query.symbol_names,
        )
        ranking_time = (time.time() - ranking_start) * 1000
        
        # Stage 5: Budget Enforcement
        budget_start = time.time()
        allocation = self.budget_enforcer.enforce(
            candidates,
            repo_summary=self.repo_summary,
            file_summaries=self.file_summaries,
            budget=budget,
        )
        budget_time = (time.time() - budget_start) * 1000
        
        # Stage 6: Assembly
        assembly_start = time.time()
        context = self.assembler.assemble(
            allocation,
            repo_summary=self.repo_summary,
            file_summaries=self.file_summaries,
            query_summary=query,
        )
        assembly_time = (time.time() - assembly_start) * 1000
        
        total_time = (time.time() - total_start) * 1000
        
        return RetrievalPipelineResult(
            context=context,
            parsed_query=parsed_query,
            candidates_found=candidates_found,
            candidates_expanded=candidates_expanded,
            candidates_included=len(allocation.included_chunks),
            candidates_excluded=len(allocation.excluded_chunks),
            query_time_ms=query_time,
            retrieval_time_ms=retrieval_time,
            expansion_time_ms=expansion_time,
            ranking_time_ms=ranking_time,
            assembly_time_ms=assembly_time,
            total_time_ms=total_time,
        )
    
    def update_summaries(
        self,
        repo_summary: Optional[RepoSummary] = None,
        file_summaries: Optional[Dict[str, FileSummary]] = None,
    ) -> None:
        """Update cached summaries."""
        if repo_summary is not None:
            self.repo_summary = repo_summary
        if file_summaries is not None:
            self.file_summaries = file_summaries


def create_pipeline(
    vector_index,
    structural_index,
    embedder: Optional[Embedder] = None,
    repo_summary: Optional[RepoSummary] = None,
    file_summaries: Optional[Dict[str, FileSummary]] = None,
) -> RetrievalPipeline:
    """Create a retrieval pipeline with default configuration."""
    return RetrievalPipeline(
        vector_index=vector_index,
        structural_index=structural_index,
        embedder=embedder,
        repo_summary=repo_summary,
        file_summaries=file_summaries,
    )
