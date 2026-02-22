"""
Confidence Scorer — Score overall answer quality and confidence.

Evaluates the synthesized answer across multiple dimensions:
- Source coverage (how many sources were used)
- Citation density (citations per claim)
- Content grounding (answer matches source material)
- Query coverage (does the answer address the full query)
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from ..config import SynthesisConfig, RAGConfig, get_rag_config
from ..types import Citation, RAGQuery
from .context_builder import SynthesisContext
from .answer_synthesizer import SynthesisResult

logger = logging.getLogger("code_intel.rag.synthesis.confidence_scorer")


@dataclass
class ConfidenceBreakdown:
    """Detailed confidence breakdown."""
    overall: float                  # 0.0 - 1.0
    source_coverage: float          # Coverage of source material
    citation_density: float         # Citations per claim
    grounding: float               # Answer grounded in sources
    query_coverage: float          # Answer addresses the query
    warnings: List[str] = field(default_factory=list)


class ConfidenceScorer:
    """
    Score the quality and confidence of a synthesized answer.

    Produces a 0-1 confidence score with a detailed breakdown
    that helps the user understand how reliable the answer is.
    """

    def __init__(self, config: Optional[RAGConfig] = None):
        """
        Initialize confidence scorer.

        Args:
            config: RAG configuration.
        """
        self.config = config or get_rag_config()
        self._synth = self.config.synthesis

    # =========================================================================
    # Public API
    # =========================================================================

    def score(
        self,
        query: RAGQuery,
        synthesis_result: SynthesisResult,
        context: SynthesisContext,
        citations: List[Citation],
    ) -> ConfidenceBreakdown:
        """
        Score answer confidence.

        Args:
            query: Original query.
            synthesis_result: The generated answer.
            context: Context that was provided.
            citations: Resolved citations.

        Returns:
            ConfidenceBreakdown with overall score and dimensions.
        """
        warnings: List[str] = []
        answer = synthesis_result.answer_text

        # Dimension 1: Source coverage
        source_coverage = self._score_source_coverage(
            context, citations, warnings
        )

        # Dimension 2: Citation density
        citation_density = self._score_citation_density(
            answer, citations, warnings
        )

        # Dimension 3: Grounding
        grounding = self._score_grounding(
            answer, context, warnings
        )

        # Dimension 4: Query coverage
        query_coverage = self._score_query_coverage(
            query.text, answer, warnings
        )

        # Weighted average
        overall = (
            source_coverage * 0.25
            + citation_density * 0.25
            + grounding * 0.30
            + query_coverage * 0.20
        )

        # Low confidence warning
        if overall < self._synth.low_confidence_threshold:
            warnings.append(
                f"Low confidence ({overall:.2f}): answer may be inaccurate or incomplete"
            )

        return ConfidenceBreakdown(
            overall=round(overall, 3),
            source_coverage=round(source_coverage, 3),
            citation_density=round(citation_density, 3),
            grounding=round(grounding, 3),
            query_coverage=round(query_coverage, 3),
            warnings=warnings,
        )

    # =========================================================================
    # Internal: Scoring Dimensions
    # =========================================================================

    def _score_source_coverage(
        self,
        context: SynthesisContext,
        citations: List[Citation],
        warnings: List[str],
    ) -> float:
        """
        Score how well the answer uses available source material.

        Higher when more context sections are cited.
        """
        if context.section_count == 0:
            warnings.append("No source sections available")
            return 0.0

        # Count unique cited sections
        cited_section_ids = {c.section_id for c in citations}
        available_section_ids = {s.section_id for s in context.sections}

        if not available_section_ids:
            return 0.0

        coverage = len(cited_section_ids & available_section_ids) / len(available_section_ids)

        # Perfect coverage isn't always expected; using 2+ sources is good
        if len(cited_section_ids) >= 2:
            coverage = max(coverage, 0.5)
        if len(cited_section_ids) >= 3:
            coverage = max(coverage, 0.7)

        if coverage < 0.2:
            warnings.append("Answer cites very few of the available sources")

        return min(1.0, coverage)

    def _score_citation_density(
        self,
        answer: str,
        citations: List[Citation],
        warnings: List[str],
    ) -> float:
        """
        Score citation density (citations per significant claim).

        Approximates "claims" as sentences.
        """
        if not answer.strip():
            return 0.0

        # Count sentences (rough approximation)
        sentences = re.split(r'[.!?]\s+', answer)
        sentences = [s for s in sentences if len(s.strip()) > 20]
        num_sentences = max(len(sentences), 1)

        # Count citation markers in answer
        markers = re.findall(r'\[\d+\]', answer)
        num_citations = len(markers)

        if num_citations == 0:
            warnings.append("No citations found in answer")
            return 0.0

        # Ideal: ~1 citation per 2-3 sentences
        ideal_ratio = num_sentences / 2.5
        density = min(1.0, num_citations / max(ideal_ratio, 1))

        # Penalize over-citation (more citations than sentences)
        if num_citations > num_sentences * 1.5:
            density *= 0.9

        return density

    def _score_grounding(
        self,
        answer: str,
        context: SynthesisContext,
        warnings: List[str],
    ) -> float:
        """
        Score how well the answer is grounded in source material.

        Checks for keyword overlap between answer and context.
        """
        if not answer or not context.context_text:
            return 0.0

        # Extract significant words from answer
        answer_words = set(re.findall(r'[a-zA-Z_]\w{2,}', answer.lower()))
        common = {
            "the", "and", "for", "that", "this", "with", "from",
            "are", "was", "were", "been", "have", "has", "will",
            "would", "could", "should", "can", "may", "might",
            "not", "but", "also", "more", "than", "each",
        }
        answer_words -= common

        if not answer_words:
            return 0.5  # Neutral if no meaningful words

        # Check how many answer words appear in context
        context_lower = context.context_text.lower()
        grounded = sum(1 for w in answer_words if w in context_lower)
        grounding = grounded / len(answer_words)

        # Check for phrases that indicate lack of grounding
        uncertainty_phrases = [
            "i'm not sure",
            "i don't have",
            "cannot determine",
            "not enough information",
            "no information available",
        ]
        for phrase in uncertainty_phrases:
            if phrase in answer.lower():
                grounding = min(grounding, 0.3)
                warnings.append("Answer indicates uncertainty")
                break

        return grounding

    def _score_query_coverage(
        self,
        query_text: str,
        answer: str,
        warnings: List[str],
    ) -> float:
        """
        Score how well the answer addresses the original query.

        Checks if key terms from the query appear in the answer.
        """
        # Extract query keywords
        stop_words = {
            "what", "how", "does", "the", "is", "are", "can", "you",
            "where", "when", "why", "which", "who", "will", "would",
            "do", "in", "on", "to", "for", "of", "and", "a", "an",
        }
        query_words = set(re.findall(r'[a-zA-Z_]\w{2,}', query_text.lower()))
        query_words -= stop_words

        if not query_words:
            return 0.7  # No specific keywords to check

        answer_lower = answer.lower()
        covered = sum(1 for w in query_words if w in answer_lower)
        coverage = covered / len(query_words)

        if coverage < 0.3:
            warnings.append("Answer may not fully address the query")

        return coverage
