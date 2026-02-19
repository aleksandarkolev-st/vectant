"""
RAG Pipeline — Main orchestrator connecting all 4 steps.

Step 1: Dual-Ingestion (offline, populates stores)
Step 2: Macro-Retrieval (fast vector+keyword → top 3-5 docs)
Step 3: Micro-Navigation (agentic ToC traversal → precise sections)
Step 4: Heavy Synthesis (heavy model → cited answer)

The pipeline is the primary public interface for the RAG subsystem.
"""

from __future__ import annotations

import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import numpy as np

from .config import RAGConfig, get_rag_config
from .types import (
    RAGQuery,
    RAGResult,
    MacroResult,
    MicroResult,
    SectionReference,
    SectionRelevance,
)
from .exceptions import (
    RAGError,
    ConfigurationError,
    IngestionError,
    MacroRetrievalError,
    NavigationError,
    SynthesisError,
)

# Store layer
from .store.document_store import DocumentStore
from .store.toc_store import ToCStore
from .store.summary_index import SummaryIndex
from .store.section_store import SectionStore

# Ingestion
from .ingestion.document_processor import DocumentProcessor

# Macro-retrieval
from .macro.query_analyzer import QueryAnalyzer
from .macro.summary_searcher import SummarySearcher
from .macro.keyword_filter import KeywordFilter
from .macro.document_ranker import DocumentRanker

# Micro-navigation
from .micro.tree_navigator import TreeNavigator
from .micro.section_extractor import SectionExtractor
from .micro.page_resolver import PageResolver
from .micro.relevance_scorer import RelevanceScorer

# Synthesis
from .synthesis.context_builder import ContextBuilder
from .synthesis.answer_synthesizer import AnswerSynthesizer
from .synthesis.citation_tracker import CitationTracker
from .synthesis.confidence_scorer import ConfidenceScorer

logger = logging.getLogger("code_intel.rag.pipeline")


class RAGPipeline:
    """
    Main RAG pipeline orchestrator.

    Coordinates all four steps:
    1. Ingestion (offline)
    2. Macro-retrieval (fast)
    3. Micro-navigation (agentic)
    4. Synthesis (heavy)
    """

    def __init__(
        self,
        workspace_root: str,
        config: Optional[RAGConfig] = None,
    ):
        """
        Initialize RAG pipeline.

        Args:
            workspace_root: Root directory of the workspace.
            config: RAG configuration.
        """
        self.config = config or get_rag_config()
        self.workspace_root = Path(workspace_root)

        # Storage directory
        store_dir = self.workspace_root / self.config.store.store_directory
        store_dir.mkdir(parents=True, exist_ok=True)
        self._store_dir = str(store_dir)

        # Initialize stores
        self.document_store = DocumentStore(
            storage_dir=self._store_dir,
            config=self.config.store,
        )
        self.toc_store = ToCStore(
            storage_dir=self._store_dir,
            config=self.config.store,
        )
        self.summary_index = SummaryIndex(
            dimension=self.config.embedding_dimension,
            storage_dir=self._store_dir,
            config=self.config.store,
        )
        self.section_store = SectionStore(
            storage_dir=self._store_dir,
            config=self.config.store,
        )

        # Initialize modules (lazy initialization for expensive components)
        self._processor: Optional[DocumentProcessor] = None
        self._query_analyzer: Optional[QueryAnalyzer] = None
        self._summary_searcher: Optional[SummarySearcher] = None
        self._keyword_filter: Optional[KeywordFilter] = None
        self._document_ranker: Optional[DocumentRanker] = None
        self._tree_navigator: Optional[TreeNavigator] = None
        self._section_extractor: Optional[SectionExtractor] = None
        self._page_resolver: Optional[PageResolver] = None
        self._relevance_scorer: Optional[RelevanceScorer] = None
        self._context_builder: Optional[ContextBuilder] = None
        self._answer_synthesizer: Optional[AnswerSynthesizer] = None
        self._citation_tracker: Optional[CitationTracker] = None
        self._confidence_scorer: Optional[ConfidenceScorer] = None

        self._initialized = False

    # =========================================================================
    # Initialization
    # =========================================================================

    def initialize(self) -> None:
        """
        Initialize all pipeline components.

        Call this once before using the pipeline.
        Loads persisted state from disk.
        """
        if self._initialized:
            return

        logger.info(f"Initializing RAG pipeline at {self._store_dir}")

        # Load persisted stores
        self.summary_index.load()
        self._keyword_filter_instance().save()  # Ensure file exists

        self._initialized = True
        logger.info(
            f"RAG pipeline ready: "
            f"{self.document_store.count()} docs, "
            f"{self.summary_index.count()} summaries, "
            f"{self.section_store.count()} sections"
        )

    # =========================================================================
    # Step 1: Ingestion
    # =========================================================================

    def ingest_directory(
        self,
        directory: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Ingest all documents from a directory.

        Args:
            directory: Directory to ingest. Defaults to workspace root.

        Returns:
            Ingestion statistics.
        """
        self._ensure_initialized()
        dir_path = directory or str(self.workspace_root)

        processor = self._processor_instance()

        logger.info(f"Starting ingestion of {dir_path}")
        t0 = time.time()

        result = processor.process_directory(dir_path)

        # Store ingested documents
        for doc in result.documents:
            # Store document
            self.document_store.add(doc)

            # Store ToC tree
            if doc.toc:
                self.toc_store.set(doc.id, doc.toc)

            # Store sections
            if doc.sections:
                self.section_store.add_sections(doc.sections)

            # Store summary + embedding
            if doc.summary:
                embedding = self._compute_embedding(doc.summary)
                self.summary_index.add(doc.id, embedding, doc.summary)
                self._keyword_filter_instance().add_document(
                    doc.id, doc.summary
                )

        # Persist everything
        self.summary_index.save()
        self._keyword_filter_instance().save()

        elapsed = (time.time() - t0) * 1000

        stats = {
            "documents_processed": result.documents_processed,
            "documents_skipped": result.documents_skipped,
            "documents_failed": result.documents_failed,
            "total_sections": sum(len(d.sections) for d in result.documents),
            "time_ms": elapsed,
        }

        logger.info(
            f"Ingestion complete: {stats['documents_processed']} docs "
            f"({stats['total_sections']} sections) in {elapsed:.0f}ms"
        )

        return stats

    def ingest_file(self, file_path: str) -> Dict[str, Any]:
        """
        Ingest a single file.

        Args:
            file_path: Path to the file.

        Returns:
            Ingestion result.
        """
        self._ensure_initialized()
        processor = self._processor_instance()

        doc = processor.process_file(file_path)
        if not doc:
            return {"status": "skipped", "file": file_path}

        self.document_store.add(doc)
        if doc.toc:
            self.toc_store.set(doc.id, doc.toc)
        if doc.sections:
            self.section_store.add_sections(doc.sections)
        if doc.summary:
            embedding = self._compute_embedding(doc.summary)
            self.summary_index.add(doc.id, embedding, doc.summary)
            self._keyword_filter_instance().add_document(doc.id, doc.summary)

        self.summary_index.save()
        self._keyword_filter_instance().save()

        return {
            "status": "ingested",
            "document_id": doc.id,
            "sections": len(doc.sections),
            "has_toc": doc.toc is not None,
            "has_summary": doc.summary is not None,
        }

    # =========================================================================
    # Steps 2-4: Query Pipeline
    # =========================================================================

    def query(self, query_text: str, **kwargs) -> RAGResult:
        """
        Execute the full RAG query pipeline.

        Args:
            query_text: User question.
            **kwargs: Override RAGQuery defaults.

        Returns:
            RAGResult with answer, citations, and pipeline metadata.
        """
        self._ensure_initialized()
        t_start = time.time()

        query = RAGQuery(text=query_text, **kwargs)

        # ── Step 2: Macro-Retrieval ──────────────────────────────────────
        try:
            macro_result = self._run_macro_retrieval(query)
        except Exception as e:
            logger.error(f"Macro-retrieval failed: {e}")
            return self._error_result(query, f"Macro-retrieval failed: {e}", t_start)

        if not macro_result.document_ids:
            return self._no_results_result(query, t_start)

        # ── Step 3: Micro-Navigation ─────────────────────────────────────
        try:
            micro_result, extraction_results = self._run_micro_navigation(
                query, macro_result
            )
        except Exception as e:
            logger.error(f"Micro-navigation failed: {e}")
            return self._error_result(query, f"Micro-navigation failed: {e}", t_start)

        if not extraction_results:
            return self._no_results_result(query, t_start)

        # ── Step 4: Heavy Synthesis ──────────────────────────────────────
        try:
            rag_result = self._run_synthesis(
                query, macro_result, micro_result,
                extraction_results, t_start
            )
        except Exception as e:
            logger.error(f"Synthesis failed: {e}")
            return self._error_result(query, f"Synthesis failed: {e}", t_start)

        return rag_result

    # =========================================================================
    # Internal: Pipeline Steps
    # =========================================================================

    def _run_macro_retrieval(self, query: RAGQuery) -> MacroResult:
        """Step 2: Macro-retrieval."""
        t0 = time.time()
        ranker = self._document_ranker_instance()
        result = ranker.rank(query)
        result.time_ms = (time.time() - t0) * 1000
        return result

    def _run_micro_navigation(
        self,
        query: RAGQuery,
        macro_result: MacroResult,
    ) -> tuple:
        """Step 3: Micro-navigation."""
        t0 = time.time()

        # Load ToC trees for selected documents
        toc_trees = {}
        for doc_id in macro_result.document_ids:
            tree = self.toc_store.get(doc_id)
            if tree:
                toc_trees[doc_id] = tree

        # Navigate trees
        navigator = self._tree_navigator_instance()
        nav_results = navigator.navigate(query, toc_trees)

        # Build doc_id → node_ids map
        doc_node_map = {}
        navigation_path = []
        sections_evaluated = 0

        for nav in nav_results:
            if nav.selected_node_ids:
                doc_node_map[nav.document_id] = nav.selected_node_ids
            for step in nav.steps:
                navigation_path.append(
                    f"{nav.document_id}:{step.node_title}"
                )
            sections_evaluated += len(nav.selected_node_ids)

        # Extract section content
        extractor = self._section_extractor_instance()
        extraction_results = extractor.extract_from_multiple_docs(
            doc_node_map=doc_node_map,
            toc_trees=toc_trees,
            total_token_budget=self.config.synthesis.max_context_tokens,
        )

        # Score relevance
        scorer = self._relevance_scorer_instance()
        all_references = []
        for result in extraction_results:
            scored = scorer.score_sections(
                query.text, result.sections
            )
            for ss in scored:
                ref = SectionReference(
                    section_id=ss.section.id,
                    document_id=ss.section.document_id,
                    document_title=ss.section.document_id,
                    section_title=ss.section.title,
                    breadcrumb=ss.section.breadcrumb,
                    relevance=ss.relevance,
                    relevance_score=ss.score,
                    content_snippet=ss.section.content[:200],
                )
                all_references.append(ref)

        elapsed = (time.time() - t0) * 1000

        micro_result = MicroResult(
            sections=all_references,
            navigation_path=navigation_path,
            documents_navigated=len(doc_node_map),
            sections_evaluated=sections_evaluated,
            time_ms=elapsed,
            routing_model=self.config.micro.routing_model,
        )

        return micro_result, extraction_results

    def _run_synthesis(
        self,
        query: RAGQuery,
        macro_result: MacroResult,
        micro_result: MicroResult,
        extraction_results: list,
        t_start: float,
    ) -> RAGResult:
        """Step 4: Synthesis."""
        t0 = time.time()

        # Build context
        builder = self._context_builder_instance()
        context = builder.build_context(extraction_results)

        # Synthesize answer
        synthesizer = self._answer_synthesizer_instance()
        synthesis_result = synthesizer.synthesize(query, context)

        # Track citations
        tracker = self._citation_tracker_instance()
        citations = tracker.track_citations(synthesis_result, context)

        # Score confidence
        scorer = self._confidence_scorer_instance()
        confidence = scorer.score(
            query, synthesis_result, context, citations
        )

        synthesis_time = (time.time() - t0) * 1000
        total_time = (time.time() - t_start) * 1000

        return RAGResult(
            answer=synthesis_result.answer_text,
            confidence=confidence.overall,
            citations=citations,
            sections_used=micro_result.sections,
            query=query.text,
            documents_searched=macro_result.total_candidates,
            documents_selected=len(macro_result.document_ids),
            sections_extracted=micro_result.sections_evaluated,
            macro_result=macro_result,
            micro_result=micro_result,
            macro_time_ms=macro_result.time_ms,
            micro_time_ms=micro_result.time_ms,
            synthesis_time_ms=synthesis_time,
            total_time_ms=total_time,
            routing_model=self.config.micro.routing_model,
            synthesis_model=self.config.synthesis.synthesis_model,
            input_tokens=synthesis_result.input_tokens,
            output_tokens=synthesis_result.output_tokens,
        )

    # =========================================================================
    # Error Results
    # =========================================================================

    def _error_result(
        self,
        query: RAGQuery,
        error_msg: str,
        t_start: float,
    ) -> RAGResult:
        """Build an error RAGResult."""
        return RAGResult(
            answer="",
            confidence=0.0,
            query=query.text,
            error=error_msg,
            total_time_ms=(time.time() - t_start) * 1000,
        )

    def _no_results_result(
        self,
        query: RAGQuery,
        t_start: float,
    ) -> RAGResult:
        """Build a no-results RAGResult."""
        return RAGResult(
            answer="No relevant documents or sections found for this query.",
            confidence=0.0,
            query=query.text,
            total_time_ms=(time.time() - t_start) * 1000,
        )

    # =========================================================================
    # Component Accessors (Lazy Initialization)
    # =========================================================================

    def _ensure_initialized(self) -> None:
        if not self._initialized:
            self.initialize()

    def _compute_embedding(self, summary) -> np.ndarray:
        """
        Compute embedding for a DocumentSummary.

        Uses the existing code_intel Embedder when available.
        Falls back to a zero vector when no API key is configured,
        allowing ingestion to proceed (search quality will be limited).
        """
        if summary.embedding is not None:
            vec = np.asarray(summary.embedding, dtype=np.float32)
            if vec.shape == (self.config.embedding_dimension,):
                return vec

        text = summary.to_embed_text()
        try:
            embedder = self._get_embedder()
            if embedder:
                vec = embedder.embed_query(text)
                if vec is not None:
                    return np.asarray(vec, dtype=np.float32)
        except Exception as e:
            logger.warning(f"Embedding generation failed: {e}")

        # Fallback: zero vector (search won't work but stores are populated)
        logger.debug("Using zero-vector fallback for summary embedding")
        return np.zeros(self.config.embedding_dimension, dtype=np.float32)

    def _get_embedder(self):
        """Lazy-load the embedding model."""
        if not hasattr(self, '_embedder_instance'):
            self._embedder_instance = None
            try:
                from ..indexer.embedder import Embedder
                self._embedder_instance = Embedder(
                    model=self.config.embedding_model,
                    api_key=self.config.embedding_api_key,
                )
            except (ImportError, Exception) as e:
                logger.info(f"Embedder not available: {e}")
        return self._embedder_instance

    def _processor_instance(self) -> DocumentProcessor:
        if self._processor is None:
            self._processor = DocumentProcessor(config=self.config)
        return self._processor

    def _query_analyzer_instance(self) -> QueryAnalyzer:
        if self._query_analyzer is None:
            self._query_analyzer = QueryAnalyzer(config=self.config)
        return self._query_analyzer

    def _summary_searcher_instance(self) -> SummarySearcher:
        if self._summary_searcher is None:
            self._summary_searcher = SummarySearcher(
                summary_index=self.summary_index,
                config=self.config,
            )
        return self._summary_searcher

    def _keyword_filter_instance(self) -> KeywordFilter:
        if self._keyword_filter is None:
            self._keyword_filter = KeywordFilter(
                storage_dir=self._store_dir,
                config=self.config,
            )
        return self._keyword_filter

    def _document_ranker_instance(self) -> DocumentRanker:
        if self._document_ranker is None:
            self._document_ranker = DocumentRanker(
                summary_searcher=self._summary_searcher_instance(),
                keyword_filter=self._keyword_filter_instance(),
                query_analyzer=self._query_analyzer_instance(),
                document_store=self.document_store,
                config=self.config,
            )
        return self._document_ranker

    def _tree_navigator_instance(self) -> TreeNavigator:
        if self._tree_navigator is None:
            self._tree_navigator = TreeNavigator(config=self.config)
        return self._tree_navigator

    def _section_extractor_instance(self) -> SectionExtractor:
        if self._section_extractor is None:
            self._section_extractor = SectionExtractor(
                section_store=self.section_store,
                document_store=self.document_store,
                config=self.config,
            )
        return self._section_extractor

    def _page_resolver_instance(self) -> PageResolver:
        if self._page_resolver is None:
            self._page_resolver = PageResolver(
                document_store=self.document_store,
                section_store=self.section_store,
            )
        return self._page_resolver

    def _relevance_scorer_instance(self) -> RelevanceScorer:
        if self._relevance_scorer is None:
            self._relevance_scorer = RelevanceScorer(config=self.config)
        return self._relevance_scorer

    def _context_builder_instance(self) -> ContextBuilder:
        if self._context_builder is None:
            self._context_builder = ContextBuilder(config=self.config)
        return self._context_builder

    def _answer_synthesizer_instance(self) -> AnswerSynthesizer:
        if self._answer_synthesizer is None:
            self._answer_synthesizer = AnswerSynthesizer(config=self.config)
        return self._answer_synthesizer

    def _citation_tracker_instance(self) -> CitationTracker:
        if self._citation_tracker is None:
            self._citation_tracker = CitationTracker(config=self.config)
        return self._citation_tracker

    def _confidence_scorer_instance(self) -> ConfidenceScorer:
        if self._confidence_scorer is None:
            self._confidence_scorer = ConfidenceScorer(config=self.config)
        return self._confidence_scorer

    # =========================================================================
    # Stats & Management
    # =========================================================================

    def get_stats(self) -> Dict[str, Any]:
        """Get pipeline statistics."""
        return {
            "documents": self.document_store.count(),
            "summaries": self.summary_index.count(),
            "sections": self.section_store.count(),
            "toc_trees": self.toc_store.count(),
            "keyword_terms": self._keyword_filter_instance().count(),
            "store_directory": self._store_dir,
        }

    def clear(self) -> None:
        """Clear all stored data."""
        self.document_store.clear()
        self.toc_store.clear()
        self.summary_index.clear()
        self.section_store.clear()
        self._keyword_filter_instance().clear()

        self.summary_index.save()
        self._keyword_filter_instance().save()
        logger.info("RAG pipeline data cleared")
