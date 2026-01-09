"""
Chunk Extractor - Convert parsed results to semantic chunks.

Responsible for creating properly structured SemanticChunk objects
from parser output.

CRITICAL: Sets stable chunk IDs and module groups for proper indexing.
"""

from __future__ import annotations

import logging
from typing import Dict, List, Optional

from .file_walker import WalkedFile
from .language_detector import detect_language
from .parser_base import ParseResult, ParsedSymbol
from .parsers import get_parser
from ..core.types import (
    ChunkMetadata,
    SemanticChunk,
    SymbolType,
    get_module_group,
    compute_chunk_id,
    compute_body_fingerprint,
)


logger = logging.getLogger("code_intel.ingestion.chunk_extractor")


class ChunkExtractor:
    """
    Extract semantic chunks from source files.
    
    Combines:
    1. Language detection
    2. Parsing
    3. Chunk creation
    
    Each chunk is a self-describing semantic unit with full metadata.
    """
    
    def __init__(self, include_nested: bool = True, max_chunk_tokens: int = 2000):
        """
        Initialize chunk extractor.
        
        Args:
            include_nested: Whether to include nested symbols as separate chunks
            max_chunk_tokens: Maximum tokens per chunk (larger symbols are still kept)
        """
        self.include_nested = include_nested
        self.max_chunk_tokens = max_chunk_tokens
    
    def extract(self, file: WalkedFile) -> List[SemanticChunk]:
        """
        Extract semantic chunks from a file.
        
        Args:
            file: WalkedFile with path and content
            
        Returns:
            List of SemanticChunk objects
        """
        # Detect language
        language = detect_language(file.path, file.content)
        file.language = language
        
        # Get parser
        parser = get_parser(language)
        if not parser:
            logger.debug(f"No parser for language: {language} ({file.relative_path})")
            return []
        
        # Parse
        try:
            parse_result = parser.parse(file.content, file.relative_path)
        except Exception as e:
            logger.warning(f"Parse failed for {file.relative_path}: {e}")
            return []
        
        if not parse_result.success and not parse_result.symbols:
            logger.debug(f"Parse unsuccessful for {file.relative_path}")
            return []
        
        # Convert to chunks
        chunks = self._symbols_to_chunks(
            parse_result, file.content_hash, file.relative_path
        )
        
        logger.debug(f"Extracted {len(chunks)} chunks from {file.relative_path}")
        return chunks
    
    def _symbols_to_chunks(
        self,
        parse_result: ParseResult,
        content_hash: str,
        file_path: str,
    ) -> List[SemanticChunk]:
        """Convert parsed symbols to semantic chunks."""
        chunks = []
        
        # Build import set for reference
        imported_names = set()
        for imp in parse_result.imports:
            imported_names.update(imp.names)
            if imp.alias:
                imported_names.add(imp.alias)
        
        # Build export set
        exported_names = {exp.name for exp in parse_result.exports}
        
        # Compute module group for this file
        module_group = get_module_group(file_path, parse_result.language)
        
        for symbol in parse_result.symbols:
            # Build qualified name
            if symbol.parent:
                qualified_name = f"{symbol.parent}.{symbol.name}"
            else:
                qualified_name = symbol.name
            
            # Determine what this symbol imports/exports
            symbol_imports = symbol.imports if symbol.imports else frozenset()
            symbol_exports = frozenset([symbol.name]) if symbol.name in exported_names else frozenset()
            
            # Compute stable chunk ID
            body_fingerprint = compute_body_fingerprint(symbol.code)
            chunk_id = compute_chunk_id(
                file_path,
                qualified_name,
                symbol.signature,
                body_fingerprint
            )
            
            # Create metadata
            metadata = ChunkMetadata(
                file_path=file_path,
                start_line=symbol.start_line,
                end_line=symbol.end_line,
                start_col=symbol.start_col,
                end_col=symbol.end_col,
                symbol_name=symbol.name,
                qualified_name=qualified_name,
                symbol_type=symbol.symbol_type,
                signature=symbol.signature,
                docstring=symbol.docstring,
                imports_used=frozenset(symbol_imports),
                exports_provided=symbol_exports,
                parent_symbol=symbol.parent,
                language=parse_result.language,
                is_public=symbol.is_public,
                is_test=self._is_test_code(file_path, symbol.name),
                module_group=module_group,
            )
            
            # Create chunk with stable ID
            chunk = SemanticChunk(
                id=chunk_id,
                metadata=metadata,
            )
            # Set code body separately (for lazy loading support)
            chunk._code_body = symbol.code
            chunk._code_loaded = True
            
            chunks.append(chunk)
        
        return chunks
    
    def _is_test_code(self, file_path: str, symbol_name: str) -> bool:
        """Detect if code is test code."""
        path_lower = file_path.lower()
        name_lower = symbol_name.lower()
        
        # Path-based detection
        if any(p in path_lower for p in ["test/", "tests/", "__tests__/", "spec/", "_test."]):
            return True
        
        # Name-based detection
        if name_lower.startswith("test") or name_lower.endswith("test"):
            return True
        if name_lower.startswith("spec") or name_lower.endswith("spec"):
            return True
        
        return False


def extract_chunks(file: WalkedFile, **kwargs) -> List[SemanticChunk]:
    """
    Convenience function to extract chunks from a file.
    
    Args:
        file: WalkedFile to extract from
        **kwargs: Options passed to ChunkExtractor
        
    Returns:
        List of SemanticChunk objects
    """
    extractor = ChunkExtractor(**kwargs)
    return extractor.extract(file)
