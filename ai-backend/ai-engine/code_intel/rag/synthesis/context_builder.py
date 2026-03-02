"""
Context Builder — Assemble context from extracted sections for synthesis.

Builds a structured context document that:
- Fits within the synthesis model's token budget
- Groups sections by document for coherence
- Includes section metadata (breadcrumbs, line numbers)
- Provides clear section markers for citation tracking
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

from ..config import SynthesisConfig, RAGConfig, get_rag_config
from ..types import Section, SectionReference, Document
from ..micro.section_extractor import ExtractionResult
from ..exceptions import SynthesisError

logger = logging.getLogger("code_intel.rag.synthesis.context_builder")


@dataclass
class ContextSection:
    """A section formatted for synthesis context."""
    citation_id: str          # "[1]", "[2]", etc.
    document_title: str
    section_title: str
    breadcrumb: str
    content: str
    token_estimate: int
    file_path: str = ""
    start_line: int = 0
    end_line: int = 0

    # Source references for citation tracking
    document_id: str = ""
    section_id: str = ""


@dataclass
class SynthesisContext:
    """
    Complete context package for the synthesis model.

    Contains the formatted context text and metadata needed
    for citation tracking.
    """
    context_text: str                     # Formatted text for the model
    sections: List[ContextSection]        # Ordered sections with citation IDs
    total_tokens: int = 0
    document_count: int = 0
    section_count: int = 0
    truncated: bool = False

    def get_section_by_citation(self, citation_id: str) -> Optional[ContextSection]:
        """Lookup a section by its citation marker."""
        for s in self.sections:
            if s.citation_id == citation_id:
                return s
        return None


class ContextBuilder:
    """
    Build synthesis context from extracted sections.

    Formats sections with clear markers that the LLM can reference
    in its citations. Groups by document for coherence.
    """

    def __init__(self, config: Optional[RAGConfig] = None):
        """
        Initialize context builder.

        Args:
            config: RAG configuration.
        """
        self.config = config or get_rag_config()
        self._synth = self.config.synthesis

    # =========================================================================
    # Public API
    # =========================================================================

    def build_context(
        self,
        extraction_results: List[ExtractionResult],
        token_budget: Optional[int] = None,
    ) -> SynthesisContext:
        """
        Build synthesis context from extraction results.

        Args:
            extraction_results: Section extraction results from micro-navigation.
            token_budget: Max tokens for context. Defaults to config.

        Returns:
            SynthesisContext ready for the synthesis model.
        """
        budget = token_budget or self._synth.max_context_tokens
        budget -= self._synth.reserved_for_prompt

        context_sections: List[ContextSection] = []
        total_tokens = 0
        truncated = False
        citation_idx = 1

        for result in extraction_results:
            for section in result.sections:
                # Estimate tokens for this section
                section_tokens = self._estimate_section_tokens(section, result)

                if total_tokens + section_tokens > budget:
                    truncated = True
                    # Try to fit a trimmed version
                    remaining = budget - total_tokens
                    if remaining > 100:
                        cs = self._build_context_section(
                            section, result, citation_idx, max_tokens=remaining
                        )
                        context_sections.append(cs)
                        total_tokens += remaining
                        citation_idx += 1
                    break

                cs = self._build_context_section(
                    section, result, citation_idx
                )
                context_sections.append(cs)
                total_tokens += section_tokens
                citation_idx += 1

            if truncated:
                break

        # Format the complete context text
        context_text = self._format_context_text(context_sections)

        # Count unique documents
        doc_ids = {s.document_id for s in context_sections}

        return SynthesisContext(
            context_text=context_text,
            sections=context_sections,
            total_tokens=total_tokens,
            document_count=len(doc_ids),
            section_count=len(context_sections),
            truncated=truncated,
        )

    def build_from_sections(
        self,
        sections: List[Section],
        document_titles: Dict[str, str],
        token_budget: Optional[int] = None,
    ) -> SynthesisContext:
        """
        Build context directly from Section objects.

        Convenience method for when you have sections without ExtractionResults.

        Args:
            sections: List of sections.
            document_titles: Map of document_id → title.
            token_budget: Max tokens.

        Returns:
            SynthesisContext.
        """
        budget = token_budget or (
            self._synth.max_context_tokens - self._synth.reserved_for_prompt
        )

        context_sections: List[ContextSection] = []
        total_tokens = 0
        truncated = False

        for idx, section in enumerate(sections, 1):
            tokens = section.token_count or (len(section.content) // 4 + 1)

            if total_tokens + tokens > budget:
                truncated = True
                break

            doc_title = document_titles.get(
                section.document_id, section.document_id
            )

            cs = ContextSection(
                citation_id=f"[{idx}]",
                document_title=doc_title,
                section_title=section.title,
                breadcrumb=section.breadcrumb,
                content=section.content,
                token_estimate=tokens,
                document_id=section.document_id,
                section_id=section.id,
                start_line=section.start_line,
                end_line=section.end_line,
            )
            context_sections.append(cs)
            total_tokens += tokens

        context_text = self._format_context_text(context_sections)
        doc_ids = {s.document_id for s in context_sections}

        return SynthesisContext(
            context_text=context_text,
            sections=context_sections,
            total_tokens=total_tokens,
            document_count=len(doc_ids),
            section_count=len(context_sections),
            truncated=truncated,
        )

    # =========================================================================
    # Internal: Section Formatting
    # =========================================================================

    def _build_context_section(
        self,
        section: Section,
        result: ExtractionResult,
        citation_idx: int,
        max_tokens: Optional[int] = None,
    ) -> ContextSection:
        """Build a ContextSection from a Section."""
        content = section.content

        if max_tokens and section.token_count > max_tokens:
            max_chars = max_tokens * 4
            content = content[:max_chars]
            # Trim at paragraph boundary
            last_para = content.rfind("\n\n")
            if last_para > len(content) * 0.5:
                content = content[:last_para]
            content += "\n[...truncated...]"

        return ContextSection(
            citation_id=f"[{citation_idx}]",
            document_title=result.document_title or section.document_id,
            section_title=section.title,
            breadcrumb=section.breadcrumb,
            content=content,
            token_estimate=len(content) // 4 + 1,
            file_path=result.file_path,
            document_id=section.document_id,
            section_id=section.id,
            start_line=section.start_line,
            end_line=section.end_line,
        )

    def _format_context_text(
        self,
        sections: List[ContextSection],
    ) -> str:
        """
        Format all sections into a single context string.

        Uses clear markers so the LLM can reference specific sections
        by their citation IDs.
        """
        if not sections:
            return ""

        parts: List[str] = []
        current_doc = ""

        for cs in sections:
            # Document header (only when document changes)
            if cs.document_id != current_doc:
                current_doc = cs.document_id
                parts.append(f"\n{'='*60}")
                parts.append(f"DOCUMENT: {cs.document_title}")
                if cs.file_path:
                    parts.append(f"FILE: {cs.file_path}")
                parts.append(f"{'='*60}\n")

            # Section header with citation marker
            parts.append(f"--- {cs.citation_id} {cs.section_title} ---")
            if cs.breadcrumb and cs.breadcrumb != cs.section_title:
                parts.append(f"[Path: {cs.breadcrumb}]")
            if cs.start_line:
                parts.append(f"[Lines {cs.start_line}-{cs.end_line}]")
            parts.append("")
            parts.append(cs.content)
            parts.append("")

        return "\n".join(parts)

    def _estimate_section_tokens(
        self,
        section: Section,
        result: ExtractionResult,
    ) -> int:
        """Estimate tokens for a section including headers."""
        # Section content tokens
        content_tokens = section.token_count or (len(section.content) // 4 + 1)
        # Header overhead (~30 tokens for markers, breadcrumb, etc.)
        overhead = 30
        return content_tokens + overhead
