"""
Rust Parser - Pattern-based parsing for Rust code.

Extracts functions, structs, enums, traits, and impls.
"""

from __future__ import annotations

import re
import time
from typing import List, Optional, Set

from ..parser_base import (
    BaseParser,
    ParseResult,
    ParsedSymbol,
    ImportStatement,
    ExportStatement,
    ParseError,
)
from ...core.types import SymbolType


# Rust patterns
USE_PATTERN = re.compile(r'use\s+([\w:]+)(?:::\{([^}]+)\}|::\*)?;')
MOD_PATTERN = re.compile(r'(?:pub\s+)?mod\s+(\w+)\s*[;{]')

FN_PATTERN = re.compile(
    r'(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?:->\s*([^\s{]+))?\s*(?:where[^{]*)?[{;]',
    re.MULTILINE
)
STRUCT_PATTERN = re.compile(
    r'(?:pub(?:\([^)]*\))?\s+)?struct\s+(\w+)\s*(?:<[^>]*>)?\s*(?:\([^)]*\)|(?:where[^{]*)?[{;])',
    re.MULTILINE
)
ENUM_PATTERN = re.compile(
    r'(?:pub(?:\([^)]*\))?\s+)?enum\s+(\w+)\s*(?:<[^>]*>)?\s*(?:where[^{]*)?\{',
    re.MULTILINE
)
TRAIT_PATTERN = re.compile(
    r'(?:pub(?:\([^)]*\))?\s+)?(?:unsafe\s+)?trait\s+(\w+)\s*(?:<[^>]*>)?(?:\s*:\s*[^{]+)?\s*(?:where[^{]*)?\{',
    re.MULTILINE
)
IMPL_PATTERN = re.compile(
    r'impl\s*(?:<[^>]*>)?\s*(?:(\w+)\s+for\s+)?(\w+)(?:<[^>]*>)?\s*(?:where[^{]*)?\{',
    re.MULTILINE
)
TYPE_ALIAS_PATTERN = re.compile(
    r'(?:pub(?:\([^)]*\))?\s+)?type\s+(\w+)\s*(?:<[^>]*>)?\s*=',
    re.MULTILINE
)
CONST_PATTERN = re.compile(
    r'(?:pub(?:\([^)]*\))?\s+)?const\s+(\w+)\s*:\s*([^=]+)\s*=',
    re.MULTILINE
)


class RustParser(BaseParser):
    """Parser for Rust code."""
    
    language = "rust"
    aliases = ("rs",)
    
    def parse(self, content: str, file_path: str = "") -> ParseResult:
        """Parse Rust source code."""
        start_time = time.time()
        
        result = ParseResult(
            file_path=file_path,
            language=self.language,
            symbols=[],
            imports=[],
            exports=[],
        )
        
        lines = content.splitlines(keepends=True)
        
        # Extract imports (use statements)
        result.imports = self.extract_imports(content)
        
        # Extract symbols
        self._extract_functions(content, lines, result.symbols)
        self._extract_structs(content, lines, result.symbols)
        self._extract_enums(content, lines, result.symbols)
        self._extract_traits(content, lines, result.symbols)
        self._extract_impls(content, lines, result.symbols)
        
        # Build exports (pub items)
        for sym in result.symbols:
            if sym.is_public:
                result.exports.append(ExportStatement(
                    name=sym.name,
                    line=sym.start_line,
                ))
        
        result.parse_time_ms = (time.time() - start_time) * 1000
        return result
    
    def extract_imports(self, content: str) -> List[ImportStatement]:
        """Extract use statements."""
        imports = []
        
        for match in USE_PATTERN.finditer(content):
            module = match.group(1)
            names_block = match.group(2)
            
            if names_block:
                # Multiple imports: use foo::{bar, baz}
                names = [n.strip().split(" as ")[-1] for n in names_block.split(",")]
            else:
                # Single import or glob
                names = [module.split("::")[-1]]
            
            imports.append(ImportStatement(
                module=module,
                names=names,
                line=content[:match.start()].count("\n"),
            ))
        
        return imports
    
    def extract_exports(self, content: str) -> List[ExportStatement]:
        """Rust exports are pub items."""
        exports = []
        # Will be populated during symbol extraction
        return exports
    
    def _extract_functions(
        self, content: str, lines: List[str], symbols: List[ParsedSymbol]
    ) -> None:
        """Extract function declarations."""
        for match in FN_PATTERN.finditer(content):
            name = match.group(1)
            params = match.group(2)
            return_type = match.group(3)
            
            start_line = content[:match.start()].count("\n")
            
            # Find end - either ; or }
            if content[match.end() - 1] == ";":
                end_line = start_line
            else:
                func_start = match.end() - 1
                end_line = self._find_block_end(content, func_start, start_line)
            
            preceding = content[max(0, match.start()-50):match.start()]
            is_public = "pub" in preceding
            is_async = "async" in preceding
            is_unsafe = "unsafe" in preceding
            
            signature = f"fn {name}({params})"
            if return_type:
                signature += f" -> {return_type}"
            
            code = self._get_code_slice(lines, start_line, end_line + 1)
            docstring = self._get_doc_comment(content, match.start())
            
            symbols.append(ParsedSymbol(
                name=name,
                qualified_name=name,
                symbol_type=SymbolType.FUNCTION,
                start_line=start_line,
                end_line=end_line,
                code=code,
                signature=signature,
                docstring=docstring,
                is_public=is_public,
                is_async=is_async,
            ))
    
    def _extract_structs(
        self, content: str, lines: List[str], symbols: List[ParsedSymbol]
    ) -> None:
        """Extract struct declarations."""
        for match in STRUCT_PATTERN.finditer(content):
            name = match.group(1)
            
            start_line = content[:match.start()].count("\n")
            
            # Check if unit struct, tuple struct, or block struct
            match_end_char = content[match.end() - 1]
            if match_end_char == ";":
                end_line = start_line
            elif match_end_char == "{":
                end_line = self._find_block_end(content, match.end() - 1, start_line)
            else:  # tuple struct with )
                # Find the ;
                semi_pos = content.find(";", match.end())
                end_line = content[:semi_pos].count("\n") if semi_pos > 0 else start_line
            
            preceding = content[max(0, match.start()-30):match.start()]
            is_public = "pub" in preceding
            
            code = self._get_code_slice(lines, start_line, end_line + 1)
            docstring = self._get_doc_comment(content, match.start())
            
            symbols.append(ParsedSymbol(
                name=name,
                qualified_name=name,
                symbol_type=SymbolType.STRUCT,
                start_line=start_line,
                end_line=end_line,
                code=code,
                signature=f"struct {name}",
                docstring=docstring,
                is_public=is_public,
            ))
    
    def _extract_enums(
        self, content: str, lines: List[str], symbols: List[ParsedSymbol]
    ) -> None:
        """Extract enum declarations."""
        for match in ENUM_PATTERN.finditer(content):
            name = match.group(1)
            
            start_line = content[:match.start()].count("\n")
            end_line = self._find_block_end(content, match.end() - 1, start_line)
            
            preceding = content[max(0, match.start()-30):match.start()]
            is_public = "pub" in preceding
            
            code = self._get_code_slice(lines, start_line, end_line + 1)
            docstring = self._get_doc_comment(content, match.start())
            
            symbols.append(ParsedSymbol(
                name=name,
                qualified_name=name,
                symbol_type=SymbolType.ENUM,
                start_line=start_line,
                end_line=end_line,
                code=code,
                signature=f"enum {name}",
                docstring=docstring,
                is_public=is_public,
            ))
    
    def _extract_traits(
        self, content: str, lines: List[str], symbols: List[ParsedSymbol]
    ) -> None:
        """Extract trait declarations."""
        for match in TRAIT_PATTERN.finditer(content):
            name = match.group(1)
            
            start_line = content[:match.start()].count("\n")
            end_line = self._find_block_end(content, match.end() - 1, start_line)
            
            preceding = content[max(0, match.start()-30):match.start()]
            is_public = "pub" in preceding
            
            code = self._get_code_slice(lines, start_line, end_line + 1)
            docstring = self._get_doc_comment(content, match.start())
            
            symbols.append(ParsedSymbol(
                name=name,
                qualified_name=name,
                symbol_type=SymbolType.TRAIT,
                start_line=start_line,
                end_line=end_line,
                code=code,
                signature=f"trait {name}",
                docstring=docstring,
                is_public=is_public,
            ))
    
    def _extract_impls(
        self, content: str, lines: List[str], symbols: List[ParsedSymbol]
    ) -> None:
        """Extract impl blocks."""
        for match in IMPL_PATTERN.finditer(content):
            trait_name = match.group(1)
            type_name = match.group(2)
            
            start_line = content[:match.start()].count("\n")
            end_line = self._find_block_end(content, match.end() - 1, start_line)
            
            if trait_name:
                name = f"{trait_name}_for_{type_name}"
                signature = f"impl {trait_name} for {type_name}"
            else:
                name = f"impl_{type_name}"
                signature = f"impl {type_name}"
            
            code = self._get_code_slice(lines, start_line, end_line + 1)
            docstring = self._get_doc_comment(content, match.start())
            
            symbols.append(ParsedSymbol(
                name=name,
                qualified_name=name,
                symbol_type=SymbolType.IMPL_BLOCK,
                start_line=start_line,
                end_line=end_line,
                code=code,
                signature=signature,
                docstring=docstring,
                is_public=True,  # impl blocks are always visible
                imports={type_name} | ({trait_name} if trait_name else set()),
            ))
    
    def _find_block_end(self, content: str, open_brace_pos: int, start_line: int) -> int:
        """Find the line number where a block ends."""
        depth = 1
        pos = open_brace_pos + 1
        
        while pos < len(content) and depth > 0:
            char = content[pos]
            if char == "{":
                depth += 1
            elif char == "}":
                depth -= 1
            pos += 1
        
        return content[:pos].count("\n")
    
    def _get_doc_comment(self, content: str, pos: int) -> str:
        """Get /// or //! doc comments preceding a position."""
        lines_before = content[:pos].splitlines()
        comments = []
        
        for line in reversed(lines_before[-15:]):
            stripped = line.strip()
            if stripped.startswith("///") or stripped.startswith("//!"):
                comment_text = stripped[3:].strip()
                comments.insert(0, comment_text)
            elif stripped.startswith("#[") or stripped.startswith("pub") or stripped == "":
                # Skip attributes and whitespace
                continue
            else:
                break
        
        return "\n".join(comments)
    
    def _get_code_slice(self, lines: List[str], start: int, end: int) -> str:
        """Get a slice of code from lines."""
        if start < 0:
            start = 0
        if end > len(lines):
            end = len(lines)
        return "".join(lines[start:end]).rstrip()
