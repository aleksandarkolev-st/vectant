"""
Python Parser - AST-based parsing for Python code.

Uses Python's built-in ast module for accurate parsing.
Extracts functions, classes, methods, and module-level definitions.
"""

from __future__ import annotations

import ast
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


class PythonParser(BaseParser):
    """
    AST-based Python parser.
    
    Extracts:
    - Functions (def)
    - Async functions (async def)
    - Classes
    - Methods
    - Module-level constants
    - Decorators
    - Type annotations
    """
    
    language = "python"
    aliases = ("py", "pyw", "pyi")
    
    def parse(self, content: str, file_path: str = "") -> ParseResult:
        """Parse Python source code."""
        start_time = time.time()
        
        result = ParseResult(
            file_path=file_path,
            language=self.language,
            symbols=[],
            imports=[],
            exports=[],
        )
        
        # Try to parse
        try:
            tree = ast.parse(content)
        except SyntaxError as e:
            result.success = False
            result.errors.append(ParseError(
                message=f"Syntax error: {e.msg}",
                line=e.lineno or 1,
                column=e.offset or 0,
                severity="error",
            ))
            result.parse_time_ms = (time.time() - start_time) * 1000
            return result
        
        # Split content into lines for code extraction
        lines = content.splitlines(keepends=True)
        
        # Extract imports first
        result.imports = self._extract_imports_from_ast(tree)
        
        # Build set of imported names for reference detection
        imported_names = set()
        for imp in result.imports:
            imported_names.update(imp.names)
            if imp.alias:
                imported_names.add(imp.alias)
            if not imp.names:  # Whole module import
                imported_names.add(imp.module.split(".")[0])
        
        # Extract symbols
        self._extract_symbols(
            tree, lines, result.symbols, 
            parent=None, imported_names=imported_names
        )
        
        # Detect exports (in Python, typically __all__)
        result.exports = self._extract_exports_from_ast(tree)
        
        result.parse_time_ms = (time.time() - start_time) * 1000
        return result
    
    def extract_imports(self, content: str) -> List[ImportStatement]:
        """Extract imports without full parsing."""
        try:
            tree = ast.parse(content)
            return self._extract_imports_from_ast(tree)
        except SyntaxError:
            return []
    
    def extract_exports(self, content: str) -> List[ExportStatement]:
        """Extract exports without full parsing."""
        try:
            tree = ast.parse(content)
            return self._extract_exports_from_ast(tree)
        except SyntaxError:
            return []
    
    def _extract_imports_from_ast(self, tree: ast.AST) -> List[ImportStatement]:
        """Extract import statements from AST."""
        imports = []
        
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    imports.append(ImportStatement(
                        module=alias.name,
                        names=[],
                        alias=alias.asname,
                        line=node.lineno - 1,
                        is_relative=False,
                    ))
            
            elif isinstance(node, ast.ImportFrom):
                module = node.module or ""
                names = [alias.name for alias in node.names if alias.name != "*"]
                
                imports.append(ImportStatement(
                    module=module,
                    names=names,
                    alias=None,
                    line=node.lineno - 1,
                    is_relative=node.level > 0,
                ))
        
        return imports
    
    def _extract_exports_from_ast(self, tree: ast.AST) -> List[ExportStatement]:
        """Extract __all__ exports from AST."""
        exports = []
        
        for node in ast.walk(tree):
            if isinstance(node, ast.Assign):
                for target in node.targets:
                    if isinstance(target, ast.Name) and target.id == "__all__":
                        if isinstance(node.value, (ast.List, ast.Tuple)):
                            for elt in node.value.elts:
                                if isinstance(elt, ast.Constant) and isinstance(elt.value, str):
                                    exports.append(ExportStatement(
                                        name=elt.value,
                                        line=node.lineno - 1,
                                    ))
        
        return exports
    
    def _extract_symbols(
        self,
        node: ast.AST,
        lines: List[str],
        symbols: List[ParsedSymbol],
        parent: Optional[str] = None,
        imported_names: Optional[Set[str]] = None,
    ) -> None:
        """Recursively extract symbols from AST."""
        imported_names = imported_names or set()
        
        for child in ast.iter_child_nodes(node):
            symbol = None
            
            if isinstance(child, ast.FunctionDef):
                symbol = self._parse_function(child, lines, parent, imported_names, is_async=False)
            
            elif isinstance(child, ast.AsyncFunctionDef):
                symbol = self._parse_function(child, lines, parent, imported_names, is_async=True)
            
            elif isinstance(child, ast.ClassDef):
                symbol = self._parse_class(child, lines, parent, imported_names)
            
            elif isinstance(child, ast.Assign) and parent is None:
                # Module-level assignments (constants)
                symbol = self._parse_assignment(child, lines, imported_names)
            
            if symbol:
                symbols.append(symbol)
    
    def _parse_function(
        self,
        node: ast.FunctionDef | ast.AsyncFunctionDef,
        lines: List[str],
        parent: Optional[str],
        imported_names: Set[str],
        is_async: bool,
    ) -> ParsedSymbol:
        """Parse a function or method definition."""
        name = node.name
        qualified_name = self._make_qualified_name(name, parent)
        
        # Determine if it's a method
        symbol_type = SymbolType.METHOD if parent else SymbolType.FUNCTION
        
        # Extract signature
        signature = self._build_signature(node)
        
        # Extract docstring
        docstring = ast.get_docstring(node) or ""
        
        # Get code body
        start_line = node.lineno - 1
        end_line = node.end_lineno or node.lineno
        code = self._get_code_slice(lines, start_line, end_line)
        
        # Extract decorators
        decorators = [self._get_decorator_name(d) for d in node.decorator_list]
        
        # Detect references in function body
        references = self._find_references(node, imported_names)
        
        # Check static/classmethod
        is_static = "staticmethod" in decorators
        is_classmethod = "classmethod" in decorators
        
        symbol = ParsedSymbol(
            name=name,
            qualified_name=qualified_name,
            symbol_type=symbol_type,
            start_line=start_line,
            end_line=end_line - 1,
            start_col=node.col_offset,
            end_col=node.end_col_offset or 0,
            code=code,
            signature=signature,
            docstring=docstring,
            parent=parent,
            decorators=decorators,
            is_public=self._is_public_name(name),
            is_async=is_async,
            is_static=is_static or is_classmethod,
            references=references,
        )
        
        return symbol
    
    def _parse_class(
        self,
        node: ast.ClassDef,
        lines: List[str],
        parent: Optional[str],
        imported_names: Set[str],
    ) -> ParsedSymbol:
        """Parse a class definition."""
        name = node.name
        qualified_name = self._make_qualified_name(name, parent)
        
        # Extract bases for signature
        bases = [self._node_to_string(b) for b in node.bases]
        signature = f"class {name}" + (f"({', '.join(bases)})" if bases else "")
        
        # Extract docstring
        docstring = ast.get_docstring(node) or ""
        
        # Get code body
        start_line = node.lineno - 1
        end_line = node.end_lineno or node.lineno
        code = self._get_code_slice(lines, start_line, end_line)
        
        # Extract decorators
        decorators = [self._get_decorator_name(d) for d in node.decorator_list]
        
        # Track child methods
        children = []
        
        symbol = ParsedSymbol(
            name=name,
            qualified_name=qualified_name,
            symbol_type=SymbolType.CLASS,
            start_line=start_line,
            end_line=end_line - 1,
            start_col=node.col_offset,
            end_col=node.end_col_offset or 0,
            code=code,
            signature=signature,
            docstring=docstring,
            parent=parent,
            children=children,
            decorators=decorators,
            is_public=self._is_public_name(name),
            imports=set(bases),  # Track base classes as "imports"
        )
        
        # Parse nested symbols (methods)
        nested_symbols = []
        self._extract_symbols(node, lines, nested_symbols, parent=qualified_name, imported_names=imported_names)
        
        # Record children
        symbol.children = [s.qualified_name for s in nested_symbols]
        
        return symbol
    
    def _parse_assignment(
        self,
        node: ast.Assign,
        lines: List[str],
        imported_names: Set[str],
    ) -> Optional[ParsedSymbol]:
        """Parse a module-level assignment (constant)."""
        # Only handle simple name assignments
        if len(node.targets) != 1:
            return None
        
        target = node.targets[0]
        if not isinstance(target, ast.Name):
            return None
        
        name = target.id
        
        # Skip private names for now (too noisy)
        if name.startswith("_") and not name.startswith("__"):
            return None
        
        start_line = node.lineno - 1
        end_line = node.end_lineno or node.lineno
        code = self._get_code_slice(lines, start_line, end_line)
        
        # Try to determine if it's a constant (uppercase)
        is_constant = name.isupper() or name.startswith("__")
        
        return ParsedSymbol(
            name=name,
            qualified_name=name,
            symbol_type=SymbolType.CONSTANT if is_constant else SymbolType.VARIABLE,
            start_line=start_line,
            end_line=end_line - 1,
            start_col=node.col_offset,
            end_col=node.end_col_offset or 0,
            code=code,
            signature=f"{name} = ...",
            is_public=self._is_public_name(name),
        )
    
    def _build_signature(self, node: ast.FunctionDef | ast.AsyncFunctionDef) -> str:
        """Build function signature string."""
        args = []
        
        # Regular args
        defaults_offset = len(node.args.args) - len(node.args.defaults)
        for i, arg in enumerate(node.args.args):
            arg_str = arg.arg
            if arg.annotation:
                arg_str += f": {self._node_to_string(arg.annotation)}"
            if i >= defaults_offset:
                default = node.args.defaults[i - defaults_offset]
                arg_str += f" = {self._node_to_string(default)}"
            args.append(arg_str)
        
        # *args
        if node.args.vararg:
            arg_str = f"*{node.args.vararg.arg}"
            if node.args.vararg.annotation:
                arg_str += f": {self._node_to_string(node.args.vararg.annotation)}"
            args.append(arg_str)
        
        # **kwargs
        if node.args.kwarg:
            arg_str = f"**{node.args.kwarg.arg}"
            if node.args.kwarg.annotation:
                arg_str += f": {self._node_to_string(node.args.kwarg.annotation)}"
            args.append(arg_str)
        
        # Return type
        return_type = ""
        if node.returns:
            return_type = f" -> {self._node_to_string(node.returns)}"
        
        prefix = "async def " if isinstance(node, ast.AsyncFunctionDef) else "def "
        return f"{prefix}{node.name}({', '.join(args)}){return_type}"
    
    def _get_decorator_name(self, node: ast.expr) -> str:
        """Get decorator name from AST node."""
        if isinstance(node, ast.Name):
            return node.id
        elif isinstance(node, ast.Attribute):
            return f"{self._get_decorator_name(node.value)}.{node.attr}"
        elif isinstance(node, ast.Call):
            return self._get_decorator_name(node.func)
        return ""
    
    def _node_to_string(self, node: ast.expr) -> str:
        """Convert AST node to string representation."""
        try:
            return ast.unparse(node)
        except Exception:
            # Fallback for older Python
            if isinstance(node, ast.Name):
                return node.id
            elif isinstance(node, ast.Constant):
                return repr(node.value)
            elif isinstance(node, ast.Attribute):
                return f"{self._node_to_string(node.value)}.{node.attr}"
            return "..."
    
    def _get_code_slice(self, lines: List[str], start: int, end: int) -> str:
        """Get a slice of code from lines."""
        if start < 0:
            start = 0
        if end > len(lines):
            end = len(lines)
        return "".join(lines[start:end]).rstrip()
    
    def _find_references(self, node: ast.AST, imported_names: Set[str]) -> Set[str]:
        """Find references to imported names in a node."""
        references = set()
        
        for child in ast.walk(node):
            if isinstance(child, ast.Name):
                if child.id in imported_names:
                    references.add(child.id)
            elif isinstance(child, ast.Attribute):
                # Check for module.attr pattern
                if isinstance(child.value, ast.Name):
                    if child.value.id in imported_names:
                        references.add(child.value.id)
        
        return references
