"""
Core type definitions for the Code Intelligence System.

These types form the foundation of the entire system. Every component
depends on these definitions.

Design principles:
- Each chunk is self-describing (contains all context needed for retrieval)
- Symbols are nodes in a graph (not just strings)
- Edges are typed (import, call, inheritance, etc.)
- Everything is hashable for deduplication
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Any, Dict, FrozenSet, List, Optional, Set, Tuple


class SymbolType(str, Enum):
    """
    Type of semantic unit in code.
    
    These categories determine retrieval behavior.
    """
    FUNCTION = "function"
    METHOD = "method"
    CLASS = "class"
    INTERFACE = "interface"
    TYPE_ALIAS = "type_alias"
    ENUM = "enum"
    CONSTANT = "constant"
    VARIABLE = "variable"
    MODULE = "module"
    NAMESPACE = "namespace"
    STRUCT = "struct"
    TRAIT = "trait"
    IMPL_BLOCK = "impl_block"
    DECORATOR = "decorator"
    PROPERTY = "property"
    UNKNOWN = "unknown"
    
    @property
    def is_callable(self) -> bool:
        return self in (SymbolType.FUNCTION, SymbolType.METHOD)
    
    @property
    def is_type_definition(self) -> bool:
        return self in (
            SymbolType.CLASS, SymbolType.INTERFACE, SymbolType.TYPE_ALIAS,
            SymbolType.ENUM, SymbolType.STRUCT, SymbolType.TRAIT
        )


class EdgeType(str, Enum):
    """
    Type of relationship between symbols.
    
    Critical for structural expansion during retrieval.
    """
    IMPORTS = "imports"           # A imports B
    EXPORTS = "exports"           # A exports B (re-export)
    CALLS = "calls"               # A calls B
    CALLED_BY = "called_by"       # A is called by B (reverse)
    INHERITS = "inherits"         # A inherits from B
    IMPLEMENTS = "implements"     # A implements interface B
    USES_TYPE = "uses_type"       # A uses type B
    DEFINES = "defines"           # Module A defines symbol B
    CONTAINS = "contains"         # A contains B (nested)
    OVERRIDES = "overrides"       # A overrides B
    DECORATES = "decorates"       # A decorates B
    DEPENDS_ON = "depends_on"     # Generic dependency


@dataclass(frozen=True)
class ChunkMetadata:
    """
    Metadata attached to every semantic chunk.
    
    This is what makes retrieval work. If you skip any of these fields,
    retrieval quality collapses.
    """
    # Location
    file_path: str
    start_line: int
    end_line: int
    start_col: int = 0
    end_col: int = 0
    
    # Identity
    symbol_name: str = ""
    symbol_type: SymbolType = SymbolType.UNKNOWN
    signature: str = ""  # Full signature for callable
    
    # Documentation
    docstring: str = ""
    
    # Dependencies (critical for structural expansion)
    imports_used: FrozenSet[str] = field(default_factory=frozenset)
    exports_provided: FrozenSet[str] = field(default_factory=frozenset)
    
    # Context
    parent_symbol: Optional[str] = None  # Containing class/module
    language: str = ""
    
    # Scoring
    is_public: bool = True
    is_test: bool = False
    complexity_estimate: int = 1  # 1-10 scale
    
    def __hash__(self) -> int:
        return hash((
            self.file_path, self.start_line, self.end_line,
            self.symbol_name, self.symbol_type
        ))


@dataclass
class SemanticChunk:
    """
    A single semantic unit of code.
    
    This is the fundamental unit of indexing and retrieval.
    Bad chunking = fixed token size, whole files, arbitrary line ranges.
    Correct chunking = function/class/method/constant with full context.
    """
    # Unique identifier (hash of content + location)
    id: str
    
    # The actual code
    code_body: str
    
    # All metadata
    metadata: ChunkMetadata
    
    # Vector embedding (set by indexer)
    embedding: Optional[List[float]] = None
    
    # Token count (for budget management)
    token_count: int = 0
    
    def __post_init__(self):
        if not self.id:
            # Generate deterministic ID
            content = f"{self.metadata.file_path}:{self.metadata.symbol_name}:{self.metadata.start_line}"
            self.id = hashlib.sha256(content.encode()).hexdigest()[:16]
        
        if self.token_count == 0:
            # Rough estimate: 1 token ≈ 4 chars
            self.token_count = len(self.code_body) // 4 + 1
    
    @property
    def language(self) -> str:
        return self.metadata.language
    
    @property
    def file_path(self) -> str:
        return self.metadata.file_path
    
    @property
    def symbol_name(self) -> str:
        return self.metadata.symbol_name
    
    @property
    def symbol_type(self) -> SymbolType:
        return self.metadata.symbol_type
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "code": self.code_body,
            "file": self.metadata.file_path,
            "symbol": self.metadata.symbol_name,
            "type": self.metadata.symbol_type.value,
            "signature": self.metadata.signature,
            "docstring": self.metadata.docstring,
            "lines": f"{self.metadata.start_line}-{self.metadata.end_line}",
            "imports": list(self.metadata.imports_used),
            "exports": list(self.metadata.exports_provided),
            "tokens": self.token_count,
        }
    
    def format_for_context(self, include_metadata: bool = True) -> str:
        """Format chunk for inclusion in AI context."""
        lines = []
        if include_metadata:
            lines.append(f"// File: {self.metadata.file_path}")
            lines.append(f"// Symbol: {self.metadata.symbol_name} ({self.metadata.symbol_type.value})")
            if self.metadata.signature:
                lines.append(f"// Signature: {self.metadata.signature}")
            lines.append("")
        lines.append(self.code_body)
        return "\n".join(lines)


@dataclass(frozen=True)
class SymbolNode:
    """
    A node in the symbol graph.
    
    Represents a named entity that can be referenced.
    """
    # Fully qualified name (e.g., "module.Class.method")
    qualified_name: str
    
    # Simple name (e.g., "method")
    simple_name: str
    
    # Type of symbol
    symbol_type: SymbolType
    
    # Source location
    file_path: str
    line: int
    
    # Chunk ID this symbol belongs to
    chunk_id: str
    
    # Visibility
    is_public: bool = True
    
    def __hash__(self) -> int:
        return hash(self.qualified_name)


@dataclass(frozen=True)
class SymbolEdge:
    """
    An edge in the symbol graph.
    
    Represents a relationship between two symbols.
    """
    source: str  # Qualified name of source symbol
    target: str  # Qualified name of target symbol
    edge_type: EdgeType
    
    # Source location of the reference
    file_path: str = ""
    line: int = 0
    
    # Confidence (1.0 = certain, <1.0 = inferred)
    confidence: float = 1.0
    
    def __hash__(self) -> int:
        return hash((self.source, self.target, self.edge_type))


@dataclass
class FileSummary:
    """
    Summary of a single file.
    
    Generated offline, used for cheap context injection.
    Target: 5-8 lines per file.
    """
    file_path: str
    language: str
    
    # One-line responsibility
    responsibility: str
    
    # Public API (exported symbols)
    public_api: List[str]
    
    # Key dependencies (top imports)
    dependencies: List[str]
    
    # Side effects (if any)
    side_effects: List[str]
    
    # Hash of content when summary was generated
    content_hash: str
    
    # Token count of summary
    token_count: int = 0
    
    def __post_init__(self):
        if self.token_count == 0:
            text = self.to_text()
            self.token_count = len(text) // 4 + 1
    
    def to_text(self) -> str:
        """Format for context injection."""
        lines = [
            f"## {self.file_path}",
            f"Responsibility: {self.responsibility}",
        ]
        if self.public_api:
            lines.append(f"Public API: {', '.join(self.public_api[:5])}")
        if self.dependencies:
            lines.append(f"Dependencies: {', '.join(self.dependencies[:5])}")
        if self.side_effects:
            lines.append(f"Side effects: {', '.join(self.side_effects)}")
        return "\n".join(lines)
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "file": self.file_path,
            "language": self.language,
            "responsibility": self.responsibility,
            "publicApi": self.public_api,
            "dependencies": self.dependencies,
            "sideEffects": self.side_effects,
            "contentHash": self.content_hash,
        }


@dataclass
class RepoSummary:
    """
    Summary of the entire repository.
    
    Generated offline, always included in context.
    Target: 300-800 tokens.
    """
    # High-level architecture
    architecture: str
    
    # Main entry points
    entry_points: List[str]
    
    # Major subsystems
    subsystems: List[str]
    
    # Coding conventions
    conventions: List[str]
    
    # Tech stack
    languages: List[str]
    frameworks: List[str]
    
    # Stats
    total_files: int
    total_symbols: int
    
    # Hash of repo state when generated
    state_hash: str
    
    # Token count
    token_count: int = 0
    
    def __post_init__(self):
        if self.token_count == 0:
            text = self.to_text()
            self.token_count = len(text) // 4 + 1
    
    def to_text(self) -> str:
        """Format for context injection."""
        lines = [
            "# Repository Overview",
            "",
            f"**Architecture:** {self.architecture}",
            "",
            f"**Tech Stack:** {', '.join(self.languages)} | {', '.join(self.frameworks)}",
            "",
            "**Entry Points:**",
        ]
        for ep in self.entry_points[:5]:
            lines.append(f"- {ep}")
        lines.append("")
        lines.append("**Subsystems:**")
        for ss in self.subsystems[:8]:
            lines.append(f"- {ss}")
        if self.conventions:
            lines.append("")
            lines.append("**Conventions:**")
            for conv in self.conventions[:5]:
                lines.append(f"- {conv}")
        return "\n".join(lines)
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "architecture": self.architecture,
            "entryPoints": self.entry_points,
            "subsystems": self.subsystems,
            "conventions": self.conventions,
            "languages": self.languages,
            "frameworks": self.frameworks,
            "stats": {
                "files": self.total_files,
                "symbols": self.total_symbols,
            },
        }


@dataclass
class ContextBudget:
    """
    Token budget for context assembly.
    
    Hard limits prevent silent overflow and degraded quality.
    """
    # Maximum total tokens
    max_tokens: int = 8000
    
    # Reserved for repo summary
    repo_summary_budget: int = 800
    
    # Reserved for file summaries
    file_summaries_budget: int = 1500
    
    # Reserved for code chunks
    code_chunks_budget: int = 5000
    
    # Reserved for "missing context" notes
    notes_budget: int = 200
    
    # Current usage
    used_tokens: int = 0
    
    @property
    def remaining(self) -> int:
        return max(0, self.max_tokens - self.used_tokens)
    
    def can_fit(self, tokens: int) -> bool:
        return self.used_tokens + tokens <= self.max_tokens
    
    def consume(self, tokens: int) -> bool:
        """Try to consume tokens. Returns True if successful."""
        if self.can_fit(tokens):
            self.used_tokens += tokens
            return True
        return False


@dataclass
class RetrievalResult:
    """
    Result of context retrieval.
    
    This is what gets injected into AI prompts.
    """
    # Retrieved chunks
    chunks: List[SemanticChunk]
    
    # File summaries (for files not fully retrieved)
    file_summaries: List[FileSummary]
    
    # Repo summary
    repo_summary: Optional[RepoSummary]
    
    # What was searched for
    query: str
    
    # Budget usage
    total_tokens: int
    budget: ContextBudget
    
    # What was truncated (for transparency)
    truncated_chunks: List[str] = field(default_factory=list)
    
    # Missing context note
    missing_context_note: str = ""
    
    def format_for_prompt(self) -> str:
        """
        Format the entire retrieval result for AI prompt injection.
        
        Order is critical:
        1. Repo summary (cheap, always present)
        2. File summaries (cheap, provides breadth)
        3. Code chunks (expensive, provides depth)
        4. Missing context note (transparency)
        """
        sections = []
        
        # 1. Repo summary
        if self.repo_summary:
            sections.append(self.repo_summary.to_text())
            sections.append("")
        
        # 2. File summaries
        if self.file_summaries:
            sections.append("# Relevant Files")
            for fs in self.file_summaries:
                sections.append(fs.to_text())
                sections.append("")
        
        # 3. Code chunks
        if self.chunks:
            sections.append("# Code Context")
            for chunk in self.chunks:
                sections.append(chunk.format_for_context())
                sections.append("")
        
        # 4. Missing context note
        if self.missing_context_note:
            sections.append(f"*Note: {self.missing_context_note}*")
        
        return "\n".join(sections)
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "query": self.query,
            "chunks": [c.to_dict() for c in self.chunks],
            "fileSummaries": [f.to_dict() for f in self.file_summaries],
            "repoSummary": self.repo_summary.to_dict() if self.repo_summary else None,
            "tokens": {
                "used": self.total_tokens,
                "budget": self.budget.max_tokens,
            },
            "truncated": self.truncated_chunks,
            "missingNote": self.missing_context_note,
        }


# Type aliases for clarity
ChunkId = str
SymbolName = str
FilePath = str
QualifiedName = str
