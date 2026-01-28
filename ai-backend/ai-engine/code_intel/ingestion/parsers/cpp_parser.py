"""
C/C++ Parser - Pattern-based parsing for C and C++ code.

Extracts functions, classes, structs, and namespaces.
For production, use tree-sitter or libclang.
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


# C/C++ patterns
INCLUDE_PATTERN = re.compile(r'#include\s*[<"]([^>"]+)[>"]')

# Function pattern - simplified
FUNCTION_PATTERN = re.compile(
    r'(?:(?:static|inline|virtual|explicit|constexpr|extern)\s+)*(?:[\w:]+(?:<[^>]*>)?(?:\s*\*+)?)\s+(\w+)\s*\(([^)]*)\)\s*(?:const)?\s*(?:override)?\s*(?:=\s*(?:0|default|delete))?\s*[{;]',
    re.MULTILINE
)

# Class/struct pattern
CLASS_PATTERN = re.compile(
    r'(?:template\s*<[^>]*>\s*)?(?:class|struct)\s+(?:__declspec\([^)]*\)\s+)?(\w+)(?:\s*:\s*(?:public|private|protected)\s+[\w:]+(?:\s*,\s*(?:public|private|protected)\s+[\w:]+)*)?\s*\{',
    re.MULTILINE
)

# Namespace pattern
NAMESPACE_PATTERN = re.compile(
    r'namespace\s+(\w+)\s*\{',
    re.MULTILINE
)

# Enum pattern
ENUM_PATTERN = re.compile(
    r'enum\s+(?:class\s+)?(\w+)(?:\s*:\s*\w+)?\s*\{',
    re.MULTILINE
)

# Typedef pattern
TYPEDEF_PATTERN = re.compile(
    r'typedef\s+.+?\s+(\w+)\s*;',
    re.MULTILINE
)

# Using pattern (type alias)
USING_PATTERN = re.compile(
    r'using\s+(\w+)\s*=',
    re.MULTILINE
)

# Macro/define pattern
DEFINE_PATTERN = re.compile(
    r'#define\s+(\w+)(?:\([^)]*\))?\s+',
    re.MULTILINE
)


class CppParser(BaseParser):
    """Parser for C and C++ code."""
    
    language = "cpp"
    aliases = ("c", "h", "hpp", "cc", "cxx", "hh", "hxx")
    
    def parse(self, content: str, file_path: str = "") -> ParseResult:
        """Parse C/C++ source code."""
        start_time = time.time()
        
        result = ParseResult(
            file_path=file_path,
            language=self.language,
            symbols=[],
            imports=[],
            exports=[],
        )
        
        lines = content.splitlines(keepends=True)
        
        # Extract includes
        result.imports = self.extract_imports(content)
        
        # Extract symbols
        self._extract_classes(content, lines, result.symbols)
        self._extract_functions(content, lines, result.symbols)
        self._extract_namespaces(content, lines, result.symbols)
        self._extract_enums(content, lines, result.symbols)
        
        result.parse_time_ms = (time.time() - start_time) * 1000
        return result
    
    def extract_imports(self, content: str) -> List[ImportStatement]:
        """Extract #include statements."""
        imports = []
        
        for match in INCLUDE_PATTERN.finditer(content):
            header = match.group(1)
            imports.append(ImportStatement(
                module=header,
                names=[header.split("/")[-1].replace(".h", "").replace(".hpp", "")],
                line=content[:match.start()].count("\n"),
            ))
        
        return imports
    
    def extract_exports(self, content: str) -> List[ExportStatement]:
        """C/C++ doesn't have explicit exports in the same way."""
        return []
    
    def _extract_classes(
        self, content: str, lines: List[str], symbols: List[ParsedSymbol]
    ) -> None:
        """Extract class and struct declarations."""
        for match in CLASS_PATTERN.finditer(content):
            name = match.group(1)
            
            start_line = content[:match.start()].count("\n")
            end_line = self._find_block_end(content, match.end() - 1, start_line)
            
            # Determine if struct or class
            preceding = content[max(0, match.start()-20):match.start()]
            is_struct = "struct" in preceding.lower()
            
            code = self._get_code_slice(lines, start_line, end_line + 1)
            docstring = self._get_comment(content, match.start())
            
            symbol_type = SymbolType.STRUCT if is_struct else SymbolType.CLASS
            keyword = "struct" if is_struct else "class"
            
            symbols.append(ParsedSymbol(
                name=name,
                qualified_name=name,
                symbol_type=symbol_type,
                start_line=start_line,
                end_line=end_line,
                code=code,
                signature=f"{keyword} {name}",
                docstring=docstring,
                is_public=True,  # Header files make things public
            ))
    
    def _extract_functions(
        self, content: str, lines: List[str], symbols: List[ParsedSymbol]
    ) -> None:
        """Extract function declarations and definitions."""
        for match in FUNCTION_PATTERN.finditer(content):
            name = match.group(1)
            params = match.group(2)
            
            # Skip constructor/destructor detection (same name as class)
            # Skip common keywords that look like functions
            if name in ("if", "while", "for", "switch", "return", "sizeof", "typeof"):
                continue
            
            start_line = content[:match.start()].count("\n")
            
            # Check if it's a declaration (;) or definition ({)
            match_end_char = content[match.end() - 1]
            if match_end_char == ";":
                end_line = start_line
            else:
                end_line = self._find_block_end(content, match.end() - 1, start_line)
            
            preceding = content[max(0, match.start()-100):match.start()]
            is_static = "static" in preceding.split("\n")[-1]
            is_virtual = "virtual" in preceding
            
            code = self._get_code_slice(lines, start_line, end_line + 1)
            docstring = self._get_comment(content, match.start())
            
            # Build signature from the matched line
            full_match = content[match.start():match.end() - 1]
            signature = full_match.strip()
            
            symbols.append(ParsedSymbol(
                name=name,
                qualified_name=name,
                symbol_type=SymbolType.FUNCTION,
                start_line=start_line,
                end_line=end_line,
                code=code,
                signature=signature,
                docstring=docstring,
                is_public=not is_static,
                is_static=is_static,
            ))
    
    def _extract_namespaces(
        self, content: str, lines: List[str], symbols: List[ParsedSymbol]
    ) -> None:
        """Extract namespace declarations."""
        for match in NAMESPACE_PATTERN.finditer(content):
            name = match.group(1)
            
            start_line = content[:match.start()].count("\n")
            end_line = self._find_block_end(content, match.end() - 1, start_line)
            
            code = self._get_code_slice(lines, start_line, end_line + 1)
            
            symbols.append(ParsedSymbol(
                name=name,
                qualified_name=name,
                symbol_type=SymbolType.NAMESPACE,
                start_line=start_line,
                end_line=end_line,
                code=code,
                signature=f"namespace {name}",
                is_public=True,
            ))
    
    def _extract_enums(
        self, content: str, lines: List[str], symbols: List[ParsedSymbol]
    ) -> None:
        """Extract enum declarations."""
        for match in ENUM_PATTERN.finditer(content):
            name = match.group(1)
            
            start_line = content[:match.start()].count("\n")
            end_line = self._find_block_end(content, match.end() - 1, start_line)
            
            code = self._get_code_slice(lines, start_line, end_line + 1)
            docstring = self._get_comment(content, match.start())
            
            preceding = content[max(0, match.start()-20):match.start()]
            is_enum_class = "class" in preceding
            
            symbols.append(ParsedSymbol(
                name=name,
                qualified_name=name,
                symbol_type=SymbolType.ENUM,
                start_line=start_line,
                end_line=end_line,
                code=code,
                signature=f"enum {'class ' if is_enum_class else ''}{name}",
                docstring=docstring,
                is_public=True,
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
    
    def _get_comment(self, content: str, pos: int) -> str:
        """Get comment (// or /* */) preceding a position."""
        search_start = max(0, pos - 1000)
        before = content[search_start:pos]
        
        # Look for block comment
        block_end = before.rfind("*/")
        if block_end > -1:
            block_start = before.rfind("/*", 0, block_end)
            if block_start > -1:
                comment = before[block_start+2:block_end].strip()
                # Check nothing significant between comment and position
                after = before[block_end+2:]
                if not after.strip() or all(c in " \t\n" for c in after):
                    # Clean up comment
                    lines = comment.split("\n")
                    cleaned = []
                    for line in lines:
                        line = line.strip()
                        if line.startswith("*"):
                            line = line[1:].strip()
                        cleaned.append(line)
                    return "\n".join(cleaned)
        
        # Look for line comments
        lines = before.splitlines()
        comments = []
        for line in reversed(lines[-10:]):
            stripped = line.strip()
            if stripped.startswith("//"):
                comments.insert(0, stripped[2:].strip())
            elif stripped:
                break
        
        return "\n".join(comments)
    
    def _get_code_slice(self, lines: List[str], start: int, end: int) -> str:
        """Get a slice of code from lines."""
        if start < 0:
            start = 0
        if end > len(lines):
            end = len(lines)
        return "".join(lines[start:end]).rstrip()
