"""
Page Resolver — Maps section references to precise content locations.

Handles the tricky mapping between:
- ToC node IDs (logical references)
- Section IDs (storage references)
- Line ranges in documents (physical references)
- Character offsets (for highlighting)

This module ensures that every section reference in the final answer
can be traced back to exact positions in the original documents.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from ..types import (
    Section,
    SectionReference,
    ToCTree,
    ToCNode,
    Document,
)
from ..store.section_store import SectionStore
from ..store.document_store import DocumentStore
from ..exceptions import NavigationError

logger = logging.getLogger("code_intel.rag.micro.page_resolver")


@dataclass
class ResolvedLocation:
    """
    A fully resolved location in a document.

    Maps a logical reference to physical content.
    """
    document_id: str
    document_title: str
    file_path: str
    section_id: str
    section_title: str
    breadcrumb: str

    # Physical location
    start_line: int = 0
    end_line: int = 0
    start_offset: int = 0
    end_offset: int = 0

    # Content
    content: str = ""
    content_preview: str = ""       # First 200 chars

    # Validity
    is_valid: bool = True
    error: str = ""


class PageResolver:
    """
    Resolve section references to precise content locations.

    Used by:
    - Synthesis module: to get content for context building
    - Citation tracker: to generate exact source references
    - API layer: to provide clickable links to source code
    """

    def __init__(
        self,
        document_store: DocumentStore,
        section_store: SectionStore,
    ):
        """
        Initialize page resolver.

        Args:
            document_store: Document storage.
            section_store: Section storage.
        """
        self.doc_store = document_store
        self.section_store = section_store

    # =========================================================================
    # Public API
    # =========================================================================

    def resolve_reference(
        self,
        ref: SectionReference,
        toc_tree: Optional[ToCTree] = None,
    ) -> ResolvedLocation:
        """
        Resolve a SectionReference to a full location.

        Args:
            ref: Section reference (from micro-navigation).
            toc_tree: Optional ToC tree for breadcrumb generation.

        Returns:
            ResolvedLocation with all details.
        """
        # Get document metadata
        doc_meta = self.doc_store.get_metadata(ref.document_id)
        if not doc_meta:
            return ResolvedLocation(
                document_id=ref.document_id,
                document_title=ref.document_title,
                file_path="",
                section_id=ref.section_id,
                section_title=ref.section_title,
                breadcrumb=ref.breadcrumb,
                is_valid=False,
                error=f"Document {ref.document_id} not found",
            )

        # Get section content
        section = self.section_store.get(ref.section_id)
        content = ""
        start_line = 0
        end_line = 0

        if section:
            content = section.content
            start_line = section.start_line
            end_line = section.end_line
        elif toc_tree:
            # Fallback to ToC node boundaries
            node = toc_tree.get_node(ref.section_id)
            if node:
                start_line = node.start_line
                end_line = node.end_line
                content = self._extract_content_by_lines(
                    ref.document_id, start_line, end_line
                )

        # Build breadcrumb if not provided
        breadcrumb = ref.breadcrumb
        if not breadcrumb and toc_tree:
            path = toc_tree.get_path_to_node(ref.section_id)
            breadcrumb = " > ".join(n.title for n in path if n.title)

        return ResolvedLocation(
            document_id=ref.document_id,
            document_title=doc_meta.title or doc_meta.file_name,
            file_path=doc_meta.file_path,
            section_id=ref.section_id,
            section_title=ref.section_title,
            breadcrumb=breadcrumb or ref.section_title,
            start_line=start_line,
            end_line=end_line,
            content=content,
            content_preview=content[:200] if content else "",
            is_valid=True,
        )

    def resolve_references(
        self,
        refs: List[SectionReference],
        toc_trees: Optional[Dict[str, ToCTree]] = None,
    ) -> List[ResolvedLocation]:
        """
        Resolve multiple section references.

        Args:
            refs: List of section references.
            toc_trees: Map of document_id → ToCTree.

        Returns:
            List of ResolvedLocation (same order as input).
        """
        results: List[ResolvedLocation] = []
        for ref in refs:
            tree = toc_trees.get(ref.document_id) if toc_trees else None
            results.append(self.resolve_reference(ref, tree))
        return results

    def resolve_node_ids(
        self,
        document_id: str,
        node_ids: List[str],
        toc_tree: ToCTree,
    ) -> List[ResolvedLocation]:
        """
        Resolve ToC node IDs to locations.

        Convenience method when you have node IDs instead of SectionReferences.
        """
        doc_meta = self.doc_store.get_metadata(document_id)
        if not doc_meta:
            return []

        results: List[ResolvedLocation] = []
        for node_id in node_ids:
            node = toc_tree.get_node(node_id)
            if not node:
                continue

            path = toc_tree.get_path_to_node(node_id)
            breadcrumb = " > ".join(n.title for n in path if n.title)

            # Get content
            section = self.section_store.get(node_id)
            content = ""
            if section:
                content = section.content
            else:
                content = self._extract_content_by_lines(
                    document_id, node.start_line, node.end_line
                )

            results.append(ResolvedLocation(
                document_id=document_id,
                document_title=doc_meta.title or doc_meta.file_name,
                file_path=doc_meta.file_path,
                section_id=node_id,
                section_title=node.title,
                breadcrumb=breadcrumb,
                start_line=node.start_line,
                end_line=node.end_line,
                start_offset=node.start_offset,
                end_offset=node.end_offset,
                content=content,
                content_preview=content[:200] if content else "",
                is_valid=True,
            ))

        return results

    # =========================================================================
    # Internal
    # =========================================================================

    def _extract_content_by_lines(
        self,
        document_id: str,
        start_line: int,
        end_line: int,
    ) -> str:
        """Extract content from a document by line range."""
        doc = self.doc_store.get(document_id)
        if not doc or not doc.content:
            return ""

        lines = doc.content.split("\n")
        start = max(0, start_line - 1)
        end = min(len(lines), end_line)

        if start >= end:
            return ""

        return "\n".join(lines[start:end])
