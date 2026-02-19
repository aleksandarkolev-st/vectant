"""Tests for RAG API endpoints."""

import pytest
from unittest.mock import patch, MagicMock, AsyncMock
from ..api import register_rag_routes
from ..types import RAGResult


class TestRAGAPI:
    """Unit-level tests for the API route handlers."""

    def test_register_routes(self):
        """Routes should register without error."""
        mock_router = MagicMock()
        mock_router.post = MagicMock(return_value=lambda f: f)
        mock_router.get = MagicMock(return_value=lambda f: f)
        register_rag_routes(mock_router)
        # Should have called post and get decorators
        assert mock_router.post.called or mock_router.get.called

    def test_rag_result_serialization(self):
        """RAGResult should serialize for JSON response."""
        result = RAGResult(
            query="test query",
            answer="Test answer [1].",
            citations=[],
            confidence=0.85,
            documents_searched=3,
            sections_used=2,
            model_used="gemini-2.5-flash",
            timing_ms=150.0,
        )
        d = result.to_dict()
        assert d["query"] == "test query"
        assert d["answer"] == "Test answer [1]."
        assert d["confidence"] == 0.85
        assert d["documents_searched"] == 3
        assert d["model_used"] == "gemini-2.5-flash"

    def test_rag_result_roundtrip(self):
        result = RAGResult(
            query="q",
            answer="a",
            citations=[],
            confidence=0.5,
            documents_searched=1,
            sections_used=1,
            model_used="test",
            timing_ms=10.0,
        )
        d = result.to_dict()
        restored = RAGResult.from_dict(d)
        assert restored.query == result.query
        assert restored.answer == result.answer
        assert restored.confidence == result.confidence
