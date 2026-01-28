"""
Code Ingestion Module

Responsible for:
1. Walking the repository
2. Detecting language per file
3. Parsing with real parsers (not regex)
4. Extracting semantic chunks
5. Extracting symbol edges with confidence scoring

Key principle: Raw files are garbage to an LLM. You must normalize.
"""

from .file_walker import FileWalker, WalkedFile
from .language_detector import LanguageDetector, detect_language
from .parser_base import BaseParser, ParseResult, ParsedSymbol, ImportStatement
from .chunk_extractor import ChunkExtractor, extract_chunks
from .edge_extractor import EdgeExtractor, extract_edges, compute_edge_confidence, ExtractionMethod
from .normalizer import Normalizer, normalize_file

# Language-specific parsers
from .parsers import (
    PythonParser,
    TypeScriptParser,
    JavaScriptParser,
    JavaParser,
    GoParser,
    RustParser,
    CppParser,
    get_parser,
)

__all__ = [
    # Core classes
    "FileWalker",
    "WalkedFile",
    "LanguageDetector",
    "detect_language",
    "BaseParser",
    "ParseResult",
    "ParsedSymbol",
    "ImportStatement",
    "ChunkExtractor",
    "extract_chunks",
    "EdgeExtractor",
    "extract_edges",
    "compute_edge_confidence",
    "ExtractionMethod",
    "Normalizer",
    "normalize_file",
    # Parsers
    "PythonParser",
    "TypeScriptParser",
    "JavaScriptParser", 
    "JavaParser",
    "GoParser",
    "RustParser",
    "CppParser",
    "get_parser",
]
