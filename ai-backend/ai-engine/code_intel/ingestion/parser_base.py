"""
Base Parser Interface - Abstract base class for language parsers.

All language-specific parsers must implement this interface.
Parsers use real parsing (AST-based), not regex pattern matching.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

from ..core.types import (
    ChunkMetadata,
    SemanticChunk,
    SymbolNode,
    SymbolEdge,
    SymbolType,
    EdgeType,
)


@dataclass
class ParsedSymbol:
    """
    A symbol extracted from source code.
    
    Represents a semantic unit (function, class, etc.) before
    conversion to SemanticChunk.
    """
    name: str
    qualified_name: str  # Full path like module.Class.method
    symbol_type: SymbolType
    
    # Location
    start_line: int  # 0-indexed
    end_line: int
    
    # Content
    code: str  # Full source code of this symbol
    
    # Optional location
    start_col: int = 0
    end_col: int = 0
    
    # Optional content
    signature: str = ""  # Function/method signature
    docstring: str = ""
    
    # Relationships
    parent: Optional[str] = None  # Qualified name of containing symbol
    children: List[str] = field(default_factory=list)  # Nested symbols
    
    # Dependencies
    imports: Set[str] = field(default_factory=set)
    exports: Set[str] = field(default_factory=set)
    references: Set[str] = field(default_factory=set)  # Symbols referenced in body
    
    # Metadata
    decorators: List[str] = field(default_factory=list)
    is_public: bool = True
    is_async: bool = False
    is_static: bool = False
    is_abstract: bool = False


@dataclass
class ParseResult:
    """
    Result of parsing a file.
    
    Contains all extracted symbols and their relationships.
    """
    file_path: str
    language: str
    
    # Extracted symbols
    symbols: List[ParsedSymbol]
    
    # File-level imports (what this file brings in)
    imports: List[ImportStatement]
    
    # File-level exports (what this file exposes)
    exports: List[ExportStatement]
    
    # Parse errors (non-fatal)
    errors: List[ParseError] = field(default_factory=list)
    
    # Success flag
    success: bool = True
    
    # Timing
    parse_time_ms: float = 0.0
    
    def get_symbol(self, name: str) -> Optional[ParsedSymbol]:
        """Get a symbol by name (simple or qualified)."""
        for sym in self.symbols:
            if sym.name == name or sym.qualified_name == name:
                return sym
        return None
    
    def get_top_level_symbols(self) -> List[ParsedSymbol]:
        """Get symbols at module level (not nested)."""
        return [s for s in self.symbols if s.parent is None]
    
    def to_chunks(self, content_hash: str) -> List[SemanticChunk]:
        """Convert parse result to semantic chunks."""
        chunks = []
        
        for symbol in self.symbols:
            metadata = ChunkMetadata(
                file_path=self.file_path,
                start_line=symbol.start_line,
                end_line=symbol.end_line,
                start_col=symbol.start_col,
                end_col=symbol.end_col,
                symbol_name=symbol.name,
                symbol_type=symbol.symbol_type,
                signature=symbol.signature,
                docstring=symbol.docstring,
                imports_used=frozenset(symbol.imports),
                exports_provided=frozenset(symbol.exports),
                parent_symbol=symbol.parent,
                language=self.language,
                is_public=symbol.is_public,
                is_test="_test" in self.file_path.lower() or "test_" in symbol.name.lower(),
            )
            
            chunk = SemanticChunk(
                id="",  # Will be generated
                code_body=symbol.code,
                metadata=metadata,
            )
            chunks.append(chunk)
        
        return chunks


@dataclass
class ImportStatement:
    """Represents an import statement."""
    # What's being imported
    module: str  # Module/package path
    names: List[str]  # Specific names imported (empty for whole module)
    alias: Optional[str] = None  # Import alias
    
    # Location
    line: int = 0
    
    # Type
    is_relative: bool = False
    is_type_only: bool = False  # TypeScript 'import type'


@dataclass
class ExportStatement:
    """Represents an export statement."""
    name: str
    alias: Optional[str] = None
    
    # Location
    line: int = 0
    
    # Type
    is_default: bool = False
    is_re_export: bool = False
    from_module: Optional[str] = None  # For re-exports


@dataclass
class ParseError:
    """A non-fatal parse error."""
    message: str
    line: int
    column: int = 0
    severity: str = "warning"  # warning, error


class BaseParser(ABC):
    """
    Abstract base class for language parsers.
    
    Implementations must parse code using proper AST parsing,
    not regex pattern matching. This ensures:
    - Correct handling of nested structures
    - Accurate scope detection
    - Proper signature extraction
    """
    
    # Language this parser handles
    language: str = "unknown"
    
    # Alternative names for the language
    aliases: tuple = ()
    
    @abstractmethod
    def parse(self, content: str, file_path: str = "") -> ParseResult:
        """
        Parse source code and extract semantic units.
        
        Args:
            content: Source code content
            file_path: Optional path for context
            
        Returns:
            ParseResult with extracted symbols and imports/exports
        """
        raise NotImplementedError
    
    @abstractmethod
    def extract_imports(self, content: str) -> List[ImportStatement]:
        """
        Extract import statements from source.
        
        This can be called separately for fast import graph building.
        """
        raise NotImplementedError
    
    @abstractmethod
    def extract_exports(self, content: str) -> List[ExportStatement]:
        """
        Extract export statements from source.
        
        This can be called separately for fast export detection.
        """
        raise NotImplementedError
    
    def supports_language(self, language: str) -> bool:
        """Check if this parser supports a language."""
        lang_lower = language.lower()
        return lang_lower == self.language or lang_lower in self.aliases
    
    def _make_qualified_name(self, name: str, parent: Optional[str]) -> str:
        """Create qualified name from name and parent."""
        if parent:
            return f"{parent}.{name}"
        return name
    
    def _extract_docstring(self, node: Any) -> str:
        """Extract docstring from a node (language-specific override)."""
        return ""
    
    def _is_public_name(self, name: str) -> bool:
        """Check if a name indicates public visibility."""
        # Default: private if starts with underscore
        return not name.startswith("_")
