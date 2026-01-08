"""
TypeScript/JavaScript Parser - AST-based parsing using a simple recursive descent approach.

Since we can't rely on tree-sitter being available, we implement a lightweight
parser that handles the most common patterns. For production, this should be
replaced with tree-sitter or a proper JS parser.

This parser extracts:
- Functions (function declarations, arrow functions, function expressions)
- Classes
- Methods
- Interfaces (TypeScript)
- Type aliases (TypeScript)
- Module-level constants
- Imports/exports
"""

from __future__ import annotations

import re
import time
from typing import Any, Dict, List, Optional, Set, Tuple

from ..parser_base import (
    BaseParser,
    ParseResult,
    ParsedSymbol,
    ImportStatement,
    ExportStatement,
    ParseError,
)
from ...core.types import SymbolType


# Regex patterns for JS/TS parsing
# Note: These are simplified - a real implementation should use tree-sitter

# Import patterns
IMPORT_PATTERN = re.compile(
    r'''import\s+(?:(?:(?P<default>[\w$]+)\s*,?\s*)?(?:\{\s*(?P<named>[^}]+)\s*\}\s*)?(?:\*\s+as\s+(?P<namespace>[\w$]+)\s*)?from\s+)?['"](?P<module>[^'"]+)['"]''',
    re.MULTILINE
)
IMPORT_TYPE_PATTERN = re.compile(
    r'''import\s+type\s+(?:\{\s*(?P<named>[^}]+)\s*\}\s*)?from\s+['"](?P<module>[^'"]+)['"]''',
    re.MULTILINE
)
REQUIRE_PATTERN = re.compile(
    r'''(?:const|let|var)\s+(?:\{[^}]+\}|[\w$]+)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)''',
    re.MULTILINE
)

# Export patterns
EXPORT_DEFAULT_PATTERN = re.compile(r'''export\s+default\s+(?:class|function|const|let|var)?\s*([\w$]+)?''')
EXPORT_NAMED_PATTERN = re.compile(r'''export\s+(?:const|let|var|function|class|interface|type|enum)\s+([\w$]+)''')
EXPORT_FROM_PATTERN = re.compile(r'''export\s+\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]''')

# Symbol patterns
FUNCTION_PATTERN = re.compile(
    r'''(?:export\s+)?(?:async\s+)?function\s*(\*?)\s*([\w$]+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)\s*(?::\s*([^\s{]+))?\s*\{''',
    re.MULTILINE
)
ARROW_CONST_PATTERN = re.compile(
    r'''(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s+)?\([^)]*\)\s*(?::\s*[^=]+)?\s*=>''',
    re.MULTILINE
)
CLASS_PATTERN = re.compile(
    r'''(?:export\s+)?(?:abstract\s+)?class\s+([\w$]+)(?:\s*<[^>]*>)?(?:\s+extends\s+([\w$.]+)(?:\s*<[^>]*>)?)?(?:\s+implements\s+([\w$.,\s<>]+))?\s*\{''',
    re.MULTILINE
)
INTERFACE_PATTERN = re.compile(
    r'''(?:export\s+)?interface\s+([\w$]+)(?:\s*<[^>]*>)?(?:\s+extends\s+([\w$.,\s<>]+))?\s*\{''',
    re.MULTILINE
)
TYPE_ALIAS_PATTERN = re.compile(
    r'''(?:export\s+)?type\s+([\w$]+)(?:\s*<[^>]*>)?\s*=''',
    re.MULTILINE
)
ENUM_PATTERN = re.compile(
    r'''(?:export\s+)?(?:const\s+)?enum\s+([\w$]+)\s*\{''',
    re.MULTILINE
)
CONST_PATTERN = re.compile(
    r'''(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*(?::\s*([^=]+))?\s*=\s*([^;]+);''',
    re.MULTILINE
)

# JSDoc comment pattern
JSDOC_PATTERN = re.compile(r'''/\*\*\s*([\s\S]*?)\s*\*/''')


class TypeScriptParser(BaseParser):
    """
    Parser for TypeScript code.
    
    Uses regex-based pattern matching as a fallback when tree-sitter
    is not available. For production use, integrate tree-sitter.
    """
    
    language = "typescript"
    aliases = ("ts", "tsx", "typescriptreact")
    
    def __init__(self, is_tsx: bool = False):
        self.is_tsx = is_tsx
    
    def parse(self, content: str, file_path: str = "") -> ParseResult:
        """Parse TypeScript source code."""
        start_time = time.time()
        
        result = ParseResult(
            file_path=file_path,
            language=self.language,
            symbols=[],
            imports=[],
            exports=[],
        )
        
        lines = content.splitlines(keepends=True)
        
        # Extract imports
        result.imports = self.extract_imports(content)
        
        # Extract exports
        result.exports = self.extract_exports(content)
        
        # Build imported names set
        imported_names = set()
        for imp in result.imports:
            imported_names.update(imp.names)
            if imp.alias:
                imported_names.add(imp.alias)
        
        # Extract symbols
        self._extract_functions(content, lines, result.symbols)
        self._extract_classes(content, lines, result.symbols)
        self._extract_interfaces(content, lines, result.symbols)
        self._extract_type_aliases(content, lines, result.symbols)
        self._extract_enums(content, lines, result.symbols)
        self._extract_arrow_functions(content, lines, result.symbols)
        
        result.parse_time_ms = (time.time() - start_time) * 1000
        return result
    
    def extract_imports(self, content: str) -> List[ImportStatement]:
        """Extract import statements."""
        imports = []
        
        # ES6 imports
        for match in IMPORT_PATTERN.finditer(content):
            names = []
            
            if match.group("default"):
                names.append(match.group("default"))
            
            if match.group("named"):
                # Parse named imports: { a, b as c, d }
                named_str = match.group("named")
                for part in named_str.split(","):
                    part = part.strip()
                    if " as " in part:
                        original, alias = part.split(" as ", 1)
                        names.append(alias.strip())
                    elif part:
                        names.append(part)
            
            alias = match.group("namespace")
            
            imports.append(ImportStatement(
                module=match.group("module"),
                names=names,
                alias=alias,
                line=content[:match.start()].count("\n"),
                is_relative=match.group("module").startswith("."),
            ))
        
        # Type imports
        for match in IMPORT_TYPE_PATTERN.finditer(content):
            names = []
            if match.group("named"):
                for part in match.group("named").split(","):
                    part = part.strip()
                    if " as " in part:
                        _, alias = part.split(" as ", 1)
                        names.append(alias.strip())
                    elif part:
                        names.append(part)
            
            imports.append(ImportStatement(
                module=match.group("module"),
                names=names,
                line=content[:match.start()].count("\n"),
                is_type_only=True,
            ))
        
        # require() calls
        for match in REQUIRE_PATTERN.finditer(content):
            imports.append(ImportStatement(
                module=match.group(1),
                names=[],
                line=content[:match.start()].count("\n"),
            ))
        
        return imports
    
    def extract_exports(self, content: str) -> List[ExportStatement]:
        """Extract export statements."""
        exports = []
        
        # Default exports
        for match in EXPORT_DEFAULT_PATTERN.finditer(content):
            name = match.group(1) or "default"
            exports.append(ExportStatement(
                name=name,
                is_default=True,
                line=content[:match.start()].count("\n"),
            ))
        
        # Named exports
        for match in EXPORT_NAMED_PATTERN.finditer(content):
            exports.append(ExportStatement(
                name=match.group(1),
                line=content[:match.start()].count("\n"),
            ))
        
        # Re-exports
        for match in EXPORT_FROM_PATTERN.finditer(content):
            for name in match.group(1).split(","):
                name = name.strip()
                if " as " in name:
                    original, alias = name.split(" as ", 1)
                    exports.append(ExportStatement(
                        name=alias.strip(),
                        is_re_export=True,
                        from_module=match.group(2),
                        line=content[:match.start()].count("\n"),
                    ))
                elif name:
                    exports.append(ExportStatement(
                        name=name,
                        is_re_export=True,
                        from_module=match.group(2),
                        line=content[:match.start()].count("\n"),
                    ))
        
        return exports
    
    def _extract_functions(
        self, content: str, lines: List[str], symbols: List[ParsedSymbol]
    ) -> None:
        """Extract function declarations."""
        for match in FUNCTION_PATTERN.finditer(content):
            is_generator = match.group(1) == "*"
            name = match.group(2)
            params = match.group(3)
            return_type = match.group(4) or ""
            
            start_line = content[:match.start()].count("\n")
            end_line = self._find_block_end(content, match.end() - 1, start_line)
            
            # Get preceding JSDoc
            docstring = self._get_preceding_jsdoc(content, match.start())
            
            is_async = "async" in content[max(0, match.start()-20):match.start()]
            is_export = "export" in content[max(0, match.start()-20):match.start()]
            
            signature = f"{'async ' if is_async else ''}function{'*' if is_generator else ''} {name}({params})"
            if return_type:
                signature += f": {return_type}"
            
            code = self._get_code_slice(lines, start_line, end_line + 1)
            
            symbols.append(ParsedSymbol(
                name=name,
                qualified_name=name,
                symbol_type=SymbolType.FUNCTION,
                start_line=start_line,
                end_line=end_line,
                code=code,
                signature=signature,
                docstring=docstring,
                is_public=is_export or not name.startswith("_"),
                is_async=is_async,
            ))
    
    def _extract_classes(
        self, content: str, lines: List[str], symbols: List[ParsedSymbol]
    ) -> None:
        """Extract class declarations."""
        for match in CLASS_PATTERN.finditer(content):
            name = match.group(1)
            extends = match.group(2)
            implements = match.group(3)
            
            start_line = content[:match.start()].count("\n")
            end_line = self._find_block_end(content, match.end() - 1, start_line)
            
            docstring = self._get_preceding_jsdoc(content, match.start())
            is_export = "export" in content[max(0, match.start()-20):match.start()]
            is_abstract = "abstract" in content[max(0, match.start()-20):match.start()]
            
            signature = f"class {name}"
            if extends:
                signature += f" extends {extends}"
            if implements:
                signature += f" implements {implements.strip()}"
            
            code = self._get_code_slice(lines, start_line, end_line + 1)
            
            # Track imports (base classes)
            imports_used = set()
            if extends:
                imports_used.add(extends.split(".")[0].split("<")[0])
            
            symbols.append(ParsedSymbol(
                name=name,
                qualified_name=name,
                symbol_type=SymbolType.CLASS,
                start_line=start_line,
                end_line=end_line,
                code=code,
                signature=signature,
                docstring=docstring,
                is_public=is_export or not name.startswith("_"),
                is_abstract=is_abstract,
                imports=imports_used,
            ))
    
    def _extract_interfaces(
        self, content: str, lines: List[str], symbols: List[ParsedSymbol]
    ) -> None:
        """Extract interface declarations."""
        for match in INTERFACE_PATTERN.finditer(content):
            name = match.group(1)
            extends = match.group(2)
            
            start_line = content[:match.start()].count("\n")
            end_line = self._find_block_end(content, match.end() - 1, start_line)
            
            docstring = self._get_preceding_jsdoc(content, match.start())
            is_export = "export" in content[max(0, match.start()-20):match.start()]
            
            signature = f"interface {name}"
            if extends:
                signature += f" extends {extends.strip()}"
            
            code = self._get_code_slice(lines, start_line, end_line + 1)
            
            symbols.append(ParsedSymbol(
                name=name,
                qualified_name=name,
                symbol_type=SymbolType.INTERFACE,
                start_line=start_line,
                end_line=end_line,
                code=code,
                signature=signature,
                docstring=docstring,
                is_public=is_export or not name.startswith("_"),
            ))
    
    def _extract_type_aliases(
        self, content: str, lines: List[str], symbols: List[ParsedSymbol]
    ) -> None:
        """Extract type alias declarations."""
        for match in TYPE_ALIAS_PATTERN.finditer(content):
            name = match.group(1)
            
            start_line = content[:match.start()].count("\n")
            # Find the end - type aliases end at ; or newline
            end_pos = content.find(";", match.end())
            if end_pos == -1:
                end_pos = content.find("\n", match.end())
            end_line = content[:end_pos].count("\n") if end_pos > 0 else start_line
            
            docstring = self._get_preceding_jsdoc(content, match.start())
            is_export = "export" in content[max(0, match.start()-20):match.start()]
            
            code = self._get_code_slice(lines, start_line, end_line + 1)
            
            symbols.append(ParsedSymbol(
                name=name,
                qualified_name=name,
                symbol_type=SymbolType.TYPE_ALIAS,
                start_line=start_line,
                end_line=end_line,
                code=code,
                signature=f"type {name}",
                docstring=docstring,
                is_public=is_export or not name.startswith("_"),
            ))
    
    def _extract_enums(
        self, content: str, lines: List[str], symbols: List[ParsedSymbol]
    ) -> None:
        """Extract enum declarations."""
        for match in ENUM_PATTERN.finditer(content):
            name = match.group(1)
            
            start_line = content[:match.start()].count("\n")
            end_line = self._find_block_end(content, match.end() - 1, start_line)
            
            docstring = self._get_preceding_jsdoc(content, match.start())
            is_export = "export" in content[max(0, match.start()-20):match.start()]
            
            code = self._get_code_slice(lines, start_line, end_line + 1)
            
            symbols.append(ParsedSymbol(
                name=name,
                qualified_name=name,
                symbol_type=SymbolType.ENUM,
                start_line=start_line,
                end_line=end_line,
                code=code,
                signature=f"enum {name}",
                docstring=docstring,
                is_public=is_export or not name.startswith("_"),
            ))
    
    def _extract_arrow_functions(
        self, content: str, lines: List[str], symbols: List[ParsedSymbol]
    ) -> None:
        """Extract arrow function expressions assigned to constants."""
        for match in ARROW_CONST_PATTERN.finditer(content):
            name = match.group(1)
            
            # Skip if already parsed as something else
            if any(s.name == name for s in symbols):
                continue
            
            start_line = content[:match.start()].count("\n")
            
            # Find the end - this is tricky for arrow functions
            # Try to find the matching semicolon or closing brace
            arrow_pos = content.find("=>", match.end() - 10)
            if arrow_pos == -1:
                continue
            
            # Check if it's a block body or expression
            after_arrow = content[arrow_pos + 2:].lstrip()
            if after_arrow.startswith("{"):
                # Block body
                end_line = self._find_block_end(content, arrow_pos + 2 + len(content[arrow_pos + 2:]) - len(after_arrow), start_line)
            else:
                # Expression body - find semicolon
                semi_pos = content.find(";", arrow_pos)
                end_line = content[:semi_pos].count("\n") if semi_pos > 0 else start_line
            
            docstring = self._get_preceding_jsdoc(content, match.start())
            is_export = "export" in content[max(0, match.start()-20):match.start()]
            is_async = "async" in content[match.start():arrow_pos]
            
            code = self._get_code_slice(lines, start_line, end_line + 1)
            
            symbols.append(ParsedSymbol(
                name=name,
                qualified_name=name,
                symbol_type=SymbolType.FUNCTION,
                start_line=start_line,
                end_line=end_line,
                code=code,
                signature=f"const {name} = {'async ' if is_async else ''}(...) => ...",
                docstring=docstring,
                is_public=is_export or not name.startswith("_"),
                is_async=is_async,
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
    
    def _get_preceding_jsdoc(self, content: str, pos: int) -> str:
        """Get JSDoc comment preceding a position."""
        # Look backwards for /** ... */
        search_start = max(0, pos - 2000)  # Don't look too far
        before = content[search_start:pos]
        
        match = None
        for m in JSDOC_PATTERN.finditer(before):
            match = m
        
        if match:
            # Check it's actually preceding (not much between)
            after_comment = before[match.end():]
            if len(after_comment.strip()) < 50:  # Only whitespace/decorators
                return match.group(1).strip()
        
        return ""
    
    def _get_code_slice(self, lines: List[str], start: int, end: int) -> str:
        """Get a slice of code from lines."""
        if start < 0:
            start = 0
        if end > len(lines):
            end = len(lines)
        return "".join(lines[start:end]).rstrip()


class JavaScriptParser(TypeScriptParser):
    """Parser for JavaScript code (subset of TypeScript)."""
    
    language = "javascript"
    aliases = ("js", "jsx", "javascriptreact", "mjs", "cjs")
    
    def __init__(self, is_jsx: bool = False):
        super().__init__(is_tsx=is_jsx)
