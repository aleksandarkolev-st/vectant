"""
Citation Tracker — Track provenance from answer to source sections.

Maps citation markers in the synthesized answer back to exact
source locations. Produces Citation objects that include:
- Document title and path
- Section title and breadcrumb
- Exact line ranges
- Relevant excerpt from source
- Confidence score
"""

from __future__ import annotations

import logging
import re
from typing import Dict, List, Optional, Tuple

from ..config import SynthesisConfig, RAGConfig, get_rag_config
from ..types import Citation, SectionReference
from .context_builder import SynthesisContext, ContextSection
from .answer_synthesizer import SynthesisResult
from ..exceptions import CitationError

logger = logging.getLogger("code_intel.rag.synthesis.citation_tracker")


class CitationTracker:
    """
    Track and resolve citations from synthesized answers.

    Takes the raw citation markers from the synthesis result
    and maps them to full Citation objects with source provenance.
    """

    def __init__(self, config: Optional[RAGConfig] = None):
        """
        Initialize citation tracker.

        Args:
            config: RAG configuration.
        """
        self.config = config or get_rag_config()
        self._synth = self.config.synthesis

    # =========================================================================
    # Public API
    # =========================================================================

    def track_citations(
        self,
        synthesis_result: SynthesisResult,
        context: SynthesisContext,
    ) -> List[Citation]:
        """
        Extract and resolve citations from a synthesis result.

        Args:
            synthesis_result: Raw synthesis result with answer text.
            context: The context that was provided to the model.

        Returns:
            List of resolved Citation objects.
        """
        answer_text = synthesis_result.answer_text
        raw_markers = synthesis_result.raw_citations

        if not raw_markers:
            return []

        citations: List[Citation] = []

        for marker in raw_markers:
            # Find the context section for this marker
            section = context.get_section_by_citation(marker)
            if not section:
                logger.debug(f"Citation {marker} not found in context")
                continue

            # Extract the relevant excerpt from the answer
            excerpt = self._extract_citation_excerpt(answer_text, marker)

            # Find matching content in the source section
            source_excerpt = self._find_source_excerpt(
                excerpt, section.content
            )

            # Calculate confidence
            confidence = self._compute_citation_confidence(
                excerpt, source_excerpt, section
            )

            if confidence < self._synth.min_citation_confidence:
                logger.debug(
                    f"Citation {marker} below confidence threshold: {confidence:.2f}"
                )
                continue

            citation = Citation(
                id=marker,
                document_id=section.document_id,
                document_title=section.document_title,
                section_id=section.section_id,
                section_title=section.section_title,
                breadcrumb=section.breadcrumb,
                excerpt=source_excerpt or section.content[:200],
                start_line=section.start_line,
                end_line=section.end_line,
                confidence=confidence,
            )
            citations.append(citation)

        # Enforce max citations
        if len(citations) > self._synth.max_citations:
            citations = citations[:self._synth.max_citations]

        return citations

    def validate_citations(
        self,
        citations: List[Citation],
        context: SynthesisContext,
    ) -> Tuple[List[Citation], List[str]]:
        """
        Validate citations against context.

        Returns:
            Tuple of (valid citations, list of validation warnings).
        """
        valid: List[Citation] = []
        warnings: List[str] = []

        for citation in citations:
            section = context.get_section_by_citation(citation.id)
            if not section:
                warnings.append(
                    f"Citation {citation.id}: section not found in context"
                )
                continue

            if section.document_id != citation.document_id:
                warnings.append(
                    f"Citation {citation.id}: document ID mismatch"
                )
                continue

            valid.append(citation)

        return valid, warnings

    # =========================================================================
    # Internal: Excerpt Extraction
    # =========================================================================

    def _extract_citation_excerpt(
        self,
        answer_text: str,
        marker: str,
    ) -> str:
        """
        Extract the sentence containing a citation marker from the answer.

        Returns the sentence (or clause) that references this citation.
        """
        # Find the marker position
        marker_escaped = re.escape(marker)
        match = re.search(marker_escaped, answer_text)
        if not match:
            return ""

        pos = match.start()

        # Find sentence boundaries around the marker
        # Look backward for sentence start
        start = max(0, pos - 200)
        before = answer_text[start:pos]
        sent_start = start
        for delim in [". ", ".\n", "\n\n", "\n- ", "\n* "]:
            idx = before.rfind(delim)
            if idx >= 0:
                sent_start = start + idx + len(delim)
                break

        # Look forward for sentence end
        end = min(len(answer_text), pos + 200)
        after = answer_text[pos:end]
        sent_end = end
        for delim in [". ", ".\n", "\n\n", "\n- "]:
            idx = after.find(delim)
            if idx >= 0:
                sent_end = pos + idx + 1
                break

        excerpt = answer_text[sent_start:sent_end].strip()
        # Remove the citation marker itself
        excerpt = excerpt.replace(marker, "").strip()
        return excerpt

    def _find_source_excerpt(
        self,
        answer_excerpt: str,
        source_content: str,
    ) -> Optional[str]:
        """
        Find the most relevant passage in source content matching the answer excerpt.

        Uses simple word overlap to find the best-matching paragraph.
        """
        if not answer_excerpt or not source_content:
            return None

        answer_words = set(answer_excerpt.lower().split())
        # Remove common words
        common = {"the", "a", "an", "is", "are", "was", "in", "on", "to", "for", "of", "and"}
        answer_words -= common

        if not answer_words:
            return None

        # Split source into paragraphs
        paragraphs = source_content.split("\n\n")
        if not paragraphs:
            paragraphs = source_content.split("\n")

        best_para = ""
        best_overlap = 0

        for para in paragraphs:
            if len(para.strip()) < 10:
                continue

            para_words = set(para.lower().split()) - common
            overlap = len(answer_words & para_words)

            if overlap > best_overlap:
                best_overlap = overlap
                best_para = para.strip()

        if best_overlap < 2:
            return None

        # Trim to reasonable length
        if len(best_para) > 300:
            best_para = best_para[:300] + "..."

        return best_para

    # =========================================================================
    # Internal: Confidence
    # =========================================================================

    def _compute_citation_confidence(
        self,
        answer_excerpt: str,
        source_excerpt: Optional[str],
        section: ContextSection,
    ) -> float:
        """
        Compute confidence that a citation is accurate.

        Signals:
        - Source excerpt found → higher confidence
        - Section has content → higher confidence
        - Keyword overlap → higher confidence
        """
        confidence = 0.5  # Base confidence

        # Found matching source content
        if source_excerpt:
            # Calculate word overlap ratio
            answer_words = set(answer_excerpt.lower().split())
            source_words = set(source_excerpt.lower().split())
            common = {"the", "a", "an", "is", "are", "was", "in", "to", "for", "of"}
            answer_words -= common
            source_words -= common

            if answer_words:
                overlap = len(answer_words & source_words) / len(answer_words)
                confidence += 0.3 * overlap

        # Section has substantial content
        if section.token_estimate > 50:
            confidence += 0.1

        # Section has line references
        if section.start_line > 0:
            confidence += 0.05

        # Breadcrumb exists (well-structured source)
        if section.breadcrumb:
            confidence += 0.05

        return min(1.0, confidence)
