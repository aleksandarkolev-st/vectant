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
    canonicalize_signature,
    compute_stable_symbol_id,
)
from ..core.config import get_config


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
    
    def __init__(self, include_nested: bool = True, max_chunk_tokens: Optional[int] = None):
        """
        Initialize chunk extractor.
        
        Args:
            include_nested: Whether to include nested symbols as separate chunks
            max_chunk_tokens: Maximum tokens per chunk (larger symbols are still kept)
        """
        self.include_nested = include_nested
        if max_chunk_tokens is None:
            max_chunk_tokens = get_config().indexer.max_chunk_tokens
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
        max_chunk_tokens = self._max_tokens_for_language(language)
        
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
            parse_result, file.content_hash, file.relative_path, max_chunk_tokens
        )
        
        logger.debug(f"Extracted {len(chunks)} chunks from {file.relative_path}")
        return chunks
    
    def _symbols_to_chunks(
        self,
        parse_result: ParseResult,
        content_hash: str,
        file_path: str,
        max_chunk_tokens: int,
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
        chunking_version = get_config().indexer.chunking_version
        
        for symbol in parse_result.symbols:
            # Build qualified name
            if symbol.qualified_name:
                qualified_name = symbol.qualified_name
            elif symbol.parent:
                qualified_name = f"{symbol.parent}.{symbol.name}"
            else:
                qualified_name = symbol.name
            
            # Determine what this symbol imports/exports
            symbol_imports = symbol.imports if symbol.imports else frozenset()
            symbol_exports = frozenset([symbol.name]) if symbol.name in exported_names else frozenset()
            
            # Compute stable chunk ID
            full_body_fingerprint = compute_body_fingerprint(symbol.code)
            signature_canon = canonicalize_signature(symbol.signature)
            stable_symbol_id = compute_stable_symbol_id(
                parse_result.language,
                symbol.symbol_type,
                signature_canon,
                full_body_fingerprint,
            )
            symbol_identity = f"{parse_result.language}|{symbol.symbol_type.value}|{stable_symbol_id}"
            subchunks = self._split_symbol_code(symbol.code, symbol.start_line, max_chunk_tokens)
            for index, subchunk in enumerate(subchunks):
                sub_code, sub_start_line, sub_end_line = subchunk
                sub_body_fingerprint = compute_body_fingerprint(sub_code)
                anchor = f"part:{index + 1}/{len(subchunks)}"
                chunk_id = compute_chunk_id(
                    symbol_identity=symbol_identity,
                    signature_fingerprint=signature_canon,
                    body_fingerprint=sub_body_fingerprint,
                    chunking_version=chunking_version,
                    anchor=anchor,
                )

                # Create metadata
                metadata = ChunkMetadata(
                    file_path=file_path,
                    start_line=sub_start_line,
                    end_line=sub_end_line,
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
                    chunking_version=chunking_version,
                    stable_symbol_id=stable_symbol_id,
                )

                # Create chunk with stable ID
                chunk = SemanticChunk(
                    id=chunk_id,
                    metadata=metadata,
                )
                # Set code body separately (for lazy loading support)
                chunk._code_body = sub_code
                chunk._code_loaded = True
                chunk.content_hash = content_hash

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

    def _max_tokens_for_language(self, language: str) -> int:
        config = get_config().indexer
        override = config.language_chunk_tokens.get(language)
        if override:
            return override
        return self.max_chunk_tokens

    def _split_symbol_code(
        self,
        code: str,
        start_line: int,
        max_chunk_tokens: int,
    ) -> List[tuple[str, int, int]]:
        line_count = max(1, len(code.splitlines())) if code else 0
        if max_chunk_tokens <= 0:
            return [(code, start_line, start_line + max(0, line_count - 1))]
        estimated_tokens = len(code) // 4 + 1
        if estimated_tokens <= max_chunk_tokens:
            return [(code, start_line, start_line + max(0, line_count - 1))]

        lines = code.splitlines(keepends=True)
        chunks: List[tuple[str, int, int]] = []
        current_lines: List[str] = []
        current_tokens = 0
        current_start_line = start_line

        for idx, line in enumerate(lines):
            line_tokens = len(line) // 4 + 1
            if current_lines and (current_tokens + line_tokens) > max_chunk_tokens:
                chunk_code = "".join(current_lines)
                end_line = current_start_line + len(current_lines) - 1
                chunks.append((chunk_code, current_start_line, end_line))
                current_lines = [line]
                current_tokens = line_tokens
                current_start_line = start_line + idx
            else:
                current_lines.append(line)
                current_tokens += line_tokens

        if current_lines:
            chunk_code = "".join(current_lines)
            end_line = current_start_line + len(current_lines) - 1
            chunks.append((chunk_code, current_start_line, end_line))

        return chunks


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
