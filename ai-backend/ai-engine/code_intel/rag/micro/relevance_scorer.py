"""
Relevance Scorer — Score section relevance to a query.

Provides both fast heuristic scoring and optional LLM-based scoring
for more precise relevance assessment. Used to:
- Re-rank sections after tree navigation
- Filter out low-relevance sections before synthesis
- Assign confidence scores for citations
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from typing import Dict, List, Optional, Set, Tuple

from ..config import MicroConfig, RAGConfig, get_rag_config
from ..types import Section, SectionRelevance

logger = logging.getLogger("code_intel.rag.micro.relevance_scorer")


@dataclass
class ScoredSection:
    """A section with its relevance score and classification."""
    section: Section
    score: float                      # 0.0 - 1.0
    relevance: SectionRelevance
    keyword_overlap: int = 0
    title_match: bool = False

    def __repr__(self) -> str:
        return (
            f"ScoredSection(title={self.section.title!r}, "
            f"score={self.score:.3f}, "
            f"relevance={self.relevance.value})"
        )


class RelevanceScorer:
    """
    Score and classify section relevance to a query.

    Scoring signals:
    - Keyword overlap between query and section (title + content + keywords)
    - Title match (exact phrases from query appear in title)
    - Structural hints (depth, position in document)
    - Content density (information-to-noise ratio)
    """

    def __init__(
        self,
        config: Optional[RAGConfig] = None,
    ):
        """
        Initialize relevance scorer.

        Args:
            config: RAG configuration.
        """
        self.config = config or get_rag_config()
        self._micro = self.config.micro

    # =========================================================================
    # Public API
    # =========================================================================

    def score_sections(
        self,
        query_text: str,
        sections: List[Section],
        query_keywords: Optional[List[str]] = None,
    ) -> List[ScoredSection]:
        """
        Score and rank sections by relevance to query.

        Args:
            query_text: Original query text.
            sections: Sections to score.
            query_keywords: Pre-extracted query keywords (optional).

        Returns:
            List of ScoredSection, sorted by score descending.
        """
        if not sections:
            return []

        # Extract query keywords if not provided
        if query_keywords is None:
            query_keywords = self._extract_keywords(query_text)

        query_words = {kw.lower() for kw in query_keywords}

        scored: List[ScoredSection] = []
        for section in sections:
            score, overlap, title_hit = self._score_section(
                query_text, query_words, section
            )
            relevance = self._classify_relevance(score)

            scored.append(ScoredSection(
                section=section,
                score=score,
                relevance=relevance,
                keyword_overlap=overlap,
                title_match=title_hit,
            ))

        # Sort by score descending
        scored.sort(key=lambda s: s.score, reverse=True)
        return scored

    def filter_relevant(
        self,
        query_text: str,
        sections: List[Section],
        min_score: Optional[float] = None,
        query_keywords: Optional[List[str]] = None,
    ) -> List[ScoredSection]:
        """
        Score sections and filter to only relevant ones.

        Args:
            query_text: Query text.
            sections: Sections to evaluate.
            min_score: Minimum score threshold. Defaults to config.
            query_keywords: Pre-extracted keywords.

        Returns:
            Filtered and sorted list of ScoredSection.
        """
        min_score = min_score or self._micro.min_relevance_score
        scored = self.score_sections(query_text, sections, query_keywords)
        return [s for s in scored if s.score >= min_score]

    # =========================================================================
    # Internal: Scoring
    # =========================================================================

    def _score_section(
        self,
        query_text: str,
        query_words: Set[str],
        section: Section,
    ) -> Tuple[float, int, bool]:
        """
        Score a single section.

        Returns:
            Tuple of (score, keyword_overlap_count, title_match_flag).
        """
        signals: List[Tuple[float, float]] = []  # (score, weight) pairs

        # Signal 1: Keyword overlap with section keywords (weight: 0.30)
        section_kw = {kw.lower() for kw in section.keywords}
        kw_overlap = len(query_words & section_kw)
        max_possible = max(len(query_words), 1)
        kw_score = min(1.0, kw_overlap / max_possible)
        signals.append((kw_score, 0.30))

        # Signal 2: Title relevance (weight: 0.25)
        title_words = set(section.title.lower().split())
        title_overlap = len(query_words & title_words)
        title_score = min(1.0, title_overlap / max(len(query_words), 1))
        title_match = title_overlap > 0
        signals.append((title_score, 0.25))

        # Signal 3: Content keyword frequency (weight: 0.25)
        content_lower = section.content.lower()
        content_hits = sum(
            1 for kw in query_words
            if kw in content_lower
        )
        content_score = min(1.0, content_hits / max(len(query_words), 1))
        signals.append((content_score, 0.25))

        # Signal 4: Structural position (weight: 0.10)
        # Prefer mid-depth sections (not too general, not too specific)
        depth_penalty = 0.0
        if section.depth <= 1:
            depth_penalty = 0.1  # Too general
        elif section.depth >= 4:
            depth_penalty = 0.2  # Too specific
        struct_score = max(0.0, 1.0 - depth_penalty)
        signals.append((struct_score, 0.10))

        # Signal 5: Content density (weight: 0.10)
        # Prefer sections with substantial content
        if section.token_count > 0:
            density = min(1.0, section.token_count / 200)
        else:
            density = 0.1
        signals.append((density, 0.10))

        # Weighted sum
        total_score = sum(s * w for s, w in signals)

        # Exact phrase matching bonus
        query_lower = query_text.lower()
        # Check if multi-word phrases from query appear in content
        if len(query_words) >= 2:
            words = query_text.lower().split()
            for i in range(len(words) - 1):
                bigram = f"{words[i]} {words[i + 1]}"
                if bigram in content_lower or bigram in section.title.lower():
                    total_score = min(1.0, total_score + 0.15)
                    break

        return total_score, kw_overlap, title_match

    def _classify_relevance(self, score: float) -> SectionRelevance:
        """Classify a score into a relevance level."""
        if score >= 0.7:
            return SectionRelevance.CRITICAL
        elif score >= 0.5:
            return SectionRelevance.HIGH
        elif score >= 0.3:
            return SectionRelevance.MEDIUM
        elif score >= 0.1:
            return SectionRelevance.LOW
        else:
            return SectionRelevance.NONE

    # =========================================================================
    # Internal: Keyword Extraction
    # =========================================================================

    def _extract_keywords(self, text: str) -> List[str]:
        """Extract keywords from text (simplified version)."""
        stop = {
            "a", "an", "the", "is", "are", "was", "be", "have", "has",
            "do", "does", "did", "will", "would", "could", "should",
            "in", "on", "at", "to", "for", "of", "with", "by", "from",
            "and", "but", "or", "not", "if", "how", "what", "which",
            "who", "when", "where", "why", "i", "me", "my", "we",
            "you", "your", "they", "them", "their", "this", "that",
        }
        tokens = re.findall(r'[a-zA-Z_][a-zA-Z0-9_]*', text)
        return [t for t in tokens if t.lower() not in stop and len(t) > 1]
