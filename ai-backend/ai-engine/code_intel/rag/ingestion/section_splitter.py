"""
Section Splitter — Split documents into sections based on ToC boundaries.

Maps each ToCNode to a Section with extracted content.
Handles:
- Boundary detection from ToC tree
- Content extraction by line ranges
- Section merging (when sections are too small)
- Section splitting (when sections are too large)
- Breadcrumb generation
"""

from __future__ import annotations

import hashlib
import logging
from typing import Dict, List, Optional

from ..types import (
    Document,
    ToCNode,
    ToCTree,
    ToCNodeType,
    Section,
)
from ..config import IngestionConfig


logger = logging.getLogger("code_intel.rag.ingestion.section_splitter")


class SectionSplitter:
    """
    Split documents into sections based on ToC tree boundaries.

    Each leaf node (and optionally intermediate nodes) in the ToC tree
    becomes a Section with extracted content text.
    """

    def __init__(self, config: Optional[IngestionConfig] = None):
        """
        Initialize section splitter.

        Args:
            config: Ingestion configuration.
        """
        self.config = config or IngestionConfig()

    def split(self, document: Document, toc: ToCTree) -> List[Section]:
        """
        Split a document into sections based on its ToC tree.

        Args:
            document: Source document.
            toc: ToC tree for the document.

        Returns:
            List of Section objects with extracted content.
        """
        lines = document.content.split("\n")
        sections: List[Section] = []

        # Process all leaf nodes and intermediate nodes with own content
        flat_nodes = toc.flatten()

        for node in flat_nodes:
            if node.node_type == ToCNodeType.ROOT:
                continue

            content = self._extract_node_content(node, lines, toc)
            if not content.strip():
                continue

            token_count = len(content) // 4 + 1

            # Skip sections that are too small
            if token_count < self.config.min_section_tokens:
                continue

            breadcrumb = self._build_breadcrumb(node, toc)

            section = Section(
                id=self._generate_section_id(document.id, node.id),
                document_id=document.id,
                toc_node_id=node.id,
                title=node.title,
                content=content,
                depth=node.depth,
                start_line=node.start_line,
                end_line=node.end_line,
                token_count=token_count,
                breadcrumb=breadcrumb,
                keywords=node.keywords[:self.config.max_keywords_per_section],
            )

            # Split oversized sections
            if token_count > self.config.max_section_tokens:
                sub_sections = self._split_large_section(section)
                sections.extend(sub_sections)
            else:
                sections.append(section)

        logger.debug(
            f"Split {document.metadata.file_name} into {len(sections)} sections"
        )
        return sections

    def _extract_node_content(
        self,
        node: ToCNode,
        lines: List[str],
        toc: ToCTree,
    ) -> str:
        """
        Extract content for a ToC node.

        For leaf nodes: extract full content between start_line and end_line.
        For parent nodes: extract only the content BEFORE the first child.
        """
        if node.start_line <= 0 or node.end_line <= 0:
            return ""

        start_idx = max(0, node.start_line - 1)
        end_idx = min(len(lines), node.end_line)

        if node.is_leaf:
            # Leaf node: full content
            return "\n".join(lines[start_idx:end_idx])

        # Parent node: content before first child only
        if node.children:
            first_child_start = node.children[0].start_line
            if first_child_start > node.start_line:
                own_end = first_child_start - 1
                return "\n".join(lines[start_idx:own_end])

        return "\n".join(lines[start_idx:end_idx])

    def _build_breadcrumb(self, node: ToCNode, toc: ToCTree) -> str:
        """
        Build breadcrumb path for a node.

        Example: "Architecture > Authentication > OAuth Flow"
        """
        path = toc.get_path_to_node(node.id)
        # Skip root node from breadcrumb
        titles = [
            n.title for n in path
            if n.node_type != ToCNodeType.ROOT and n.title
        ]
        return " > ".join(titles)

    def _split_large_section(self, section: Section) -> List[Section]:
        """
        Split a section that exceeds max_section_tokens.

        Strategy: Split at paragraph boundaries (double newlines),
        then at single newlines if paragraphs are still too large.
        """
        max_tokens = self.config.max_section_tokens
        content = section.content
        lines = content.split("\n")

        # Try to split at paragraph boundaries
        paragraphs = content.split("\n\n")
        if len(paragraphs) > 1:
            return self._split_into_chunks(
                section, paragraphs, "\n\n", max_tokens
            )

        # Split at line boundaries
        if len(lines) > 1:
            return self._split_into_chunks(
                section, lines, "\n", max_tokens
            )

        # Can't split further — return as-is (oversized)
        return [section]

    def _split_into_chunks(
        self,
        original: Section,
        parts: List[str],
        separator: str,
        max_tokens: int,
    ) -> List[Section]:
        """Split parts into sub-sections that fit within max_tokens."""
        sub_sections: List[Section] = []
        current_parts: List[str] = []
        current_tokens = 0
        chunk_idx = 0

        for part in parts:
            part_tokens = len(part) // 4 + 1
            if current_tokens + part_tokens > max_tokens and current_parts:
                # Emit current chunk
                content = separator.join(current_parts)
                sub_section = Section(
                    id=f"{original.id}_sub{chunk_idx}",
                    document_id=original.document_id,
                    toc_node_id=original.toc_node_id,
                    title=f"{original.title} (part {chunk_idx + 1})",
                    content=content,
                    depth=original.depth,
                    start_line=original.start_line,
                    end_line=original.end_line,
                    token_count=len(content) // 4 + 1,
                    breadcrumb=original.breadcrumb,
                    keywords=original.keywords,
                )
                sub_sections.append(sub_section)
                current_parts = []
                current_tokens = 0
                chunk_idx += 1

            current_parts.append(part)
            current_tokens += part_tokens

        # Emit remaining
        if current_parts:
            content = separator.join(current_parts)
            sub_section = Section(
                id=f"{original.id}_sub{chunk_idx}",
                document_id=original.document_id,
                toc_node_id=original.toc_node_id,
                title=f"{original.title} (part {chunk_idx + 1})" if chunk_idx > 0 else original.title,
                content=content,
                depth=original.depth,
                start_line=original.start_line,
                end_line=original.end_line,
                token_count=len(content) // 4 + 1,
                breadcrumb=original.breadcrumb,
                keywords=original.keywords,
            )
            sub_sections.append(sub_section)

        return sub_sections

    @staticmethod
    def _generate_section_id(document_id: str, node_id: str) -> str:
        """Generate a stable section ID."""
        raw = f"{document_id}|{node_id}"
        return hashlib.sha256(raw.encode()).hexdigest()[:20]
