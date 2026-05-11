"""
Semantic Analyzer - Deep AST-based code analysis.

This analyzer performs deeper analysis than static pattern matching,
including:
- Variable scope analysis (undefined, unused variables)
- Type inference and checking
- Control flow analysis (unreachable code, missing returns)
- Resource lifecycle analysis (unclosed handles)
- Function signature analysis (argument mismatches)
"""

from __future__ import annotations

import ast
import re
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

from .types import (
    AnalysisTier,
    CodeFix,
    Diagnostic,
    DiagnosticCategory,
    DiagnosticLocation,
    FileContext,
    Severity,
    TierResult,
)


class BaseSemanticAnalyzer(ABC):
    """Base class for language-specific semantic analyzers."""
    
    language: str = "generic"
    
    @abstractmethod
    def analyze(self, file: FileContext, related_files: Optional[List[FileContext]] = None) -> List[Diagnostic]:
        """
        Perform semantic analysis and return diagnostics.
        
        Args:
            file: The primary file to analyze
            related_files: Related files in the workspace (includes, imports, etc.)
        """
        raise NotImplementedError


@dataclass
class Scope:
    """Represents a variable scope."""
    name: str
    parent: Optional['Scope'] = None
    definitions: Dict[str, Tuple[int, int]] = field(default_factory=dict)  # name -> (line, col)
    usages: Dict[str, List[Tuple[int, int]]] = field(default_factory=dict)  # name -> [(line, col), ...]
    children: List['Scope'] = field(default_factory=list)
    
    def define(self, name: str, line: int, col: int) -> None:
        self.definitions[name] = (line, col)
        if name not in self.usages:
            self.usages[name] = []
    
    def use(self, name: str, line: int, col: int) -> None:
        if name not in self.usages:
            self.usages[name] = []
        self.usages[name].append((line, col))
    
    def is_defined(self, name: str) -> bool:
        if name in self.definitions:
            return True
        if self.parent:
            return self.parent.is_defined(name)
        return False
    
    def get_unused(self) -> List[Tuple[str, int, int]]:
        """Get variables defined but never used."""
        unused = []
        for name, (line, col) in self.definitions.items():
            # Skip private/dunder names
            if name.startswith('_'):
                continue
            if name not in self.usages or len(self.usages[name]) == 0:
                unused.append((name, line, col))
        return unused


class PythonSemanticAnalyzer(BaseSemanticAnalyzer):
    """Semantic analyzer for Python code."""
    
    language = "python"
    
    # Built-in names that shouldn't be flagged as undefined
    BUILTINS = {
        'True', 'False', 'None', 'print', 'len', 'range', 'str', 'int', 'float',
        'list', 'dict', 'set', 'tuple', 'bool', 'type', 'isinstance', 'issubclass',
        'hasattr', 'getattr', 'setattr', 'delattr', 'callable', 'iter', 'next',
        'enumerate', 'zip', 'map', 'filter', 'sorted', 'reversed', 'min', 'max',
        'sum', 'abs', 'round', 'pow', 'divmod', 'all', 'any', 'open', 'file',
        'input', 'raw_input', 'repr', 'ascii', 'bin', 'hex', 'oct', 'ord', 'chr',
        'format', 'vars', 'dir', 'id', 'hash', 'help', 'eval', 'exec', 'compile',
        'globals', 'locals', 'super', 'object', 'staticmethod', 'classmethod',
        'property', 'Exception', 'BaseException', 'ValueError', 'TypeError',
        'KeyError', 'IndexError', 'AttributeError', 'RuntimeError', 'StopIteration',
        'ImportError', 'ModuleNotFoundError', 'FileNotFoundError', 'OSError',
        'IOError', 'AssertionError', 'NotImplementedError', 'NameError',
        'ZeroDivisionError', 'OverflowError', 'MemoryError', 'RecursionError',
        '__name__', '__file__', '__doc__', '__package__', '__spec__',
        '__annotations__', '__dict__', '__class__', '__init__', '__new__',
        '__del__', '__repr__', '__str__', '__bytes__', '__format__',
        '__lt__', '__le__', '__eq__', '__ne__', '__gt__', '__ge__',
        '__hash__', '__bool__', '__getattr__', '__setattr__', '__delattr__',
        '__getattribute__', '__get__', '__set__', '__delete__',
        '__call__', '__len__', '__getitem__', '__setitem__', '__delitem__',
        '__iter__', '__next__', '__reversed__', '__contains__',
        '__add__', '__sub__', '__mul__', '__truediv__', '__floordiv__',
        '__mod__', '__pow__', '__and__', '__or__', '__xor__',
        '__lshift__', '__rshift__', '__neg__', '__pos__', '__abs__',
        '__invert__', '__enter__', '__exit__', '__await__', '__aiter__',
        '__anext__', '__aenter__', '__aexit__', 'self', 'cls',
        'dataclass', 'field', 'abstractmethod', 'Optional', 'List', 'Dict',
        'Set', 'Tuple', 'Any', 'Union', 'Callable', 'Type', 'Generic',
        'TypeVar', 'Sequence', 'Mapping', 'Iterable', 'Iterator',
    }
    
    def analyze(self, file: FileContext, related_files: Optional[List[FileContext]] = None) -> List[Diagnostic]:
        diagnostics: List[Diagnostic] = []
        
        try:
            tree = ast.parse(file.content)
        except SyntaxError:
            # Syntax errors are handled by static analyzer
            return diagnostics
        
        # Collect imported names
        imported_names: Set[str] = set()
        self._collect_imports(tree, imported_names)
        
        # Build scope tree
        global_scope = Scope(name="<module>")
        self._analyze_scope(tree, global_scope, imported_names)
        
        # Check for undefined variables
        diagnostics.extend(self._check_undefined(tree, global_scope, imported_names, file))
        
        # Check for unused variables
        diagnostics.extend(self._check_unused(global_scope, file))
        
        # Check for unreachable code
        diagnostics.extend(self._check_unreachable(tree, file))
        
        # Check for missing return statements
        diagnostics.extend(self._check_missing_returns(tree, file))
        
        # Check for potential None dereference
        diagnostics.extend(self._check_none_dereference(tree, file))
        
        # Check for comparison to None using ==
        diagnostics.extend(self._check_none_comparison(tree, file))
        
        # Check for bare except clauses
        diagnostics.extend(self._check_bare_except(tree, file))
        
        return diagnostics
    
    def _collect_imports(self, tree: ast.AST, imported: Set[str]) -> None:
        """Collect all imported names."""
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                for alias in node.names:
                    name = alias.asname if alias.asname else alias.name.split('.')[0]
                    imported.add(name)
            elif isinstance(node, ast.ImportFrom):
                for alias in node.names:
                    if alias.name == '*':
                        continue  # Can't track star imports
                    name = alias.asname if alias.asname else alias.name
                    imported.add(name)
    
    def _analyze_scope(
        self,
        node: ast.AST,
        scope: Scope,
        imported: Set[str],
    ) -> None:
        """Recursively analyze scopes and collect variable definitions/usages."""
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            # Function creates new scope
            func_scope = Scope(name=node.name, parent=scope)
            scope.children.append(func_scope)
            scope.define(node.name, node.lineno - 1, node.col_offset)
            
            # Add parameters to function scope
            for arg in node.args.args:
                func_scope.define(arg.arg, arg.lineno - 1, arg.col_offset)
            for arg in node.args.posonlyargs:
                func_scope.define(arg.arg, arg.lineno - 1, arg.col_offset)
            for arg in node.args.kwonlyargs:
                func_scope.define(arg.arg, arg.lineno - 1, arg.col_offset)
            if node.args.vararg:
                func_scope.define(node.args.vararg.arg, node.args.vararg.lineno - 1, node.args.vararg.col_offset)
            if node.args.kwarg:
                func_scope.define(node.args.kwarg.arg, node.args.kwarg.lineno - 1, node.args.kwarg.col_offset)
            
            # Analyze function body
            for child in node.body:
                self._analyze_scope(child, func_scope, imported)
            
        elif isinstance(node, ast.ClassDef):
            # Class creates new scope
            class_scope = Scope(name=node.name, parent=scope)
            scope.children.append(class_scope)
            scope.define(node.name, node.lineno - 1, node.col_offset)
            
            for child in node.body:
                self._analyze_scope(child, class_scope, imported)
                
        elif isinstance(node, ast.Name):
            if isinstance(node.ctx, ast.Store):
                scope.define(node.id, node.lineno - 1, node.col_offset)
            elif isinstance(node.ctx, ast.Load):
                scope.use(node.id, node.lineno - 1, node.col_offset)
                
        elif isinstance(node, (ast.For, ast.AsyncFor)):
            # For loop target is a definition
            if isinstance(node.target, ast.Name):
                scope.define(node.target.id, node.target.lineno - 1, node.target.col_offset)
            elif isinstance(node.target, ast.Tuple):
                for elt in node.target.elts:
                    if isinstance(elt, ast.Name):
                        scope.define(elt.id, elt.lineno - 1, elt.col_offset)
            
            for child in ast.iter_child_nodes(node):
                self._analyze_scope(child, scope, imported)
                
        elif isinstance(node, ast.comprehension):
            # Comprehension target is a definition
            if isinstance(node.target, ast.Name):
                scope.define(node.target.id, node.target.lineno - 1, node.target.col_offset)
            
            for child in ast.iter_child_nodes(node):
                self._analyze_scope(child, scope, imported)
                
        elif isinstance(node, (ast.ExceptHandler,)):
            if node.name:
                scope.define(node.name, node.lineno - 1, node.col_offset)
            for child in node.body:
                self._analyze_scope(child, scope, imported)
                
        elif isinstance(node, (ast.With, ast.AsyncWith)):
            for item in node.items:
                if item.optional_vars:
                    if isinstance(item.optional_vars, ast.Name):
                        scope.define(item.optional_vars.id, item.optional_vars.lineno - 1, item.optional_vars.col_offset)
            for child in node.body:
                self._analyze_scope(child, scope, imported)
        else:
            for child in ast.iter_child_nodes(node):
                self._analyze_scope(child, scope, imported)
    
    def _check_undefined(
        self,
        tree: ast.AST,
        scope: Scope,
        imported: Set[str],
        file: FileContext,
    ) -> List[Diagnostic]:
        """Check for use of undefined variables."""
        diagnostics = []
        all_defined = set(scope.definitions.keys()) | imported | self.BUILTINS
        
        for child_scope in scope.children:
            all_defined.add(child_scope.name)
        
        for name, usages in scope.usages.items():
            if name not in all_defined:
                for line, col in usages:
                    diagnostics.append(Diagnostic(
                        message=f"Name '{name}' is not defined",
                        severity=Severity.ERROR,
                        tier=AnalysisTier.SEMANTIC,
                        location=DiagnosticLocation(
                            line=line,
                            column=col,
                            end_line=line,
                            end_column=col + len(name),
                        ),
                        code="SEM001",
                        category=DiagnosticCategory.UNDEFINED_VARIABLE,
                    ))
        
        return diagnostics
    
    def _check_unused(self, scope: Scope, file: FileContext) -> List[Diagnostic]:
        """Check for unused variables."""
        diagnostics = []
        
        for name, line, col in scope.get_unused():
            diagnostics.append(Diagnostic(
                message=f"Variable '{name}' is defined but never used",
                severity=Severity.WARNING,
                tier=AnalysisTier.SEMANTIC,
                location=DiagnosticLocation(
                    line=line,
                    column=col,
                    end_line=line,
                    end_column=col + len(name),
                ),
                code="SEM002",
                category=DiagnosticCategory.UNUSED_CODE,
                fixes=[
                    CodeFix(
                        description=f"Remove unused variable '{name}'",
                        replacement_text="",
                        location=DiagnosticLocation(line, col, line, col + len(name)),
                    ),
                    CodeFix(
                        description=f"Prefix with underscore to indicate intentionally unused",
                        replacement_text=f"_{name}",
                        location=DiagnosticLocation(line, col, line, col + len(name)),
                    ),
                ],
            ))
        
        # Recursively check child scopes
        for child in scope.children:
            diagnostics.extend(self._check_unused(child, file))
        
        return diagnostics
    
    def _check_unreachable(self, tree: ast.AST, file: FileContext) -> List[Diagnostic]:
        """Check for unreachable code after return/raise/break/continue."""
        diagnostics = []
        
        class UnreachableVisitor(ast.NodeVisitor):
            def visit_FunctionDef(self, node):
                self._check_body(node.body)
                self.generic_visit(node)
            
            def visit_AsyncFunctionDef(self, node):
                self._check_body(node.body)
                self.generic_visit(node)
            
            def _check_body(self, body: List[ast.stmt]):
                found_terminal = False
                terminal_line = 0
                for stmt in body:
                    if found_terminal:
                        diagnostics.append(Diagnostic(
                            message="Unreachable code detected",
                            severity=Severity.WARNING,
                            tier=AnalysisTier.SEMANTIC,
                            location=DiagnosticLocation(
                                line=stmt.lineno - 1,
                                column=stmt.col_offset,
                                end_line=stmt.end_lineno - 1 if stmt.end_lineno else stmt.lineno - 1,
                                end_column=stmt.end_col_offset if stmt.end_col_offset else stmt.col_offset + 10,
                            ),
                            code="SEM003",
                            category=DiagnosticCategory.UNUSED_CODE,
                            explanation=f"This code comes after a return/raise statement on line {terminal_line} and will never execute.",
                        ))
                        break
                    if isinstance(stmt, (ast.Return, ast.Raise)):
                        found_terminal = True
                        terminal_line = stmt.lineno
        
        visitor = UnreachableVisitor()
        visitor.visit(tree)
        
        return diagnostics
    
    def _check_missing_returns(self, tree: ast.AST, file: FileContext) -> List[Diagnostic]:
        """Check for functions with inconsistent return statements."""
        diagnostics = []
        
        class ReturnChecker(ast.NodeVisitor):
            def visit_FunctionDef(self, node):
                self._check_function(node)
                self.generic_visit(node)
            
            def visit_AsyncFunctionDef(self, node):
                self._check_function(node)
                self.generic_visit(node)
            
            def _check_function(self, node):
                # Skip if function has no body or is just pass/...
                if not node.body:
                    return
                if len(node.body) == 1 and isinstance(node.body[0], (ast.Pass, ast.Expr)):
                    if isinstance(node.body[0], ast.Expr) and isinstance(node.body[0].value, ast.Constant):
                        if node.body[0].value.value == ...:
                            return
                
                has_return_value = False
                has_bare_return = False
                has_no_return_path = False
                
                def check_returns(body: List[ast.stmt], depth: int = 0) -> bool:
                    """Returns True if all paths return."""
                    nonlocal has_return_value, has_bare_return
                    
                    for i, stmt in enumerate(body):
                        if isinstance(stmt, ast.Return):
                            if stmt.value is not None:
                                has_return_value = True
                            else:
                                has_bare_return = True
                            return True
                        elif isinstance(stmt, ast.If):
                            # Both branches must return
                            if_returns = check_returns(stmt.body, depth + 1)
                            else_returns = check_returns(stmt.orelse, depth + 1) if stmt.orelse else False
                            if if_returns and else_returns:
                                return True
                    return False
                
                check_returns(node.body)
                
                # If we have both value returns and bare returns, that's suspicious
                if has_return_value and has_bare_return:
                    diagnostics.append(Diagnostic(
                        message=f"Function '{node.name}' has inconsistent return statements",
                        severity=Severity.WARNING,
                        tier=AnalysisTier.SEMANTIC,
                        location=DiagnosticLocation(
                            line=node.lineno - 1,
                            column=node.col_offset,
                            end_line=node.lineno - 1,
                            end_column=node.col_offset + len(f"def {node.name}"),
                        ),
                        code="SEM004",
                        category=DiagnosticCategory.LOGIC_ERROR,
                        explanation="Some paths return a value while others don't. This may indicate a bug.",
                    ))
        
        checker = ReturnChecker()
        checker.visit(tree)
        
        return diagnostics
    
    def _check_none_dereference(self, tree: ast.AST, file: FileContext) -> List[Diagnostic]:
        """Check for potential None dereference patterns."""
        diagnostics = []
        lines = file.content.splitlines()
        
        for i, line in enumerate(lines):
            # Pattern: calling method immediately after assignment that might be None
            # e.g., result = some_dict.get("key").strip()
            match = re.search(r'\.get\s*\([^)]*\)\s*\.', line)
            if match:
                diagnostics.append(Diagnostic(
                    message="Potential None dereference: dict.get() may return None",
                    severity=Severity.WARNING,
                    tier=AnalysisTier.SEMANTIC,
                    location=DiagnosticLocation(
                        line=i,
                        column=match.start(),
                        end_line=i,
                        end_column=match.end(),
                    ),
                    code="SEM005",
                    category=DiagnosticCategory.NULL_REFERENCE,
                    explanation="dict.get() returns None if key is not found. Consider using .get(key, default) or checking for None.",
                    fixes=[
                        CodeFix(
                            description="Add default value to .get()",
                            replacement_text='.get(key, "").', 
                            location=DiagnosticLocation(i, match.start(), i, match.end()),
                        ),
                    ],
                ))
        
        return diagnostics
    
    def _check_none_comparison(self, tree: ast.AST, file: FileContext) -> List[Diagnostic]:
        """Check for == None instead of 'is None'."""
        diagnostics = []
        
        class NoneCompareVisitor(ast.NodeVisitor):
            def visit_Compare(self, node):
                for i, (op, comparator) in enumerate(zip(node.ops, node.comparators)):
                    if isinstance(op, (ast.Eq, ast.NotEq)) and isinstance(comparator, ast.Constant):
                        if comparator.value is None:
                            correct = "is not" if isinstance(op, ast.NotEq) else "is"
                            diagnostics.append(Diagnostic(
                                message=f"Use '{correct} None' instead of '{'!=' if isinstance(op, ast.NotEq) else '=='} None'",
                                severity=Severity.INFO,
                                tier=AnalysisTier.SEMANTIC,
                                location=DiagnosticLocation(
                                    line=node.lineno - 1,
                                    column=node.col_offset,
                                    end_line=node.end_lineno - 1 if node.end_lineno else node.lineno - 1,
                                    end_column=node.end_col_offset if node.end_col_offset else node.col_offset + 10,
                                ),
                                code="SEM006",
                                category=DiagnosticCategory.BEST_PRACTICE,
                            ))
                self.generic_visit(node)
        
        visitor = NoneCompareVisitor()
        visitor.visit(tree)
        
        return diagnostics
    
    def _check_bare_except(self, tree: ast.AST, file: FileContext) -> List[Diagnostic]:
        """Check for bare except clauses."""
        diagnostics = []
        
        class ExceptVisitor(ast.NodeVisitor):
            def visit_ExceptHandler(self, node):
                if node.type is None:
                    diagnostics.append(Diagnostic(
                        message="Avoid bare 'except:' clause; catch specific exceptions",
                        severity=Severity.WARNING,
                        tier=AnalysisTier.SEMANTIC,
                        location=DiagnosticLocation(
                            line=node.lineno - 1,
                            column=node.col_offset,
                            end_line=node.lineno - 1,
                            end_column=node.col_offset + 6,  # "except"
                        ),
                        code="SEM007",
                        category=DiagnosticCategory.BEST_PRACTICE,
                        explanation="Bare except catches all exceptions including KeyboardInterrupt and SystemExit, making debugging harder.",
                        fixes=[
                            CodeFix(
                                description="Catch Exception instead",
                                replacement_text="except Exception:",
                                location=DiagnosticLocation(node.lineno - 1, node.col_offset, node.lineno - 1, node.col_offset + 7),
                            ),
                        ],
                    ))
                self.generic_visit(node)
        
        visitor = ExceptVisitor()
        visitor.visit(tree)
        
        return diagnostics


class TypeScriptSemanticAnalyzer(BaseSemanticAnalyzer):
    """Semantic analyzer for TypeScript/JavaScript code."""
    
    language = "typescript"
    
    # Common globals that shouldn't be flagged as undefined
    GLOBALS = {
        'console', 'window', 'document', 'process', 'require', 'module',
        'exports', 'global', 'globalThis', 'Buffer', 'setTimeout', 'setInterval',
        'clearTimeout', 'clearInterval', 'setImmediate', 'clearImmediate',
        'Promise', 'Array', 'Object', 'String', 'Number', 'Boolean', 'Symbol',
        'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'Math', 'JSON', 'Error',
        'TypeError', 'ReferenceError', 'SyntaxError', 'RangeError', 'URIError',
        'Function', 'RegExp', 'undefined', 'null', 'NaN', 'Infinity',
        'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURI', 'decodeURI',
        'encodeURIComponent', 'decodeURIComponent', 'eval', 'fetch', 'Request',
        'Response', 'Headers', 'URL', 'URLSearchParams', 'FormData', 'Blob',
        'File', 'FileReader', 'Event', 'CustomEvent', 'EventTarget',
        'AbortController', 'AbortSignal', 'TextEncoder', 'TextDecoder',
        'this', 'super', 'arguments', 'React', 'Component', 'useState',
        'useEffect', 'useCallback', 'useMemo', 'useRef', 'useContext',
        'useReducer', 'useLayoutEffect', 'useImperativeHandle', 'useDebugValue',
    }
    
    def analyze(self, file: FileContext, related_files: Optional[List[FileContext]] = None) -> List[Diagnostic]:
        diagnostics: List[Diagnostic] = []
        lines = file.content.splitlines()
        
        # Check for potential issues
        diagnostics.extend(self._check_promise_issues(lines, file))
        diagnostics.extend(self._check_null_coalescing_opportunities(lines, file))
        diagnostics.extend(self._check_type_assertions(lines, file))
        diagnostics.extend(self._check_unused_async(lines, file))
        
        return diagnostics
    
    def _check_promise_issues(self, lines: List[str], file: FileContext) -> List[Diagnostic]:
        """Check for common Promise anti-patterns."""
        diagnostics = []
        
        for i, line in enumerate(lines):
            # Check for floating promises (async call without await)
            # This is a simplified heuristic
            if re.search(r'\basync\s+', line) and re.search(r'\(\s*\)\s*;?\s*$', line):
                if 'await' not in line and 'return' not in line:
                    diagnostics.append(Diagnostic(
                        message="Possible floating Promise - async function called without await",
                        severity=Severity.WARNING,
                        tier=AnalysisTier.SEMANTIC,
                        location=DiagnosticLocation(line=i, column=0, end_line=i, end_column=len(line)),
                        code="SEM101",
                        category=DiagnosticCategory.LOGIC_ERROR,
                    ))
            
            # Check for .then().catch() that could be async/await
            if '.then(' in line and '.catch(' in line:
                diagnostics.append(Diagnostic(
                    message="Consider using async/await instead of .then().catch() for cleaner code",
                    severity=Severity.HINT,
                    tier=AnalysisTier.SEMANTIC,
                    location=DiagnosticLocation(line=i, column=line.index('.then('), end_line=i, end_column=len(line)),
                    code="SEM102",
                    category=DiagnosticCategory.BEST_PRACTICE,
                ))
        
        return diagnostics
    
    def _check_null_coalescing_opportunities(self, lines: List[str], file: FileContext) -> List[Diagnostic]:
        """Suggest nullish coalescing operator where applicable."""
        diagnostics = []
        
        for i, line in enumerate(lines):
            # Pattern: x === null || x === undefined
            if re.search(r'\w+\s*===?\s*null\s*\|\|\s*\w+\s*===?\s*undefined', line):
                diagnostics.append(Diagnostic(
                    message="Consider using nullish coalescing operator (??) or optional chaining (?.)",
                    severity=Severity.HINT,
                    tier=AnalysisTier.SEMANTIC,
                    location=DiagnosticLocation(line=i, column=0, end_line=i, end_column=len(line)),
                    code="SEM103",
                    category=DiagnosticCategory.BEST_PRACTICE,
                ))
            
            # Pattern: x !== null && x !== undefined && x.prop
            if re.search(r'\w+\s*!==?\s*null\s*&&\s*\w+\s*!==?\s*undefined\s*&&', line):
                diagnostics.append(Diagnostic(
                    message="Consider using optional chaining (?.) for safer property access",
                    severity=Severity.HINT,
                    tier=AnalysisTier.SEMANTIC,
                    location=DiagnosticLocation(line=i, column=0, end_line=i, end_column=len(line)),
                    code="SEM104",
                    category=DiagnosticCategory.BEST_PRACTICE,
                ))
        
        return diagnostics
    
    def _check_type_assertions(self, lines: List[str], file: FileContext) -> List[Diagnostic]:
        """Check for potentially unsafe type assertions."""
        diagnostics = []
        
        for i, line in enumerate(lines):
            # Check for 'as any' which defeats type checking
            match = re.search(r'\bas\s+any\b', line)
            if match:
                diagnostics.append(Diagnostic(
                    message="Avoid 'as any' - it defeats TypeScript's type checking",
                    severity=Severity.WARNING,
                    tier=AnalysisTier.SEMANTIC,
                    location=DiagnosticLocation(
                        line=i,
                        column=match.start(),
                        end_line=i,
                        end_column=match.end(),
                    ),
                    code="SEM105",
                    category=DiagnosticCategory.TYPE_ERROR,
                    explanation="Type assertions to 'any' bypass all type checks. Consider using a more specific type or fixing the underlying type issue.",
                ))
            
            # Check for double assertions (as unknown as Type) which are often a code smell
            match = re.search(r'\bas\s+unknown\s+as\b', line)
            if match:
                diagnostics.append(Diagnostic(
                    message="Double type assertion detected - this may indicate a type design issue",
                    severity=Severity.INFO,
                    tier=AnalysisTier.SEMANTIC,
                    location=DiagnosticLocation(
                        line=i,
                        column=match.start(),
                        end_line=i,
                        end_column=match.end(),
                    ),
                    code="SEM106",
                    category=DiagnosticCategory.TYPE_ERROR,
                ))
        
        return diagnostics
    
    def _check_unused_async(self, lines: List[str], file: FileContext) -> List[Diagnostic]:
        """Check for async functions that don't use await."""
        diagnostics = []
        in_async_function = False
        async_start_line = 0
        brace_count = 0
        has_await = False
        
        for i, line in enumerate(lines):
            # Detect async function start
            if re.search(r'\basync\s+(?:function|\(|[a-zA-Z_])', line):
                in_async_function = True
                async_start_line = i
                brace_count = line.count('{') - line.count('}')
                has_await = 'await' in line
                continue
            
            if in_async_function:
                brace_count += line.count('{') - line.count('}')
                if 'await' in line:
                    has_await = True
                
                if brace_count <= 0:
                    if not has_await:
                        diagnostics.append(Diagnostic(
                            message="Async function doesn't use 'await' - consider removing 'async' keyword",
                            severity=Severity.INFO,
                            tier=AnalysisTier.SEMANTIC,
                            location=DiagnosticLocation(
                                line=async_start_line,
                                column=0,
                                end_line=async_start_line,
                                end_column=len(lines[async_start_line]) if async_start_line < len(lines) else 0,
                            ),
                            code="SEM107",
                            category=DiagnosticCategory.PERFORMANCE,
                        ))
                    in_async_function = False
                    has_await = False
        
        return diagnostics


class CppSemanticAnalyzer(BaseSemanticAnalyzer):
    """Semantic analyzer for C++ code with cross-file include resolution."""
    
    language = "cpp"
    
    # Standard library headers that provide common symbols
    STD_LIBRARY_SYMBOLS = {
        'iostream': {'cout', 'cin', 'cerr', 'clog', 'endl', 'flush', 'ostream', 'istream', 'ios'},
        'string': {'string', 'wstring', 'basic_string', 'to_string', 'stoi', 'stol', 'stof', 'stod'},
        'vector': {'vector'},
        'map': {'map', 'multimap'},
        'set': {'set', 'multiset'},
        'unordered_map': {'unordered_map', 'unordered_multimap'},
        'unordered_set': {'unordered_set', 'unordered_multiset'},
        'algorithm': {'sort', 'find', 'copy', 'transform', 'for_each', 'count', 'fill'},
        'memory': {'unique_ptr', 'shared_ptr', 'weak_ptr', 'make_unique', 'make_shared'},
        'cstdio': {'printf', 'scanf', 'sprintf', 'sscanf', 'fprintf', 'fscanf', 'FILE', 'stdin', 'stdout', 'stderr'},
        'cstring': {'strlen', 'strcpy', 'strcat', 'strcmp', 'memcpy', 'memset', 'memmove'},
        'cmath': {'sin', 'cos', 'tan', 'sqrt', 'pow', 'abs', 'floor', 'ceil', 'log', 'exp'},
        'cstdlib': {'malloc', 'free', 'calloc', 'realloc', 'exit', 'atoi', 'atof', 'rand', 'srand'},
        'fstream': {'ifstream', 'ofstream', 'fstream'},
        'sstream': {'stringstream', 'istringstream', 'ostringstream'},
        'functional': {'function', 'bind', 'placeholders'},
        'utility': {'pair', 'make_pair', 'move', 'swap', 'forward'},
        'iterator': {'begin', 'end', 'next', 'prev', 'advance', 'distance'},
        'stdexcept': {'exception', 'runtime_error', 'logic_error', 'out_of_range', 'invalid_argument'},
    }
    
    def analyze(self, file: FileContext, related_files: Optional[List[FileContext]] = None) -> List[Diagnostic]:
        diagnostics: List[Diagnostic] = []
        lines = file.content.splitlines()
        
        # Debug logging
        import logging
        logger = logging.getLogger(__name__)
        logger.info(f"[CppSemanticAnalyzer] Analyzing file: {file.path}")
        logger.info(f"[CppSemanticAnalyzer] Related files: {[f.path for f in (related_files or [])]}")
        
        # Build the set of available symbols from includes
        available_symbols = self._collect_available_symbols(lines, related_files or [])
        logger.info(f"[CppSemanticAnalyzer] Available symbols: {available_symbols}")
        
        diagnostics.extend(self._check_memory_issues(lines, file))
        diagnostics.extend(self._check_smart_pointer_opportunities(lines, file))
        diagnostics.extend(self._check_const_correctness(lines, file))
        diagnostics.extend(self._check_syntax_issues(lines, file))
        diagnostics.extend(self._check_variable_issues(lines, file))
        # Undefined-function detection is intentionally not run for C/C++.
        # clangd is the authoritative source for symbol resolution, and the
        # regex-based heuristic that previously ran here produced systematic
        # false positives: it didn't recognise lambdas (`auto draw = [&](){}`)
        # as defined names and had no real preprocessor to ingest header
        # symbols (X11, POSIX, etc.). Running both surfaced clangd's correct
        # diagnostics alongside the heuristic's noise. The heuristic was not
        # worth chasing toward parity with clangd — that role belongs to the
        # real LSP.
        # Note: Logic error detection is handled by AI tier for better accuracy
        # Note: Include checking disabled - too many false positives, let compiler handle it
        
        logger.info(f"[CppSemanticAnalyzer] Total diagnostics: {len(diagnostics)}")
        for d in diagnostics:
            logger.info(f"[CppSemanticAnalyzer] Diagnostic: {d.message}, fixes: {len(d.fixes)}")
        
        return diagnostics
    
    def _collect_available_symbols(self, lines: List[str], related_files: List[FileContext]) -> Set[str]:
        """
        Collect all symbols available through includes.
        This resolves transitive includes (e.g., test.h includes iostream -> iostream symbols available).
        """
        import logging
        logger = logging.getLogger(__name__)
        
        available = set()
        
        # First pass: collect direct includes
        direct_includes = set()
        for line in lines:
            stripped = line.strip()
            # Match #include <header> or #include "header"
            match = re.match(r'#include\s*[<"]([^>"]+)[>"]', stripped)
            if match:
                header = match.group(1)
                direct_includes.add(header)
                # Add symbols from standard library
                header_base = header.replace('.h', '').replace('.hpp', '')
                if header_base in self.STD_LIBRARY_SYMBOLS:
                    available.update(self.STD_LIBRARY_SYMBOLS[header_base])
        
        logger.info(f"[_collect_available_symbols] Direct includes: {direct_includes}")
        logger.info(f"[_collect_available_symbols] Related files: {[f.path for f in related_files]}")
        
        # Second pass: resolve includes from related files (transitive)
        processed_files = set()
        files_to_process = []
        
        # Find related files that match our includes
        for header in direct_includes:
            header_lower = header.lower()
            for related in related_files:
                rel_path = related.path.lower()
                # Match by filename (e.g., "test.h" matches "folder/test.h")
                rel_filename = rel_path.split('/')[-1].split('\\')[-1]
                logger.info(f"[_collect_available_symbols] Checking: header='{header_lower}' vs rel_filename='{rel_filename}' (full: '{rel_path}')")
                if rel_filename == header_lower or rel_path.endswith('/' + header_lower) or rel_path.endswith('\\' + header_lower):
                    logger.info(f"[_collect_available_symbols] MATCH! Adding {related.path} to process")
                    files_to_process.append(related)
        
        # Process related files to get their symbols and transitive includes
        while files_to_process:
            related = files_to_process.pop(0)
            if related.path in processed_files:
                continue
            processed_files.add(related.path)
            logger.info(f"[_collect_available_symbols] Processing related file: {related.path}")
            
            related_lines = related.content.splitlines()
            for rel_line in related_lines:
                stripped = rel_line.strip()
                # Check for includes in the related file
                match = re.match(r'#include\s*[<"]([^>"]+)[>"]', stripped)
                if match:
                    header = match.group(1)
                    header_base = header.replace('.h', '').replace('.hpp', '')
                    logger.info(f"[_collect_available_symbols] Found include in related file: {header} (base: {header_base})")
                    if header_base in self.STD_LIBRARY_SYMBOLS:
                        symbols_to_add = self.STD_LIBRARY_SYMBOLS[header_base]
                        logger.info(f"[_collect_available_symbols] Adding symbols from {header_base}: {symbols_to_add}")
                        available.update(symbols_to_add)
                    # Also check if this is another local header we have
                    for other_related in related_files:
                        if other_related.path not in processed_files:
                            rel_path = other_related.path.lower()
                            header_lower = header.lower()
                            if rel_path.endswith(header_lower):
                                files_to_process.append(other_related)
                
                # Extract user-defined symbols (functions, classes, variables) from header files
                # Function declarations: return_type function_name(...)
                func_match = re.match(r'^(?:static\s+|inline\s+|extern\s+)?(?:const\s+)?(?:unsigned\s+|signed\s+)?(?:[\w:]+(?:<[^>]+>)?)(?:[\s\*&]+)(\w+)\s*\(', stripped)
                if func_match and not stripped.startswith('#') and not stripped.startswith('//'):
                    func_name = func_match.group(1)
                    # Skip if it's a type keyword
                    if func_name not in {'if', 'for', 'while', 'switch', 'return', 'sizeof', 'typedef', 'struct', 'class', 'enum', 'union'}:
                        logger.info(f"[_collect_available_symbols] Found user-defined function: {func_name}")
                        available.add(func_name)
                
                # Class/struct declarations
                class_match = re.match(r'^(?:class|struct)\s+(\w+)', stripped)
                if class_match:
                    class_name = class_match.group(1)
                    logger.info(f"[_collect_available_symbols] Found user-defined class/struct: {class_name}")
                    available.add(class_name)
                
                # Constant/variable declarations  
                var_match = re.match(r'^(?:const\s+|static\s+|extern\s+)?(?:unsigned\s+|signed\s+)?(?:int|float|double|char|bool|long|short|auto)\s+(\w+)\s*[=;]', stripped)
                if var_match and not stripped.startswith('#'):
                    var_name = var_match.group(1)
                    logger.info(f"[_collect_available_symbols] Found user-defined variable: {var_name}")
                    available.add(var_name)
        
        logger.info(f"[_collect_available_symbols] Final available symbols: {available}")
        return available
    
    def _check_include_issues(
        self, 
        lines: List[str], 
        file: FileContext, 
        available_symbols: Set[str],
        related_files: List[FileContext]
    ) -> List[Diagnostic]:
        """Check for include-related issues with cross-file awareness.
        
        DISABLED: This check was producing too many false positives.
        The include checking is now handled properly by the compiler.
        Semantic analysis should focus on logic errors, not include errors.
        """
        # Return empty - don't check for missing includes in semantic tier
        # This was causing false positives when:
        # 1. Cache returned stale results
        # 2. Include was actually present but symbol detection failed
        # Let the compiler handle include errors - it's more accurate
        return []
    
    def _check_syntax_issues(self, lines: List[str], file: FileContext) -> List[Diagnostic]:
        """Check for basic syntax issues like missing semicolons, malformed includes, unbalanced braces."""
        diagnostics = []
        brace_depth = 0
        paren_depth = 0
        full_content = '\n'.join(lines)
        
        # Check for malformed #include directives
        for i, line in enumerate(lines):
            stripped = line.strip()
            
            # Check for malformed includes - missing closing > or "
            include_match = re.match(r'#\s*include\s*<([^>]*)$', stripped)
            if include_match:
                # Line ends without closing >
                diagnostics.append(Diagnostic(
                    message="Malformed #include directive: missing closing '>'",
                    severity=Severity.ERROR,
                    tier=AnalysisTier.SEMANTIC,
                    location=DiagnosticLocation(
                        line=i,
                        column=len(stripped),
                        end_line=i,
                        end_column=len(stripped) + 1,
                    ),
                    code="SEM220",
                    category=DiagnosticCategory.SYNTAX,
                    fixes=[
                        CodeFix(
                            description="Add missing '>'",
                            replacement_text=stripped + ">",
                            location=DiagnosticLocation(i, 0, i, len(line.rstrip())),
                            is_preferred=True,
                        )
                    ],
                ))
            
            include_match_quote = re.match(r'#\s*include\s*"([^"]*)$', stripped)
            if include_match_quote:
                diagnostics.append(Diagnostic(
                    message="Malformed #include directive: missing closing '\"'",
                    severity=Severity.ERROR,
                    tier=AnalysisTier.SEMANTIC,
                    location=DiagnosticLocation(
                        line=i,
                        column=len(stripped),
                        end_line=i,
                        end_column=len(stripped) + 1,
                    ),
                    code="SEM220",
                    category=DiagnosticCategory.SYNTAX,
                    fixes=[
                        CodeFix(
                            description='Add missing \'"\'',
                            replacement_text=stripped + '"',
                            location=DiagnosticLocation(i, 0, i, len(line.rstrip())),
                            is_preferred=True,
                        )
                    ],
                ))
        
        # Check for missing function return type (e.g., main() instead of int main())
        for i, line in enumerate(lines):
            stripped = line.strip()
            
            # Skip comments and preprocessor
            if stripped.startswith('//') or stripped.startswith('#') or stripped.startswith('/*'):
                continue
            
            # Pattern: function definition without return type - starts with identifier followed by (
            # But skip keywords that look like functions
            if re.match(r'^(\w+)\s*\([^)]*\)\s*\{?\s*$', stripped):
                func_name = re.match(r'^(\w+)', stripped).group(1)
                # Skip if it's a keyword or looks like a type
                keywords = {'if', 'for', 'while', 'switch', 'catch', 'return', 'delete', 'sizeof', 'typeof', 'alignof'}
                type_keywords = {'int', 'float', 'double', 'char', 'void', 'bool', 'long', 'short', 'unsigned', 'signed', 'auto', 'const', 'static', 'extern', 'inline', 'virtual', 'explicit', 'class', 'struct', 'enum', 'namespace', 'template', 'typename'}
                
                if func_name not in keywords and func_name not in type_keywords:
                    # Check if previous non-empty line has a return type
                    prev_line_has_type = False
                    for j in range(i - 1, -1, -1):
                        prev_stripped = lines[j].strip()
                        if prev_stripped and not prev_stripped.startswith('//'):
                            # Check if it looks like a return type (ends with type keyword or *)
                            if re.search(r'(int|float|double|char|void|bool|long|short|unsigned|auto|\*|&)\s*$', prev_stripped):
                                prev_line_has_type = True
                            break
                    
                    if not prev_line_has_type:
                        col = line.find(func_name)
                        diagnostics.append(Diagnostic(
                            message=f"Function '{func_name}' is missing a return type",
                            severity=Severity.ERROR,
                            tier=AnalysisTier.SEMANTIC,
                            location=DiagnosticLocation(
                                line=i,
                                column=col,
                                end_line=i,
                                end_column=col + len(func_name),
                            ),
                            code="SEM221",
                            category=DiagnosticCategory.SYNTAX,
                            explanation="In C++, all functions must have an explicit return type. Use 'int' for main() or 'void' for functions that don't return a value.",
                            fixes=[
                                CodeFix(
                                    description=f"Add 'int' return type",
                                    replacement_text=line[:col] + f"int {func_name}" + line[col + len(func_name):].rstrip(),
                                    location=DiagnosticLocation(i, 0, i, len(line.rstrip())),
                                    is_preferred=func_name == 'main',
                                ),
                                CodeFix(
                                    description=f"Add 'void' return type",
                                    replacement_text=line[:col] + f"void {func_name}" + line[col + len(func_name):].rstrip(),
                                    location=DiagnosticLocation(i, 0, i, len(line.rstrip())),
                                    is_preferred=func_name != 'main',
                                ),
                            ],
                        ))
        
        # Track brace depth for unbalanced brace detection
        brace_stack = []  # Stack of (line, column) for opening braces
        
        for i, line in enumerate(lines):
            stripped = line.strip()
            
            # Skip string literals and comments for brace counting
            in_string = False
            in_char = False
            for j, ch in enumerate(line):
                if ch == '"' and (j == 0 or line[j-1] != '\\'):
                    in_string = not in_string
                elif ch == "'" and (j == 0 or line[j-1] != '\\'):
                    in_char = not in_char
                elif not in_string and not in_char:
                    if ch == '{':
                        brace_stack.append((i, j))
                    elif ch == '}':
                        if brace_stack:
                            brace_stack.pop()
                        else:
                            # Unmatched closing brace
                            diagnostics.append(Diagnostic(
                                message="Unmatched closing brace '}'",
                                severity=Severity.ERROR,
                                tier=AnalysisTier.SEMANTIC,
                                location=DiagnosticLocation(
                                    line=i,
                                    column=j,
                                    end_line=i,
                                    end_column=j + 1,
                                ),
                                code="SEM222",
                                category=DiagnosticCategory.SYNTAX,
                            ))
        
        # Check for unclosed braces at end of file
        for open_line, open_col in brace_stack:
            diagnostics.append(Diagnostic(
                message="Unclosed brace '{' - missing closing '}'",
                severity=Severity.ERROR,
                tier=AnalysisTier.SEMANTIC,
                location=DiagnosticLocation(
                    line=open_line,
                    column=open_col,
                    end_line=open_line,
                    end_column=open_col + 1,
                ),
                code="SEM223",
                category=DiagnosticCategory.SYNTAX,
                explanation="Every opening brace '{' must have a matching closing brace '}'",
            ))
        
        # Original semicolon checking
        brace_depth = 0
        for i, line in enumerate(lines):
            stripped = line.strip()
            
            # Track brace depth
            brace_depth += stripped.count('{') - stripped.count('}')
            
            # Skip empty lines, comments, preprocessor
            if not stripped or stripped.startswith('//') or stripped.startswith('#') or stripped.startswith('/*'):
                continue
            
            # Skip control structures and definitions
            if any(stripped.endswith(x) for x in ['{', '}', ':', '//']):
                continue
            
            if stripped in ['{', '}', '};']:
                continue
            
            # Skip if/for/while etc.
            if re.match(r'^(if|else|for|while|switch|do|case|default|try|catch)\b', stripped):
                continue
            
            # Inside a function, check for missing semicolons
            if brace_depth > 0 and not stripped.endswith(';') and not stripped.endswith(','):
                # Variable declarations without semicolon
                type_pattern = r'^(int|float|double|char|bool|long|short|unsigned|auto|const|void|string|std::\w+)\s+\w+'
                if re.match(type_pattern, stripped):
                    eol_col = len(line.rstrip())
                    diagnostics.append(Diagnostic(
                        message="Missing semicolon at end of statement",
                        severity=Severity.ERROR,
                        tier=AnalysisTier.SEMANTIC,
                        location=DiagnosticLocation(
                            line=i,
                            column=eol_col,
                            end_line=i,
                            end_column=eol_col + 1,
                        ),
                        code="SEM210",
                        category=DiagnosticCategory.SYNTAX,
                        fixes=[
                            CodeFix(
                                description="Add missing semicolon",
                                replacement_text=line.rstrip() + ";",
                                location=DiagnosticLocation(i, 0, i, eol_col),
                                is_preferred=True,
                            ),
                        ],
                    ))
        
        return diagnostics
    
    def _check_variable_issues(self, lines: List[str], file: FileContext) -> List[Diagnostic]:
        """Check for variable-related issues."""
        diagnostics = []
        
        # Track declared variables
        declared_vars: Dict[str, Tuple[int, bool, int]] = {}  # name -> (line, initialized, col)
        brace_depth = 0
        
        for i, line in enumerate(lines):
            stripped = line.strip()
            brace_depth += stripped.count('{') - stripped.count('}')
            
            # Check for uninitialized variable declarations
            match = re.match(r'^(\s*)(int|float|double|char|bool|long|short)\s+(\w+)\s*;', line)
            if match:
                leading_ws = match.group(1)
                var_type = match.group(2)
                var_name = match.group(3)
                col = line.find(var_name)
                declared_vars[var_name] = (i, False, col)
                
                # Calculate proper replacement range - from start of type to end of semicolon
                start_col = len(leading_ws)
                end_col = len(line.rstrip())
                
                # Warn about uninitialized variable
                diagnostics.append(Diagnostic(
                    message=f"Variable '{var_name}' is declared but not initialized - may contain garbage value",
                    severity=Severity.WARNING,
                    tier=AnalysisTier.SEMANTIC,
                    location=DiagnosticLocation(
                        line=i,
                        column=col,
                        end_line=i,
                        end_column=col + len(var_name),
                    ),
                    code="SEM211",
                    category=DiagnosticCategory.UNDEFINED_VARIABLE,
                    explanation=f"In C++, uninitialized local variables contain undefined values. Initialize '{var_name}' to avoid undefined behavior.",
                    fixes=[
                        CodeFix(
                            description=f"Initialize {var_name} to 0",
                            replacement_text=f"{var_type} {var_name} = 0;",
                            location=DiagnosticLocation(i, start_col, i, end_col),
                            is_preferred=True,
                        )
                    ],
                ))
        
        return diagnostics
    
    def _check_memory_issues(self, lines: List[str], file: FileContext) -> List[Diagnostic]:
        """Check for potential memory management issues."""
        diagnostics = []
        
        # Track new/delete pairs (simplified)
        for i, line in enumerate(lines):
            # Check for new without corresponding delete in visible scope
            if re.search(r'\bnew\s+\w+', line) and 'unique_ptr' not in line and 'shared_ptr' not in line:
                diagnostics.append(Diagnostic(
                    message="Raw 'new' detected - consider using smart pointers (std::unique_ptr, std::shared_ptr)",
                    severity=Severity.INFO,
                    tier=AnalysisTier.SEMANTIC,
                    location=DiagnosticLocation(
                        line=i,
                        column=line.index('new'),
                        end_line=i,
                        end_column=line.index('new') + 3,
                    ),
                    code="SEM201",
                    category=DiagnosticCategory.RESOURCE_LEAK,
                    explanation="Raw pointers require manual memory management and are prone to memory leaks. Smart pointers automatically manage memory.",
                ))
            
            # Check for delete without null check
            match = re.search(r'\bdelete\s+(\w+)', line)
            if match:
                ptr_name = match.group(1)
                # Simple heuristic: if no null check on previous lines
                prev_lines = '\n'.join(lines[max(0, i-3):i])
                if f'if ({ptr_name}' not in prev_lines and f'if({ptr_name}' not in prev_lines:
                    diagnostics.append(Diagnostic(
                        message=f"Consider checking if '{ptr_name}' is null before delete",
                        severity=Severity.HINT,
                        tier=AnalysisTier.SEMANTIC,
                        location=DiagnosticLocation(
                            line=i,
                            column=match.start(),
                            end_line=i,
                            end_column=match.end(),
                        ),
                        code="SEM202",
                        category=DiagnosticCategory.NULL_REFERENCE,
                    ))
        
        return diagnostics
    
    def _check_smart_pointer_opportunities(self, lines: List[str], file: FileContext) -> List[Diagnostic]:
        """Suggest smart pointer usage opportunities."""
        diagnostics = []
        
        for i, line in enumerate(lines):
            # Check for raw pointer member variables
            match = re.search(r'(\w+)\s*\*\s*\w+\s*;', line)
            if match and 'const' not in line and '//' not in line[:line.index('*')]:
                diagnostics.append(Diagnostic(
                    message="Consider using smart pointer for class member instead of raw pointer",
                    severity=Severity.HINT,
                    tier=AnalysisTier.SEMANTIC,
                    location=DiagnosticLocation(line=i, column=match.start(), end_line=i, end_column=match.end()),
                    code="SEM203",
                    category=DiagnosticCategory.BEST_PRACTICE,
                ))
        
        return diagnostics
    
    def _check_const_correctness(self, lines: List[str], file: FileContext) -> List[Diagnostic]:
        """Check for const-correctness issues."""
        diagnostics = []
        
        for i, line in enumerate(lines):
            # Check for non-const reference parameters that could be const
            # This is a simplified heuristic
            match = re.search(r'\(.*?(\w+)\s*&\s*(\w+).*?\)', line)
            if match and 'const' not in line[:match.start(1)]:
                param_type = match.group(1)
                if param_type not in {'int', 'float', 'double', 'char', 'bool', 'auto'}:
                    diagnostics.append(Diagnostic(
                        message=f"Consider making '{param_type}' parameter const if it's not modified",
                        severity=Severity.HINT,
                        tier=AnalysisTier.SEMANTIC,
                        location=DiagnosticLocation(line=i, column=match.start(1), end_line=i, end_column=match.end(2)),
                        code="SEM204",
                        category=DiagnosticCategory.BEST_PRACTICE,
                    ))
        
        return diagnostics


class SemanticAnalyzer:
    """
    Main semantic analyzer that dispatches to language-specific implementations.
    Supports cross-file analysis with related files for include/import resolution.
    """
    
    _analyzers: Dict[str, BaseSemanticAnalyzer] = {}
    
    def __init__(self):
        # Register language analyzers
        self._register(PythonSemanticAnalyzer())
        self._register(TypeScriptSemanticAnalyzer())
        self._register(CppSemanticAnalyzer())
    
    def _register(self, analyzer: BaseSemanticAnalyzer) -> None:
        self._analyzers[analyzer.language] = analyzer
    
    def analyze(self, file: FileContext, related_files: Optional[List[FileContext]] = None) -> TierResult:
        """
        Perform semantic analysis on a file with cross-file awareness.
        
        Args:
            file: The primary file to analyze
            related_files: Other files in the workspace for include/import resolution
        
        Returns a TierResult containing all diagnostics.
        """
        start_time = time.perf_counter()
        
        lang = self._normalize_language(file.language)
        analyzer = self._analyzers.get(lang)
        
        if analyzer is None:
            # No semantic analyzer for this language
            return TierResult(
                tier=AnalysisTier.SEMANTIC,
                diagnostics=[],
                elapsed_ms=0.0,
            )
        
        try:
            diagnostics = analyzer.analyze(file, related_files)
        except Exception as e:
            # Don't crash on analysis errors
            diagnostics = [
                Diagnostic(
                    message=f"Semantic analysis error: {str(e)}",
                    severity=Severity.INFO,
                    tier=AnalysisTier.SEMANTIC,
                    location=DiagnosticLocation(0, 0, 0, 0),
                    code="SEM999",
                    category=DiagnosticCategory.SYNTAX,
                )
            ]
        
        elapsed_ms = (time.perf_counter() - start_time) * 1000
        
        return TierResult(
            tier=AnalysisTier.SEMANTIC,
            diagnostics=diagnostics,
            elapsed_ms=elapsed_ms,
        )
    
    def _normalize_language(self, lang: str) -> str:
        """Normalize language identifier."""
        lang = lang.lower().strip()
        
        aliases = {
            'py': 'python',
            'python3': 'python',
            'ts': 'typescript',
            'tsx': 'typescript',
            'js': 'typescript',  # Use same analyzer
            'jsx': 'typescript',
            'javascript': 'typescript',
            'c++': 'cpp',
            'cxx': 'cpp',
            'cc': 'cpp',
            'c': 'cpp',  # Use similar checks
        }
        
        return aliases.get(lang, lang)
