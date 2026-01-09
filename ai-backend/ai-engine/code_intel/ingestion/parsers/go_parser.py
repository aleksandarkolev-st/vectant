"""
Go Parser - Pattern-based parsing for Go code.

Extracts functions, types, interfaces, and methods.
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


# Go patterns
PACKAGE_PATTERN = re.compile(r'package\s+(\w+)')
IMPORT_SINGLE_PATTERN = re.compile(r'import\s+"([^"]+)"')
IMPORT_BLOCK_PATTERN = re.compile(r'import\s*\(([\s\S]*?)\)')
IMPORT_LINE_PATTERN = re.compile(r'(?:(\w+)\s+)?"([^"]+)"')

FUNC_PATTERN = re.compile(
    r'func\s+(?:\((\w+)\s+\*?(\w+)\)\s+)?(\w+)\s*(?:\[([^\]]+)\])?\s*\(([^)]*)\)\s*(?:\(([^)]+)\)|(\w+(?:\s*\[\])?)?)?',
    re.MULTILINE
)
TYPE_STRUCT_PATTERN = re.compile(
    r'type\s+(\w+)\s+struct\s*\{',
    re.MULTILINE
)
TYPE_INTERFACE_PATTERN = re.compile(
    r'type\s+(\w+)\s+interface\s*\{',
    re.MULTILINE
)
TYPE_ALIAS_PATTERN = re.compile(
    r'type\s+(\w+)\s+(?!struct|interface)(\w+)',
    re.MULTILINE
)
CONST_BLOCK_PATTERN = re.compile(
    r'const\s*\(([\s\S]*?)\)',
    re.MULTILINE
)
CONST_SINGLE_PATTERN = re.compile(
    r'const\s+(\w+)\s*(?:(\w+))?\s*=',
    re.MULTILINE
)
VAR_PATTERN = re.compile(
    r'var\s+(\w+)\s+(\w+)',
    re.MULTILINE
)


class GoParser(BaseParser):
    """Parser for Go code."""
    
    language = "go"
    aliases = ()
    
    def parse(self, content: str, file_path: str = "") -> ParseResult:
        """Parse Go source code."""
        start_time = time.time()
        
        result = ParseResult(
            file_path=file_path,
            language=self.language,
            symbols=[],
            imports=[],
            exports=[],
        )
        
        lines = content.splitlines(keepends=True)
        
        # Extract package
        package_match = PACKAGE_PATTERN.search(content)
        package = package_match.group(1) if package_match else ""
        
        # Extract imports
        result.imports = self.extract_imports(content)
        
        # Extract functions
        self._extract_functions(content, lines, result.symbols, package)
        
        # Extract types
        self._extract_structs(content, lines, result.symbols, package)
        self._extract_interfaces(content, lines, result.symbols, package)
        
        # Extract exports (public = uppercase first letter)
        for sym in result.symbols:
            if sym.name[0].isupper():
                result.exports.append(ExportStatement(
                    name=sym.name,
                    line=sym.start_line,
                ))
        
        result.parse_time_ms = (time.time() - start_time) * 1000
        return result
    
    def extract_imports(self, content: str) -> List[ImportStatement]:
        """Extract import statements."""
        imports = []
        
        # Single imports
        for match in IMPORT_SINGLE_PATTERN.finditer(content):
            module = match.group(1)
            imports.append(ImportStatement(
                module=module,
                names=[module.split("/")[-1]],
                line=content[:match.start()].count("\n"),
            ))
        
        # Import blocks
        for block_match in IMPORT_BLOCK_PATTERN.finditer(content):
            block = block_match.group(1)
            block_start_line = content[:block_match.start()].count("\n")
            
            for line_num, line in enumerate(block.splitlines()):
                line_match = IMPORT_LINE_PATTERN.search(line)
                if line_match:
                    alias = line_match.group(1)
                    module = line_match.group(2)
                    
                    imports.append(ImportStatement(
                        module=module,
                        names=[module.split("/")[-1]],
                        alias=alias,
                        line=block_start_line + line_num + 1,
                    ))
        
        return imports
    
    def extract_exports(self, content: str) -> List[ExportStatement]:
        """Go exports are uppercase-first identifiers."""
        exports = []
        # Will be populated during symbol extraction
        return exports
    
    def _extract_functions(
        self, content: str, lines: List[str], symbols: List[ParsedSymbol], package: str
    ) -> None:
        """Extract function and method declarations."""
        for match in FUNC_PATTERN.finditer(content):
            receiver_name = match.group(1)
            receiver_type = match.group(2)
            func_name = match.group(3)
            type_params = match.group(4)
            params = match.group(5)
            return_multi = match.group(6)
            return_single = match.group(7)
            
            start_line = content[:match.start()].count("\n")
            
            # Find end of function
            func_start = content.find("{", match.end())
            if func_start == -1:
                continue
            end_line = self._find_block_end(content, func_start, start_line)
            
            # Build signature
            signature_parts = ["func"]
            if receiver_type:
                signature_parts.append(f"({receiver_name} {receiver_type})")
            signature_parts.append(func_name)
            if type_params:
                signature_parts[-1] += f"[{type_params}]"
            signature_parts[-1] += f"({params})"
            
            returns = return_multi or return_single
            if returns:
                signature_parts.append(returns.strip())
            
            signature = " ".join(signature_parts)
            
            # Is it a method?
            symbol_type = SymbolType.METHOD if receiver_type else SymbolType.FUNCTION
            qualified_name = f"{receiver_type}.{func_name}" if receiver_type else func_name
            
            code = self._get_code_slice(lines, start_line, end_line + 1)
            
            # Get preceding comment
            docstring = self._get_preceding_comment(content, match.start())
            
            symbols.append(ParsedSymbol(
                name=func_name,
                qualified_name=qualified_name,
                symbol_type=symbol_type,
                start_line=start_line,
                end_line=end_line,
                code=code,
                signature=signature,
                docstring=docstring,
                parent=receiver_type,
                is_public=func_name[0].isupper() if func_name else False,
            ))
    
    def _extract_structs(
        self, content: str, lines: List[str], symbols: List[ParsedSymbol], package: str
    ) -> None:
        """Extract struct type declarations."""
        for match in TYPE_STRUCT_PATTERN.finditer(content):
            name = match.group(1)
            
            start_line = content[:match.start()].count("\n")
            end_line = self._find_block_end(content, match.end() - 1, start_line)
            
            code = self._get_code_slice(lines, start_line, end_line + 1)
            docstring = self._get_preceding_comment(content, match.start())
            
            symbols.append(ParsedSymbol(
                name=name,
                qualified_name=name,
                symbol_type=SymbolType.STRUCT,
                start_line=start_line,
                end_line=end_line,
                code=code,
                signature=f"type {name} struct",
                docstring=docstring,
                is_public=name[0].isupper() if name else False,
            ))
    
    def _extract_interfaces(
        self, content: str, lines: List[str], symbols: List[ParsedSymbol], package: str
    ) -> None:
        """Extract interface type declarations."""
        for match in TYPE_INTERFACE_PATTERN.finditer(content):
            name = match.group(1)
            
            start_line = content[:match.start()].count("\n")
            end_line = self._find_block_end(content, match.end() - 1, start_line)
            
            code = self._get_code_slice(lines, start_line, end_line + 1)
            docstring = self._get_preceding_comment(content, match.start())
            
            symbols.append(ParsedSymbol(
                name=name,
                qualified_name=name,
                symbol_type=SymbolType.INTERFACE,
                start_line=start_line,
                end_line=end_line,
                code=code,
                signature=f"type {name} interface",
                docstring=docstring,
                is_public=name[0].isupper() if name else False,
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
    
    def _get_preceding_comment(self, content: str, pos: int) -> str:
        """Get comment block preceding a position."""
        # Look for // comments
        lines_before = content[:pos].splitlines()
        comments = []
        
        for line in reversed(lines_before[-10:]):
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
