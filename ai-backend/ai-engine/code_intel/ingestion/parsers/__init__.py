"""
Language-specific Parsers

Each parser uses proper AST parsing (not regex) to extract semantic units.
"""

from .python_parser import PythonParser
from .typescript_parser import TypeScriptParser, JavaScriptParser
from .java_parser import JavaParser
from .go_parser import GoParser
from .rust_parser import RustParser
from .cpp_parser import CppParser

from typing import Optional
from ..parser_base import BaseParser


# Registry of all parsers
_PARSERS = {
    "python": PythonParser,
    "py": PythonParser,
    "typescript": TypeScriptParser,
    "ts": TypeScriptParser,
    "typescriptreact": TypeScriptParser,
    "tsx": TypeScriptParser,
    "javascript": JavaScriptParser,
    "js": JavaScriptParser,
    "javascriptreact": JavaScriptParser,
    "jsx": JavaScriptParser,
    "java": JavaParser,
    "go": GoParser,
    "rust": RustParser,
    "rs": RustParser,
    "cpp": CppParser,
    "c": CppParser,
}


def get_parser(language: str) -> Optional[BaseParser]:
    """
    Get a parser for a language.
    
    Args:
        language: Language identifier
        
    Returns:
        Parser instance or None if unsupported
    """
    lang_lower = language.lower()
    parser_class = _PARSERS.get(lang_lower)
    
    if parser_class:
        return parser_class()
    
    return None


def supports_language(language: str) -> bool:
    """Check if a language is supported."""
    return language.lower() in _PARSERS


__all__ = [
    "PythonParser",
    "TypeScriptParser",
    "JavaScriptParser",
    "JavaParser",
    "GoParser",
    "RustParser",
    "CppParser",
    "get_parser",
    "supports_language",
]
