"""
Core type definitions for the RAG subsystem.

All types are designed to be:
- Serializable (JSON persistence)
- Hashable (deduplication)
- Composable (tree structures for ToC)
- Compatible with the existing code_intel type system
"""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Any, Dict, FrozenSet, List, Optional, Set, Tuple


# =============================================================================
# Enumerations
# =============================================================================


class DocumentFormat(str, Enum):
    """Supported document formats for ingestion."""
    MARKDOWN = "markdown"
    PLAIN_TEXT = "plain_text"
    CODE = "code"
    RST = "rst"
    HTML = "html"
    PDF = "pdf"
    UNKNOWN = "unknown"


class ToCNodeType(str, Enum):
    """Type of node in a Table of Contents tree."""
    ROOT = "root"
    HEADING = "heading"           # Markdown heading (H1-H6)
    SECTION = "section"           # Logical section
    SUBSECTION = "subsection"     # Nested section
    CODE_BLOCK = "code_block"     # Fenced code block
    LIST_GROUP = "list_group"     # Group of list items
    TABLE = "table"               # Table section
    FRONTMATTER = "frontmatter"   # YAML/TOML frontmatter
    PARAGRAPH = "paragraph"       # Text paragraph(s)
    FUNCTION = "function"         # Code: function definition
    CLASS = "class_def"           # Code: class definition
    MODULE = "module"             # Code: module-level
    COMMENT_BLOCK = "comment_block"  # Code: large comment/docstring


class SectionRelevance(str, Enum):
    """Relevance level of a section to a query."""
    CRITICAL = "critical"     # Directly answers the query
    HIGH = "high"             # Strongly related
    MEDIUM = "medium"         # Somewhat related
    LOW = "low"               # Tangentially related
    NONE = "none"             # Not relevant


class SynthesisModel(str, Enum):
    """Model tier for synthesis."""
    FAST = "fast"             # Routing/navigation (Gemini Flash, Claude Haiku)
    HEAVY = "heavy"           # Final synthesis (Gemini Pro, GPT-4o)


# =============================================================================
# Document Types
# =============================================================================


@dataclass
class DocumentMetadata:
    """
    Metadata for an ingested document.

    Captures everything needed for dedup, invalidation, and provenance.
    """
    file_path: str
    file_name: str
    format: DocumentFormat
    size_bytes: int
    content_hash: str                 # SHA-256 of raw content
    language: str = ""                # For code files
    title: str = ""                   # Extracted or inferred title
    created_at: float = 0.0          # Unix timestamp
    modified_at: float = 0.0         # Unix timestamp
    ingested_at: float = field(default_factory=time.time)
    tags: List[str] = field(default_factory=list)
    source: str = "filesystem"        # filesystem, url, api, etc.

    # Statistics
    line_count: int = 0
    word_count: int = 0
    section_count: int = 0

    def __hash__(self) -> int:
        return hash(self.content_hash)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "file_path": self.file_path,
            "file_name": self.file_name,
            "format": self.format.value,
            "size_bytes": self.size_bytes,
            "content_hash": self.content_hash,
            "language": self.language,
            "title": self.title,
            "created_at": self.created_at,
            "modified_at": self.modified_at,
            "ingested_at": self.ingested_at,
            "tags": self.tags,
            "source": self.source,
            "line_count": self.line_count,
            "word_count": self.word_count,
            "section_count": self.section_count,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "DocumentMetadata":
        return cls(
            file_path=data["file_path"],
            file_name=data["file_name"],
            format=DocumentFormat(data.get("format", "unknown")),
            size_bytes=data.get("size_bytes", 0),
            content_hash=data["content_hash"],
            language=data.get("language", ""),
            title=data.get("title", ""),
            created_at=data.get("created_at", 0.0),
            modified_at=data.get("modified_at", 0.0),
            ingested_at=data.get("ingested_at", 0.0),
            tags=data.get("tags", []),
            source=data.get("source", "filesystem"),
            line_count=data.get("line_count", 0),
            word_count=data.get("word_count", 0),
            section_count=data.get("section_count", 0),
        )


@dataclass
class Document:
    """
    A fully ingested document with content and metadata.

    This is the primary unit of the RAG ingestion pipeline.
    Content is stored separately from metadata for memory efficiency.
    """
    id: str                           # SHA-256[:24] of content_hash + file_path
    metadata: DocumentMetadata
    content: str                      # Raw document content
    sections: List["Section"] = field(default_factory=list)
    toc: Optional["ToCTree"] = None
    summary: Optional["DocumentSummary"] = None

    def __post_init__(self):
        if not self.id:
            raw = f"{self.metadata.content_hash}|{self.metadata.file_path}"
            self.id = hashlib.sha256(raw.encode()).hexdigest()[:24]

    def __hash__(self) -> int:
        return hash(self.id)

    def __eq__(self, other: object) -> bool:
        if isinstance(other, Document):
            return self.id == other.id
        return NotImplemented

    @property
    def title(self) -> str:
        return self.metadata.title or self.metadata.file_name

    @property
    def format(self) -> DocumentFormat:
        return self.metadata.format

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "metadata": self.metadata.to_dict(),
            "content_length": len(self.content),
            "section_count": len(self.sections),
            "has_toc": self.toc is not None,
            "has_summary": self.summary is not None,
        }


# =============================================================================
# Table of Contents Types
# =============================================================================


@dataclass
class ToCNode:
    """
    A node in the Table of Contents tree.

    Each node represents a section/heading in the document with:
    - Hierarchical position (depth, parent, children)
    - Content boundaries (start_line, end_line)
    - Navigation metadata (title, node_type)
    """
    id: str                           # Unique node ID within document
    title: str                        # Section title / heading text
    node_type: ToCNodeType = ToCNodeType.SECTION
    depth: int = 0                    # 0 = root, 1 = H1, 2 = H2, etc.

    # Content boundaries (line numbers, 1-based)
    start_line: int = 0
    end_line: int = 0

    # Character offsets (optional, for precise extraction)
    start_offset: int = 0
    end_offset: int = 0

    # Tree structure
    parent_id: Optional[str] = None
    children: List["ToCNode"] = field(default_factory=list)

    # Content preview (first ~100 chars of section)
    preview: str = ""

    # Estimated token count for this section
    token_estimate: int = 0

    # Keywords extracted from section content
    keywords: List[str] = field(default_factory=list)

    def __hash__(self) -> int:
        return hash(self.id)

    def __eq__(self, other: object) -> bool:
        if isinstance(other, ToCNode):
            return self.id == other.id
        return NotImplemented

    @property
    def is_leaf(self) -> bool:
        return len(self.children) == 0

    @property
    def child_count(self) -> int:
        return len(self.children)

    @property
    def total_descendants(self) -> int:
        """Count all descendants recursively."""
        count = len(self.children)
        for child in self.children:
            count += child.total_descendants
        return count

    def get_path(self) -> str:
        """Get human-readable path (e.g., 'Architecture > Auth > Middleware')."""
        # This requires parent walking, which needs the tree context
        return self.title

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "node_type": self.node_type.value,
            "depth": self.depth,
            "start_line": self.start_line,
            "end_line": self.end_line,
            "start_offset": self.start_offset,
            "end_offset": self.end_offset,
            "parent_id": self.parent_id,
            "children": [c.to_dict() for c in self.children],
            "preview": self.preview,
            "token_estimate": self.token_estimate,
            "keywords": self.keywords,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ToCNode":
        children_data = data.get("children", [])
        node = cls(
            id=data["id"],
            title=data["title"],
            node_type=ToCNodeType(data.get("node_type", "section")),
            depth=data.get("depth", 0),
            start_line=data.get("start_line", 0),
            end_line=data.get("end_line", 0),
            start_offset=data.get("start_offset", 0),
            end_offset=data.get("end_offset", 0),
            parent_id=data.get("parent_id"),
            preview=data.get("preview", ""),
            token_estimate=data.get("token_estimate", 0),
            keywords=data.get("keywords", []),
        )
        node.children = [ToCNode.from_dict(c) for c in children_data]
        return node


@dataclass
class ToCTree:
    """
    Complete Table of Contents tree for a document.

    The tree is rooted at a virtual root node. All H1/top-level sections
    are children of the root. Supports efficient traversal for the
    micro-navigation agent.
    """
    document_id: str
    root: ToCNode
    total_nodes: int = 0
    max_depth: int = 0

    # Flat index for fast node lookup by ID
    _node_index: Dict[str, ToCNode] = field(default_factory=dict, repr=False)

    def __post_init__(self):
        if not self._node_index:
            self._rebuild_index()

    def _rebuild_index(self) -> None:
        """Rebuild flat node index from tree."""
        self._node_index = {}
        self._index_node(self.root)
        self.total_nodes = len(self._node_index)
        self.max_depth = self._compute_max_depth(self.root)

    def _index_node(self, node: ToCNode) -> None:
        """Recursively index a node and its children."""
        self._node_index[node.id] = node
        for child in node.children:
            self._index_node(child)

    def _compute_max_depth(self, node: ToCNode) -> int:
        """Compute maximum depth of tree."""
        if not node.children:
            return node.depth
        return max(self._compute_max_depth(c) for c in node.children)

    def get_node(self, node_id: str) -> Optional[ToCNode]:
        """Get node by ID in O(1)."""
        return self._node_index.get(node_id)

    def get_children(self, node_id: str) -> List[ToCNode]:
        """Get children of a node."""
        node = self._node_index.get(node_id)
        if node:
            return node.children
        return []

    def get_path_to_node(self, node_id: str) -> List[ToCNode]:
        """Get path from root to node (breadcrumb trail)."""
        path = []
        current = self._node_index.get(node_id)
        while current:
            path.append(current)
            if current.parent_id:
                current = self._node_index.get(current.parent_id)
            else:
                break
        path.reverse()
        return path

    def get_siblings(self, node_id: str) -> List[ToCNode]:
        """Get sibling nodes (same parent)."""
        node = self._node_index.get(node_id)
        if not node or not node.parent_id:
            return []
        parent = self._node_index.get(node.parent_id)
        if not parent:
            return []
        return [c for c in parent.children if c.id != node_id]

    def flatten(self) -> List[ToCNode]:
        """Flatten tree to ordered list (depth-first)."""
        result: List[ToCNode] = []
        self._flatten_node(self.root, result)
        return result

    def _flatten_node(self, node: ToCNode, result: List[ToCNode]) -> None:
        """Recursively flatten a node."""
        result.append(node)
        for child in node.children:
            self._flatten_node(child, result)

    def format_for_llm(self, max_depth: int = 4) -> str:
        """
        Format tree as indented text for LLM consumption.

        This is what the routing agent reads to navigate the document.

        Example output:
            1. Introduction
              1.1 Overview
              1.2 Getting Started
            2. Architecture
              2.1 Authentication
                2.1.1 OAuth Flow
                2.1.2 Session Management
              2.2 Database
        """
        lines: List[str] = []
        self._format_node(self.root, lines, max_depth, "")
        return "\n".join(lines)

    def _format_node(
        self,
        node: ToCNode,
        lines: List[str],
        max_depth: int,
        prefix: str,
    ) -> None:
        """Recursively format a node."""
        if node.depth > max_depth:
            return
        if node.node_type != ToCNodeType.ROOT:
            indent = "  " * (node.depth - 1)
            token_hint = f" (~{node.token_estimate} tokens)" if node.token_estimate else ""
            lines.append(f"{indent}{prefix}{node.title}{token_hint}")
        for i, child in enumerate(node.children):
            child_prefix = f"{i + 1}. " if node.node_type == ToCNodeType.ROOT else ""
            self._format_node(child, lines, max_depth, child_prefix)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "document_id": self.document_id,
            "root": self.root.to_dict(),
            "total_nodes": self.total_nodes,
            "max_depth": self.max_depth,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "ToCTree":
        tree = cls(
            document_id=data["document_id"],
            root=ToCNode.from_dict(data["root"]),
            total_nodes=data.get("total_nodes", 0),
            max_depth=data.get("max_depth", 0),
        )
        tree._rebuild_index()
        return tree


# =============================================================================
# Section Types
# =============================================================================


@dataclass
class Section:
    """
    A discrete section of a document, extracted based on ToC boundaries.

    Sections are the atomic retrieval units in micro-navigation.
    Each section maps to exactly one ToCNode.
    """
    id: str                           # Unique section ID
    document_id: str                  # Parent document ID
    toc_node_id: str                  # Corresponding ToC node
    title: str                        # Section title
    content: str                      # Section content text
    depth: int = 0                    # Nesting depth

    # Content boundaries
    start_line: int = 0
    end_line: int = 0

    # Token count
    token_count: int = 0

    # Path in document (e.g., "Architecture > Auth > Middleware")
    breadcrumb: str = ""

    # Extracted keywords for this section
    keywords: List[str] = field(default_factory=list)

    def __post_init__(self):
        if self.token_count == 0 and self.content:
            self.token_count = len(self.content) // 4 + 1

    def __hash__(self) -> int:
        return hash(self.id)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "document_id": self.document_id,
            "toc_node_id": self.toc_node_id,
            "title": self.title,
            "content_length": len(self.content),
            "depth": self.depth,
            "start_line": self.start_line,
            "end_line": self.end_line,
            "token_count": self.token_count,
            "breadcrumb": self.breadcrumb,
            "keywords": self.keywords,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any], content: str = "") -> "Section":
        return cls(
            id=data["id"],
            document_id=data["document_id"],
            toc_node_id=data["toc_node_id"],
            title=data["title"],
            content=content,
            depth=data.get("depth", 0),
            start_line=data.get("start_line", 0),
            end_line=data.get("end_line", 0),
            token_count=data.get("token_count", 0),
            breadcrumb=data.get("breadcrumb", ""),
            keywords=data.get("keywords", []),
        )


# =============================================================================
# Summary Types
# =============================================================================


@dataclass
class DocumentSummary:
    """
    High-level summary of an entire document.

    Generated during dual-ingestion (Step 1).
    Embedded into the fast vector index for macro-retrieval (Step 2).
    """
    document_id: str
    title: str
    summary_text: str                 # 2-5 sentence high-level summary
    key_topics: List[str]             # Main topics covered
    key_entities: List[str]           # Important named entities (APIs, classes, etc.)
    content_hash: str                 # Hash of document at summary time

    # Embedding for fast vector search
    embedding: Optional[Any] = field(default=None, repr=False)  # numpy array

    # Statistics
    token_count: int = 0
    section_count: int = 0
    word_count: int = 0

    def __post_init__(self):
        if self.token_count == 0 and self.summary_text:
            self.token_count = len(self.summary_text) // 4 + 1

    def to_embed_text(self) -> str:
        """Build text for embedding generation."""
        parts = [
            f"DOCUMENT: {self.title}",
            f"SUMMARY: {self.summary_text}",
        ]
        if self.key_topics:
            parts.append(f"TOPICS: {', '.join(self.key_topics)}")
        if self.key_entities:
            parts.append(f"ENTITIES: {', '.join(self.key_entities)}")
        return "\n".join(parts)

    def to_dict(self) -> Dict[str, Any]:
        return {
            "document_id": self.document_id,
            "title": self.title,
            "summary_text": self.summary_text,
            "key_topics": self.key_topics,
            "key_entities": self.key_entities,
            "content_hash": self.content_hash,
            "token_count": self.token_count,
            "section_count": self.section_count,
            "word_count": self.word_count,
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "DocumentSummary":
        return cls(
            document_id=data["document_id"],
            title=data["title"],
            summary_text=data["summary_text"],
            key_topics=data.get("key_topics", []),
            key_entities=data.get("key_entities", []),
            content_hash=data["content_hash"],
            token_count=data.get("token_count", 0),
            section_count=data.get("section_count", 0),
            word_count=data.get("word_count", 0),
        )


# =============================================================================
# Query & Result Types
# =============================================================================


@dataclass
class SectionReference:
    """Reference to a specific section used in answer synthesis."""
    section_id: str
    document_id: str
    document_title: str
    section_title: str
    breadcrumb: str
    relevance: SectionRelevance
    relevance_score: float = 0.0      # 0.0 - 1.0
    content_snippet: str = ""         # First ~200 chars of content

    def to_dict(self) -> Dict[str, Any]:
        return {
            "section_id": self.section_id,
            "document_id": self.document_id,
            "document_title": self.document_title,
            "section_title": self.section_title,
            "breadcrumb": self.breadcrumb,
            "relevance": self.relevance.value,
            "relevance_score": self.relevance_score,
            "content_snippet": self.content_snippet,
        }


@dataclass
class Citation:
    """
    A citation linking a claim in the answer to source material.

    Tracks provenance from answer text back to exact document sections.
    """
    id: str                           # Citation ID (e.g., "[1]")
    document_id: str
    document_title: str
    section_id: str
    section_title: str
    breadcrumb: str                   # Full path in document
    excerpt: str                      # Relevant excerpt from source
    start_line: int = 0               # Line reference in source document
    end_line: int = 0
    confidence: float = 1.0           # How confident we are this citation is correct

    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "document_id": self.document_id,
            "document_title": self.document_title,
            "section_id": self.section_id,
            "section_title": self.section_title,
            "breadcrumb": self.breadcrumb,
            "excerpt": self.excerpt,
            "start_line": self.start_line,
            "end_line": self.end_line,
            "confidence": self.confidence,
        }


@dataclass
class RAGQuery:
    """
    A user query for the RAG pipeline.

    Carries the original question plus any routing hints.
    """
    text: str                         # Original user question
    max_documents: int = 5            # Max documents for macro-retrieval
    max_sections: int = 10            # Max sections for micro-navigation
    max_tokens: int = 8000            # Token budget for synthesis
    require_citations: bool = True    # Whether to generate citations
    fast_model: str = ""              # Override fast routing model
    heavy_model: str = ""             # Override heavy synthesis model

    # Optional filters
    document_ids: Optional[List[str]] = None       # Restrict to specific docs
    file_patterns: Optional[List[str]] = None      # Glob patterns for files
    tags: Optional[List[str]] = None               # Filter by tags

    # Internal metadata (set by pipeline)
    _query_embedding: Optional[Any] = field(default=None, repr=False)
    _parsed_keywords: List[str] = field(default_factory=list, repr=False)


@dataclass
class MacroResult:
    """Result from macro-retrieval (Step 2)."""
    document_ids: List[str]           # Top document IDs
    scores: Dict[str, float]          # doc_id -> relevance score
    total_candidates: int             # Total documents searched
    time_ms: float = 0.0             # Retrieval time

    def to_dict(self) -> Dict[str, Any]:
        return {
            "document_ids": self.document_ids,
            "scores": self.scores,
            "total_candidates": self.total_candidates,
            "time_ms": self.time_ms,
        }


@dataclass
class MicroResult:
    """Result from micro-navigation (Step 3)."""
    sections: List[SectionReference]  # Selected sections
    navigation_path: List[str]        # Path taken through ToC trees
    documents_navigated: int = 0
    sections_evaluated: int = 0
    time_ms: float = 0.0
    routing_model: str = ""           # Model used for routing

    def to_dict(self) -> Dict[str, Any]:
        return {
            "sections": [s.to_dict() for s in self.sections],
            "navigation_path": self.navigation_path,
            "documents_navigated": self.documents_navigated,
            "sections_evaluated": self.sections_evaluated,
            "time_ms": self.time_ms,
            "routing_model": self.routing_model,
        }


@dataclass
class RAGResult:
    """
    Complete result from the RAG pipeline.

    Includes the answer, citations, and full pipeline observability.
    """
    # The answer
    answer: str
    confidence: float = 0.0           # 0.0 - 1.0

    # Citations
    citations: List[Citation] = field(default_factory=list)

    # Source sections used
    sections_used: List[SectionReference] = field(default_factory=list)

    # Pipeline metadata
    query: str = ""
    documents_searched: int = 0
    documents_selected: int = 0
    sections_extracted: int = 0

    # Sub-results for observability
    macro_result: Optional[MacroResult] = None
    micro_result: Optional[MicroResult] = None

    # Timing
    macro_time_ms: float = 0.0
    micro_time_ms: float = 0.0
    synthesis_time_ms: float = 0.0
    total_time_ms: float = 0.0

    # Models used
    routing_model: str = ""
    synthesis_model: str = ""

    # Token usage
    input_tokens: int = 0
    output_tokens: int = 0

    # Error info
    error: Optional[str] = None
    partial: bool = False             # True if answer is based on partial data

    def to_dict(self) -> Dict[str, Any]:
        return {
            "answer": self.answer,
            "confidence": self.confidence,
            "citations": [c.to_dict() for c in self.citations],
            "sections_used": [s.to_dict() for s in self.sections_used],
            "query": self.query,
            "documents_searched": self.documents_searched,
            "documents_selected": self.documents_selected,
            "sections_extracted": self.sections_extracted,
            "timing": {
                "macro_ms": self.macro_time_ms,
                "micro_ms": self.micro_time_ms,
                "synthesis_ms": self.synthesis_time_ms,
                "total_ms": self.total_time_ms,
            },
            "models": {
                "routing": self.routing_model,
                "synthesis": self.synthesis_model,
            },
            "tokens": {
                "input": self.input_tokens,
                "output": self.output_tokens,
            },
            "error": self.error,
            "partial": self.partial,
        }
