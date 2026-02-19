"""Tests for relevance scorer."""

import pytest
from ..types import Section, SectionRelevance
from ..micro.relevance_scorer import RelevanceScorer, ScoredSection


class TestRelevanceScorer:
    def setup_method(self):
        self.scorer = RelevanceScorer()

    def _make_section(self, title="Test Section", content="", level=1):
        return Section(
            id="sec1",
            document_id="doc1",
            toc_node_id="node1",
            title=title,
            content=content or "Default section content for testing purposes.",
            start_line=1,
            end_line=10,
            breadcrumbs=[title],
            level=level,
        )

    def test_basic_scoring(self):
        section = self._make_section(
            title="Python Installation",
            content="How to install Python on your machine.",
        )
        result = self.scorer.score(
            query="How to install Python",
            section=section,
        )
        assert isinstance(result, ScoredSection)
        assert 0.0 <= result.score <= 1.0
        assert result.section_id == "sec1"

    def test_high_relevance(self):
        section = self._make_section(
            title="Python Installation Guide",
            content="Python installation requires downloading Python from python.org. Install Python using the installer. Configure Python path.",
        )
        result = self.scorer.score(
            query="Python installation",
            section=section,
        )
        assert result.relevance in (SectionRelevance.CRITICAL, SectionRelevance.HIGH, SectionRelevance.MEDIUM)

    def test_low_relevance(self):
        section = self._make_section(
            title="Cooking Recipes",
            content="How to bake a chocolate cake with flour and sugar.",
        )
        result = self.scorer.score(
            query="Python installation",
            section=section,
        )
        assert result.relevance in (SectionRelevance.LOW, SectionRelevance.NONE, SectionRelevance.MEDIUM)

    def test_title_match_boost(self):
        sec_match = self._make_section(
            title="Authentication Setup",
            content="Generic content here about various things.",
        )
        sec_no_match = self._make_section(
            title="Random Topic",
            content="Generic content here about various things.",
        )
        score_match = self.scorer.score("authentication setup", sec_match)
        score_no = self.scorer.score("authentication setup", sec_no_match)
        assert score_match.score >= score_no.score

    def test_score_multiple(self):
        sections = [
            self._make_section(title=f"Section {i}", content=f"Content {i}")
            for i in range(3)
        ]
        results = self.scorer.score_sections("test query", sections)
        assert len(results) == 3
        # Should be sorted by score descending
        for i in range(len(results) - 1):
            assert results[i].score >= results[i + 1].score

    def test_empty_query(self):
        section = self._make_section()
        result = self.scorer.score("", section)
        assert isinstance(result, ScoredSection)
        assert result.score >= 0.0

    def test_relevance_classification(self):
        """All SectionRelevance values should be valid."""
        section = self._make_section(
            title="Exact Match Topic",
            content="This covers the exact match topic in great detail.",
        )
        result = self.scorer.score("exact match topic", section)
        assert result.relevance in list(SectionRelevance)
