"""
ToC Extractor — Build Table of Contents trees from documents.

Extracts hierarchical structure from documents:
- Markdown: heading hierarchy (# H1, ## H2, etc.)
- reStructuredText: section titles with underlines
- Code files: class/function hierarchy
- Plain text: paragraph grouping

The resulting ToCTree is the foundation for micro-navigation.
"""

from __future__ import annotations

import hashlib
import logging
import re
from typing import Dict, List, Optional, Tuple

from ..types import (
    Document,
    DocumentFormat,
    ToCNode,
    ToCTree,
    ToCNodeType,
)
from ..config import IngestionConfig
from ..exceptions import ToCExtractionError


logger = logging.getLogger("code_intel.rag.ingestion.toc_extractor")


class ToCExtractor:
    """
    Extract Table of Contents trees from documents.

    Supports multiple document formats with format-specific parsing.
    Falls back to heuristic paragraph grouping for unknown formats.
    """

    def __init__(self, config: Optional[IngestionConfig] = None):
        """
        Initialize ToC extractor.

        Args:
            config: Ingestion configuration.
        """
        self.config = config or IngestionConfig()

    def extract(self, document: Document) -> ToCTree:
        """
        Extract ToC tree from a document.

        Args:
            document: Document to extract ToC from.

        Returns:
            ToCTree with hierarchical structure.

        Raises:
            ToCExtractionError: If extraction fails critically.
        """
        try:
            if document.format == DocumentFormat.MARKDOWN:
                root = self._extract_markdown(document)
            elif document.format == DocumentFormat.RST:
                root = self._extract_rst(document)
            elif document.format == DocumentFormat.CODE:
                root = self._extract_code(document)
            elif document.format == DocumentFormat.HTML:
                root = self._extract_html(document)
            else:
                root = self._extract_plain_text(document)

            tree = ToCTree(
                document_id=document.id,
                root=root,
            )
            tree._rebuild_index()

            logger.debug(
                f"Extracted ToC for {document.metadata.file_name}: "
                f"{tree.total_nodes} nodes, depth {tree.max_depth}"
            )
            return tree

        except ToCExtractionError:
            raise
        except Exception as e:
            raise ToCExtractionError(
                f"Failed to extract ToC from {document.metadata.file_name}",
                details={"document_id": document.id},
                cause=e,
            )

    # =========================================================================
    # Markdown Extraction
    # =========================================================================

    def _extract_markdown(self, document: Document) -> ToCNode:
        """Extract ToC from Markdown document using heading hierarchy."""
        lines = document.content.split("\n")
        root = ToCNode(
            id=f"{document.id}_root",
            title=document.title,
            node_type=ToCNodeType.ROOT,
            depth=0,
            start_line=1,
            end_line=len(lines),
            start_offset=0,
            end_offset=len(document.content),
        )

        # Parse headings
        headings: List[Tuple[int, int, str, int]] = []  # (line_num, depth, title, offset)
        offset = 0
        in_code_block = False

        for line_num, line in enumerate(lines, 1):
            stripped = line.strip()

            # Track fenced code blocks
            if stripped.startswith("```") or stripped.startswith("~~~"):
                in_code_block = not in_code_block
                offset += len(line) + 1
                continue

            if in_code_block:
                offset += len(line) + 1
                continue

            # ATX headings (# H1, ## H2, etc.)
            match = re.match(r"^(#{1,6})\s+(.+?)(?:\s*#*\s*)?$", line)
            if match:
                depth = len(match.group(1))
                title = match.group(2).strip()
                if depth <= self.config.max_toc_depth:
                    headings.append((line_num, depth, title, offset))

            offset += len(line) + 1

        if not headings:
            # No headings found — create single section from full content
            content_preview = document.content[:200].strip()
            child = ToCNode(
                id=f"{document.id}_s0",
                title=document.title or "Document",
                node_type=ToCNodeType.SECTION,
                depth=1,
                start_line=1,
                end_line=len(lines),
                start_offset=0,
                end_offset=len(document.content),
                parent_id=root.id,
                preview=content_preview,
                token_estimate=len(document.content) // 4,
            )
            child.keywords = self._extract_keywords(document.content)
            root.children.append(child)
            return root

        # Build tree from headings
        self._build_heading_tree(root, headings, lines, document)

        return root

    def _build_heading_tree(
        self,
        root: ToCNode,
        headings: List[Tuple[int, int, str, int]],
        lines: List[str],
        document: Document,
    ) -> None:
        """Build tree structure from flat heading list."""
        # Stack-based tree construction
        # Stack contains (node, depth) pairs
        stack: List[Tuple[ToCNode, int]] = [(root, 0)]

        for i, (line_num, depth, title, offset) in enumerate(headings):
            # Determine content boundaries
            start_line = line_num
            if i + 1 < len(headings):
                end_line = headings[i + 1][0] - 1
            else:
                end_line = len(lines)

            # Calculate content offsets
            start_off = offset
            end_off = sum(len(lines[j]) + 1 for j in range(end_line)) if end_line <= len(lines) else len(document.content)
            end_off = min(end_off, len(document.content))

            # Extract section content for preview and keywords
            section_lines = lines[start_line - 1:end_line]
            section_text = "\n".join(section_lines)
            preview = section_text[:200].strip()
            token_estimate = len(section_text) // 4

            node_id = f"{document.id}_h{i}"
            node = ToCNode(
                id=node_id,
                title=title,
                node_type=ToCNodeType.HEADING,
                depth=depth,
                start_line=start_line,
                end_line=end_line,
                start_offset=start_off,
                end_offset=end_off,
                preview=preview,
                token_estimate=token_estimate,
                keywords=self._extract_keywords(section_text),
            )

            # Find parent: pop stack until we find a node with smaller depth
            while len(stack) > 1 and stack[-1][1] >= depth:
                stack.pop()

            parent_node = stack[-1][0]
            node.parent_id = parent_node.id
            parent_node.children.append(node)
            stack.append((node, depth))

    # =========================================================================
    # reStructuredText Extraction
    # =========================================================================

    def _extract_rst(self, document: Document) -> ToCNode:
        """Extract ToC from reStructuredText document."""
        lines = document.content.split("\n")
        root = ToCNode(
            id=f"{document.id}_root",
            title=document.title,
            node_type=ToCNodeType.ROOT,
            depth=0,
            start_line=1,
            end_line=len(lines),
        )

        # RST uses underline characters for heading levels
        # The order they appear defines the hierarchy
        underline_chars = "=-~`'^_*+#"
        char_depth_map: Dict[str, int] = {}
        current_depth = 0

        headings: List[Tuple[int, int, str]] = []

        for i, line in enumerate(lines):
            if i + 1 < len(lines):
                next_line = lines[i + 1].rstrip()
                # Check if next line is an underline
                if (
                    len(next_line) >= 3
                    and next_line == next_line[0] * len(next_line)
                    and next_line[0] in underline_chars
                    and line.strip()
                ):
                    char = next_line[0]
                    if char not in char_depth_map:
                        current_depth += 1
                        char_depth_map[char] = current_depth
                    depth = char_depth_map[char]
                    headings.append((i + 1, depth, line.strip()))

        if not headings:
            # Fallback to paragraph grouping
            return self._extract_plain_text(document)

        self._build_heading_tree(
            root,
            [(ln, d, t, 0) for ln, d, t in headings],
            lines,
            document,
        )
        return root

    # =========================================================================
    # Code File Extraction
    # =========================================================================

    def _extract_code(self, document: Document) -> ToCNode:
        """Extract ToC from code file using class/function structure."""
        lines = document.content.split("\n")
        root = ToCNode(
            id=f"{document.id}_root",
            title=document.title or document.metadata.file_name,
            node_type=ToCNodeType.MODULE,
            depth=0,
            start_line=1,
            end_line=len(lines),
        )

        lang = document.metadata.language

        if lang == "python":
            self._extract_python_structure(root, lines, document)
        elif lang in ("typescript", "javascript"):
            self._extract_ts_structure(root, lines, document)
        elif lang in ("rust", "go", "java", "cpp", "c"):
            self._extract_c_family_structure(root, lines, document)
        else:
            # Generic: split by blank line groups
            self._extract_generic_code(root, lines, document)

        return root

    def _extract_python_structure(
        self,
        root: ToCNode,
        lines: List[str],
        document: Document,
    ) -> None:
        """Extract Python class/function hierarchy."""
        # Pattern for top-level definitions
        class_pattern = re.compile(r"^class\s+(\w+)")
        func_pattern = re.compile(r"^def\s+(\w+)")
        method_pattern = re.compile(r"^\s+def\s+(\w+)")

        current_class: Optional[ToCNode] = None
        idx = 0

        for line_num, line in enumerate(lines, 1):
            # Class definition
            class_match = class_pattern.match(line)
            if class_match:
                name = class_match.group(1)
                end = self._find_python_block_end(lines, line_num - 1)
                section_text = "\n".join(lines[line_num - 1:end])

                node = ToCNode(
                    id=f"{document.id}_cls{idx}",
                    title=f"class {name}",
                    node_type=ToCNodeType.CLASS,
                    depth=1,
                    start_line=line_num,
                    end_line=end,
                    parent_id=root.id,
                    preview=line.strip()[:200],
                    token_estimate=len(section_text) // 4,
                    keywords=self._extract_keywords(section_text),
                )
                root.children.append(node)
                current_class = node
                idx += 1
                continue

            # Top-level function
            func_match = func_pattern.match(line)
            if func_match:
                name = func_match.group(1)
                end = self._find_python_block_end(lines, line_num - 1)
                section_text = "\n".join(lines[line_num - 1:end])

                node = ToCNode(
                    id=f"{document.id}_fn{idx}",
                    title=f"def {name}()",
                    node_type=ToCNodeType.FUNCTION,
                    depth=1,
                    start_line=line_num,
                    end_line=end,
                    parent_id=root.id,
                    preview=line.strip()[:200],
                    token_estimate=len(section_text) // 4,
                    keywords=self._extract_keywords(section_text),
                )
                root.children.append(node)
                current_class = None
                idx += 1
                continue

            # Method inside class
            if current_class:
                method_match = method_pattern.match(line)
                if method_match:
                    name = method_match.group(1)
                    end = self._find_python_block_end(lines, line_num - 1)
                    section_text = "\n".join(lines[line_num - 1:end])

                    node = ToCNode(
                        id=f"{document.id}_mtd{idx}",
                        title=f"def {name}()",
                        node_type=ToCNodeType.FUNCTION,
                        depth=2,
                        start_line=line_num,
                        end_line=end,
                        parent_id=current_class.id,
                        preview=line.strip()[:200],
                        token_estimate=len(section_text) // 4,
                    )
                    current_class.children.append(node)
                    idx += 1

    def _find_python_block_end(self, lines: List[str], start_idx: int) -> int:
        """Find the end of a Python block (class/function)."""
        if start_idx >= len(lines):
            return len(lines)

        # Get indentation of the definition line
        def_line = lines[start_idx]
        def_indent = len(def_line) - len(def_line.lstrip())

        for i in range(start_idx + 1, len(lines)):
            line = lines[i]
            if not line.strip():
                continue
            current_indent = len(line) - len(line.lstrip())
            if current_indent <= def_indent:
                return i
        return len(lines)

    def _extract_ts_structure(
        self,
        root: ToCNode,
        lines: List[str],
        document: Document,
    ) -> None:
        """Extract TypeScript/JavaScript class/function structure."""
        # Patterns for TS/JS definitions
        patterns = [
            (re.compile(r"^(?:export\s+)?class\s+(\w+)"), ToCNodeType.CLASS),
            (re.compile(r"^(?:export\s+)?(?:async\s+)?function\s+(\w+)"), ToCNodeType.FUNCTION),
            (re.compile(r"^(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?\("), ToCNodeType.FUNCTION),
            (re.compile(r"^(?:export\s+)?interface\s+(\w+)"), ToCNodeType.CLASS),
            (re.compile(r"^(?:export\s+)?type\s+(\w+)"), ToCNodeType.CLASS),
        ]

        idx = 0
        for line_num, line in enumerate(lines, 1):
            for pattern, node_type in patterns:
                match = pattern.match(line.strip())
                if match:
                    name = match.group(1)
                    end = self._find_brace_block_end(lines, line_num - 1)
                    section_text = "\n".join(lines[line_num - 1:end])

                    node = ToCNode(
                        id=f"{document.id}_ts{idx}",
                        title=name,
                        node_type=node_type,
                        depth=1,
                        start_line=line_num,
                        end_line=end,
                        parent_id=root.id,
                        preview=line.strip()[:200],
                        token_estimate=len(section_text) // 4,
                        keywords=self._extract_keywords(section_text),
                    )
                    root.children.append(node)
                    idx += 1
                    break

    def _extract_c_family_structure(
        self,
        root: ToCNode,
        lines: List[str],
        document: Document,
    ) -> None:
        """Extract C-family language structure (Rust, Go, Java, C/C++)."""
        # Generic brace-based structure detection
        patterns = [
            re.compile(r"^\s*(?:pub\s+)?(?:struct|enum|trait|impl)\s+(\w+)"),
            re.compile(r"^\s*(?:pub\s+)?(?:fn|func|void|int|string)\s+(\w+)"),
            re.compile(r"^\s*(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface)\s+(\w+)"),
        ]

        idx = 0
        for line_num, line in enumerate(lines, 1):
            for pattern in patterns:
                match = pattern.match(line)
                if match:
                    name = match.group(1)
                    end = self._find_brace_block_end(lines, line_num - 1)
                    section_text = "\n".join(lines[line_num - 1:end])

                    node = ToCNode(
                        id=f"{document.id}_c{idx}",
                        title=name,
                        node_type=ToCNodeType.FUNCTION,
                        depth=1,
                        start_line=line_num,
                        end_line=end,
                        parent_id=root.id,
                        preview=line.strip()[:200],
                        token_estimate=len(section_text) // 4,
                    )
                    root.children.append(node)
                    idx += 1
                    break

    def _extract_generic_code(
        self,
        root: ToCNode,
        lines: List[str],
        document: Document,
    ) -> None:
        """Extract structure from unknown code format using blank line groups."""
        groups: List[Tuple[int, int]] = []
        group_start: Optional[int] = None

        for i, line in enumerate(lines):
            if line.strip():
                if group_start is None:
                    group_start = i
            else:
                if group_start is not None:
                    groups.append((group_start, i))
                    group_start = None

        if group_start is not None:
            groups.append((group_start, len(lines)))

        for idx, (start, end) in enumerate(groups):
            section_text = "\n".join(lines[start:end])
            if len(section_text) // 4 < self.config.min_section_tokens:
                continue

            first_line = lines[start].strip()[:80]
            node = ToCNode(
                id=f"{document.id}_g{idx}",
                title=first_line or f"Section {idx + 1}",
                node_type=ToCNodeType.SECTION,
                depth=1,
                start_line=start + 1,
                end_line=end,
                parent_id=root.id,
                preview=section_text[:200],
                token_estimate=len(section_text) // 4,
            )
            root.children.append(node)

    def _find_brace_block_end(self, lines: List[str], start_idx: int) -> int:
        """Find the end of a brace-delimited block."""
        brace_depth = 0
        found_open = False

        for i in range(start_idx, len(lines)):
            for char in lines[i]:
                if char == "{":
                    brace_depth += 1
                    found_open = True
                elif char == "}":
                    brace_depth -= 1
                    if found_open and brace_depth == 0:
                        return i + 1
        return len(lines)

    # =========================================================================
    # HTML Extraction
    # =========================================================================

    def _extract_html(self, document: Document) -> ToCNode:
        """Extract ToC from HTML document using heading tags."""
        lines = document.content.split("\n")
        root = ToCNode(
            id=f"{document.id}_root",
            title=document.title,
            node_type=ToCNodeType.ROOT,
            depth=0,
            start_line=1,
            end_line=len(lines),
        )

        heading_pattern = re.compile(r"<h([1-6])[^>]*>(.*?)</h\1>", re.IGNORECASE | re.DOTALL)
        headings: List[Tuple[int, int, str, int]] = []

        offset = 0
        for line_num, line in enumerate(document.content.split("\n"), 1):
            for match in heading_pattern.finditer(line):
                depth = int(match.group(1))
                title = re.sub(r"<[^>]+>", "", match.group(2)).strip()
                if title and depth <= self.config.max_toc_depth:
                    headings.append((line_num, depth, title, offset))
            offset += len(line) + 1

        if headings:
            self._build_heading_tree(root, headings, lines, document)
        else:
            return self._extract_plain_text(document)

        return root

    # =========================================================================
    # Plain Text Extraction
    # =========================================================================

    def _extract_plain_text(self, document: Document) -> ToCNode:
        """Extract structure from plain text using paragraph grouping."""
        lines = document.content.split("\n")
        root = ToCNode(
            id=f"{document.id}_root",
            title=document.title or document.metadata.file_name,
            node_type=ToCNodeType.ROOT,
            depth=0,
            start_line=1,
            end_line=len(lines),
        )

        # Split into paragraphs (groups separated by blank lines)
        paragraphs: List[Tuple[int, int, str]] = []
        para_start: Optional[int] = None

        for i, line in enumerate(lines):
            if line.strip():
                if para_start is None:
                    para_start = i
            else:
                if para_start is not None:
                    text = "\n".join(lines[para_start:i])
                    paragraphs.append((para_start, i, text))
                    para_start = None

        if para_start is not None:
            text = "\n".join(lines[para_start:])
            paragraphs.append((para_start, len(lines), text))

        # Group small paragraphs together
        idx = 0
        for start, end, text in paragraphs:
            if len(text) // 4 < self.config.min_section_tokens:
                continue

            title = text.split("\n")[0][:80].strip()
            node = ToCNode(
                id=f"{document.id}_p{idx}",
                title=title or f"Paragraph {idx + 1}",
                node_type=ToCNodeType.PARAGRAPH,
                depth=1,
                start_line=start + 1,
                end_line=end,
                parent_id=root.id,
                preview=text[:200],
                token_estimate=len(text) // 4,
            )
            root.children.append(node)
            idx += 1

        return root

    # =========================================================================
    # Keyword Extraction
    # =========================================================================

    def _extract_keywords(
        self,
        text: str,
        max_keywords: Optional[int] = None,
    ) -> List[str]:
        """
        Extract keywords from text using TF heuristics.

        Args:
            text: Text to extract keywords from.
            max_keywords: Maximum keywords to return.

        Returns:
            List of keyword strings.
        """
        max_kw = max_keywords or self.config.max_keywords_per_section

        # Tokenize
        words = re.findall(r"\b[a-zA-Z_][a-zA-Z0-9_]{2,}\b", text.lower())

        # Count frequencies
        freq: Dict[str, int] = {}
        for word in words:
            if word not in _STOP_WORDS:
                freq[word] = freq.get(word, 0) + 1

        # Sort by frequency and return top-N
        sorted_words = sorted(freq.items(), key=lambda x: x[1], reverse=True)
        return [word for word, _ in sorted_words[:max_kw]]


# Common stop words for keyword extraction
_STOP_WORDS = frozenset({
    "the", "and", "for", "with", "that", "this", "from", "are", "was",
    "were", "been", "have", "has", "had", "does", "did", "will", "would",
    "could", "should", "may", "might", "can", "not", "but", "also",
    "than", "then", "only", "very", "just", "into", "over", "such",
    "when", "where", "which", "while", "about", "each", "make", "like",
    "long", "look", "many", "some", "more", "most", "other", "after",
    "before", "between", "through", "during", "without", "again",
    "further", "once", "here", "there", "all", "both", "few", "own",
    "same", "too", "any", "how", "what", "who", "whom", "why",
    "return", "self", "none", "true", "false", "import", "from",
    "class", "def", "function", "const", "let", "var", "new",
})
