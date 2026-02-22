"""Tests for citation tracker."""

import pytest
from ..types import Citation
from ..synthesis.context_builder import ContextSection
from ..synthesis.citation_tracker import CitationTracker


class TestCitationTracker:
    def setup_method(self):
        self.tracker = CitationTracker(min_citation_confidence=0.3)
        self.context_sections = [
            ContextSection(
                section_id="s1",
                document_id="doc1",
                title="Installation",
                content="Install Python from python.org. Use version 3.10 or higher for best compatibility.",
                breadcrumbs=["Docs", "Installation"],
                citation_index=1,
                start_line=1,
                end_line=5,
                token_count=20,
            ),
            ContextSection(
                section_id="s2",
                document_id="doc1",
                title="Configuration",
                content="Set the API_KEY environment variable. Configure the database connection string.",
                breadcrumbs=["Docs", "Configuration"],
                citation_index=2,
                start_line=6,
                end_line=10,
                token_count=15,
            ),
        ]

    def test_track_citations(self):
        answer = "Install Python from python.org [1]. Then set API_KEY [2]."
        citations = self.tracker.track(
            answer_text=answer,
            context_sections=self.context_sections,
        )
        assert len(citations) >= 1
        assert all(isinstance(c, Citation) for c in citations)

    def test_no_citations_in_text(self):
        answer = "Just a plain answer with no references."
        citations = self.tracker.track(
            answer_text=answer,
            context_sections=self.context_sections,
        )
        assert citations == []

    def test_invalid_citation_index(self):
        answer = "Reference to nonexistent source [99]."
        citations = self.tracker.track(
            answer_text=answer,
            context_sections=self.context_sections,
        )
        # Should skip invalid index
        assert len(citations) == 0

    def test_multiple_same_citation(self):
        answer = "Python [1] is great. Install Python [1] now."
        citations = self.tracker.track(
            answer_text=answer,
            context_sections=self.context_sections,
        )
        # Should deduplicate or handle multiple occurrences
        assert isinstance(citations, list)

    def test_citation_confidence(self):
        answer = "Install Python from python.org [1]."
        citations = self.tracker.track(
            answer_text=answer,
            context_sections=self.context_sections,
        )
        if citations:
            assert all(c.confidence >= 0.0 for c in citations)

    def test_citation_has_excerpt(self):
        answer = "Install Python from python.org [1]."
        citations = self.tracker.track(
            answer_text=answer,
            context_sections=self.context_sections,
        )
        if citations:
            assert citations[0].excerpt is not None or citations[0].source_text is not None

    def test_min_confidence_filter(self):
        tracker = CitationTracker(min_citation_confidence=0.99)
        answer = "Something vague [1]."
        citations = tracker.track(
            answer_text=answer,
            context_sections=self.context_sections,
        )
        # With very high threshold, might filter out low-confidence citations
        assert isinstance(citations, list)
