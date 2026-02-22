"""Tests for query analyzer."""

import pytest
from ..macro.query_analyzer import QueryAnalyzer, QueryIntent, AnalyzedQuery


class TestQueryAnalyzer:
    def setup_method(self):
        self.analyzer = QueryAnalyzer()

    def test_keyword_extraction(self):
        result = self.analyzer.analyze(
            "How does the AuthService handle OAuth tokens?",
            generate_embedding=False,
        )
        assert "AuthService" in result.keywords or "authservice" in [k.lower() for k in result.keywords]
        assert "OAuth" in result.keywords or "oauth" in [k.lower() for k in result.keywords]
        # Stop words should be removed
        assert result.stop_words_removed > 0

    def test_intent_procedural(self):
        result = self.analyzer.analyze("How to set up OAuth?", generate_embedding=False)
        assert result.intent == QueryIntent.PROCEDURAL

    def test_intent_debugging(self):
        result = self.analyzer.analyze("Why does the login fail?", generate_embedding=False)
        assert result.intent == QueryIntent.DEBUGGING

    def test_intent_factual(self):
        result = self.analyzer.analyze("What is the VectorIndex?", generate_embedding=False)
        assert result.intent == QueryIntent.FACTUAL

    def test_intent_comparison(self):
        result = self.analyzer.analyze(
            "What's the difference between OAuth and API keys?",
            generate_embedding=False,
        )
        assert result.intent == QueryIntent.COMPARISON

    def test_intent_conceptual(self):
        result = self.analyzer.analyze(
            "How does the architecture work?",
            generate_embedding=False,
        )
        assert result.intent == QueryIntent.CONCEPTUAL

    def test_entity_extraction_pascal_case(self):
        result = self.analyzer.analyze(
            "The AuthService uses VectorIndex for search",
            generate_embedding=False,
        )
        assert "AuthService" in result.entities or "VectorIndex" in result.entities

    def test_entity_extraction_backtick(self):
        result = self.analyzer.analyze(
            "What does `generate_content` do?",
            generate_embedding=False,
        )
        assert "generate_content" in result.entities

    def test_entity_extraction_upper_case(self):
        result = self.analyzer.analyze(
            "What is MAX_RETRIES?",
            generate_embedding=False,
        )
        assert "MAX_RETRIES" in result.entities

    def test_keyword_expansion(self):
        result = self.analyzer.analyze(
            "AuthService configuration",
            generate_embedding=False,
        )
        all_kw = result.all_keywords
        # PascalCase should be split
        lower_kw = [k.lower() for k in all_kw]
        assert "auth" in lower_kw or "service" in lower_kw

    def test_empty_query_raises(self):
        with pytest.raises(Exception):
            self.analyzer.analyze("", generate_embedding=False)

    def test_expanded_text(self):
        result = self.analyzer.analyze("How does auth work?", generate_embedding=False)
        assert len(result.expanded_text) > 0
