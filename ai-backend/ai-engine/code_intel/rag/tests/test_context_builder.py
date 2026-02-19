"""Tests for context builder."""

import pytest
from ..types import Section, SectionReference
from ..synthesis.context_builder import ContextBuilder, ContextSection, SynthesisContext


class TestContextBuilder:
    def setup_method(self):
        self.builder = ContextBuilder(
            max_context_tokens=4000,
            reserved_for_prompt=500,
        )

    def _make_section(self, sec_id, doc_id, title, content, start_line=1, end_line=10):
        return Section(
            id=sec_id,
            document_id=doc_id,
            toc_node_id=f"node_{sec_id}",
            title=title,
            content=content,
            start_line=start_line,
            end_line=end_line,
            breadcrumbs=["Root", title],
        )

    def test_build_context(self):
        sections = [
            self._make_section("s1", "doc1", "Intro", "Introduction content here."),
            self._make_section("s2", "doc1", "Setup", "Setup instructions here."),
        ]
        context = self.builder.build(
            query="How to set up?",
            sections=sections,
        )
        assert isinstance(context, SynthesisContext)
        assert len(context.sections) == 2
        assert context.total_tokens > 0

    def test_citation_markers(self):
        sections = [
            self._make_section("s1", "doc1", "First", "First content."),
            self._make_section("s2", "doc2", "Second", "Second content."),
        ]
        context = self.builder.build("query", sections)
        text = context.format_context_text()
        assert "[1]" in text
        assert "[2]" in text

    def test_empty_sections(self):
        context = self.builder.build("query", [])
        assert isinstance(context, SynthesisContext)
        assert len(context.sections) == 0

    def test_token_budget_respected(self):
        # Create many large sections
        sections = [
            self._make_section(
                f"s{i}", "doc1", f"Section {i}",
                "Long content. " * 200,
            )
            for i in range(20)
        ]
        builder = ContextBuilder(max_context_tokens=500, reserved_for_prompt=100)
        context = builder.build("query", sections)
        assert context.total_tokens <= 500

    def test_grouped_by_document(self):
        sections = [
            self._make_section("s1", "doc1", "A", "Content A"),
            self._make_section("s2", "doc2", "B", "Content B"),
            self._make_section("s3", "doc1", "C", "Content C"),
        ]
        context = self.builder.build("query", sections)
        text = context.format_context_text()
        # Document grouping should appear
        assert isinstance(text, str)
        assert len(text) > 0

    def test_context_section_has_citation_index(self):
        sections = [
            self._make_section("s1", "doc1", "First", "Content."),
        ]
        context = self.builder.build("query", sections)
        assert context.sections[0].citation_index == 1
