"""
Summary Generator — Generate document-level summaries for macro-retrieval.

Produces a 2-5 sentence high-level summary for each document,
plus key topics and entities. These summaries are embedded into the
fast vector index for macro-retrieval (Step 2).

Two modes:
- Deterministic: heuristic extraction (no LLM) — fast, free, consistent
- LLM-augmented: use fast model for better summaries — higher quality
"""

from __future__ import annotations

import logging
import re
from typing import Dict, List, Optional

from ..types import (
    Document,
    DocumentFormat,
    DocumentSummary,
    Section,
    ToCTree,
)
from ..config import IngestionConfig
from ..exceptions import SummaryGenerationError


logger = logging.getLogger("code_intel.rag.ingestion.summary_gen")


class SummaryGenerator:
    """
    Generate document-level summaries.

    Uses deterministic heuristics by default. Can optionally use a fast LLM
    for higher-quality summaries.
    """

    def __init__(
        self,
        config: Optional[IngestionConfig] = None,
        llm_client: Optional[object] = None,
    ):
        """
        Initialize summary generator.

        Args:
            config: Ingestion configuration.
            llm_client: Optional LLM client for augmented summaries.
        """
        self.config = config or IngestionConfig()
        self.llm_client = llm_client

    def generate(
        self,
        document: Document,
        toc: Optional[ToCTree] = None,
        sections: Optional[List[Section]] = None,
    ) -> DocumentSummary:
        """
        Generate a summary for a document.

        Args:
            document: Source document.
            toc: Optional ToC tree (provides structural context).
            sections: Optional pre-split sections.

        Returns:
            DocumentSummary with summary text, topics, and entities.

        Raises:
            SummaryGenerationError: If summary generation fails.
        """
        try:
            if self.llm_client:
                return self._generate_llm_summary(document, toc, sections)
            return self._generate_heuristic_summary(document, toc, sections)
        except SummaryGenerationError:
            raise
        except Exception as e:
            raise SummaryGenerationError(
                f"Failed to generate summary for {document.metadata.file_name}",
                details={"document_id": document.id},
                cause=e,
            )

    def _generate_heuristic_summary(
        self,
        document: Document,
        toc: Optional[ToCTree] = None,
        sections: Optional[List[Section]] = None,
    ) -> DocumentSummary:
        """
        Generate summary using deterministic heuristics.

        Strategy:
        1. Extract title and first paragraph as summary base
        2. Use ToC headings as key topics
        3. Extract named entities (capitalized words, API names)
        """
        content = document.content
        title = document.title

        # Build summary text
        summary_text = self._build_summary_text(document, toc)

        # Extract topics from ToC headings
        key_topics = self._extract_topics(document, toc)

        # Extract entities
        key_entities = self._extract_entities(content)

        return DocumentSummary(
            document_id=document.id,
            title=title,
            summary_text=summary_text,
            key_topics=key_topics[:self.config.summary_max_topics],
            key_entities=key_entities[:self.config.summary_max_entities],
            content_hash=document.metadata.content_hash,
            section_count=len(sections) if sections else 0,
            word_count=document.metadata.word_count,
        )

    def _build_summary_text(
        self,
        document: Document,
        toc: Optional[ToCTree] = None,
    ) -> str:
        """Build summary text from document content."""
        parts: List[str] = []
        content = document.content

        if document.format == DocumentFormat.MARKDOWN:
            parts.append(self._summarize_markdown(content))
        elif document.format == DocumentFormat.CODE:
            parts.append(self._summarize_code(document))
        else:
            parts.append(self._summarize_plain_text(content))

        # Add ToC overview if available
        if toc and toc.root.children:
            headings = [c.title for c in toc.root.children[:8]]
            if headings:
                parts.append(
                    f"Main sections: {', '.join(headings)}."
                )

        summary = " ".join(parts)

        # Truncate to max tokens
        max_chars = self.config.summary_max_tokens * 4
        if len(summary) > max_chars:
            summary = summary[:max_chars - 3] + "..."

        return summary

    def _summarize_markdown(self, content: str) -> str:
        """Extract summary from markdown content."""
        lines = content.split("\n")
        summary_lines: List[str] = []

        in_code_block = False
        heading_seen = False

        for line in lines:
            stripped = line.strip()

            # Skip code blocks
            if stripped.startswith("```") or stripped.startswith("~~~"):
                in_code_block = not in_code_block
                continue
            if in_code_block:
                continue

            # Skip headings (we use them for topics)
            if stripped.startswith("#"):
                heading_seen = True
                continue

            # Skip empty lines
            if not stripped:
                if summary_lines:
                    break  # Stop at first empty line after content
                continue

            # Skip front matter
            if stripped == "---":
                continue

            # Collect first paragraph
            summary_lines.append(stripped)

            # Enough for a summary
            if len(" ".join(summary_lines)) > 300:
                break

        if summary_lines:
            return " ".join(summary_lines)

        # Fallback: use first non-empty line
        for line in lines[:20]:
            stripped = line.strip().lstrip("#").strip()
            if stripped and len(stripped) > 10:
                return stripped

        return f"Document: {content[:100]}..." if content else "Empty document."

    def _summarize_code(self, document: Document) -> str:
        """Extract summary from code file."""
        content = document.content
        lang = document.metadata.language
        lines = content.split("\n")

        # Try to extract module docstring
        if lang == "python":
            docstring = self._extract_python_docstring(lines)
            if docstring:
                return docstring

        # Try to extract top-level comment
        comment_lines: List[str] = []
        for line in lines[:30]:
            stripped = line.strip()
            if stripped.startswith("#") and lang == "python":
                comment_lines.append(stripped.lstrip("#").strip())
            elif stripped.startswith("//"):
                comment_lines.append(stripped.lstrip("/").strip())
            elif stripped.startswith("/*") or stripped.startswith("*"):
                text = stripped.strip("/*").strip()
                if text:
                    comment_lines.append(text)
            elif stripped and not stripped.startswith(("import", "from", "use", "package")):
                break

        if comment_lines:
            return " ".join(comment_lines[:5])

        # Fallback: list top-level definitions
        definitions = self._extract_top_definitions(lines, lang)
        if definitions:
            return f"{document.metadata.file_name}: defines {', '.join(definitions[:5])}."

        return f"Code file: {document.metadata.file_name}"

    def _extract_python_docstring(self, lines: List[str]) -> str:
        """Extract Python module-level docstring."""
        in_docstring = False
        docstring_lines: List[str] = []

        for line in lines[:30]:
            stripped = line.strip()
            if not in_docstring:
                if stripped.startswith('"""') or stripped.startswith("'''"):
                    in_docstring = True
                    quote = stripped[:3]
                    # Check for single-line docstring
                    rest = stripped[3:]
                    if rest.endswith(quote):
                        return rest[:-3].strip()
                    if rest:
                        docstring_lines.append(rest)
                elif stripped and not stripped.startswith("#"):
                    break  # Non-comment, non-docstring line
            else:
                if stripped.endswith('"""') or stripped.endswith("'''"):
                    text = stripped[:-3].strip()
                    if text:
                        docstring_lines.append(text)
                    break
                docstring_lines.append(stripped)

        if docstring_lines:
            return " ".join(docstring_lines[:5])
        return ""

    def _extract_top_definitions(self, lines: List[str], lang: str) -> List[str]:
        """Extract names of top-level definitions."""
        definitions: List[str] = []

        for line in lines:
            stripped = line.strip()
            if lang == "python":
                match = re.match(r"^(?:class|def)\s+(\w+)", stripped)
                if match:
                    definitions.append(match.group(1))
            elif lang in ("typescript", "javascript"):
                match = re.match(
                    r"^(?:export\s+)?(?:class|function|interface|type|const|let)\s+(\w+)",
                    stripped,
                )
                if match:
                    definitions.append(match.group(1))
            else:
                match = re.match(r"^(?:pub\s+)?(?:fn|func|struct|enum|class|interface)\s+(\w+)", stripped)
                if match:
                    definitions.append(match.group(1))

        return definitions

    def _summarize_plain_text(self, content: str) -> str:
        """Extract summary from plain text."""
        # Use first paragraph
        paragraphs = content.strip().split("\n\n")
        if paragraphs:
            first_para = paragraphs[0].strip()
            if len(first_para) > 400:
                return first_para[:397] + "..."
            return first_para
        return content[:200] + "..."

    def _extract_topics(
        self,
        document: Document,
        toc: Optional[ToCTree] = None,
    ) -> List[str]:
        """Extract key topics from document structure."""
        topics: List[str] = []

        if toc:
            # Use ToC headings as topics
            for node in toc.root.children:
                topics.append(node.title)
                # Add sub-headings for top-level sections
                for child in node.children[:3]:
                    topics.append(child.title)

        if not topics:
            # Fallback: extract capitalized phrases
            content = document.content[:2000]
            matches = re.findall(r"\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b", content)
            topics = list(dict.fromkeys(matches))  # Dedup preserving order

        return topics[:self.config.summary_max_topics]

    def _extract_entities(self, content: str) -> List[str]:
        """
        Extract named entities from content.

        Heuristic: look for PascalCase words, ALL_CAPS constants,
        and quoted terms.
        """
        entities: List[str] = []
        seen: set = set()

        # PascalCase identifiers
        for match in re.finditer(r"\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b", content):
            name = match.group(1)
            if name.lower() not in seen:
                seen.add(name.lower())
                entities.append(name)

        # ALL_CAPS constants
        for match in re.finditer(r"\b([A-Z][A-Z_]{2,})\b", content):
            name = match.group(1)
            if name.lower() not in seen and name not in ("README", "TODO", "NOTE", "FIXME", "HACK"):
                seen.add(name.lower())
                entities.append(name)

        # Backtick-quoted terms (common in documentation)
        for match in re.finditer(r"`([^`]+)`", content):
            name = match.group(1).strip()
            if name.lower() not in seen and 2 < len(name) < 50:
                seen.add(name.lower())
                entities.append(name)

        return entities[:self.config.summary_max_entities]

    def _generate_llm_summary(
        self,
        document: Document,
        toc: Optional[ToCTree] = None,
        sections: Optional[List[Section]] = None,
    ) -> DocumentSummary:
        """
        Generate summary using LLM.

        Falls back to heuristic if LLM call fails.
        """
        # Build prompt context
        prompt_parts = [
            f"Document: {document.title}",
            f"Format: {document.format.value}",
        ]

        if toc:
            toc_text = toc.format_for_llm(max_depth=3)
            prompt_parts.append(f"\nTable of Contents:\n{toc_text}")

        # Include first portion of content
        content_preview = document.content[:3000]
        prompt_parts.append(f"\nContent preview:\n{content_preview}")

        prompt = "\n".join(prompt_parts)

        try:
            # Call LLM for summary
            # This is a simplified interface — actual implementation depends
            # on the LLM client used
            response = self._call_llm(prompt)
            if response:
                summary_text = response.get("summary", "")
                topics = response.get("topics", [])
                entities = response.get("entities", [])
            else:
                # Fallback to heuristic
                return self._generate_heuristic_summary(document, toc, sections)
        except Exception as e:
            logger.warning(f"LLM summary failed, falling back to heuristic: {e}")
            return self._generate_heuristic_summary(document, toc, sections)

        return DocumentSummary(
            document_id=document.id,
            title=document.title,
            summary_text=summary_text,
            key_topics=topics[:self.config.summary_max_topics],
            key_entities=entities[:self.config.summary_max_entities],
            content_hash=document.metadata.content_hash,
            section_count=len(sections) if sections else 0,
            word_count=document.metadata.word_count,
        )

    def _call_llm(self, prompt: str) -> Optional[Dict]:
        """
        Call the LLM client for summary generation.

        Returns dict with 'summary', 'topics', 'entities' keys.
        Returns None if no LLM client configured.
        """
        if not self.llm_client:
            return None

        # The actual LLM call would be implemented based on the
        # specific client (Gemini, OpenAI, etc.)
        # For now, we return None to trigger heuristic fallback
        try:
            if hasattr(self.llm_client, "generate_summary"):
                return self.llm_client.generate_summary(prompt)
        except Exception as e:
            logger.warning(f"LLM call failed: {e}")
        return None
