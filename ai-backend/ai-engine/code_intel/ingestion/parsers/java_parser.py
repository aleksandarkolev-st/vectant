"""
Java Parser - Pattern-based parsing for Java code.

Extracts classes, interfaces, methods, and fields.
For production use, integrate a proper Java parser like JavaParser or tree-sitter.
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


# Java patterns
PACKAGE_PATTERN = re.compile(r'package\s+([\w.]+)\s*;')
IMPORT_PATTERN = re.compile(r'import\s+(?:static\s+)?([\w.*]+)\s*;')

CLASS_PATTERN = re.compile(
    r'(?:(?:public|private|protected|abstract|final|static)\s+)*class\s+(\w+)(?:\s*<[^>]*>)?(?:\s+extends\s+(\w+))?(?:\s+implements\s+([\w,\s]+))?\s*\{',
    re.MULTILINE
)
INTERFACE_PATTERN = re.compile(
    r'(?:(?:public|private|protected)\s+)?interface\s+(\w+)(?:\s*<[^>]*>)?(?:\s+extends\s+([\w,\s]+))?\s*\{',
    re.MULTILINE
)
ENUM_PATTERN = re.compile(
    r'(?:(?:public|private|protected)\s+)?enum\s+(\w+)\s*\{',
    re.MULTILINE
)
METHOD_PATTERN = re.compile(
    r'(?:(?:public|private|protected|static|final|abstract|synchronized|native)\s+)*(?:<[^>]*>\s+)?(\w+(?:\[\])?)\s+(\w+)\s*\(([^)]*)\)\s*(?:throws\s+[\w,\s]+)?\s*[{;]',
    re.MULTILINE
)
FIELD_PATTERN = re.compile(
    r'(?:(?:public|private|protected|static|final|transient|volatile)\s+)+(\w+(?:\[\])?(?:<[^>]*>)?)\s+(\w+)\s*(?:=|;)',
    re.MULTILINE
)

JAVADOC_PATTERN = re.compile(r'/\*\*\s*([\s\S]*?)\s*\*/')


class JavaParser(BaseParser):
    """Parser for Java code."""
    
    language = "java"
    aliases = ()
    
    def parse(self, content: str, file_path: str = "") -> ParseResult:
        """Parse Java source code."""
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
        
        # Extract classes
        self._extract_classes(content, lines, result.symbols, package)
        
        # Extract interfaces
        self._extract_interfaces(content, lines, result.symbols, package)
        
        # Extract enums
        self._extract_enums(content, lines, result.symbols, package)
        
        result.parse_time_ms = (time.time() - start_time) * 1000
        return result
    
    def extract_imports(self, content: str) -> List[ImportStatement]:
        """Extract import statements."""
        imports = []
        
        for match in IMPORT_PATTERN.finditer(content):
            module = match.group(1)
            # Handle star imports
            names = [] if module.endswith(".*") else [module.split(".")[-1]]
            module_path = module.rsplit(".", 1)[0] if "." in module else module
            
            imports.append(ImportStatement(
                module=module_path,
                names=names,
                line=content[:match.start()].count("\n"),
            ))
        
        return imports
    
    def extract_exports(self, content: str) -> List[ExportStatement]:
        """Java doesn't have explicit exports - public classes are exported."""
        exports = []
        
        for match in CLASS_PATTERN.finditer(content):
            preceding = content[max(0, match.start()-50):match.start()]
            if "public" in preceding:
                exports.append(ExportStatement(
                    name=match.group(1),
                    line=content[:match.start()].count("\n"),
                ))
        
        return exports
    
    def _extract_classes(
        self, content: str, lines: List[str], symbols: List[ParsedSymbol], package: str
    ) -> None:
        """Extract class declarations."""
        for match in CLASS_PATTERN.finditer(content):
            name = match.group(1)
            extends = match.group(2)
            implements = match.group(3)
            
            start_line = content[:match.start()].count("\n")
            end_line = self._find_block_end(content, match.end() - 1, start_line)
            
            qualified_name = f"{package}.{name}" if package else name
            
            docstring = self._get_preceding_javadoc(content, match.start())
            
            preceding = content[max(0, match.start()-100):match.start()]
            is_public = "public" in preceding
            is_abstract = "abstract" in preceding
            
            signature = f"class {name}"
            if extends:
                signature += f" extends {extends}"
            if implements:
                signature += f" implements {implements.strip()}"
            
            code = self._get_code_slice(lines, start_line, end_line + 1)
            
            imports_used = set()
            if extends:
                imports_used.add(extends)
            
            symbols.append(ParsedSymbol(
                name=name,
                qualified_name=qualified_name,
                symbol_type=SymbolType.CLASS,
                start_line=start_line,
                end_line=end_line,
                code=code,
                signature=signature,
                docstring=docstring,
                is_public=is_public,
                is_abstract=is_abstract,
                imports=imports_used,
            ))
    
    def _extract_interfaces(
        self, content: str, lines: List[str], symbols: List[ParsedSymbol], package: str
    ) -> None:
        """Extract interface declarations."""
        for match in INTERFACE_PATTERN.finditer(content):
            name = match.group(1)
            extends = match.group(2)
            
            start_line = content[:match.start()].count("\n")
            end_line = self._find_block_end(content, match.end() - 1, start_line)
            
            qualified_name = f"{package}.{name}" if package else name
            
            docstring = self._get_preceding_javadoc(content, match.start())
            
            preceding = content[max(0, match.start()-50):match.start()]
            is_public = "public" in preceding
            
            signature = f"interface {name}"
            if extends:
                signature += f" extends {extends.strip()}"
            
            code = self._get_code_slice(lines, start_line, end_line + 1)
            
            symbols.append(ParsedSymbol(
                name=name,
                qualified_name=qualified_name,
                symbol_type=SymbolType.INTERFACE,
                start_line=start_line,
                end_line=end_line,
                code=code,
                signature=signature,
                docstring=docstring,
                is_public=is_public,
            ))
    
    def _extract_enums(
        self, content: str, lines: List[str], symbols: List[ParsedSymbol], package: str
    ) -> None:
        """Extract enum declarations."""
        for match in ENUM_PATTERN.finditer(content):
            name = match.group(1)
            
            start_line = content[:match.start()].count("\n")
            end_line = self._find_block_end(content, match.end() - 1, start_line)
            
            qualified_name = f"{package}.{name}" if package else name
            
            docstring = self._get_preceding_javadoc(content, match.start())
            
            preceding = content[max(0, match.start()-50):match.start()]
            is_public = "public" in preceding
            
            code = self._get_code_slice(lines, start_line, end_line + 1)
            
            symbols.append(ParsedSymbol(
                name=name,
                qualified_name=qualified_name,
                symbol_type=SymbolType.ENUM,
                start_line=start_line,
                end_line=end_line,
                code=code,
                signature=f"enum {name}",
                docstring=docstring,
                is_public=is_public,
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
    
    def _get_preceding_javadoc(self, content: str, pos: int) -> str:
        """Get Javadoc comment preceding a position."""
        search_start = max(0, pos - 2000)
        before = content[search_start:pos]
        
        match = None
        for m in JAVADOC_PATTERN.finditer(before):
            match = m
        
        if match:
            after_comment = before[match.end():]
            if len(after_comment.strip()) < 100:
                return match.group(1).strip()
        
        return ""
    
    def _get_code_slice(self, lines: List[str], start: int, end: int) -> str:
        """Get a slice of code from lines."""
        if start < 0:
            start = 0
        if end > len(lines):
            end = len(lines)
        return "".join(lines[start:end]).rstrip()
