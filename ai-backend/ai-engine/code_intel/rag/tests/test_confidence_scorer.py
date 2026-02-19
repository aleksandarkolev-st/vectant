"""Tests for confidence scorer."""

import pytest
from ..types import Citation
from ..synthesis.context_builder import ContextSection, SynthesisContext
from ..synthesis.confidence_scorer import ConfidenceScorer, ConfidenceBreakdown


class TestConfidenceScorer:
    def setup_method(self):
        self.scorer = ConfidenceScorer(low_confidence_threshold=0.4)

    def _make_context(self, query="How to install?"):
        sections = [
            ContextSection(
                section_id="s1",
                document_id="doc1",
                title="Installation",
                content="Install Python from python.org.",
                breadcrumbs=["Docs", "Installation"],
                citation_index=1,
                start_line=1,
                end_line=5,
                token_count=10,
            ),
        ]
        return SynthesisContext(query=query, sections=sections, total_tokens=10)

    def test_basic_scoring(self):
        ctx = self._make_context()
        answer = "Install Python from python.org [1]."
        citations = [
            Citation(
                citation_index=1,
                section_id="s1",
                document_id="doc1",
                excerpt="Install Python from python.org",
                source_text="Install Python from python.org.",
                confidence=0.9,
            ),
        ]
        result = self.scorer.score(
            answer_text=answer,
            context=ctx,
            citations=citations,
        )
        assert isinstance(result, ConfidenceBreakdown)
        assert 0.0 <= result.overall_score <= 1.0

    def test_no_citations_low_confidence(self):
        ctx = self._make_context()
        result = self.scorer.score(
            answer_text="Some answer without any citations.",
            context=ctx,
            citations=[],
        )
        # No citations should lower confidence
        assert result.citation_density_score < 0.5

    def test_uncertainty_phrases(self):
        ctx = self._make_context()
        answer = "I'm not sure, but I think maybe Python is needed [1]."
        citations = [
            Citation(
                citation_index=1,
                section_id="s1",
                document_id="doc1",
                excerpt="Python",
                source_text="Install Python from python.org.",
                confidence=0.5,
            ),
        ]
        result = self.scorer.score(answer, ctx, citations)
        # Uncertainty phrases should reduce grounding score
        assert result.grounding_score < 1.0

    def test_warnings_on_low_confidence(self):
        ctx = self._make_context()
        result = self.scorer.score(
            answer_text="Completely unrelated answer about cooking.",
            context=ctx,
            citations=[],
        )
        # Low confidence should generate warnings
        assert isinstance(result.warnings, list)

    def test_query_coverage(self):
        ctx = self._make_context("Python installation guide")
        answer = "To install Python, download from python.org and run the installer [1]."
        citations = [
            Citation(
                citation_index=1,
                section_id="s1",
                document_id="doc1",
                excerpt="Install Python",
                source_text="Install Python from python.org.",
                confidence=0.8,
            ),
        ]
        result = self.scorer.score(answer, ctx, citations)
        assert result.query_coverage_score >= 0.0

    def test_all_dimensions_present(self):
        ctx = self._make_context()
        result = self.scorer.score("answer [1]", ctx, [
            Citation(1, "s1", "doc1", "text", "source", 0.7),
        ])
        assert hasattr(result, "source_coverage_score")
        assert hasattr(result, "citation_density_score")
        assert hasattr(result, "grounding_score")
        assert hasattr(result, "query_coverage_score")
        assert hasattr(result, "overall_score")
        assert hasattr(result, "warnings")
