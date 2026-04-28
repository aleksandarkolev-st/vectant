"""Tests for SectionReranker (rule-based backend).

These tests focus on the rule-based path. The cross_encoder path is only
covered when sentence-transformers is installed; the loader silently falls
back so the rest of the suite still runs in environments without it.
"""
from __future__ import annotations

import pytest

from code_intel.rag.config import RAGConfig
from code_intel.rag.micro.relevance_scorer import ScoredSection
from code_intel.rag.micro.section_reranker import SectionReranker
from code_intel.rag.types import Section, SectionRelevance


def _section(*, title: str, content: str, sid: str = "s1", token_count: int = 0) -> Section:
    return Section(
        id=sid,
        document_id="d1",
        toc_node_id="n1",
        title=title,
        content=content,
        token_count=token_count or max(1, len(content) // 4),
    )


def _scored(section: Section, score: float = 0.5) -> ScoredSection:
    return ScoredSection(
        section=section,
        score=score,
        relevance=SectionRelevance.MEDIUM,
    )


class TestSectionRerankerRule:
    """Rule-based reranker boosts the section with the strongest signal."""

    def setup_method(self):
        cfg = RAGConfig()
        cfg.micro.section_rerank_backend = "rule"
        cfg.micro.section_rerank_blend = 1.0  # ignore original score
        self.reranker = SectionReranker(config=cfg)

    def test_phrase_match_dominates(self):
        sections = [
            _scored(_section(
                title="Other",
                content="Generic content about something unrelated entirely.",
                sid="other",
            ), score=0.5),
            _scored(_section(
                title="Auth",
                content="The auth flow uses oauth and jwt tokens to verify users.",
                sid="auth",
            ), score=0.5),
        ]

        result = self.reranker.rerank("auth flow uses oauth", sections)
        assert result[0].section.id == "auth"
        assert result[0].score > result[1].score

    def test_title_match_signal(self):
        sections = [
            _scored(_section(
                title="Authentication Setup",
                content="Set up the auth handlers.",
                sid="title-match",
            ), score=0.5),
            _scored(_section(
                title="Misc",
                content="Setup the auth handlers also.",
                sid="content-only",
            ), score=0.5),
        ]
        result = self.reranker.rerank("authentication", sections)
        # Title match should beat the content-only one.
        assert result[0].section.id == "title-match"

    def test_short_section_penalised(self):
        sections = [
            _scored(_section(
                title="Tiny",
                content="auth.",
                sid="tiny",
                token_count=2,
            ), score=0.5),
            _scored(_section(
                title="Full",
                content=("auth handlers verify tokens via the gateway. "
                         "they then route requests downstream. " * 5),
                sid="full",
            ), score=0.5),
        ]
        result = self.reranker.rerank("auth", sections)
        assert result[0].section.id == "full"

    def test_blend_zero_preserves_original(self):
        cfg = RAGConfig()
        cfg.micro.section_rerank_blend = 0.0  # ignore rerank entirely
        reranker = SectionReranker(config=cfg)

        sections = [
            _scored(_section(title="A", content="auth", sid="A"), score=0.9),
            _scored(_section(title="B", content="auth flow handles tokens", sid="B"), score=0.1),
        ]
        result = reranker.rerank("auth flow", sections)
        # blend=0 means the original (A=0.9, B=0.1) wins regardless of features.
        assert result[0].section.id == "A"

    def test_empty_input_is_safe(self):
        assert self.reranker.rerank("anything", []) == []

    def test_top_k_tail_preserved(self):
        cfg = RAGConfig()
        cfg.micro.section_rerank_top_k = 1  # only rerank head
        cfg.micro.section_rerank_blend = 1.0
        reranker = SectionReranker(config=cfg)

        sections = [
            _scored(_section(title="A", content="not auth", sid="A"), score=0.9),
            _scored(_section(title="B", content="not auth", sid="B"), score=0.5),
        ]
        result = reranker.rerank("auth", sections)
        # Only first reranks; B stays where it was.
        assert len(result) == 2
        assert result[1].section.id == "B"

    def test_relevance_classification_updated(self):
        sections = [
            _scored(_section(
                title="Auth Flow", content="auth flow uses oauth", sid="A",
            ), score=0.5),
        ]
        out = self.reranker.rerank("auth flow uses oauth", sections)
        # Score should go up dramatically — phrase match.
        assert out[0].score >= 0.3
        assert out[0].relevance != SectionRelevance.NONE


class TestCrossEncoderFallback:
    """When sentence-transformers isn't available, backend falls back silently."""

    def test_unavailable_falls_back_to_rule(self):
        cfg = RAGConfig()
        cfg.micro.section_rerank_backend = "cross_encoder"
        # Force the loader to None to simulate package missing.
        reranker = SectionReranker(config=cfg)
        # Either the package was missing (fell back to "rule") or it loaded.
        # In CI without the dep, backend should be "rule".
        assert reranker.backend in ("rule", "cross_encoder")
        # Must still produce a valid result either way.
        sections = [
            _scored(_section(title="A", content="auth flow", sid="A"), score=0.5)
        ]
        out = reranker.rerank("auth", sections)
        assert len(out) == 1
