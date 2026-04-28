"""
RAG Pipeline — Main orchestrator connecting all 4 steps.

Step 1: Dual-Ingestion (offline, populates stores)
Step 2: Macro-Retrieval (fast vector+keyword → top 3-5 docs)
Step 3: Micro-Navigation (agentic ToC traversal → precise sections)
Step 4: Heavy Synthesis (heavy model → cited answer)

The pipeline is the primary public interface for the RAG subsystem.
"""

from __future__ import annotations

import hashlib
import logging
import threading
import time
import uuid
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional

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
from .micro.section_reranker import SectionReranker

# Synthesis
from .synthesis.context_builder import ContextBuilder
from .synthesis.answer_synthesizer import AnswerSynthesizer
from .synthesis.citation_tracker import CitationTracker
from .synthesis.confidence_scorer import ConfidenceScorer

# Cross-pipeline retrieval helpers (HyDE rewrite + MMR diversity)
from ..retrieval.query_rewriter import QueryRewriter, RewrittenQuery
from ..retrieval.fusion import mmr as _mmr_select

from ..gitignore_guard import ensure_gitignore

# Observability — structured spans replace ad-hoc timing log strings.
from .observability import Tracer, NULL_TRACER

logger = logging.getLogger("code_intel.rag.pipeline")


@dataclass
class IngestJob:
    """
    Tracks an async ingest_directory call.

    Created by ingest_directory_async() and updated as the worker thread
    progresses. Safe to expose verbatim through the API.
    """
    job_id: str
    directory: str
    status: str  # "queued", "running", "completed", "failed", "cancelled"
    started_at: float
    finished_at: Optional[float] = None
    stats: Optional[Dict[str, Any]] = None
    error: Optional[str] = None
    force_reindex: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "job_id": self.job_id,
            "directory": self.directory,
            "status": self.status,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "elapsed_ms": (
                ((self.finished_at or time.time()) - self.started_at) * 1000.0
            ),
            "stats": self.stats,
            "error": self.error,
            "force_reindex": self.force_reindex,
        }


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

        # Ensure AI index dirs are gitignored in this workspace
        ensure_gitignore(self.workspace_root)

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
        self._query_rewriter: Optional[QueryRewriter] = None
        self._summary_searcher: Optional[SummarySearcher] = None
        self._keyword_filter: Optional[KeywordFilter] = None
        self._document_ranker: Optional[DocumentRanker] = None
        self._tree_navigator: Optional[TreeNavigator] = None
        self._section_extractor: Optional[SectionExtractor] = None
        self._relevance_scorer: Optional[RelevanceScorer] = None
        self._section_reranker: Optional[SectionReranker] = None
        self._context_builder: Optional[ContextBuilder] = None
        self._answer_synthesizer: Optional[AnswerSynthesizer] = None
        self._citation_tracker: Optional[CitationTracker] = None
        self._confidence_scorer: Optional[ConfidenceScorer] = None

        self._initialized = False
        self._zero_vector_count = 0

        # Query result cache: identical query text within TTL returns the
        # cached RAGResult (skips macro+micro+synthesis). Invalidated on
        # any ingest/remove/clear so callers never see stale answers.
        self._query_cache: "OrderedDict[str, Any]" = OrderedDict()
        self._query_cache_lock = threading.Lock()
        self._cache_hits = 0
        self._cache_misses = 0

        # Async ingestion. `_ingest_lock` enforces single-flight: a second
        # async ingest blocks until the first completes (avoids two threads
        # mutating the same stores). `_jobs` is a bounded LRU of recent
        # IngestJob records keyed by job_id.
        self._ingest_lock = threading.Lock()
        self._jobs_lock = threading.Lock()
        self._jobs: "OrderedDict[str, IngestJob]" = OrderedDict()
        self._jobs_max_entries = 64

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
        *,
        force_reindex: bool = False,
        trace: bool = True,
    ) -> Dict[str, Any]:
        """
        Ingest all documents from a directory.

        Also purges stale documents whose source files no longer exist on disk
        and deduplicates documents that were previously ingested.

        Args:
            directory: Directory to ingest. Defaults to workspace root.
            force_reindex: When True, re-process every file even if the
                content hash matches an existing record. Use after upgrading
                the embedding model or the summary prompt — both invalidate
                stored vectors/summaries despite the content being identical.
            trace: Emit a structured ingestion span tree. Default True.

        Returns:
            Ingestion statistics. Includes `trace` when tracing is enabled.
        """
        self._ensure_initialized()
        dir_path = directory or str(self.workspace_root)
        tracer: Tracer = (
            Tracer.create(enabled=True) if trace else NULL_TRACER
        )

        with tracer.span(
            "rag.ingest_directory",
            attrs={"directory": dir_path, "force_reindex": force_reindex},
        ) as ingest_span:
            stats = self._ingest_directory_inner(
                dir_path, force_reindex=force_reindex, tracer=tracer
            )
            ingest_span.set_attribute(
                "documents_processed", stats.get("documents_processed", 0)
            )
            ingest_span.set_attribute(
                "documents_unchanged", stats.get("documents_unchanged", 0)
            )
            ingest_span.set_attribute(
                "documents_purged", stats.get("documents_purged", 0)
            )

        if trace:
            stats["trace"] = tracer.to_dict()
        tracer.emit_log(logger)
        return stats

    def _ingest_directory_inner(
        self,
        dir_path: str,
        *,
        force_reindex: bool,
        tracer: Tracer,
    ) -> Dict[str, Any]:
        """Private body of ingest_directory. Tracer is required."""
        processor = self._processor_instance()
        logger.info(f"Starting ingestion of {dir_path}")
        t0 = time.time()

        # Incremental indexing: collect content hashes already in the store so
        # the processor can skip re-extracting/re-embedding files that haven't
        # changed. The summary LLM call is the dominant cost on re-ingest;
        # skipping it makes the steady-state re-ingest near-instant.
        already_indexed: set = set()
        if not force_reindex:
            try:
                existing_meta = self.document_store.get_all_metadata()
                already_indexed = {
                    m.content_hash for m in existing_meta.values() if m.content_hash
                }
            except Exception as e:
                logger.debug(f"Could not collect existing hashes: {e}")
                already_indexed = set()

        with tracer.span(
            "rag.ingest.process",
            attrs={"already_indexed": len(already_indexed)},
        ) as proc_span:
            result = processor.process_directory(
                dir_path,
                already_indexed=already_indexed,
            )
            proc_span.set_attribute("documents_processed", result.documents_processed)
            proc_span.set_attribute("documents_unchanged", result.documents_unchanged)
            proc_span.set_attribute("documents_failed", result.documents_failed)

        # Build set of freshly-ingested file paths for stale-detection later
        ingested_paths: set = set()

        # Mark the unchanged-but-still-present files so the stale-purge below
        # doesn't drop them. They're not in `result.documents`, but they're
        # still on disk and still in our store; they should remain.
        for p in result.unchanged_paths:
            ingested_paths.add(str(p))

        # First pass: store docs/ToC/sections, defer summary embedding so
        # we can batch all summary embedding calls into a single round-trip
        # (Gemini Embedder.embed_texts batches internally — 100 docs goes
        # from 100 sequential API calls to 1-2 batch calls).
        docs_with_summary: List = []  # (doc_id, summary) pairs

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

            # Defer summary embedding for the batch pass below.
            if doc.summary:
                docs_with_summary.append((doc.id, doc.summary))

        # Batch-embed all summaries in one round-trip.
        if docs_with_summary:
            with tracer.span(
                "rag.ingest.embed_batch",
                attrs={"count": len(docs_with_summary)},
            ):
                summaries = [s for _, s in docs_with_summary]
                embeddings = self._compute_embeddings_batch(summaries)
                for (doc_id, summary), embedding in zip(docs_with_summary, embeddings):
                    self.summary_index.add(doc_id, embedding, summary)
                    self._keyword_filter_instance().add_document(doc_id, summary)

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

        # Document set changed — drop any cached query results.
        self._invalidate_query_cache("ingest_directory")

        elapsed = (time.time() - t0) * 1000

        stats = {
            "documents_processed": result.documents_processed,
            "documents_unchanged": result.documents_unchanged,
            "documents_skipped": result.documents_skipped,
            "documents_failed": result.documents_failed,
            "documents_purged": stale_removed,
            "total_sections": sum(len(d.sections) for d in result.documents),
            "time_ms": elapsed,
        }

        logger.info(
            f"Ingestion complete: {stats['documents_processed']} docs "
            f"({stats['total_sections']} sections, "
            f"{result.documents_unchanged} unchanged, "
            f"{stale_removed} purged) "
            f"in {elapsed:.0f}ms"
        )

        return stats

    def ingest_file(
        self,
        file_path: str,
        *,
        force_reindex: bool = False,
    ) -> Dict[str, Any]:
        """
        Ingest a single file.

        If the file was previously ingested, the old document and all
        associated data (sections, ToC, summary, keywords) are removed
        first to prevent duplicates.

        Args:
            file_path: Path to the file.
            force_reindex: Re-process even if the content hash matches the
                existing record. Default False — unchanged files are a no-op.

        Returns:
            Ingestion result.
        """
        self._ensure_initialized()
        processor = self._processor_instance()

        # Fast path: if the file is already in the store and its content hash
        # matches what's on disk, there's nothing to do. We don't even need to
        # parse the file — DocumentLoader hashes during read, but we can check
        # the hash before paying for ToC/Summary. This makes per-file
        # invalidation (e.g. on file save) free when the save was a no-op.
        if not force_reindex:
            existing_id = self.document_store.get_by_path(file_path)
            if existing_id:
                existing_meta = self.document_store.get_metadata(existing_id)
                if existing_meta and existing_meta.content_hash:
                    try:
                        from .ingestion.content_hasher import ContentHasher
                        from pathlib import Path as _P
                        p = _P(file_path)
                        if p.exists():
                            text = p.read_text(encoding="utf-8", errors="replace")
                            current_hash = ContentHasher(
                                self.config.ingestion.hash_algorithm
                            ).hash_content(text)
                            if current_hash == existing_meta.content_hash:
                                return {
                                    "status": "unchanged",
                                    "file": file_path,
                                    "document_id": existing_id,
                                }
                    except Exception as e:
                        logger.debug(f"Hash precheck failed for {file_path}: {e}")

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

        # Document set changed — drop any cached query results.
        self._invalidate_query_cache("ingest_file")

        return {
            "status": "ingested",
            "document_id": doc.id,
            "sections": len(doc.sections),
            "has_toc": doc.toc is not None,
            "has_summary": doc.summary is not None,
        }

    # =========================================================================
    # Async Ingestion (job API)
    # =========================================================================

    def ingest_directory_async(
        self,
        directory: Optional[str] = None,
        *,
        force_reindex: bool = False,
    ) -> str:
        """
        Kick off ingest_directory on a background thread.

        Returns immediately with a job_id. Poll get_ingest_job(job_id) for
        status. Single-flight: a second call queues behind the first via
        `_ingest_lock` (the worker acquires the lock — `running` only flips
        from `queued` once the lock is held).

        Args:
            directory: Directory to ingest. Defaults to workspace root.
            force_reindex: Skip the content-hash incremental optimisation.

        Returns:
            job_id (uuid4 hex) usable with get_ingest_job().
        """
        self._ensure_initialized()
        target_dir = directory or str(self.workspace_root)
        job_id = uuid.uuid4().hex
        job = IngestJob(
            job_id=job_id,
            directory=target_dir,
            status="queued",
            started_at=time.time(),
            force_reindex=force_reindex,
        )

        with self._jobs_lock:
            self._jobs[job_id] = job
            self._jobs.move_to_end(job_id)
            while len(self._jobs) > self._jobs_max_entries:
                self._jobs.popitem(last=False)

        def _run():
            # Single-flight gate. Acquired here so `queued`/`running` is
            # observable from outside before the lock blocks (helpful when
            # ingests serialize behind a slow earlier run).
            with self._ingest_lock:
                with self._jobs_lock:
                    job.status = "running"
                try:
                    stats = self.ingest_directory(
                        target_dir, force_reindex=force_reindex
                    )
                    with self._jobs_lock:
                        job.stats = stats
                        job.status = "completed"
                        job.finished_at = time.time()
                except Exception as e:
                    logger.exception(
                        f"Async ingestion failed for job {job_id}"
                    )
                    with self._jobs_lock:
                        job.error = f"{type(e).__name__}: {e}"
                        job.status = "failed"
                        job.finished_at = time.time()

        thread = threading.Thread(
            target=_run,
            daemon=True,
            name=f"rag-ingest-{job_id[:8]}",
        )
        thread.start()
        return job_id

    def get_ingest_job(self, job_id: str) -> Optional[Dict[str, Any]]:
        """Return a serialisable snapshot of the named job, or None."""
        with self._jobs_lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            return job.to_dict()

    def list_ingest_jobs(
        self, *, limit: int = 20
    ) -> List[Dict[str, Any]]:
        """Return up to `limit` most-recent jobs (newest last)."""
        with self._jobs_lock:
            jobs = list(self._jobs.values())[-limit:]
            return [j.to_dict() for j in jobs]

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
            **kwargs: Override RAGQuery defaults. `trace=False` disables
                tracing for this call (defaults to True — every query
                gets a structured span tree in result.trace).

        Returns:
            RAGResult with answer, citations, and pipeline metadata.
        """
        self._ensure_initialized()
        t_start = time.time()

        # Tracing is opt-out per call so callers can keep a low-overhead path
        # for hot loops, but the default is on — there's no point shipping
        # observability if it's never enabled.
        trace_enabled = bool(kwargs.pop("trace", True))
        tracer: Tracer = (
            Tracer.create(enabled=True) if trace_enabled else NULL_TRACER
        )

        query = RAGQuery(text=query_text, **kwargs)

        with tracer.span(
            "rag.query",
            attrs={
                "query_len": len(query_text),
                "max_documents": query.max_documents,
                "max_sections": query.max_sections,
            },
        ) as root_span:

            # ── Cache lookup (skip Steps 2-4 entirely on hit) ────────────
            cache_key = self._cache_key_for(query_text, kwargs)
            with tracer.span("rag.cache.lookup") as cache_span:
                cached = self._cache_lookup(cache_key)
                cache_span.set_attribute("hit", cached is not None)
            if cached is not None:
                root_span.set_attribute("from_cache", True)
                tracer.emit_log(logger)
                # Surface the trace on the cached object too — callers may
                # want to know "this came from the cache" without inspecting
                # confidence scores or model names.
                if trace_enabled:
                    cached.trace = tracer.to_dict()
                return cached

            # ── Step 2: Macro-Retrieval ──────────────────────────────────
            try:
                with tracer.span("rag.macro") as macro_span:
                    macro_result = self._run_macro_retrieval(query)
                    macro_span.set_attribute(
                        "documents_selected", len(macro_result.document_ids)
                    )
                    macro_span.set_attribute(
                        "documents_searched", macro_result.total_candidates
                    )
            except Exception as e:
                logger.error(f"Macro-retrieval failed: {e}")
                tracer.emit_log(logger, level=logging.ERROR)
                return self._error_result(
                    query, f"Macro-retrieval failed: {e}", t_start, tracer
                )

            if not macro_result.document_ids:
                tracer.emit_log(logger)
                return self._no_results_result(query, t_start, tracer)

            # ── Step 3: Micro-Navigation ─────────────────────────────────
            try:
                with tracer.span("rag.micro") as micro_span:
                    micro_result, extraction_results = self._run_micro_navigation(
                        query, macro_result
                    )
                    micro_span.set_attribute(
                        "sections", len(micro_result.sections)
                    )
                    micro_span.set_attribute(
                        "sections_evaluated", micro_result.sections_evaluated
                    )
            except Exception as e:
                logger.error(f"Micro-navigation failed: {e}")
                tracer.emit_log(logger, level=logging.ERROR)
                return self._error_result(
                    query, f"Micro-navigation failed: {e}", t_start, tracer
                )

            if not extraction_results:
                tracer.emit_log(logger)
                return self._no_results_result(query, t_start, tracer)

            # ── Step 4: Heavy Synthesis ──────────────────────────────────
            try:
                with tracer.span("rag.synthesis") as synth_span:
                    rag_result = self._run_synthesis(
                        query, macro_result, micro_result,
                        extraction_results, t_start
                    )
                    synth_span.set_attribute("model", rag_result.synthesis_model)
                    synth_span.set_attribute("input_tokens", rag_result.input_tokens)
                    synth_span.set_attribute("output_tokens", rag_result.output_tokens)
                    synth_span.set_attribute("citations", len(rag_result.citations))
                    synth_span.set_attribute("confidence", rag_result.confidence)
            except Exception as e:
                logger.error(f"Synthesis failed: {e}")
                tracer.emit_log(logger, level=logging.ERROR)
                return self._error_result(
                    query, f"Synthesis failed: {e}", t_start, tracer
                )

            # Only cache real answers, not error/no-results results.
            if rag_result.answer and not getattr(rag_result, "error", None):
                self._cache_store(cache_key, rag_result)

        # Attach the assembled trace to the result and emit a single
        # structured log line. Replaces the per-step `logger.info` strings.
        if trace_enabled:
            rag_result.trace = tracer.to_dict()
        tracer.emit_log(logger)
        return rag_result

    # =========================================================================
    # Streaming Query (SSE)
    # =========================================================================

    def query_stream(
        self,
        query_text: str,
        **kwargs,
    ) -> Iterator[Dict[str, Any]]:
        """
        Run the full pipeline and stream typed events back to the caller.

        Event types:
            "start"          — pipeline begins, includes query text
            "macro"          — macro-retrieval done, doc IDs + scores
            "micro"          — micro-navigation done, section count
            "context"        — synthesis context built, token estimate
            "answer_delta"   — partial token chunk from synthesis (repeated)
            "complete"       — final answer + full RAGResult dict
            "error"          — terminal: pipeline aborted

        Cache hits short-circuit to a single "complete" event. Errors are
        always terminal; once "error" or "complete" fires, no further
        events are produced.
        """
        self._ensure_initialized()
        t_start = time.time()
        # `trace` isn't a RAGQuery field; the streaming entry point already
        # emits step events (macro/micro/context/answer_delta) which IS the
        # trace, so we just discard the flag here.
        kwargs.pop("trace", None)
        query = RAGQuery(text=query_text, **kwargs)

        yield {"type": "start", "query": query_text}

        # Cache lookup. Identical-query short-circuit yields a single
        # "complete" so streaming clients have a uniform finish event.
        cache_key = self._cache_key_for(query_text, kwargs)
        cached = self._cache_lookup(cache_key)
        if cached is not None:
            yield {
                "type": "answer_delta",
                "text": cached.answer,
                "from_cache": True,
            }
            yield {
                "type": "complete",
                "result": cached.to_dict(),
                "from_cache": True,
            }
            return

        # ── Step 2: macro ────────────────────────────────────────────────
        try:
            macro_result = self._run_macro_retrieval(query)
        except Exception as e:
            logger.error(f"Streaming macro failed: {e}")
            yield {"type": "error", "error": f"macro: {e}"}
            return
        yield {
            "type": "macro",
            "documents_selected": len(macro_result.document_ids),
            "documents_searched": macro_result.total_candidates,
            "time_ms": macro_result.time_ms,
        }
        if not macro_result.document_ids:
            yield {
                "type": "complete",
                "result": self._no_results_result(query, t_start).to_dict(),
            }
            return

        # ── Step 3: micro ────────────────────────────────────────────────
        try:
            micro_result, extraction_results = self._run_micro_navigation(
                query, macro_result
            )
        except Exception as e:
            logger.error(f"Streaming micro failed: {e}")
            yield {"type": "error", "error": f"micro: {e}"}
            return
        yield {
            "type": "micro",
            "sections": len(micro_result.sections),
            "time_ms": micro_result.time_ms,
        }
        if not extraction_results:
            yield {
                "type": "complete",
                "result": self._no_results_result(query, t_start).to_dict(),
            }
            return

        # ── Step 4: context build + streaming synthesis ──────────────────
        try:
            builder = self._context_builder_instance()
            context = builder.build_context(extraction_results)
        except Exception as e:
            logger.error(f"Streaming context build failed: {e}")
            yield {"type": "error", "error": f"context: {e}"}
            return
        yield {
            "type": "context",
            "tokens": context.total_tokens,
            "section_count": context.section_count,
            "truncated": context.truncated,
        }

        synthesizer = self._answer_synthesizer_instance()
        synth_t0 = time.time()
        full_answer = ""
        synth_meta: Optional[Dict[str, Any]] = None
        for ev in synthesizer.synthesize_stream(query, context):
            etype = ev.get("type")
            if etype == "delta":
                full_answer += ev.get("text", "")
                yield {"type": "answer_delta", "text": ev["text"]}
            elif etype == "complete":
                synth_meta = ev
                full_answer = ev.get("answer", full_answer)
            elif etype == "error":
                yield {"type": "error", "error": ev.get("error", "synthesis failed")}
                return

        if synth_meta is None:
            yield {"type": "error", "error": "synthesis produced no output"}
            return

        # Track citations + confidence on the assembled answer using the
        # same components the non-streaming path uses, so RAGResult is
        # identical regardless of which entry point was used.
        synthesis_time = (time.time() - synth_t0) * 1000.0
        try:
            from .synthesis.answer_synthesizer import SynthesisResult
            synth_result = SynthesisResult(
                answer_text=full_answer,
                raw_citations=synth_meta.get("raw_citations", []),
                model_used=synth_meta.get("model_used", ""),
                input_tokens=synth_meta.get("input_tokens", 0),
                output_tokens=synth_meta.get("output_tokens", 0),
                time_ms=synthesis_time,
            )
            tracker = self._citation_tracker_instance()
            citations = tracker.track_citations(synth_result, context)
            scorer = self._confidence_scorer_instance()
            confidence = scorer.score(query, synth_result, context, citations)
        except Exception as e:
            logger.debug(f"Citation/confidence step failed in stream: {e}")
            citations = []
            confidence = type("Conf", (), {"overall": 0.5})()

        total_time = (time.time() - t_start) * 1000.0

        rag_result = RAGResult(
            answer=full_answer,
            confidence=getattr(confidence, "overall", 0.5),
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
            input_tokens=synth_meta.get("input_tokens", 0),
            output_tokens=synth_meta.get("output_tokens", 0),
        )

        # Persist to cache so a follow-up non-streaming query hits warm.
        if rag_result.answer:
            self._cache_store(cache_key, rag_result)

        yield {
            "type": "complete",
            "result": rag_result.to_dict(),
        }

    # =========================================================================
    # Query Result Cache
    # =========================================================================

    def _cache_key_for(
        self,
        query_text: str,
        kwargs: Dict[str, Any],
    ) -> str:
        """
        Stable key including the kwargs that materially change the result
        (max_documents, max_sections, etc.) so callers asking the same
        question with different budgets don't collide.
        """
        relevant = {
            k: kwargs[k] for k in (
                "max_documents", "max_sections", "max_tokens",
                "require_citations", "document_ids", "tags",
            ) if k in kwargs
        }
        payload = f"{query_text.strip().lower()}|{repr(sorted(relevant.items()))}"
        return hashlib.sha1(payload.encode("utf-8")).hexdigest()

    def _cache_lookup(self, key: str) -> Optional[RAGResult]:
        """Return cached RAGResult if present and within TTL."""
        cache_cfg = getattr(self.config, "cache", None)
        if not cache_cfg or not cache_cfg.enable_query_cache:
            return None

        with self._query_cache_lock:
            entry = self._query_cache.get(key)
            if entry is None:
                self._cache_misses += 1
                return None
            if time.time() - entry["ts"] > cache_cfg.ttl_seconds:
                self._query_cache.pop(key, None)
                self._cache_misses += 1
                return None
            # LRU bump
            self._query_cache.move_to_end(key)
            self._cache_hits += 1
            return entry["result"]

    def _cache_store(self, key: str, result: RAGResult) -> None:
        """Store a RAGResult, evicting the oldest entry past max_entries."""
        cache_cfg = getattr(self.config, "cache", None)
        if not cache_cfg or not cache_cfg.enable_query_cache:
            return

        with self._query_cache_lock:
            self._query_cache[key] = {"result": result, "ts": time.time()}
            self._query_cache.move_to_end(key)
            while len(self._query_cache) > cache_cfg.max_entries:
                self._query_cache.popitem(last=False)

    def _invalidate_query_cache(self, reason: str = "") -> None:
        """Drop all cached query results (called on ingest/remove/clear)."""
        with self._query_cache_lock:
            n = len(self._query_cache)
            if n:
                self._query_cache.clear()
                logger.debug(f"Query cache invalidated ({n} entries) — {reason}")

    # =========================================================================
    # Internal: Pipeline Steps
    # =========================================================================

    def _run_macro_retrieval(self, query: RAGQuery) -> MacroResult:
        """Step 2: Macro-retrieval.

        Optionally runs the user query through the HyDE rewriter first. The
        rewriter produces a hypothetical code snippet which we feed to the
        embedder in place of the raw question; BM25 keeps the original text
        so we don't pollute keyword stats with LLM-invented identifiers.
        Falls back transparently when there's no API key, the rewriter
        errors, or the feature is disabled in config.
        """
        t0 = time.time()
        ranker = self._document_ranker_instance()

        if not getattr(self.config.macro, "enable_query_rewrite", False):
            result = ranker.rank(query)
            result.time_ms = (time.time() - t0) * 1000
            return result

        # Best-effort rewrite. Any failure → original query path.
        embedding_text: Optional[str] = None
        try:
            rewriter = self._query_rewriter_instance()
            rewritten: RewrittenQuery = rewriter.rewrite(
                query.text,
                conversation_history=None,
                enable_hyde=getattr(self.config.macro, "enable_hyde", True),
            )
            if rewritten.used_hyde and rewritten.hyde_document:
                # Embed HyDE doc + rewritten question so the vector still has
                # the question's intent anchored alongside the synthetic code.
                embedding_text = f"{rewritten.rewritten}\n\n{rewritten.hyde_document}"
        except Exception as e:
            logger.debug(f"Query rewrite failed, using original: {e}")

        if embedding_text is None:
            result = ranker.rank(query)
            result.time_ms = (time.time() - t0) * 1000
            return result

        # Pre-analyze the original query but inject the HyDE text as the
        # embedding source, then ask the ranker to use that analyzed query.
        try:
            analyzer = self._query_analyzer_instance()
            analyzed = analyzer.analyze(
                query.text,
                generate_embedding=True,
                embedding_text=embedding_text,
            )
            result = ranker.rank_with_analyzed(analyzed, query)
        except Exception as e:
            logger.debug(f"HyDE-augmented analyze failed, falling back: {e}")
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

        # Score relevance, then optionally rerank for precision, then
        # diversify via MMR. The flat list preserves the (extraction_index,
        # scored_section) mapping so we can reorder/filter the underlying
        # extraction_results in-place after diversification — keeping
        # ContextBuilder's downstream view aligned.
        scorer = self._relevance_scorer_instance()
        flat: List[tuple] = []
        for ei, result in enumerate(extraction_results):
            scored = scorer.score_sections(query.text, result.sections)
            for ss in scored:
                flat.append((ei, ss))

        # Precision pass: a finer-grained rerank over the top candidates.
        # Runs after scoring (so we don't waste it on obvious junk) and
        # before MMR (so MMR diversifies the genuinely-best sections, not
        # the merely-keyword-matching ones).
        if (
            getattr(self.config.micro, "enable_section_rerank", False)
            and len(flat) > 1
        ):
            try:
                reranker = self._section_reranker_instance()
                # Sort by current score so reranker sees the top-K first;
                # _section_rerank_top_k controls how many actually get
                # reranked (the tail is left in original order).
                flat.sort(key=lambda t: t[1].score, reverse=True)
                scored_only = [ss for _, ss in flat]
                reranked = reranker.rerank(query.text, scored_only)
                # Restore (ei, ss) tuples preserving the new order.
                ss_to_ei = {id(ss): ei for ei, ss in flat}
                flat = [(ss_to_ei[id(ss)], ss) for ss in reranked]
            except Exception as e:
                logger.debug(f"Section rerank failed, keeping original order: {e}")

        if (
            getattr(self.config.macro, "enable_section_mmr", False)
            and len(flat) > 1
        ):
            flat = self._apply_section_mmr(flat)

        # Rebuild each ExtractionResult.sections in MMR (or score) order so
        # ContextBuilder sees the diversified set. Sections dropped by the
        # diversity cap are removed from the extraction altogether.
        per_ext: Dict[int, List[Any]] = {ei: [] for ei in range(len(extraction_results))}
        for ei, ss in flat:
            per_ext[ei].append(ss.section)
        for ei, sections in per_ext.items():
            extraction_results[ei].sections = sections

        all_references: List[SectionReference] = []
        for ei, ss in flat:
            doc_title = ss.section.document_id
            doc_meta = self.document_store.get_metadata(ss.section.document_id)
            if doc_meta:
                doc_title = doc_meta.title or doc_meta.file_name

            all_references.append(SectionReference(
                section_id=ss.section.id,
                document_id=ss.section.document_id,
                document_title=doc_title,
                section_title=ss.section.title,
                breadcrumb=ss.section.breadcrumb,
                relevance=ss.relevance,
                relevance_score=ss.score,
                content_snippet=ss.section.content[:200],
            ))

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

    # =========================================================================
    # Internal: Section-level MMR diversity
    # =========================================================================

    @staticmethod
    def _section_token_set(text: str, cap: int = 400) -> set:
        """Cheap token set for Jaccard similarity. Caps input length so a
        long section doesn't dominate the comparison cost.
        """
        if not text:
            return set()
        head = text[:cap].lower()
        return {t for t in head.split() if len(t) > 2}

    def _apply_section_mmr(self, flat: List[tuple]) -> List[tuple]:
        """Diversify scored sections with MMR.

        Similarity blends a same-document indicator (0.6) with a token
        Jaccard on the section bodies (0.4) — mirrors the cheap reranker
        similarity used in retrieval/reranker.py so we don't pull in the
        chunk-tied LightweightReranker. Cap is the configured
        max_total_sections so we don't accidentally let MMR pad results.
        """
        lambda_ = float(getattr(self.config.macro, "section_mmr_lambda", 0.7))
        cap = max(1, int(getattr(self.config.micro, "max_total_sections", len(flat))))

        # Pre-compute token sets once per section.
        token_sets = {
            id(ss.section): self._section_token_set(ss.section.content)
            for _, ss in flat
        }

        def relevance_fn(item: tuple) -> float:
            return float(item[1].score)

        def similarity_fn(a: tuple, b: tuple) -> float:
            sa, sb = a[1].section, b[1].section
            same_doc = 1.0 if sa.document_id == sb.document_id else 0.0
            ta, tb = token_sets[id(sa)], token_sets[id(sb)]
            if not ta or not tb:
                jacc = 0.0
            else:
                inter = ta & tb
                union = ta | tb
                jacc = len(inter) / len(union) if union else 0.0
            return 0.6 * same_doc + 0.4 * jacc

        return _mmr_select(
            flat,
            relevance_fn=relevance_fn,
            similarity_fn=similarity_fn,
            lambda_=lambda_,
            top_k=cap,
        )

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
        tracer: Optional[Tracer] = None,
    ) -> RAGResult:
        """Build an error RAGResult."""
        return RAGResult(
            answer="",
            confidence=0.0,
            query=query.text,
            error=error_msg,
            total_time_ms=(time.time() - t_start) * 1000,
            trace=(tracer.to_dict() if tracer is not None else None),
        )

    def _no_results_result(
        self,
        query: RAGQuery,
        t_start: float,
        tracer: Optional[Tracer] = None,
    ) -> RAGResult:
        """Build a no-results RAGResult."""
        return RAGResult(
            answer="No relevant documents or sections found for this query.",
            confidence=0.0,
            query=query.text,
            total_time_ms=(time.time() - t_start) * 1000,
            trace=(tracer.to_dict() if tracer is not None else None),
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
        embed_failure = None
        embedder = None
        try:
            embedder = self._get_embedder()
            if embedder:
                vec = embedder.embed_query(text)
                if vec is not None:
                    return np.asarray(vec, dtype=np.float32)
        except Exception as e:
            embed_failure = e
            logger.warning(f"Embedding generation failed: {e}")

        return self._zero_vector_fallback(embedder, embed_failure)

    def _compute_embeddings_batch(
        self, summaries: List
    ) -> List[np.ndarray]:
        """
        Embed multiple DocumentSummary objects in a single API round-trip.

        Falls back gracefully per-summary on:
        - pre-computed embeddings on the summary (used as-is if dim matches)
        - per-text failure inside the batch (replaced with zero vector)
        - whole-batch failure (each summary gets a zero vector)

        Returns embeddings in the same order as `summaries`.
        """
        if not summaries:
            return []

        # Identify which summaries already have valid embeddings to skip.
        result: List[Optional[np.ndarray]] = [None] * len(summaries)
        to_embed_idx: List[int] = []
        to_embed_text: List[str] = []

        for i, s in enumerate(summaries):
            if s.embedding is not None:
                vec = np.asarray(s.embedding, dtype=np.float32)
                if vec.shape == (self.config.embedding_dimension,):
                    result[i] = vec
                    continue
            to_embed_idx.append(i)
            to_embed_text.append(s.to_embed_text())

        if not to_embed_idx:
            return [r for r in result if r is not None]

        embedder = None
        embed_failure: Optional[Exception] = None
        try:
            embedder = self._get_embedder()
            if embedder:
                # Embedder.embed_texts batches at batch_size internally and
                # returns List[List[float]] (or None for per-text failures).
                vectors = embedder.embed_texts(to_embed_text)
                for k, idx in enumerate(to_embed_idx):
                    vec = vectors[k] if k < len(vectors) else None
                    if vec is not None:
                        result[idx] = np.asarray(vec, dtype=np.float32)
        except Exception as e:
            embed_failure = e
            logger.warning(f"Batch embedding generation failed: {e}")

        # Fill any holes (per-item failures or whole-batch failure) with zeros.
        for i in range(len(result)):
            if result[i] is None:
                result[i] = self._zero_vector_fallback(embedder, embed_failure)

        return [r for r in result if r is not None]

    def _zero_vector_fallback(
        self,
        embedder: Optional[Any],
        embed_failure: Optional[Exception],
    ) -> np.ndarray:
        """Zero vector + (one-shot) warning. Vector search disabled until recovery."""
        self._zero_vector_count += 1
        if self._zero_vector_count == 1:
            has_api_key = bool(
                embedder and getattr(embedder, "has_api_key", lambda: False)()
            )
            if has_api_key:
                logger.warning(
                    "Embedding backend unavailable — using zero-vector fallback. "
                    "Vector search in macro-retrieval will not return results until "
                    f"Gemini embedding requests recover. Last error: {embed_failure}"
                )
            else:
                logger.warning(
                    "Embedding API key is not configured — using zero-vector fallback. "
                    "Vector search in macro-retrieval will not return results. "
                    "Set GEMINI_API_KEY or GOOGLE_API_KEY to enable real embeddings."
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

    def _query_rewriter_instance(self) -> QueryRewriter:
        if self._query_rewriter is None:
            # Reuse the synthesis API key (Gemini) — falls back to GEMINI_API_KEY
            # env via QueryRewriter's own default. With no key the rewriter
            # is a quiet no-op, so the pipeline still works offline.
            api_key = getattr(self.config.synthesis, "synthesis_api_key", None)
            self._query_rewriter = QueryRewriter(api_key=api_key)
        return self._query_rewriter

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

    def _section_reranker_instance(self) -> SectionReranker:
        if self._section_reranker is None:
            self._section_reranker = SectionReranker(config=self.config)
        return self._section_reranker

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
        kf = self._keyword_filter_instance()
        kf_stats = kf.get_stats()
        with self._query_cache_lock:
            cache_size = len(self._query_cache)
        total_lookups = self._cache_hits + self._cache_misses
        cache_hit_rate = (
            self._cache_hits / total_lookups if total_lookups > 0 else 0.0
        )
        return {
            "documents": self.document_store.count(),
            "summaries": self.summary_index.count(),
            "sections": self.section_store.count(),
            "toc_trees": self.toc_store.count(),
            "keyword_docs": kf_stats.get("document_count", 0),
            "keyword_terms": kf_stats.get("unique_terms", 0),
            "store_directory": self._store_dir,
            "query_cache": {
                "size": cache_size,
                "hits": self._cache_hits,
                "misses": self._cache_misses,
                "hit_rate": round(cache_hit_rate, 3),
            },
            "zero_vector_fallbacks": self._zero_vector_count,
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

        # The DocumentProcessor maintains a per-instance content-hash dedup
        # cache (`_seen_hashes`). Without resetting it, every subsequent
        # ingest_directory()/ingest_file() call will silently skip the
        # just-cleared docs as "duplicates" and the store stays empty.
        if self._processor is not None:
            try:
                self._processor.reset_dedup()
            except Exception as e:
                logger.debug(f"Processor dedup reset failed: {e}")

        self._invalidate_query_cache("clear")

        logger.info("RAG pipeline data cleared")

    def _remove_doc_by_id(self, doc_id: str) -> int:
        """Remove a document and all its associated data by ID.

        Each store removal is wrapped in a try/except so a failure in one
        store doesn't prevent cleanup of the others.
        
        Returns:
            Number of sections removed.
        """
        sections_removed = 0
        try:
            sections_removed = self.section_store.remove_by_document(doc_id)
        except Exception as e:
            logger.debug(f"section_store.remove_by_document({doc_id}): {e}")
        try:
            self.toc_store.remove(doc_id)
        except Exception as e:
            logger.debug(f"toc_store.remove({doc_id}): {e}")
        try:
            self.summary_index.remove(doc_id)
        except Exception as e:
            logger.debug(f"summary_index.remove({doc_id}): {e}")
        try:
            self._keyword_filter_instance().remove_document(doc_id)
        except Exception as e:
            logger.debug(f"keyword_filter.remove_document({doc_id}): {e}")
        try:
            self.document_store.remove(doc_id)
        except Exception as e:
            logger.debug(f"document_store.remove({doc_id}): {e}")
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

        # Document set changed — drop any cached query results.
        self._invalidate_query_cache("remove_file")

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
