"""
Section Extractor — Extract precise section content from documents.

Given the selected ToC node IDs from the TreeNavigator, the extractor:
1. Resolves node IDs to line ranges in the source document
2. Extracts the exact content for each section
3. Trims to token budget
4. Assembles a structured context package
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from ..config import MicroConfig, RAGConfig, get_rag_config
from ..types import (
    Section,
    SectionReference,
    SectionRelevance,
    ToCTree,
    ToCNode,
)
from ..store.section_store import SectionStore
from ..store.document_store import DocumentStore
from ..exceptions import NavigationError, SectionNotFoundError

logger = logging.getLogger("code_intel.rag.micro.section_extractor")


@dataclass
class ExtractionResult:
    """Result of section extraction for a document."""
    document_id: str
    sections: List[Section]
    references: List[SectionReference]
    total_tokens: int = 0
    truncated: bool = False


class SectionExtractor:
    """
    Extract section content from documents using ToC node references.

    Works with both pre-stored sections (SectionStore) and on-the-fly
    extraction from raw document content (DocumentStore).
    """

    def __init__(
        self,
        section_store: SectionStore,
        document_store: DocumentStore,
        config: Optional[RAGConfig] = None,
    ):
        """
        Initialize section extractor.

        Args:
            section_store: Stored section data.
            document_store: Raw document data.
            config: RAG configuration.
        """
        self.section_store = section_store
        self.doc_store = document_store
        self.config = config or get_rag_config()
        self._micro = self.config.micro

    # =========================================================================
    # Public API
    # =========================================================================

    def extract_sections(
        self,
        document_id: str,
        node_ids: List[str],
        toc_tree: Optional[ToCTree] = None,
        token_budget: Optional[int] = None,
    ) -> ExtractionResult:
        """
        Extract sections from a document by ToC node IDs.

        Args:
            document_id: Document ID.
            node_ids: List of ToC node IDs to extract.
            toc_tree: ToC tree (for breadcrumb generation).
            token_budget: Maximum tokens. None = no limit.

        Returns:
            ExtractionResult with sections and references.
        """
        sections: List[Section] = []
        references: List[SectionReference] = []
        total_tokens = 0
        truncated = False
        budget = token_budget or self.config.synthesis.max_context_tokens

        # Get document metadata for titles
        doc_meta = self.doc_store.get_metadata(document_id)
        doc_title = doc_meta.title if doc_meta else document_id

        for node_id in node_ids:
            if total_tokens >= budget:
                truncated = True
                break

            # Try stored section first (fast path)
            section = self._get_stored_section(document_id, node_id)

            # Fallback: extract from raw content using ToC node boundaries
            if section is None and toc_tree:
                section = self._extract_from_content(
                    document_id, node_id, toc_tree
                )

            if section is None:
                logger.debug(f"Could not extract section {node_id} from {document_id}")
                continue

            # Token budget check
            if total_tokens + section.token_count > budget:
                # Trim section to fit
                remaining = budget - total_tokens
                section = self._trim_section(section, remaining)
                truncated = True

            sections.append(section)
            total_tokens += section.token_count

            # Build reference
            breadcrumb = section.breadcrumb
            if not breadcrumb and toc_tree:
                path = toc_tree.get_path_to_node(node_id)
                breadcrumb = " > ".join(n.title for n in path if n.title)

            ref = SectionReference(
                section_id=section.id,
                document_id=document_id,
                document_title=doc_title,
                section_title=section.title,
                breadcrumb=breadcrumb,
                relevance=SectionRelevance.HIGH,
                relevance_score=0.8,
                content_snippet=section.content[:200] if section.content else "",
            )
            references.append(ref)

        return ExtractionResult(
            document_id=document_id,
            sections=sections,
            references=references,
            total_tokens=total_tokens,
            truncated=truncated,
        )

    def extract_from_multiple_docs(
        self,
        doc_node_map: Dict[str, List[str]],
        toc_trees: Dict[str, ToCTree],
        total_token_budget: Optional[int] = None,
    ) -> List[ExtractionResult]:
        """
        Extract sections from multiple documents.

        Distributes token budget across documents proportionally.

        Args:
            doc_node_map: Map of document_id → list of node IDs.
            toc_trees: Map of document_id → ToCTree.
            total_token_budget: Total token budget across all documents.

        Returns:
            List of ExtractionResult, one per document.
        """
        budget = total_token_budget or self.config.synthesis.max_context_tokens
        doc_count = len(doc_node_map)

        if doc_count == 0:
            return []

        # Distribute budget proportionally to node counts
        total_nodes = sum(len(ids) for ids in doc_node_map.values())
        if total_nodes == 0:
            return []

        results: List[ExtractionResult] = []
        remaining_budget = budget

        for doc_id, node_ids in doc_node_map.items():
            if remaining_budget <= 0:
                break

            # Budget proportional to node count
            doc_budget = int(budget * len(node_ids) / total_nodes)
            doc_budget = min(doc_budget, remaining_budget)
            doc_budget = max(doc_budget, 500)  # Minimum 500 tokens per doc

            tree = toc_trees.get(doc_id)
            result = self.extract_sections(
                document_id=doc_id,
                node_ids=node_ids,
                toc_tree=tree,
                token_budget=doc_budget,
            )
            results.append(result)
            remaining_budget -= result.total_tokens

        return results

    # =========================================================================
    # Internal: Section Retrieval
    # =========================================================================

    def _get_stored_section(
        self,
        document_id: str,
        node_id: str,
    ) -> Optional[Section]:
        """Try to get a pre-stored section."""
        # Sections are keyed by their own ID, which is derived from
        # document_id + toc_node_id during ingestion
        sections = self.section_store.get_by_document(document_id)
        for section in sections:
            if section.toc_node_id == node_id:
                return section
        return None

    def _extract_from_content(
        self,
        document_id: str,
        node_id: str,
        tree: ToCTree,
    ) -> Optional[Section]:
        """
        Extract section content from raw document using line ranges.

        Falls back to the DocumentStore for raw content + ToCNode
        line boundaries.
        """
        node = tree.get_node(node_id)
        if not node:
            return None

        # Get raw document content
        doc = self.doc_store.get(document_id)
        if not doc:
            return None

        content = doc.content
        lines = content.split("\n")

        # Extract by line range (1-based -> 0-based)
        start = max(0, node.start_line - 1)
        end = min(len(lines), node.end_line)

        if start >= end:
            return None

        section_content = "\n".join(lines[start:end])

        # Build breadcrumb
        path = tree.get_path_to_node(node_id)
        breadcrumb = " > ".join(n.title for n in path if n.title)

        return Section(
            id=f"{document_id}:{node_id}",
            document_id=document_id,
            toc_node_id=node_id,
            title=node.title,
            content=section_content,
            depth=node.depth,
            start_line=node.start_line,
            end_line=node.end_line,
            breadcrumb=breadcrumb,
            keywords=node.keywords,
        )

    def _trim_section(self, section: Section, max_tokens: int) -> Section:
        """
        Trim a section to fit within a token budget.

        Preserves the beginning of the section (most likely to have
        the key information) and adds a truncation marker.
        """
        if section.token_count <= max_tokens:
            return section

        # Rough char estimate
        max_chars = max_tokens * 4
        content = section.content

        if len(content) <= max_chars:
            return section

        # Trim at paragraph boundary if possible
        trimmed = content[:max_chars]
        last_para = trimmed.rfind("\n\n")
        if last_para > max_chars * 0.5:
            trimmed = trimmed[:last_para]

        trimmed += "\n\n[... section truncated ...]"

        return Section(
            id=section.id,
            document_id=section.document_id,
            toc_node_id=section.toc_node_id,
            title=section.title,
            content=trimmed,
            depth=section.depth,
            start_line=section.start_line,
            end_line=section.end_line,
            token_count=max_tokens,
            breadcrumb=section.breadcrumb,
            keywords=section.keywords,
        )
