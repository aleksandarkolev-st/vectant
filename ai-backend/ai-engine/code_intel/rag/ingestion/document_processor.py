"""
Document Processor — Orchestrates the full dual-ingestion pipeline.

Coordinates the four ingestion sub-components:
1. DocumentLoader  → reads files from disk into Document objects
2. ToCExtractor    → builds a Table of Contents tree per document
3. SectionSplitter → splits document into discrete sections
4. SummaryGenerator → generates a high-level summary + embedding text

The processor is the primary entry point called by the RAG pipeline
for both single-file and directory-level ingestion.
"""

from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional

from ..config import RAGConfig
from ..types import Document, ToCTree, Section, DocumentSummary
from ..exceptions import (
    IngestionError,
    DocumentParseError,
    ToCExtractionError,
    SummaryGenerationError,
)
from .document_loader import DocumentLoader
from .toc_extractor import ToCExtractor
from .section_splitter import SectionSplitter
from .summary_generator import SummaryGenerator
from .content_hasher import ContentHasher

logger = logging.getLogger("code_intel.rag.ingestion.processor")


# =========================================================================
# Result types
# =========================================================================


@dataclass
class ProcessingResult:
    """Result of processing a directory of documents."""

    documents: List[Document] = field(default_factory=list)
    documents_processed: int = 0
    documents_skipped: int = 0
    documents_failed: int = 0
    errors: List[str] = field(default_factory=list)
    elapsed_ms: float = 0.0

    @property
    def total_sections(self) -> int:
        return sum(len(d.sections) for d in self.documents)

    @property
    def total_with_toc(self) -> int:
        return sum(1 for d in self.documents if d.toc is not None)

    @property
    def total_with_summary(self) -> int:
        return sum(1 for d in self.documents if d.summary is not None)


# =========================================================================
# Document Processor
# =========================================================================


class DocumentProcessor:
    """
    Orchestrates the dual-ingestion pipeline for the RAG subsystem.

    Pipeline per document:
        load → extract ToC → split sections → generate summary

    Handles errors gracefully — a failure in ToC extraction or
    summary generation does not discard the loaded document.
    """

    def __init__(self, config: RAGConfig) -> None:
        """
        Initialize the document processor.

        Args:
            config: Full RAG configuration (ingestion sub-config is extracted).
        """
        self.config = config
        ingestion_cfg = config.ingestion

        self._loader = DocumentLoader(config=ingestion_cfg)
        self._toc_extractor = ToCExtractor(config=ingestion_cfg)
        self._section_splitter = SectionSplitter(config=ingestion_cfg)
        self._summary_generator = SummaryGenerator(config=ingestion_cfg)
        self._hasher = ContentHasher(algorithm=ingestion_cfg.hash_algorithm)

        # Track content hashes for dedup within a single ingestion run
        self._seen_hashes: Dict[str, str] = {}  # content_hash → doc_id

    # =====================================================================
    # Public API
    # =====================================================================

    def process_directory(self, directory: str) -> ProcessingResult:
        """
        Process all supported files in a directory.

        Loads, parses, extracts ToC, splits sections, and generates
        summaries for every eligible file.

        Args:
            directory: Absolute path to the directory.

        Returns:
            ProcessingResult with documents and statistics.
        """
        t0 = time.time()
        result = ProcessingResult()
        dir_path = Path(directory)

        if not dir_path.is_dir():
            raise IngestionError(
                f"Not a directory: {directory}",
                details={"directory": directory},
            )

        logger.info(f"Processing directory: {directory}")

        # Step 1: Load all documents via DocumentLoader
        try:
            raw_documents = self._loader.load_directory(directory)
        except IngestionError:
            raise
        except Exception as e:
            raise IngestionError(
                f"Failed to load directory: {directory}",
                details={"directory": directory},
                cause=e,
            )

        logger.info(f"Loaded {len(raw_documents)} raw documents from {directory}")

        # Step 2: Process each document through the pipeline
        for doc in raw_documents:
            try:
                processed = self._process_single_document(doc)
                if processed is None:
                    result.documents_skipped += 1
                    continue
                result.documents.append(processed)
                result.documents_processed += 1
            except Exception as e:
                result.documents_failed += 1
                error_msg = f"{doc.metadata.file_path}: {e}"
                result.errors.append(error_msg)
                logger.warning(f"Failed to process document: {error_msg}")

        result.elapsed_ms = (time.time() - t0) * 1000

        logger.info(
            f"Directory processing complete: "
            f"{result.documents_processed} processed, "
            f"{result.documents_skipped} skipped, "
            f"{result.documents_failed} failed "
            f"({result.elapsed_ms:.0f}ms)"
        )

        return result

    def process_file(self, file_path: str) -> Optional[Document]:
        """
        Process a single file through the full ingestion pipeline.

        Args:
            file_path: Absolute path to the file.

        Returns:
            Fully processed Document, or None if skipped (e.g. duplicate).
        """
        logger.debug(f"Processing file: {file_path}")

        # Load
        try:
            doc = self._loader.load_file(file_path)
        except (IngestionError, DocumentParseError):
            raise
        except Exception as e:
            raise IngestionError(
                f"Failed to load file: {file_path}",
                details={"file_path": file_path},
                cause=e,
            )

        return self._process_single_document(doc)

    # =====================================================================
    # Internal Pipeline
    # =====================================================================

    def _process_single_document(self, doc: Document) -> Optional[Document]:
        """
        Run the full ingestion pipeline on a loaded Document.

        Steps:
            1. Dedup check (content hash)
            2. ToC extraction
            3. Section splitting
            4. Summary generation

        Failures in steps 2-4 are logged but non-fatal — the Document
        is still returned with whatever data was successfully extracted.

        Args:
            doc: A loaded Document (content + metadata present).

        Returns:
            The enriched Document, or None if it was a duplicate.
        """
        content_hash = doc.metadata.content_hash

        # Dedup: skip if we've already processed identical content
        if content_hash in self._seen_hashes:
            existing_id = self._seen_hashes[content_hash]
            logger.debug(
                f"Skipping duplicate: {doc.metadata.file_path} "
                f"(same content as {existing_id})"
            )
            return None

        self._seen_hashes[content_hash] = doc.id

        # --- Step 2: ToC extraction ---
        toc: Optional[ToCTree] = None
        try:
            toc = self._toc_extractor.extract(doc)
            doc.toc = toc
            logger.debug(
                f"Extracted ToC for {doc.metadata.file_name}: "
                f"{toc.total_nodes} nodes, depth {toc.max_depth}"
            )
        except ToCExtractionError as e:
            logger.warning(
                f"ToC extraction failed for {doc.metadata.file_path}: {e}"
            )
        except Exception as e:
            logger.warning(
                f"Unexpected error extracting ToC for "
                f"{doc.metadata.file_path}: {e}"
            )

        # --- Step 3: Section splitting ---
        sections: List[Section] = []
        if toc is not None:
            try:
                sections = self._section_splitter.split(doc, toc)
                doc.sections = sections
                doc.metadata.section_count = len(sections)
                logger.debug(
                    f"Split {doc.metadata.file_name} into {len(sections)} sections"
                )
            except Exception as e:
                logger.warning(
                    f"Section splitting failed for {doc.metadata.file_path}: {e}"
                )
        else:
            logger.debug(
                f"Skipping section split for {doc.metadata.file_name} (no ToC)"
            )

        # --- Step 4: Summary generation ---
        try:
            summary = self._summary_generator.generate(
                doc, toc=toc, sections=sections or None
            )
            doc.summary = summary
            logger.debug(
                f"Generated summary for {doc.metadata.file_name}: "
                f"{len(summary.summary_text)} chars, "
                f"{len(summary.key_topics)} topics"
            )
        except SummaryGenerationError as e:
            logger.warning(
                f"Summary generation failed for {doc.metadata.file_path}: {e}"
            )
        except Exception as e:
            logger.warning(
                f"Unexpected error generating summary for "
                f"{doc.metadata.file_path}: {e}"
            )

        return doc

    # =====================================================================
    # Utilities
    # =====================================================================

    def reset_dedup(self) -> None:
        """Clear the dedup hash cache (useful between ingestion runs)."""
        self._seen_hashes.clear()

    @property
    def seen_count(self) -> int:
        """Number of unique documents processed in this run."""
        return len(self._seen_hashes)
