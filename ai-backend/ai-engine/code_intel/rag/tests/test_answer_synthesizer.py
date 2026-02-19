"""Tests for answer synthesizer."""

import pytest
from unittest.mock import patch, MagicMock
from ..synthesis.context_builder import ContextSection, SynthesisContext
from ..synthesis.answer_synthesizer import AnswerSynthesizer, SynthesisResult


class TestAnswerSynthesizer:
    def setup_method(self):
        self.synthesizer = AnswerSynthesizer(
            model_name="gemini-2.5-flash",
            fallback_model="gemini-2.0-flash-lite",
            temperature=0.3,
        )

    def _make_context(self):
        sections = [
            ContextSection(
                section_id="s1",
                document_id="doc1",
                title="Setup Guide",
                content="Install Python 3.10+. Run pip install -r requirements.txt.",
                breadcrumbs=["Docs", "Setup Guide"],
                citation_index=1,
                start_line=1,
                end_line=5,
                token_count=20,
            ),
            ContextSection(
                section_id="s2",
                document_id="doc1",
                title="Configuration",
                content="Set API_KEY in .env file. Configure database URL.",
                breadcrumbs=["Docs", "Configuration"],
                citation_index=2,
                start_line=6,
                end_line=10,
                token_count=15,
            ),
        ]
        return SynthesisContext(
            query="How to set up the project?",
            sections=sections,
            total_tokens=35,
        )

    def test_build_prompt(self):
        ctx = self._make_context()
        prompt = self.synthesizer._build_synthesis_prompt(ctx)
        assert "How to set up the project?" in prompt
        assert "[1]" in prompt
        assert "[2]" in prompt
        assert "Setup Guide" in prompt

    def test_extract_citations(self):
        text = "Install Python [1]. Then configure [2] settings [1]."
        markers = self.synthesizer._extract_citation_markers(text)
        assert 1 in markers
        assert 2 in markers

    def test_no_citations(self):
        text = "No citations in this text at all."
        markers = self.synthesizer._extract_citation_markers(text)
        assert len(markers) == 0

    def test_synthesis_result_structure(self):
        result = SynthesisResult(
            answer="Test answer [1].",
            citation_markers=[1],
            model_used="gemini-2.5-flash",
            prompt_tokens=100,
            completion_tokens=50,
        )
        assert result.answer == "Test answer [1]."
        assert result.model_used == "gemini-2.5-flash"
        assert 1 in result.citation_markers

    @patch("google.generativeai.GenerativeModel")
    def test_synthesize_mocked(self, mock_model_class):
        """Test synthesis with mocked Gemini API."""
        mock_model = MagicMock()
        mock_response = MagicMock()
        mock_response.text = "To set up the project, install Python [1] and configure the API key [2]."
        mock_model.generate_content.return_value = mock_response
        mock_model_class.return_value = mock_model

        ctx = self._make_context()
        result = self.synthesizer.synthesize(ctx)
        assert isinstance(result, SynthesisResult)
        assert "[1]" in result.answer or "[2]" in result.answer
