"""
Core type definitions for the Code Intelligence System.

These types form the foundation of the entire system. Every component
depends on these definitions.

Design principles:
- Each chunk is self-describing (contains all context needed for retrieval)
- Symbols are nodes in a graph (not just strings)
- Edges are typed (import, call, inheritance, etc.)
- Everything is hashable for deduplication
- Chunk IDs are content-stable (not line-number dependent)
- Code bodies are loaded lazily to save memory
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field
from enum import Enum, auto
from typing import Any, Callable, Dict, FrozenSet, List, Optional, Protocol, Set, Tuple
import numpy as np


class FileReader(Protocol):
    """Protocol for lazy code loading."""
    def read_lines(self, file_path: str, start_line: int, end_line: int) -> str:
        """Read lines from a file."""
        ...


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
    qualified_name: str = ""  # Full path: module.Class.method
    symbol_type: SymbolType = SymbolType.UNKNOWN
    signature: str = ""  # Full signature for callable
    
    # Documentation
    docstring: str = ""
    
    # Dependencies (critical for structural expansion)
    imports_used: FrozenSet[str] = field(default_factory=frozenset)
    exports_provided: FrozenSet[str] = field(default_factory=frozenset)
    type_refs: FrozenSet[str] = field(default_factory=frozenset)
    
    # Context
    parent_symbol: Optional[str] = None  # Containing class/module
    language: str = ""
    
    # Scoring
    is_public: bool = True
    is_test: bool = False
    complexity_estimate: int = 1  # 1-10 scale
    
    # Module grouping (for canonical module limits)
    module_group: str = ""  # Canonical grouping (see language-specific rules)

    # Chunking version (for staleness protection)
    chunking_version: str = ""

    # Stable symbol identity (rename/move resilient)
    stable_symbol_id: str = ""
    
    def __hash__(self) -> int:
        return hash((
            self.file_path, self.start_line, self.end_line,
            self.symbol_name, self.symbol_type, self.chunking_version
        ))


def compute_chunk_id(
    symbol_identity: str,
    signature_fingerprint: str,
    body_fingerprint: str,
    chunking_version: str = "",
    anchor: str = "",
) -> str:
    """
    Compute a stable chunk ID from content-stable properties.

    CRITICAL: This ID must be stable across file renames and line shifts.

    This ID is STABLE across:
    - Adding lines above (no line number dependency)
    - Whitespace-only edits (via normalized fingerprint)
    - File moves/renames (no raw file_path)

    This ID CHANGES when:
    - Symbol identity changes (module/scope/name/type)
    - Signature changes (canonical signature changes)
    - Body semantics change (semantic fingerprint changes)

    Args:
        symbol_identity: Stable symbol identity (language/type/name/scope)
        signature_fingerprint: Canonical signature fingerprint
        body_fingerprint: Semantic body fingerprint
        chunking_version: Chunking version for staleness protection
        anchor: Optional stable anchor (e.g., structural symbol ID)

    Returns:
        32-character hex ID (128-bit)
    """
    content = f"{symbol_identity}|{signature_fingerprint}|{body_fingerprint}|{chunking_version}|{anchor}"
    return hashlib.sha256(content.encode()).hexdigest()[:32]


def compute_stable_symbol_id(
    language: str,
    symbol_type: SymbolType,
    signature_fingerprint: str,
    body_fingerprint: str,
) -> str:
    """
    Compute a stable symbol identity that is resilient to renames/moves.

    This intentionally omits file path and qualified name.
    """
    content = f"{language}|{symbol_type.value}|{signature_fingerprint}|{body_fingerprint}"
    return hashlib.sha256(content.encode()).hexdigest()[:24]


def canonicalize_signature(signature: str) -> str:
    """
    Canonicalize a symbol signature for stability.

    This is a structural-ish normalization intended to reduce noise from
    formatting differences (whitespace, line breaks). It does NOT perform
    language-specific AST canonicalization.
    """
    if not signature:
        return ""
    # Normalize unicode and collapse whitespace
    canon = unicodedata.normalize("NFC", signature)
    canon = re.sub(r"\s+", " ", canon).strip()
    # Remove spaces around common punctuation
    canon = re.sub(r"\s*([(),:<>\[\]{}=\-\+*/])\s*", r"\1", canon)
    return canon


_GENERIC_KEYWORDS = frozenset({
    # Common keywords across languages
    "class", "def", "function", "fn", "return", "if", "else", "elif", "for", "while",
    "switch", "case", "break", "continue", "try", "except", "catch", "finally",
    "import", "from", "export", "module", "namespace", "public", "private", "protected",
    "static", "const", "let", "var", "new", "this", "self", "super", "extends",
    "implements", "interface", "enum", "struct", "trait", "impl", "yield", "async",
    "await", "lambda", "with", "in", "is", "as", "raise", "throw", "match",
    "true", "false", "null", "none", "nil", "undefined", "void",
})


def _strip_comments(text: str) -> str:
    # Remove block comments first
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.DOTALL)
    # Remove line comments
    text = re.sub(r"//.*?$", " ", text, flags=re.MULTILINE)
    text = re.sub(r"#.*?$", " ", text, flags=re.MULTILINE)
    return text


def _normalize_literals(text: str) -> str:
    # Normalize strings (single, double, backtick)
    text = re.sub(r"'(?:\\.|[^'\\])*'", "'str'", text)
    text = re.sub(r'"(?:\\.|[^"\\])*"', '"str"', text)
    text = re.sub(r"`(?:\\.|[^`\\])*`", "`str`", text)
    # Normalize numeric literals
    text = re.sub(r"\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b", "0", text)
    return text


def _normalize_identifiers(text: str) -> str:
    def _replace(match: re.Match) -> str:
        token = match.group(0)
        if token.lower() in _GENERIC_KEYWORDS:
            return token
        return "id"
    return re.sub(r"\b[A-Za-z_][A-Za-z0-9_]*\b", _replace, text)


def compute_body_fingerprint(code_body: str) -> str:
    """
    Compute a semantic-lite fingerprint of code body.

    Normalizes the body to be insensitive to:
    - Whitespace and indentation
    - Comments
    - Literal values (strings/numbers)
    - Local identifier renames (heuristic)

    NOTE: This is language-agnostic and regex-based. It does not
    perform full AST canonicalization.
    """
    if not code_body:
        return ""
    text = unicodedata.normalize("NFC", code_body)
    text = _strip_comments(text)
    text = _normalize_literals(text)
    text = _normalize_identifiers(text)
    # Normalize whitespace
    text = re.sub(r"\s+", " ", text).strip()
    return hashlib.sha256(text.encode()).hexdigest()[:16]


class HashVerificationError(Exception):
    """Raised when file content hash doesn't match indexed hash."""
    pass


class FileReaderWithHash(Protocol):
    """Extended FileReader that supports hash verification."""
    def read_lines(self, file_path: str, start_line: int, end_line: int) -> str:
        """Read lines from a file."""
        ...
    
    def get_file_hash(self, file_path: str) -> str:
        """Get the current content hash of a file."""
        ...


@dataclass
class SemanticChunk:
    """
    A single semantic unit of code.
    
    This is the fundamental unit of indexing and retrieval.
    Bad chunking = fixed token size, whole files, arbitrary line ranges.
    Correct chunking = function/class/method/constant with full context.
    
    LAZY CODE LOADING: To save memory, code_body can be loaded on-demand
    from disk using get_code() with a FileReader.
    
    HASH CONSISTENCY: Each chunk stores the content_hash at index time.
    When loading lazily, we verify the file hasn't changed.
    """
    # Unique identifier (hash of content + qualified name + signature)
    id: str
    
    # The actual code - can be None for lazy loading
    _code_body: Optional[str] = field(default=None, repr=False)
    
    # All metadata
    metadata: ChunkMetadata = field(default_factory=lambda: ChunkMetadata(
        file_path="", start_line=0, end_line=0
    ))
    
    # Vector embedding (set by indexer) - stored as numpy for efficiency
    embedding: Optional[np.ndarray] = field(default=None, repr=False)
    
    # Token count (for budget management) - counted with target model tokenizer
    token_count: int = 0
    
    # Content hash of file at index time (for lazy loading verification)
    content_hash: str = ""
    
    # Whether code body is loaded
    _code_loaded: bool = field(default=False, repr=False)
    
    def __post_init__(self):
        if not self.id:
            # Generate stable ID from content-stable properties
            body_fingerprint = ""
            if self._code_body:
                body_fingerprint = compute_body_fingerprint(self._code_body)
                self._code_loaded = True

            qualified_name = self.metadata.qualified_name or self.metadata.symbol_name
            signature_canon = canonicalize_signature(self.metadata.signature)
            stable_symbol_id = self.metadata.stable_symbol_id
            symbol_identity = f"{self.metadata.language}|{self.metadata.symbol_type.value}|{stable_symbol_id or qualified_name}"
            self.id = compute_chunk_id(
                symbol_identity=symbol_identity,
                signature_fingerprint=signature_canon,
                body_fingerprint=body_fingerprint,
                chunking_version=self.metadata.chunking_version,
            )
        
        if self.token_count == 0 and self._code_body:
            # Rough estimate: 1 token ≈ 4 chars (will be recomputed with proper tokenizer)
            self.token_count = len(self._code_body) // 4 + 1
    
    @property
    def code_body(self) -> str:
        """Get the code body. Returns empty string if not loaded."""
        return self._code_body or ""
    
    @code_body.setter
    def code_body(self, value: str):
        """Set the code body."""
        self._code_body = value
        self._code_loaded = True
    
    def get_code(
        self, 
        file_reader: Optional[FileReader] = None,
        verify_hash: bool = True,
        raise_on_mismatch: bool = False,
    ) -> str:
        """
        Get the code body, loading lazily if needed.
        
        HASH VERIFICATION: If content_hash was set at index time and file_reader
        supports get_file_hash(), we verify the file hasn't changed.
        
        Args:
            file_reader: FileReader to use for lazy loading
            verify_hash: If True, verify file hash matches indexed hash
            raise_on_mismatch: If True, raise HashVerificationError on mismatch
                               If False, return empty string (caller should reindex)
            
        Returns:
            The code body, or empty string if:
            - No file_reader provided
            - Hash mismatch (unless raise_on_mismatch=True)
            
        Raises:
            HashVerificationError: If raise_on_mismatch=True and hash doesn't match
        """
        if self._code_body is not None:
            return self._code_body
        
        if file_reader is not None and self.metadata.file_path:
            # Verify file hash hasn't changed (if we have hash support)
            if verify_hash and self.content_hash and hasattr(file_reader, 'get_file_hash'):
                current_hash = file_reader.get_file_hash(self.metadata.file_path)
                if current_hash != self.content_hash:
                    if raise_on_mismatch:
                        raise HashVerificationError(
                            f"File {self.metadata.file_path} has changed since indexing. "
                            f"Expected hash {self.content_hash}, got {current_hash}. "
                            f"Please reindex the file."
                        )
                    # File changed - return empty to signal need for reindex
                    return ""

            # Snapshot mtime/size if supported
            pre_stat = None
            if hasattr(file_reader, "get_file_stat"):
                try:
                    pre_stat = file_reader.get_file_stat(self.metadata.file_path)
                except Exception:
                    pre_stat = None

            self._code_body = file_reader.read_lines(
                self.metadata.file_path,
                self.metadata.start_line,
                self.metadata.end_line
            )

            # Recheck stat to avoid reading newer bytes
            if pre_stat and hasattr(file_reader, "get_file_stat"):
                try:
                    post_stat = file_reader.get_file_stat(self.metadata.file_path)
                    if not post_stat or post_stat.get("mtime_ns") != pre_stat.get("mtime_ns") or post_stat.get("size") != pre_stat.get("size"):
                        return ""
                except Exception:
                    return ""
            self._code_loaded = True
            return self._code_body
        
        return ""
    
    def needs_reindex(self, file_reader: Optional[FileReaderWithHash] = None) -> bool:
        """
        Check if this chunk needs reindexing due to file changes.
        
        Args:
            file_reader: FileReader with get_file_hash support
            
        Returns:
            True if file has changed since indexing
        """
        if not self.content_hash:
            return False  # No hash to verify
        
        if file_reader is None or not hasattr(file_reader, 'get_file_hash'):
            return False  # Can't verify
        
        try:
            current_hash = file_reader.get_file_hash(self.metadata.file_path)
            return current_hash != self.content_hash
        except Exception:
            return True  # File missing or unreadable - needs reindex
    
    def is_code_loaded(self) -> bool:
        """Check if code body is currently loaded."""
        return self._code_loaded
    
    def unload_code(self) -> None:
        """Unload code body to save memory (metadata + line ranges preserved)."""
        self._code_body = None
        self._code_loaded = False
    
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
    
    @property
    def signature(self) -> str:
        return self.metadata.signature
    
    @property
    def docstring(self) -> str:
        return self.metadata.docstring
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "code": self._code_body or "",
            "file": self.metadata.file_path,
            "symbol": self.metadata.symbol_name,
            "qualified_name": self.metadata.qualified_name,
            "type": self.metadata.symbol_type.value,
            "signature": self.metadata.signature,
            "docstring": self.metadata.docstring,
            "lines": f"{self.metadata.start_line}-{self.metadata.end_line}",
            "imports": list(self.metadata.imports_used),
            "exports": list(self.metadata.exports_provided),
            "type_refs": list(self.metadata.type_refs),
            "tokens": self.token_count,
            "module_group": self.metadata.module_group,
            "stable_symbol_id": self.metadata.stable_symbol_id,
            "content_hash": self.content_hash,  # For lazy loading verification
        }
    
    def format_for_context(self, include_metadata: bool = True) -> str:
        """Format chunk for inclusion in AI context."""
        lines = []
        if include_metadata:
            lines.append(f"// File: {self.metadata.file_path}")
            lines.append(f"// Symbol: {self.metadata.qualified_name or self.metadata.symbol_name} ({self.metadata.symbol_type.value})")
            if self.metadata.signature:
                lines.append(f"// Signature: {self.metadata.signature}")
            lines.append("")
        lines.append(self._code_body or "")
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

    # Stable symbol ID (rename/move resilient)
    stable_symbol_id: str = ""
    
    # Visibility
    is_public: bool = True
    
    def __hash__(self) -> int:
        return hash(self.qualified_name)


@dataclass(frozen=True)
class SymbolEdge:
    """
    An edge in the symbol graph.
    
    Represents a relationship between two symbols.
    
    Edge extraction priority (highest to lowest confidence):
    1. LSP references (confidence=1.0) - Most reliable
    2. AST/parser extraction (confidence=0.9) - Reliable
    3. Heuristic fallbacks (confidence=0.6) - Less reliable
    """
    source: str  # Qualified name of source symbol
    target: str  # Qualified name of target symbol
    edge_type: EdgeType
    
    # Source location of the reference
    file_path: str = ""
    line: int = 0
    
    # Confidence (1.0 = certain, <1.0 = inferred)
    # Used to limit expansion per confidence level
    confidence: float = 1.0
    
    # How the edge was extracted: "lsp", "ast", "heuristic"
    source_method: str = "ast"
    
    def __hash__(self) -> int:
        return hash((self.source, self.target, self.edge_type))


# Expansion limits per edge confidence level
EXPANSION_LIMITS = {
    "lsp": {"max_per_source": 10, "max_hops": 2},
    "ast": {"max_per_source": 5, "max_hops": 2},
    "heuristic": {"max_per_source": 2, "max_hops": 1},
}


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

    # Chunking version used to generate summary
    chunking_version: str = ""

    # Provenance
    chunk_ids: List[str] = field(default_factory=list)
    evidence: Dict[str, List[str]] = field(default_factory=dict)
    
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
            "file_path": self.file_path,
            "language": self.language,
            "responsibility": self.responsibility,
            "public_api": self.public_api,
            "dependencies": self.dependencies,
            "side_effects": self.side_effects,
            "content_hash": self.content_hash,
            "chunking_version": self.chunking_version,
            "chunk_ids": self.chunk_ids,
            "evidence": self.evidence,
        }


@dataclass
class ModuleSummary:
    """
    Summary of a module or subsystem.

    Generated by LLM; used for high-level context.
    """
    module_path: str
    summary: str
    key_symbols: List[str]
    dependencies: List[str]
    content_hash: str
    chunking_version: str = ""
    token_count: int = 0

    def __post_init__(self):
        if self.token_count == 0:
            self.token_count = len(self.summary) // 4 + 1

    def to_dict(self) -> Dict[str, Any]:
        return {
            "module_path": self.module_path,
            "summary": self.summary,
            "key_symbols": self.key_symbols,
            "dependencies": self.dependencies,
            "content_hash": self.content_hash,
            "chunking_version": self.chunking_version,
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
    
    # Reserved for model response
    reserved_for_response: int = 500
    
    # Current usage
    used_tokens: int = 0
    
    @property
    def remaining(self) -> int:
        return max(0, self.max_tokens - self.used_tokens - self.reserved_for_response)
    
    def can_fit(self, tokens: int) -> bool:
        return self.used_tokens + tokens <= self.max_tokens - self.reserved_for_response
    
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
    Includes sufficiency indicator from deterministic controller.
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
    
    # Assembled context string
    assembled_context: str = ""
    
    # Sufficiency indicator from deterministic controller
    # This tells the LLM if it has enough context to answer
    sufficiency: Any = None  # ContextSufficiency enum from controller
    refusal_reason: Any = None  # RefusalReason enum from controller

    # Observability trace (optional)
    trace: List[Dict[str, Any]] = field(default_factory=list)
    debug: Dict[str, Any] = field(default_factory=dict)
    
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
            "trace": self.trace,
            "debug": self.debug,
        }


# Type aliases for clarity
ChunkId = str
SymbolName = str
FilePath = str
QualifiedName = str


# =============================================================================
# Module Grouping (Language-specific canonical grouping for limit enforcement)
# =============================================================================

def get_module_group(file_path: str, language: str, symbol_name: str = "") -> str:
    """
    Get the canonical module group for a file.
    
    This defines "module" consistently across languages for limit enforcement.
    "Max 10 symbols per module" uses this grouping.
    
    | Language   | Module Definition                              |
    |------------|------------------------------------------------|
    | Python     | Package directory (closest __init__.py parent) |
    | TypeScript | File path + tsconfig paths resolution          |
    | Java       | Package (com.example.auth)                     |
    | Rust       | Crate + module path (crate::auth::middleware)  |
    | C++        | Header file or namespace                       |
    | Go         | Package directory                              |
    
    Args:
        file_path: Path to the file
        language: Language identifier
        symbol_name: Optional symbol name for namespace extraction
        
    Returns:
        Canonical module group string
    """
    import os
    
    # Normalize path separators
    normalized_path = file_path.replace("\\", "/")
    
    if language == "python":
        return _find_python_package_root(normalized_path)
    elif language in ("typescript", "javascript"):
        return _resolve_ts_module(normalized_path)
    elif language == "java":
        return _extract_java_package(normalized_path)
    elif language == "rust":
        return _extract_rust_module_path(normalized_path)
    elif language in ("c", "cpp", "c++"):
        return _extract_cpp_module(normalized_path, symbol_name)
    elif language == "go":
        return _extract_go_package(normalized_path)
    else:
        # Default: use directory
        return os.path.dirname(normalized_path)


def _find_python_package_root(file_path: str) -> str:
    """Find the package root (closest __init__.py parent)."""
    import os
    
    parts = file_path.split("/")
    
    # Walk up looking for __init__.py
    for i in range(len(parts) - 1, 0, -1):
        parent_dir = "/".join(parts[:i])
        # Check if this looks like a package
        if any(p in ["__init__.py", "__init__.pyi"] for p in parts[i-1:i]):
            continue
        # Return the directory containing the file
        if i < len(parts) - 1:
            return "/".join(parts[:i+1])
    
    return "/".join(parts[:-1]) if len(parts) > 1 else parts[0]


def _resolve_ts_module(file_path: str) -> str:
    """Resolve TypeScript module (file path based)."""
    import os
    
    # Normalize path and remove extension
    normalized = file_path.replace("\\", "/")
    base = normalized.rsplit(".", 1)[0] if "." in normalized else normalized

    # Strip common root folders to stabilize module grouping
    for root in ("src/", "lib/", "app/"):
        if base.startswith(root):
            base = base[len(root):]
            break

    # Monorepo patterns: packages/<pkg>/src -> <pkg>/...
    for scope_root in ("packages", "apps"):
        parts = base.split("/")
        if len(parts) >= 3 and parts[0] == scope_root and parts[2] in ("src", "lib", "app"):
            base = "/".join([parts[1]] + parts[3:])
            break
    
    # Handle index files
    if base.endswith("/index"):
        base = base[:-6]
    
    return base


def _extract_java_package(file_path: str) -> str:
    """Extract Java package from file path."""
    # Java packages follow directory structure
    # src/main/java/com/example/auth/AuthService.java -> com.example.auth
    
    parts = file_path.split("/")
    
    # Find java/ or src/ and take everything after
    for i, part in enumerate(parts):
        if part in ("java", "kotlin", "scala"):
            package_parts = parts[i+1:-1]  # Exclude filename
            return ".".join(package_parts)
    
    # Fallback: use directory
    return ".".join(parts[:-1]) if len(parts) > 1 else ""


def _extract_rust_module_path(file_path: str) -> str:
    """Extract Rust crate/module path."""
    # src/auth/middleware.rs -> crate::auth::middleware
    
    parts = file_path.split("/")
    
    # Find src/ and take everything after
    for i, part in enumerate(parts):
        if part == "src":
            module_parts = parts[i+1:]
            # Remove .rs extension from last part
            if module_parts and module_parts[-1].endswith(".rs"):
                module_parts[-1] = module_parts[-1][:-3]
            # Handle mod.rs and lib.rs
            if module_parts and module_parts[-1] in ("mod", "lib"):
                module_parts = module_parts[:-1]
            return "crate::" + "::".join(module_parts)
    
    return "crate"


def _extract_cpp_module(file_path: str, symbol_name: str) -> str:
    """Extract C++ module (header file or namespace)."""
    # Use the header file path as the module
    
    # If it's a header, use the full path
    if file_path.endswith((".h", ".hpp", ".hxx")):
        return file_path.rsplit(".", 1)[0]
    
    # For .cpp files, try to find corresponding header
    for ext in [".h", ".hpp", ".hxx"]:
        header = file_path.rsplit(".", 1)[0] + ext
        return header.rsplit(".", 1)[0]
    
    return file_path.rsplit(".", 1)[0] if "." in file_path else file_path


def _extract_go_package(file_path: str) -> str:
    """Extract Go package (directory)."""
    import os
    return os.path.dirname(file_path)


# =============================================================================
# Token Counter (Model-specific)
# =============================================================================

class TokenCounter:
    """
    Count tokens using the target model's tokenizer.
    
    CRITICAL: Token counts must match the model being prompted.
    If you count with a different tokenizer, BudgetEnforcer will fail.
    
    Supports:
    - GPT models (via tiktoken)
    - Gemini models (approximation or API)
    - Claude models (approximation)
    """
    
    def __init__(self, model: str = "gpt-4"):
        self.model = model
        self._enc = None
        self._chars_per_token = 4  # Default approximation
        
        if "gpt" in model.lower() or "text-embedding" in model.lower():
            try:
                import tiktoken
                self._enc = tiktoken.encoding_for_model(model)
            except Exception:
                # Fallback to cl100k_base for GPT-4 family
                try:
                    import tiktoken
                    self._enc = tiktoken.get_encoding("cl100k_base")
                except ImportError:
                    pass
        elif "gemini" in model.lower():
            # Gemini uses ~4 chars/token approximation
            self._chars_per_token = 4
        elif "claude" in model.lower():
            # Claude uses ~3.5 chars/token approximation
            self._chars_per_token = 3.5
    
    def count(self, text: str) -> int:
        """
        Count tokens in text.
        
        Args:
            text: Text to count tokens for
            
        Returns:
            Token count
        """
        if self._enc:
            return len(self._enc.encode(text))
        return int(len(text) / self._chars_per_token)
    
    def count_chunk(self, chunk: SemanticChunk) -> int:
        """
        Count tokens for a chunk including metadata overhead.
        
        Args:
            chunk: Chunk to count
            
        Returns:
            Token count
        """
        total = 0
        
        # Signature
        if chunk.metadata.signature:
            total += self.count(chunk.metadata.signature)
        
        # Docstring
        if chunk.metadata.docstring:
            total += self.count(chunk.metadata.docstring)
        
        # Code body
        if chunk._code_body:
            total += self.count(chunk._code_body)
        
        # Metadata overhead (~20 tokens)
        total += 20
        
        return total


# =============================================================================
# Stopwords for symbol matching
# =============================================================================

SYMBOL_STOPWORDS = frozenset([
    "utils", "util", "helper", "helpers", "common", "shared",
    "handler", "handlers", "manager", "managers", "service", "services",
    "controller", "controllers", "model", "models", "view", "views",
    "index", "main", "app", "base", "abstract", "interface",
    "type", "types", "config", "constant", "constants",
    "test", "tests", "spec", "specs", "mock", "mocks",
    "get", "set", "is", "has", "to", "from", "of", "the",
])

