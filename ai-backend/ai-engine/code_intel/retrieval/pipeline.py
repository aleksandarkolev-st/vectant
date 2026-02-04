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
from typing import Any, Dict, List, Optional, Set
import re

import numpy as np

from ..core.types import RepoSummary, FileSummary, ModuleSummary, ContextBudget, RetrievalResult
from ..core.config import CodeIntelConfig
from ..indexer import Embedder

from .query_processor import QueryProcessor, ParsedQuery
from .retriever import ContextRetriever, RetrievalCandidate
from .graph_expander import GraphExpander
from .ranker import ContextRanker
from .budget_enforcer import BudgetEnforcer, BudgetAllocation
from .context_assembler import ContextAssembler, AssembledContext
from .reranker import LightweightReranker, GeminiReranker


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

    # Rolling p95 metrics
    stage_p95_ms: Dict[str, float] = field(default_factory=dict)

    # Observability trace
    trace: List[Dict[str, Any]] = field(default_factory=list)


class RetrievalPipeline:
    """
    Complete retrieval pipeline for code context assembly.
    
    Orchestrates all pipeline stages to produce LLM-ready context.
    """
    
    def __init__(
        self,
        vector_index,  # VectorIndex
        structural_index,  # StructuralIndex
        lexical_index=None,  # LexicalIndex
        embedder: Optional[Embedder] = None,
        repo_summary: Optional[RepoSummary] = None,
        file_summaries: Optional[Dict[str, FileSummary]] = None,
        module_summaries: Optional[Dict[str, ModuleSummary]] = None,
        file_reader=None,
        router=None,
        config: Optional[CodeIntelConfig] = None,
    ):
        self.vector_index = vector_index
        self.structural_index = structural_index
        self.lexical_index = lexical_index
        self.embedder = embedder or Embedder()
        self.repo_summary = repo_summary
        self.file_summaries = file_summaries or {}
        self.module_summaries = module_summaries or {}
        self.file_reader = file_reader
        self.router = router
        self.config = config or CodeIntelConfig()
        
        # Initialize components
        self.query_processor = QueryProcessor()
        self.retriever = ContextRetriever(
            vector_index,
            lexical_index=lexical_index,
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
        self.reranker = LightweightReranker()
        self.llm_reranker = None
        if self.config.retrieval.enable_llm_rerank:
            self.llm_reranker = GeminiReranker(
                api_key=self.config.gemini_api_key,
                model=self.config.retrieval.llm_rerank_model,
                timeout_ms=self.config.retrieval.llm_rerank_timeout_ms,
            )
        self.budget_enforcer = BudgetEnforcer(config=self.config.context)
        self.assembler = ContextAssembler(config=self.config.context)

        # Latency tracking
        self._latency_samples: Dict[str, List[float]] = {
            "query": [],
            "retrieval": [],
            "expansion": [],
            "ranking": [],
            "assembly": [],
        }
        self._latency_cap = 200
        self._last_counters: Dict[str, int] = {}

        # Invariants
        assert self.config.retrieval.rerank_top_k >= self.config.retrieval.final_max_chunks, (
            "rerank_top_k must be >= final_max_chunks"
        )
    
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

        # Dynamic budgets by intent
        dynamic_max_chunks = None
        if self.config.retrieval.enable_dynamic_budgets and parsed_query.intent:
            intent_key = parsed_query.intent.value
            override_tokens = self.config.retrieval.intent_budget_tokens.get(intent_key)
            if override_tokens:
                budget.max_tokens = int(override_tokens)
            dynamic_max_chunks = self.config.retrieval.intent_max_chunks.get(intent_key)

        # Route query (intent + seed selection)
        route_result = None
        query_symbols = list(parsed_query.symbol_names or [])
        query_files = list(parsed_query.file_patterns or [])
        query_text_aug = parsed_query.search_text
        if self.router:
            route_result = self.router.route(parsed_query, query)
            if route_result.seed_symbols:
                query_symbols.extend(route_result.seed_symbols)
            if route_result.seed_files:
                query_files.extend(route_result.seed_files)
            if route_result.query_terms:
                query_text_aug = f"{query_text_aug} {' '.join(route_result.query_terms)}"
        
        # Get embedding for query
        query_embedding = self.embedder.embed_query(parsed_query.search_text)
        parsed_query.embedding = query_embedding
        
        query_time = (time.time() - query_start) * 1000
        
        # Extract folder scope for scoped retrieval
        folder_scope = parsed_query.folder_scope
        
        # Stage 2: Retrieve Candidates
        retrieval_start = time.time()
        vector_top_k = self.config.retrieval.vector_top_k or self.config.retrieval.top_k_candidates
        candidates, retrieval_stats = self.retriever.retrieve(
            query_embedding=query_embedding,
            query_text=query_text_aug,
            query_symbols=query_symbols,
            query_files=query_files,
            top_k=vector_top_k,
            filter_language=filter_language,
            exclude_test_files=not include_tests,
            folder_scope=folder_scope,
        )
        retrieval_time = (time.time() - retrieval_start) * 1000
        candidates_found = len(candidates)

        # Multi-pass retrieval (relaxed thresholds)
        multi_pass_used = False
        if self.config.retrieval.enable_multi_pass and candidates_found < self.config.retrieval.multi_pass_min_candidates:
            relaxed_candidates, relaxed_stats = self._relaxed_retrieve(
                query_embedding=query_embedding,
                query_text=query_text_aug,
                query_symbols=query_symbols,
                query_files=query_files,
                top_k=max(vector_top_k, self.config.retrieval.multi_pass_vector_top_k),
                filter_language=filter_language,
                include_tests=self.config.retrieval.multi_pass_include_tests,
                folder_scope=folder_scope,
            )
            if len(relaxed_candidates) > candidates_found:
                candidates = relaxed_candidates
                retrieval_stats = relaxed_stats
                candidates_found = len(candidates)
                multi_pass_used = True

        # Inject routed seed chunks (highest priority)
        if route_result and route_result.seed_chunks:
            seed_candidates: List[RetrievalCandidate] = []
            for cid in route_result.seed_chunks:
                chunk = self.vector_index.get_chunk(cid)
                if not chunk:
                    continue
                boost = route_result.boosts_by_chunk.get(cid, 0.0)
                seed_candidates.append(RetrievalCandidate(
                    chunk=chunk,
                    keyword_score=1.0,
                    combined_score=1.1 + boost,
                    source="router",
                ))
            # Merge with existing candidates
            merged = {c.chunk.id: c for c in candidates}
            for sc in seed_candidates:
                if sc.chunk.id not in merged:
                    merged[sc.chunk.id] = sc
                else:
                    merged[sc.chunk.id].combined_score = max(
                        merged[sc.chunk.id].combined_score,
                        sc.combined_score,
                    )
            candidates = list(merged.values())
            candidates_found = len(candidates)
            retrieval_stats["post_dedup"] = candidates_found
        assert retrieval_stats.get("post_dedup", candidates_found) == candidates_found, (
            "Dedup must occur before ranking/budgeting"
        )

        # Snapshot file state for consistency (hash + stat)
        snapshot_state = self._snapshot_file_state(candidates)

        # Optional definition pull (symbol index hop)
        if self.lexical_index and candidates:
            candidates = self._definition_pull(candidates, parsed_query, snapshot_state)
        
        # Stage 3: Graph Expansion
        expansion_start = time.time()
        if self.graph_expander and candidates:
            candidates = self.graph_expander.expand(
                candidates,
                max_expanded=self.config.retrieval.max_expanded_chunks,
            )
        expansion_time = (time.time() - expansion_start) * 1000
        candidates_expanded = len(candidates)

        # Apply file-level boosts from routing
        if route_result and route_result.boosts_by_file:
            for cand in candidates:
                boost = route_result.boosts_by_file.get(cand.chunk.file_path, 0.0)
                if boost:
                    cand.combined_score += boost

        # Snapshot file hashes and staleness filter (hash + chunking version)
        snapshot_hashes = {fp: state["hash"] for fp, state in snapshot_state.items()}
        before_stale = len(candidates)
        candidates = self._filter_stale_candidates(candidates, snapshot_hashes)
        post_staleness_count = len(candidates)
        dropped_stale = before_stale - post_staleness_count
        
        # Stage 4: Ranking
        ranking_start = time.time()
        candidates = self.ranker.rank(
            candidates,
            query_symbols=parsed_query.symbol_names,
        )
        ranking_time = (time.time() - ranking_start) * 1000

        # Stage 4b: Lightweight rerank/filter
        rerank_time = 0.0
        post_rerank_count = len(candidates)
        if self.reranker and candidates:
            rerank_top_k = max(self.config.retrieval.rerank_top_k, self.config.retrieval.final_max_chunks)
            candidates = candidates[:rerank_top_k]
            rerank_start = time.time()
            reranked = self.reranker.rerank(
                [(c.chunk, c.combined_score) for c in candidates],
                query,
                query_symbols=parsed_query.symbol_names,
            )
            rerank_time = (time.time() - rerank_start) * 1000
            if reranked:
                by_id = {c.chunk.id: c for c in candidates}
                new_candidates: List[RetrievalCandidate] = []
                for r in reranked:
                    cand = by_id.get(r.chunk.id)
                    if not cand:
                        continue
                    cand.combined_score = r.rerank_score
                    new_candidates.append(cand)
                candidates = new_candidates
            post_rerank_count = len(candidates)

        # Stage 4c: Optional LLM rerank
        llm_rerank_time = 0.0
        post_llm_rerank = len(candidates)
        if self.llm_reranker and candidates:
            llm_top_k = max(self.config.retrieval.llm_rerank_top_k, self.config.retrieval.final_max_chunks)
            llm_candidates = candidates[:llm_top_k]
            llm_start = time.time()
            llm_results = self.llm_reranker.rerank(
                [(c.chunk, c.combined_score) for c in llm_candidates],
                query,
                max_results=llm_top_k,
            )
            llm_rerank_time = (time.time() - llm_start) * 1000
            if llm_results:
                by_id = {c.chunk.id: c for c in llm_candidates}
                new_candidates: List[RetrievalCandidate] = []
                for r in llm_results:
                    if r.score < self.config.retrieval.llm_rerank_min_score:
                        continue
                    cand = by_id.get(r.chunk_id)
                    if not cand:
                        continue
                    cand.combined_score = r.score
                    new_candidates.append(cand)
                if new_candidates:
                    candidates = new_candidates
            post_llm_rerank = len(candidates)
        
        # Stage 5: Budget Enforcement
        budget_start = time.time()
        filtered_summaries = self._filter_file_summaries(self.file_summaries, snapshot_hashes)
        # Apply final chunk cap from retrieval config
        if hasattr(self.budget_enforcer.config, "max_chunks"):
            self.budget_enforcer.config.max_chunks = (
                int(dynamic_max_chunks)
                if dynamic_max_chunks is not None
                else self.config.retrieval.final_max_chunks
            )

        allocation = self.budget_enforcer.enforce(
            candidates,
            repo_summary=self.repo_summary,
            file_summaries=filtered_summaries,
            module_summaries=self.module_summaries,
            budget=budget,
        )
        budget_time = (time.time() - budget_start) * 1000
        
        # Stage 6: Assembly
        assembly_start = time.time()
        context = self.assembler.assemble(
            allocation,
            repo_summary=self.repo_summary,
            file_summaries=filtered_summaries,
            module_summaries=self.module_summaries,
            query_summary=query,
        )
        assembly_time = (time.time() - assembly_start) * 1000
        
        total_time = (time.time() - total_start) * 1000

        # Build observability trace (only for included chunks - fixes telemetry accuracy)
        trace: List[Dict[str, Any]] = []
        
        # Add scope metadata at the start of trace
        if folder_scope:
            trace.append({
                "type": "scope",
                "folder_scope": folder_scope,
                "reason": "metadata",
            })
        
        for cand in allocation.included_chunks:
            trace.append({
                "chunk_id": cand.chunk.id,
                "file": cand.chunk.file_path,
                "symbol": cand.chunk.symbol_name,
                "source": cand.source,
                "score": cand.combined_score,
                "reason": "included",
                "expansion_depth": cand.expansion_depth,
            })
        # Note: We intentionally exclude truncated and budget_excluded chunks from trace
        # to ensure telemetry only shows actually used context (fixes "Context used" accuracy)
        for cand in allocation.truncated_chunks:
                "chunk_id": cand.chunk.id,
                "file": cand.chunk.file_path,
                "symbol": cand.chunk.symbol_name,
                "source": cand.source,
                "score": cand.combined_score,
                "reason": "truncated",
                "expansion_depth": cand.expansion_depth,
            })
        for cand in allocation.excluded_chunks:
            trace.append({
                "chunk_id": cand.chunk.id,
                "file": cand.chunk.file_path,
                "symbol": cand.chunk.symbol_name,
                "source": cand.source,
                "score": cand.combined_score,
                "reason": "budget_excluded",
                "expansion_depth": cand.expansion_depth,
            })
        
        stage_p95 = self._record_metrics({
            "query": query_time,
            "retrieval": retrieval_time,
            "expansion": expansion_time,
            "ranking": ranking_time,
            "assembly": assembly_time,
        })

        self._last_counters = {
            "pre_dedup_total": (
                retrieval_stats.get("pre_dedup_vector", 0)
                + retrieval_stats.get("pre_dedup_lexical", 0)
                + retrieval_stats.get("pre_dedup_symbol", 0)
                + retrieval_stats.get("pre_dedup_file", 0)
            ),
            "pre_dedup_vector": retrieval_stats.get("pre_dedup_vector", 0),
            "pre_dedup_lexical": retrieval_stats.get("pre_dedup_lexical", 0),
            "pre_dedup_symbol": retrieval_stats.get("pre_dedup_symbol", 0),
            "pre_dedup_file": retrieval_stats.get("pre_dedup_file", 0),
            "post_dedup": retrieval_stats.get("post_dedup", candidates_found),
            "post_graph": candidates_expanded,
            "post_staleness": post_staleness_count,
            "post_rerank": post_rerank_count,
            "post_llm_rerank": post_llm_rerank,
            "final": len(allocation.included_chunks),
            "candidates_found": candidates_found,
            "graph_expanded_count": max(0, candidates_expanded - candidates_found),
            "dropped_chunks_stale": dropped_stale,
            "dropped_chunks_version": 0,
            "rerank_latency_ms": int(rerank_time),
            "llm_rerank_latency_ms": int(llm_rerank_time),
            "multi_pass_used": int(1 if multi_pass_used else 0),
        }

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
            stage_p95_ms=stage_p95,
            trace=trace,
        )

    def _relaxed_retrieve(
        self,
        query_embedding,
        query_text: str,
        query_symbols: List[str],
        query_files: List[str],
        top_k: int,
        filter_language: Optional[str],
        include_tests: bool,
        folder_scope: Optional[str] = None,
    ):
        """Run a relaxed retrieval pass with lower thresholds."""
        prev = {
            "min_similarity": self.config.retrieval.min_similarity,
            "vector_top_k": self.config.retrieval.vector_top_k,
            "bm25_top_k": self.config.retrieval.bm25_top_k,
        }
        try:
            self.config.retrieval.min_similarity = self.config.retrieval.multi_pass_min_similarity
            self.config.retrieval.vector_top_k = max(self.config.retrieval.vector_top_k, self.config.retrieval.multi_pass_vector_top_k)
            self.config.retrieval.bm25_top_k = max(self.config.retrieval.bm25_top_k, self.config.retrieval.multi_pass_bm25_top_k)
            self.retriever.config = self.config.retrieval
            return self.retriever.retrieve(
                query_embedding=query_embedding,
                query_text=query_text,
                query_symbols=query_symbols,
                query_files=query_files,
                top_k=top_k,
                filter_language=filter_language,
                exclude_test_files=not include_tests,
                folder_scope=folder_scope,
            )
        finally:
            self.config.retrieval.min_similarity = prev["min_similarity"]
            self.config.retrieval.vector_top_k = prev["vector_top_k"]
            self.config.retrieval.bm25_top_k = prev["bm25_top_k"]
            self.retriever.config = self.config.retrieval
    
    def _get_metrics_collector(self):
        """Get metrics collector (lazy import to avoid circular dependency)."""
        if not hasattr(self, '_metrics_collector'):
            self._metrics_collector = None
            try:
                from metrics import get_metrics_collector
                self._metrics_collector = get_metrics_collector()
            except ImportError:
                pass
        return self._metrics_collector

    def _record_metrics(self, sample: Dict[str, float]) -> Dict[str, float]:
        p95 = {}
        for key, val in sample.items():
            arr = self._latency_samples.get(key, [])
            arr.append(val)
            if len(arr) > self._latency_cap:
                arr.pop(0)
            self._latency_samples[key] = arr
            if arr:
                sorted_arr = sorted(arr)
                idx = int(0.95 * (len(sorted_arr) - 1))
                p95[key] = sorted_arr[idx]
        
        # Record to central metrics collector
        collector = self._get_metrics_collector()
        if collector:
            collector.record_retrieval(
                query_ms=sample.get("query", 0),
                retrieval_ms=sample.get("retrieval", 0),
                expansion_ms=sample.get("expansion", 0),
                ranking_ms=sample.get("ranking", 0),
                assembly_ms=sample.get("assembly", 0),
                total_ms=sum(sample.values()),
                counters=self._last_counters,
            )
        
        return p95

    def get_metrics(self) -> Dict[str, Dict[str, float]]:
        """Get current latency metrics (p50/p95/p99) per stage."""
        metrics: Dict[str, Dict[str, float]] = {}
        for key, arr in self._latency_samples.items():
            if not arr:
                metrics[key] = {"p50": 0.0, "p95": 0.0, "p99": 0.0}
                continue
            sorted_arr = sorted(arr)
            n = len(sorted_arr)
            p50 = sorted_arr[int(0.50 * (n - 1))]
            p95 = sorted_arr[int(0.95 * (n - 1))]
            p99 = sorted_arr[int(0.99 * (n - 1))]
            metrics[key] = {"p50": p50, "p95": p95, "p99": p99}
        return metrics

    def get_counters(self) -> Dict[str, int]:
        """Get last retrieval counters."""
        return dict(self._last_counters)
    
    def record_quality_metrics(self, recall_at_k: Dict[int, float], mrr: float) -> None:
        """Record quality metrics (Recall@k, MRR) for evaluation."""
        collector = self._get_metrics_collector()
        if collector:
            collector.record_retrieval_quality(recall_at_k, mrr)

    def _snapshot_file_state(self, candidates: List[RetrievalCandidate]) -> Dict[str, Dict[str, int | str]]:
        if not self.file_reader:
            return {}
        files = {c.chunk.file_path for c in candidates}
        snapshot: Dict[str, Dict[str, int | str]] = {}
        for fp in files:
            file_hash = self.file_reader.get_file_hash(fp)
            stat = None
            if hasattr(self.file_reader, "get_file_stat"):
                stat = self.file_reader.get_file_stat(fp)
            snapshot[fp] = {
                "hash": file_hash,
                "mtime_ns": int(stat.get("mtime_ns")) if stat else 0,
                "size": int(stat.get("size")) if stat else 0,
            }
        return snapshot

    def _snapshot_still_valid(self, file_path: str, snapshot_state: Dict[str, Dict[str, int | str]]) -> bool:
        if not self.file_reader:
            return True
        state = snapshot_state.get(file_path)
        if not state:
            return True
        if hasattr(self.file_reader, "get_file_stat"):
            current = self.file_reader.get_file_stat(file_path)
            if not current:
                return False
            if int(current.get("mtime_ns", 0)) != int(state.get("mtime_ns", 0)):
                return False
            if int(current.get("size", 0)) != int(state.get("size", 0)):
                return False
        return True

    def _filter_stale_candidates(
        self,
        candidates: List[RetrievalCandidate],
        snapshot_hashes: Optional[Dict[str, str]] = None,
    ) -> List[RetrievalCandidate]:
        if not self.file_reader:
            return candidates

        current_hashes: Dict[str, str] = snapshot_hashes or {}
        filtered: List[RetrievalCandidate] = []
        chunking_version = self.config.indexer.chunking_version

        dropped_version = 0

        for cand in candidates:
            fp = cand.chunk.file_path
            if fp not in current_hashes:
                current_hashes[fp] = self.file_reader.get_file_hash(fp)
            current_hash = current_hashes[fp]
            if not current_hash:
                continue
            if current_hash and cand.chunk.content_hash and current_hash != cand.chunk.content_hash:
                continue
            if cand.chunk.metadata.chunking_version != chunking_version:
                dropped_version += 1
                continue
            filtered.append(cand)

        if dropped_version:
            self._last_counters["dropped_chunks_version"] = dropped_version

        return filtered

    def _filter_file_summaries(
        self,
        summaries: Dict[str, FileSummary],
        snapshot_hashes: Optional[Dict[str, str]] = None,
    ) -> Dict[str, FileSummary]:
        if not summaries or not self.file_reader:
            return summaries

        filtered: Dict[str, FileSummary] = {}
        chunking_version = self.config.indexer.chunking_version

        for path, summary in summaries.items():
            current_hash = snapshot_hashes.get(path) if snapshot_hashes else self.file_reader.get_file_hash(path)
            if not current_hash:
                continue
            if summary.content_hash and current_hash != summary.content_hash:
                continue
            if summary.chunking_version != chunking_version:
                continue
            if summary.chunk_ids:
                current_chunks = self.structural_index.get_chunks_for_file(path)
                if current_chunks and set(summary.chunk_ids) != set(current_chunks):
                    continue
            filtered[path] = summary

        return filtered

    def _definition_pull(
        self,
        candidates: List[RetrievalCandidate],
        parsed_query: ParsedQuery,
        snapshot_state: Optional[Dict[str, Dict[str, int | str]]] = None,
    ) -> List[RetrievalCandidate]:
        if not self.lexical_index or not self.file_reader:
            return candidates

        max_candidates = self.config.retrieval.definition_pull_top_k
        symbols_per_chunk = self.config.retrieval.definition_pull_symbols_per_chunk
        seen = {c.chunk.id for c in candidates}
        new_candidates = list(candidates)

        # Start with explicit query symbols
        symbol_queue: List[str] = list(parsed_query.symbol_names or [])

        # Pull symbols from top chunks
        for cand in candidates[:max_candidates]:
            if snapshot_state and not self._snapshot_still_valid(cand.chunk.file_path, snapshot_state):
                continue
            code = cand.chunk.get_code(self.file_reader, verify_hash=True)
            if not code:
                continue
            symbols = self._extract_identifiers(code)
            symbol_queue.extend(list(symbols)[:symbols_per_chunk])

        symbol_queue = list(dict.fromkeys(symbol_queue))

        seed_files = {c.chunk.file_path for c in candidates[:max_candidates]}

        for sym in symbol_queue:
            # Structural index first with disambiguation
            structural_ids = self.structural_index.find_chunks_for_symbol(sym)
            ranked = self._rank_symbol_candidates(structural_ids, seed_files, candidates[:max_candidates])
            for cid in ranked:
                chunk = self.vector_index.get_chunk(cid)
                if not chunk or chunk.id in seen:
                    continue
                seen.add(chunk.id)
                new_candidates.append(RetrievalCandidate(
                    chunk=chunk,
                    keyword_score=1.0,
                    combined_score=0.95,
                    source="symbol_def_structural",
                ))

            # BM25 fallback
            results = self.lexical_index.search_exact_symbol(sym)
            for r in results:
                chunk = r.chunk or self.vector_index.get_chunk(r.chunk_id)
                if not chunk or chunk.id in seen:
                    continue
                seen.add(chunk.id)
                new_candidates.append(RetrievalCandidate(
                    chunk=chunk,
                    keyword_score=1.0,
                    combined_score=0.9,
                    source="symbol_def",
                ))

            if len(new_candidates) >= max_candidates * 2:
                break

        return new_candidates

    def _rank_symbol_candidates(
        self,
        chunk_ids: List[str] | Set[str],
        seed_files: Set[str],
        seed_candidates: List[RetrievalCandidate],
    ) -> List[str]:
        if not chunk_ids:
            return []

        top_files = {c.chunk.file_path for c in seed_candidates}
        top_chunks = {c.chunk.id for c in seed_candidates}
        seed_languages = [c.chunk.language for c in seed_candidates if c.chunk.language]
        seed_language = max(set(seed_languages), key=seed_languages.count) if seed_languages else ""
        seed_types = [c.chunk.symbol_type.value for c in seed_candidates if c.chunk.symbol_type]
        seed_type = max(set(seed_types), key=seed_types.count) if seed_types else ""

        def file_proximity_score(candidate_file: str) -> float:
            if candidate_file in seed_files:
                return 1.0
            # One-hop import proximity
            imports = self.structural_index.get_file_imports(candidate_file)
            importers = self.structural_index.get_file_importers(candidate_file)
            if imports.intersection(seed_files) or importers.intersection(seed_files):
                return 0.7
            # Two-hop (approx): check neighbors of seed files
            neighbors = set()
            for sf in seed_files:
                neighbors.update(self.structural_index.get_file_imports(sf))
                neighbors.update(self.structural_index.get_file_importers(sf))
            if candidate_file in neighbors:
                return 0.4
            return 0.0

        def path_similarity(a: str, b: str) -> float:
            a_parts = a.split("/")
            b_parts = b.split("/")
            common = 0
            for ap, bp in zip(a_parts, b_parts):
                if ap != bp:
                    break
                common += 1
            denom = max(len(a_parts), len(b_parts), 1)
            return common / denom

        scored: List[tuple[str, float]] = []
        for cid in chunk_ids:
            chunk = self.vector_index.get_chunk(cid)
            if not chunk:
                continue
            score = 0.0
            # Import graph proximity
            score += file_proximity_score(chunk.file_path)
            # Language/kind alignment
            if seed_language and chunk.language == seed_language:
                score += 0.2
            if seed_type and chunk.symbol_type.value == seed_type:
                score += 0.1
            # File distance vs top files
            if top_files:
                score += max(path_similarity(chunk.file_path, f) for f in top_files) * 0.2
            # Chunk overlap with top retrieved chunks (same file)
            if chunk.file_path in top_files:
                score += 0.3
            # Prioritize exact match on existing chunks
            if chunk.id in top_chunks:
                score += 0.2
            scored.append((cid, score))

        scored.sort(key=lambda x: x[1], reverse=True)
        return [cid for cid, _ in scored]

    def _extract_identifiers(self, text: str) -> List[str]:
        return list({m.group(0) for m in re.finditer(r"[A-Za-z_][A-Za-z0-9_]{2,}", text)})
    
    def update_summaries(
        self,
        repo_summary: Optional[RepoSummary] = None,
        file_summaries: Optional[Dict[str, FileSummary]] = None,
        module_summaries: Optional[Dict[str, ModuleSummary]] = None,
    ) -> None:
        """Update cached summaries."""
        if repo_summary is not None:
            self.repo_summary = repo_summary
        if file_summaries is not None:
            self.file_summaries = file_summaries
        if module_summaries is not None:
            self.module_summaries = module_summaries


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
