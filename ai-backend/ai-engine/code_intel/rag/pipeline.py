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
        self._relevance_scorer: Optional[RelevanceScorer] = None
        self._context_builder: Optional[ContextBuilder] = None
        self._answer_synthesizer: Optional[AnswerSynthesizer] = None
        self._citation_tracker: Optional[CitationTracker] = None
        self._confidence_scorer: Optional[ConfidenceScorer] = None

        self._initialized = False
        self._zero_vector_count = 0

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

        # Only create keyword index file if it doesn't already exist;
        # the KeywordFilter constructor already loads from disk if present
        kf = self._keyword_filter_instance()
        if kf.count() == 0:
            kw_path = Path(self._store_dir) / self.config.store.keyword_index_file
            if not kw_path.exists():
                kf.save()  # Create empty file for first time only

        self._initialized = True
        logger.info(
            f"RAG pipeline ready: "
            f"{self.document_store.count()} docs, "
            f"{self.summary_index.count()} summaries, "
            f"{self.section_store.count()} sections"
        )

    def _normalize_doc_paths(self, doc) -> None:
        """Rewrite a document's file_path to be relative to workspace root.

        This ensures stored metadata is portable and matches the relative
        paths used by the frontend / engine layer.
        """
        if not doc or not doc.metadata:
            return
        fp = str(doc.metadata.file_path).replace("\\", "/")
        root = str(self.workspace_root).replace("\\", "/")
        if not root.endswith("/"):
            root += "/"
        if fp.startswith(root):
            doc.metadata.file_path = fp[len(root):]

    # =========================================================================
    # Step 1: Ingestion
    # =========================================================================

    def ingest_directory(
        self,
        directory: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Ingest all documents from a directory.

        Also purges stale documents whose source files no longer exist on disk
        and deduplicates documents that were previously ingested.

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

        # Build set of freshly-ingested file paths for stale-detection later
        ingested_paths: set = set()

        # Store ingested documents
        for doc in result.documents:
            self._normalize_doc_paths(doc)
            file_path = doc.metadata.file_path if doc.metadata else None
            if file_path:
                ingested_paths.add(str(file_path))

            # Remove existing doc for this path to avoid duplicates
            if file_path:
                existing_id = self.document_store.get_by_path(str(file_path))
                if existing_id:
                    try:
                        self._remove_doc_by_id(existing_id)
                    except Exception as e:
                        logger.debug(f"Stale doc cleanup for {file_path}: {e}")

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

        # ── Purge stale documents for files that no longer exist ─────────
        stale_removed = 0
        try:
            all_metadata = self.document_store._load_metadata()
            stale_ids = []
            for doc_id, meta in all_metadata.items():
                fp = getattr(meta, 'file_path', None) or (meta.get('file_path') if isinstance(meta, dict) else None)
                if fp and str(fp) not in ingested_paths:
                    if not Path(str(fp)).exists():
                        stale_ids.append(doc_id)
            for doc_id in stale_ids:
                try:
                    self._remove_doc_by_id(doc_id)
                    stale_removed += 1
                except Exception as e:
                    logger.debug(f"Failed to purge stale doc {doc_id}: {e}")
        except Exception as e:
            logger.warning(f"Stale document purge failed: {e}")

        # Persist everything
        self.summary_index.save()
        self._keyword_filter_instance().save()

        elapsed = (time.time() - t0) * 1000

        stats = {
            "documents_processed": result.documents_processed,
            "documents_skipped": result.documents_skipped,
            "documents_failed": result.documents_failed,
            "documents_purged": stale_removed,
            "total_sections": sum(len(d.sections) for d in result.documents),
            "time_ms": elapsed,
        }

        logger.info(
            f"Ingestion complete: {stats['documents_processed']} docs "
            f"({stats['total_sections']} sections, {stale_removed} purged) "
            f"in {elapsed:.0f}ms"
        )

        return stats

    def ingest_file(self, file_path: str) -> Dict[str, Any]:
        """
        Ingest a single file.

        If the file was previously ingested, the old document and all
        associated data (sections, ToC, summary, keywords) are removed
        first to prevent duplicates.

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

        self._normalize_doc_paths(doc)

        # ── Remove stale data if the file was already ingested ───────────
        existing_id = self.document_store.get_by_path(file_path)
        if existing_id:
            try:
                self.remove_file(file_path)
                logger.debug(f"Replaced existing document {existing_id} for {file_path}")
            except Exception as e:
                logger.warning(f"Failed to remove old document for {file_path}: {e}")

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
    # Steps 2-3: Context Retrieval (no LLM synthesis)
    # =========================================================================

    def retrieve_context(
        self,
        query_text: str,
        max_tokens: int = 8000,
        **kwargs,
    ) -> Dict[str, Any]:
        """
        Retrieve relevant context using Steps 2+3 only (no heavy LLM call).

        This is the PRIMARY method for integration with the chat pipeline.
        It gives us the RAG pipeline's superior retrieval (macro-retrieval +
        micro-navigation) without the latency of a synthesis LLM call.

        Args:
            query_text: User question.
            max_tokens: Token budget for assembled context.
            **kwargs: Override RAGQuery defaults.

        Returns:
            Dict with:
                context_text: Assembled context string for the LLM prompt.
                sources: List of source sections with file/line/score.
                tokens_used: Estimated tokens in context.
                documents_searched: Total documents considered.
                documents_selected: Documents selected by macro-retrieval.
                sections_used: Number of sections in context.
                truncated: Whether context was truncated.
                timing: Sub-step timing breakdown.
                trace: Full pipeline trace for observability.
        """
        self._ensure_initialized()
        t_start = time.time()

        query = RAGQuery(text=query_text, max_tokens=max_tokens, **kwargs)

        # Check if we have any data
        if self.document_store.count() == 0:
            return {
                "context_text": "",
                "sources": [],
                "tokens_used": 0,
                "documents_searched": 0,
                "documents_selected": 0,
                "sections_used": 0,
                "truncated": False,
                "timing": {"total_ms": (time.time() - t_start) * 1000},
                "trace": [],
                "sufficiency": "EMPTY",
            }

        # ── Step 2: Macro-Retrieval ──────────────────────────────────────
        try:
            macro_result = self._run_macro_retrieval(query)
        except Exception as e:
            logger.error(f"Macro-retrieval failed: {e}")
            return {
                "context_text": "",
                "sources": [],
                "tokens_used": 0,
                "documents_searched": 0,
                "documents_selected": 0,
                "sections_used": 0,
                "truncated": False,
                "timing": {"total_ms": (time.time() - t_start) * 1000},
                "trace": [{"step": "macro", "error": str(e)}],
                "sufficiency": "INSUFFICIENT",
            }

        if not macro_result.document_ids:
            return {
                "context_text": "",
                "sources": [],
                "tokens_used": 0,
                "documents_searched": macro_result.total_candidates,
                "documents_selected": 0,
                "sections_used": 0,
                "truncated": False,
                "timing": {
                    "macro_ms": macro_result.time_ms,
                    "total_ms": (time.time() - t_start) * 1000,
                },
                "trace": [{"step": "macro", "result": "no_documents"}],
                "sufficiency": "INSUFFICIENT",
            }

        # ── Step 3: Micro-Navigation ─────────────────────────────────────
        try:
            micro_result, extraction_results = self._run_micro_navigation(
                query, macro_result
            )
        except Exception as e:
            logger.error(f"Micro-navigation failed: {e}")
            return {
                "context_text": "",
                "sources": [],
                "tokens_used": 0,
                "documents_searched": macro_result.total_candidates,
                "documents_selected": len(macro_result.document_ids),
                "sections_used": 0,
                "truncated": False,
                "timing": {
                    "macro_ms": macro_result.time_ms,
                    "total_ms": (time.time() - t_start) * 1000,
                },
                "trace": [{"step": "micro", "error": str(e)}],
                "sufficiency": "INSUFFICIENT",
            }

        if not extraction_results:
            return {
                "context_text": "",
                "sources": [],
                "tokens_used": 0,
                "documents_searched": macro_result.total_candidates,
                "documents_selected": len(macro_result.document_ids),
                "sections_used": 0,
                "truncated": False,
                "timing": {
                    "macro_ms": macro_result.time_ms,
                    "micro_ms": micro_result.time_ms,
                    "total_ms": (time.time() - t_start) * 1000,
                },
                "trace": [{"step": "micro", "result": "no_sections"}],
                "sufficiency": "INSUFFICIENT",
            }

        # ── Build context (reuse Step 4's ContextBuilder, no LLM) ────────
        try:
            builder = self._context_builder_instance()
            synth_ctx = builder.build_context(
                extraction_results, token_budget=max_tokens
            )
        except Exception as e:
            logger.error(f"Context building failed: {e}")
            return {
                "context_text": "",
                "sources": [],
                "tokens_used": 0,
                "documents_searched": macro_result.total_candidates,
                "documents_selected": len(macro_result.document_ids),
                "sections_used": len(micro_result.sections),
                "truncated": False,
                "timing": {
                    "macro_ms": macro_result.time_ms,
                    "micro_ms": micro_result.time_ms,
                    "total_ms": (time.time() - t_start) * 1000,
                },
                "trace": [{"step": "build", "error": str(e)}],
                "sufficiency": "INSUFFICIENT",
            }

        total_ms = (time.time() - t_start) * 1000

        # Build sources list from context sections (for ContextResponse)
        sources = []
        for cs in synth_ctx.sections:
            sources.append({
                "file": cs.file_path or cs.document_title,
                "start_line": cs.start_line,
                "end_line": cs.end_line,
                "symbol": cs.section_title,
                "score": 0.0,
                "document_id": cs.document_id,
                "citation_id": cs.citation_id,
                "breadcrumb": cs.breadcrumb,
            })

        # Map relevance scores from micro-navigation
        score_map = {
            ref.section_id: ref.relevance_score
            for ref in micro_result.sections
            if ref.relevance_score > 0
        }
        for src in sources:
            sid = src.get("document_id", "")
            if sid in score_map:
                src["score"] = score_map[sid]

        # Build trace
        trace = []
        for ref in micro_result.sections:
            trace.append({
                "reason": "included",
                "file": ref.document_title,
                "symbol": ref.section_title,
                "score": ref.relevance_score,
                "chunk_id": ref.section_id,
                "breadcrumb": ref.breadcrumb,
            })

        # Determine sufficiency
        if synth_ctx.section_count == 0:
            sufficiency = "EMPTY"
        elif synth_ctx.truncated:
            sufficiency = "PARTIAL"
        else:
            sufficiency = "SUFFICIENT"

        logger.info(
            f"RAG context retrieved: {synth_ctx.section_count} sections "
            f"from {synth_ctx.document_count} docs in {total_ms:.0f}ms "
            f"({synth_ctx.total_tokens} tokens, {sufficiency})"
        )

        return {
            "context_text": synth_ctx.context_text,
            "sources": sources,
            "tokens_used": synth_ctx.total_tokens,
            "documents_searched": macro_result.total_candidates,
            "documents_selected": len(macro_result.document_ids),
            "sections_used": synth_ctx.section_count,
            "truncated": synth_ctx.truncated,
            "timing": {
                "macro_ms": macro_result.time_ms,
                "micro_ms": micro_result.time_ms,
                "build_ms": total_ms - macro_result.time_ms - micro_result.time_ms,
                "total_ms": total_ms,
            },
            "trace": trace,
            "sufficiency": sufficiency,
        }

    # =========================================================================
    # Steps 2-4: Full Query Pipeline (with synthesis)
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
                # Resolve actual document title from store
                doc_title = ss.section.document_id
                doc_meta = self.document_store.get_metadata(ss.section.document_id)
                if doc_meta:
                    doc_title = doc_meta.title or doc_meta.file_name

                ref = SectionReference(
                    section_id=ss.section.id,
                    document_id=ss.section.document_id,
                    document_title=doc_title,
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

        # Fallback: zero vector — vector search is effectively disabled
        self._zero_vector_count += 1
        if self._zero_vector_count == 1:
            logger.warning(
                "No embedding API available — using zero-vector fallback. "
                "Vector search in macro-retrieval will not return results. "
                "Set GEMINI_API_KEY to enable real embeddings."
            )
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

    def _remove_doc_by_id(self, doc_id: str) -> int:
        """Remove a document and all its associated data by ID.
        
        Returns:
            Number of sections removed.
        """
        sections_removed = self.section_store.remove_by_document(doc_id)
        self.toc_store.remove(doc_id)
        self.summary_index.remove(doc_id)
        self._keyword_filter_instance().remove_document(doc_id)
        self.document_store.remove(doc_id)
        return sections_removed

    def remove_file(self, file_path: str) -> Dict[str, Any]:
        """
        Remove a file's data from all RAG stores.

        Cleans up document, sections, ToC tree, summary vector,
        and keyword index entry for the given file path.

        Args:
            file_path: Absolute or relative file path.

        Returns:
            Removal result with counts.
        """
        self._ensure_initialized()

        doc_id = self.document_store.get_by_path(file_path)
        if not doc_id:
            return {"status": "not_found", "file": file_path}

        sections_removed = self._remove_doc_by_id(doc_id)

        # Persist
        self.summary_index.save()
        self._keyword_filter_instance().save()

        logger.info(
            f"Removed file from RAG: {file_path} "
            f"(doc={doc_id}, {sections_removed} sections)"
        )
        return {
            "status": "removed",
            "file": file_path,
            "document_id": doc_id,
            "sections_removed": sections_removed,
        }
