from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field
from typing import Dict, List, Set

from analyzer.baseAnalyzer import BaseAnalyzer
from analyzer.utils import make_diag, CodeFix

_STRICT_EQUALITY = re.compile(r"(?<![=!])==(?!=)")
_ANY_TYPE = re.compile(r":\s*any\b")
_DECLARATION = re.compile(r"^(?:export\s+)?(?:const|let)\s+.+$")

_IO_HEADER = re.compile(r'#\s*include\s*<\s*iostream\s*>')
_IO_USAGE = re.compile(r"\b(?:std::)?c(?:out|in|err|log)\b|\bstd::endl\b")
_USING_NAMESPACE_STD = re.compile(r"using\s+namespace\s+std\s*;")
_JAVA_STRING_EQ = re.compile(r'"[^"]*"\s*==\s*[^;\n]+|"[^"]*"\s*!=\s*[^;\n]+')
_JAVA_RAW_NEW = re.compile(r"\bnew\s+[A-Z]\w*\s*\(")
_GO_RAW_HTTP = re.compile(r"\bhttp\.Get\([^)]*\)")
_GO_PANIC = re.compile(r"\bpanic\(")
_GO_GLOBAL_VAR = re.compile(r"^var\s+\w+\s*=\s*", re.MULTILINE)
_C_STDIO = "#include <stdio.h>"
_C_PRINTF = re.compile(r"\bprintf\s*\(")
_C_MALLOC = re.compile(r"\bmalloc\s*\(")
_C_FREE = re.compile(r"\bfree\s*\(")
_CPP_GOTO = re.compile(r"\bgoto\s+\w+")
_CPP_CSTYLE_CAST = re.compile(r"\(\s*(int|float|double|char|long|short)\s*\)")


class PythonAnalyzer(BaseAnalyzer):
    language = "python"
    aliases = ("py",)

    def analyze(self, code: str):
        diagnostics: List[dict] = []
        stripped = code.strip()
        if not stripped:
            return diagnostics

        try:
            tree = ast.parse(code)
        except SyntaxError as exc:
            diagnostics.append(
                make_diag(
                    msg=f"Syntax error: {exc.msg}",
                    severity="error",
                    line=(exc.lineno or 1) - 1,
                    column=(exc.offset or 1) - 1,
                    end_line=(exc.end_lineno or exc.lineno or 1) - 1,
                    end_column=(exc.end_offset or exc.offset or 1) - 1,
                    code="PY001",
                )
            )
            return diagnostics

        visitor = PythonAstVisitor(diagnostics)
        visitor.visit(tree)
        visitor.finalize()

        for idx, line in enumerate(code.splitlines()):
            upper_line = line.upper()
            if "TODO" in upper_line or "FIXME" in upper_line:
                col = line.upper().index("TODO" if "TODO" in upper_line else "FIXME")
                diagnostics.append(
                    make_diag(
                        msg="Address TODO/FIXME comment before shipping",
                        severity="info",
                        line=idx,
                        column=col,
                        end_line=idx,
                        end_column=col + 4,
                        code="PY006",
                    )
                )
            if re.search(r"def\s+\w+\([^)]*=\s*(\[\]|\{\}|set\(|dict\(|list\(|set\()", line):
                col = line.index("=")
                diagnostics.append(
                    make_diag(
                        msg="Avoid mutable default arguments; use None and assign inside.",
                        severity="warning",
                        line=idx,
                        column=col,
                        end_line=idx,
                        end_column=col + 5,
                        code="PY007",
                    )
                )
            if "print(" in line and not line.strip().startswith("#"):
                diagnostics.append(
                    make_diag(
                        msg="Remove debug `print` statements before shipping",
                        severity="info",
                        line=idx,
                        column=line.index("print("),
                        end_line=idx,
                        end_column=line.index("print(") + 5,
                        code="PY008",
                    )
                )

        return diagnostics


class TypeScriptAnalyzer(BaseAnalyzer):
    language = "typescript"
    aliases = ("ts", "javascript", "js")

    def analyze(self, code: str):
        diagnostics: List[dict] = []
        lines = code.splitlines()

        for line_no, line in enumerate(lines):
            stripped = line.strip()
            if not stripped or stripped.startswith(("//", "/*", "*")):
                continue

            self._detectStrictEquality(line, line_no, diagnostics)
            self._detectAnyType(line, line_no, diagnostics)
            self._detectVarUsage(line, line_no, diagnostics)
            self._detectConsoleLog(line, line_no, diagnostics)
            self._detectAlertEval(line, line_no, diagnostics)
            self._detectMissingSemicolon(stripped, line, line_no, diagnostics)

        return diagnostics

    def _detectStrictEquality(self, line: str, line_no: int, diagnostics: List[dict]):
        for match in _STRICT_EQUALITY.finditer(line):
            diagnostics.append(
                make_diag(
                    msg="Use `===` instead of `==` for strict equality",
                    severity="warning",
                    line=line_no,
                    column=match.start(),
                    end_line=line_no,
                    end_column=match.end(),
                    code="TS001",
                )
            )

    def _detectAnyType(self, line: str, line_no: int, diagnostics: List[dict]):
        match = _ANY_TYPE.search(line)
        if match:
            diagnostics.append(
                make_diag(
                    msg="Avoid `any` when possible; prefer explicit types",
                    severity="info",
                    line=line_no,
                    column=match.start(),
                    end_line=line_no,
                    end_column=match.end(),
                    code="TS002",
                )
            )

    def _detectVarUsage(self, line: str, line_no: int, diagnostics: List[dict]):
        if "var " in line:
            var_col = line.index("var")
            diagnostics.append(
                make_diag(
                    msg="Prefer `let` or `const` instead of `var`",
                    severity="warning",
                    line=line_no,
                    column=var_col,
                    end_line=line_no,
                    end_column=var_col + 3,
                    code="TS003",
                )
            )

    def _detectConsoleLog(self, line: str, line_no: int, diagnostics: List[dict]):
        if "console.log" in line:
            console_col = line.index("console.log")
            diagnostics.append(
                make_diag(
                    msg="Remove `console.log` statements in production code",
                    severity="info",
                    line=line_no,
                    column=console_col,
                    end_line=line_no,
                    end_column=console_col + 11,
                    code="TS004",
                )
            )

    def _detectAlertEval(self, line: str, line_no: int, diagnostics: List[dict]):
        if "alert(" in line:
            diagnostics.append(
                make_diag(
                    msg="Avoid `alert`; prefer in-app notifications or dev-only logging",
                    severity="info",
                    line=line_no,
                    column=line.index("alert("),
                    end_line=line_no,
                    end_column=line.index("alert(") + 6,
                    code="TS006",
                )
            )
        if "eval(" in line:
            diagnostics.append(
                make_diag(
                    msg="Avoid `eval`; it is unsafe and blocks optimizations",
                    severity="warning",
                    line=line_no,
                    column=line.index("eval("),
                    end_line=line_no,
                    end_column=line.index("eval(") + 4,
                    code="TS007",
                )
            )

    def _detectMissingSemicolon(
        self, stripped: str, raw_line: str, line_no: int, diagnostics: List[dict]
    ):
        if not _DECLARATION.match(stripped):
            return
        if stripped.endswith((";", "{", "}", ",")):
            return
        if stripped.endswith(("=>", "))", "]")):
            return
        line_len = len(raw_line.rstrip())
        diagnostics.append(
            make_diag(
                msg="Possible missing semicolon",
                severity="info",
                line=line_no,
                column=line_len,
                end_line=line_no,
                end_column=line_len,
                code="TS005",
            )
        )


class CppAnalyzer(BaseAnalyzer):
    language = "cpp"
    aliases = ("c++", "cc")

    def analyze(self, code: str):
        diagnostics: List[dict] = []
        stripped = code.strip()
        if not stripped:
            return diagnostics

        self._checkIostreamInclude(code, diagnostics)
        self._checkUsingNamespaceStd(code, diagnostics)
        self._checkRawNewUsage(code, diagnostics)
        self._checkNullUsage(code, diagnostics)
        self._checkMainReturn(code, diagnostics)
        self._checkGoto(code, diagnostics)
        self._checkCStyleCast(code, diagnostics)
        self._checkMissingSemicolons(code, diagnostics)
        self._checkUninitializedVariables(code, diagnostics)

        return diagnostics

    def _checkMissingSemicolons(self, code: str, diagnostics: List[dict]):
        """Check for potential missing semicolons."""
        lines = code.splitlines()
        inside_function = False
        brace_depth = 0
        
        for idx, line in enumerate(lines):
            stripped = line.strip()
            
            # Track brace depth
            brace_depth += stripped.count('{') - stripped.count('}')
            
            # Skip empty lines, comments, preprocessor directives
            if not stripped or stripped.startswith('//') or stripped.startswith('#') or stripped.startswith('/*') or stripped.startswith('*'):
                continue
            
            # Skip lines that end with control structures
            if any(stripped.endswith(x) for x in ['{', '}', ':', '//', '*/']):
                continue
            
            # Skip lines that are just opening/closing braces
            if stripped in ['{', '}', '};']:
                continue
            
            # Skip function declarations, class declarations, etc.
            if any(kw in stripped for kw in ['class ', 'struct ', 'enum ', 'namespace ', 'template', 'public:', 'private:', 'protected:']):
                continue
            
            # Skip if/else/for/while/switch statements (they don't need semicolons)
            if re.match(r'^(if|else|for|while|switch|do)\s*[\(\{]?', stripped):
                continue
            if stripped in ['else', 'else{', 'do', 'do{']:
                continue
            
            # Check if line ends without semicolon but should have one
            # This is a heuristic: lines with declarations or statements inside functions
            if brace_depth > 0:  # Inside a function/block
                # Lines that look like statements but don't end with semicolon
                if not stripped.endswith(';') and not stripped.endswith(','):
                    # Check if it looks like a variable declaration or statement
                    if re.match(r'^\s*(int|float|double|char|bool|long|short|unsigned|auto|const|static|void|string|std::\w+)\s+\w+', stripped):
                        # Find the actual column position
                        col = len(line) - len(line.lstrip())
                        diagnostics.append(
                            make_diag(
                                msg="Missing semicolon at end of statement",
                                severity="error",
                                line=idx,
                                column=len(line.rstrip()),
                                end_line=idx,
                                end_column=len(line.rstrip()) + 1,
                                code="CPP010",
                            )
                        )
                    # Check for expressions like function calls without semicolon
                    elif re.match(r'^\s*\w+.*[^;{}\s]$', stripped) and '(' in stripped and ')' in stripped:
                        if not any(kw in stripped for kw in ['if', 'for', 'while', 'switch', 'catch']):
                            diagnostics.append(
                                make_diag(
                                    msg="Missing semicolon at end of statement",
                                    severity="error",
                                    line=idx,
                                    column=len(line.rstrip()),
                                    end_line=idx,
                                    end_column=len(line.rstrip()) + 1,
                                    code="CPP010",
                                )
                            )

    def _checkUninitializedVariables(self, code: str, diagnostics: List[dict]):
        """Check for potentially uninitialized variables."""
        lines = code.splitlines()
        
        # Track declared variables and their initialization status
        # This is a simplified heuristic - a full check would require proper parsing
        declared_vars = {}  # name -> (line, initialized)
        
        for idx, line in enumerate(lines):
            stripped = line.strip()
            
            # Skip comments and preprocessor
            if not stripped or stripped.startswith('//') or stripped.startswith('#'):
                continue
            
            # Check for variable declarations without initialization
            # Pattern: type name; or type name, name2;
            match = re.match(r'^\s*(int|float|double|char|bool|long|short|unsigned|auto|const|static)\s+(\w+)\s*;', stripped)
            if match:
                var_type = match.group(1)
                var_name = match.group(2)
                # Skip if it's a function declaration
                if '(' not in stripped:
                    col = line.find(var_name)
                    declared_vars[var_name] = (idx, False, col)
        
        # Check for usage of uninitialized variables
        for idx, line in enumerate(lines):
            stripped = line.strip()
            
            for var_name, (decl_line, initialized, col) in list(declared_vars.items()):
                # Check if variable is used before being assigned
                if idx > decl_line:
                    # Check for assignment (var = something)
                    if re.search(rf'\b{var_name}\s*=', stripped):
                        declared_vars[var_name] = (decl_line, True, col)
                        continue
                    
                    # Check for usage without prior assignment
                    if re.search(rf'\b{var_name}\b', stripped) and not initialized:
                        # Check if it's being assigned in this line (cin >> var)
                        if re.search(rf'>>\s*{var_name}\b', stripped):
                            declared_vars[var_name] = (decl_line, True, col)
                            continue
                        # It's being used without initialization
                        use_col = line.find(var_name)
                        diagnostics.append(
                            make_diag(
                                msg=f"Variable '{var_name}' may be used before initialization",
                                severity="warning",
                                line=idx,
                                column=use_col,
                                end_line=idx,
                                end_column=use_col + len(var_name),
                                code="CPP011",
                            )
                        )

    def _checkIostreamInclude(self, code: str, diagnostics: List[dict]):
        # Only report if iostream is used but NOT included
        if _IO_USAGE.search(code) and not _IO_HEADER.search(code):
            diagnostics.append(
                make_diag(
                    msg="Missing `#include <iostream>` for cin/cout usage",
                    severity="error",
                    line=0,
                    column=0,
                    end_line=0,
                    end_column=1,
                    code="CPP001",
                    fixes=[
                        CodeFix(
                            description="Add #include <iostream>",
                            replacement_text="#include <iostream>\n",
                            line=0,
                            column=0,
                            end_line=0,
                            end_column=0,
                            is_preferred=True,
                        )
                    ],
                )
            )

    def _checkUsingNamespaceStd(self, code: str, diagnostics: List[dict]):
        match = _USING_NAMESPACE_STD.search(code)
        if match:
            line = code[: match.start()].count("\n")
            last_newline = code.rfind("\n", 0, match.start())
            column = match.start() - (last_newline + 1 if last_newline != -1 else 0)
            diagnostics.append(
                make_diag(
                    msg="Avoid `using namespace std;` in headers or global scope",
                    severity="warning",
                    line=line,
                    column=column,
                    end_line=line,
                    end_column=column + len(match.group()),
                    code="CPP002",
                )
            )

    def _checkRawNewUsage(self, code: str, diagnostics: List[dict]):
        if re.search(r"\bnew\b", code) and not re.search(r"\bdelete\b", code):
            diagnostics.append(
                make_diag(
                    msg="Raw `new` detected without matching `delete`",
                    severity="warning",
                    line=0,
                    end_line=0,
                    end_column=1,
                    code="CPP003",
                )
            )

    def _checkNullUsage(self, code: str, diagnostics: List[dict]):
        if "NULL" not in code:
            return
        first_line = next(
            (idx for idx, line in enumerate(code.splitlines()) if "NULL" in line),
            0,
        )
        null_col = code.splitlines()[first_line].index("NULL")
        diagnostics.append(
            make_diag(
                msg="Prefer `nullptr` over legacy `NULL`",
                severity="info",
                line=first_line,
                column=null_col,
                end_line=first_line,
                end_column=null_col + 4,
                code="CPP004",
            )
        )

    def _checkMainReturn(self, code: str, diagnostics: List[dict]):
        if "int main" in code and "return" not in code:
            diagnostics.append(
                make_diag(
                    msg="`int main` should return a status code",
                    severity="info",
                    line=0,
                    end_line=0,
                    end_column=1,
                    code="CPP005",
                )
            )

    def _checkGoto(self, code: str, diagnostics: List[dict]):
        match = _CPP_GOTO.search(code)
        if match:
            line = code[: match.start()].count("\n")
            diagnostics.append(
                make_diag(
                    msg="Avoid `goto`; refactor with loops/conditions",
                    severity="warning",
                    line=line,
                    column=0,
                    end_line=line,
                    end_column=0,
                    code="CPP006",
                )
            )

    def _checkCStyleCast(self, code: str, diagnostics: List[dict]):
        match = _CPP_CSTYLE_CAST.search(code)
        if not match:
            return
        line = code[: match.start()].count("\n")
        col = match.start() - (code.rfind("\n", 0, match.start()) + 1)
        diagnostics.append(
            make_diag(
                msg="Prefer C++ static_cast/reinterpret_cast over C-style casts",
                severity="info",
                line=line,
                column=col,
                end_line=line,
                end_column=col + (match.end() - match.start()),
                code="CPP007",
            )
        )


class CAnalyzer(BaseAnalyzer):
    language = "c"
    aliases = ("c99", "c11")

    def analyze(self, code: str):
        diagnostics: List[dict] = []
        stripped = code.strip()
        if not stripped:
            return diagnostics

        if _C_PRINTF.search(code) and _C_STDIO not in code:
            diagnostics.append(
                make_diag(
                    msg="Missing `#include <stdio.h>` for printf usage",
                    severity="error",
                    line=0,
                    end_line=0,
                    end_column=1,
                    code="C001",
                )
            )
        if _C_MALLOC.search(code) and not _C_FREE.search(code):
            diagnostics.append(
                make_diag(
                    msg="Calls to malloc should have matching free to avoid leaks",
                    severity="warning",
                    line=0,
                    end_line=0,
                    end_column=1,
                    code="C002",
                )
            )
        if "int main" in code and "return" not in code:
            diagnostics.append(
                make_diag(
                    msg="`int main` should return a status code",
                    severity="info",
                    line=0,
                    end_line=0,
                    end_column=1,
                    code="C003",
                )
            )
        return diagnostics


class JavaAnalyzer(BaseAnalyzer):
    language = "java"
    aliases = ("jav",)

    def analyze(self, code: str):
        diagnostics: List[dict] = []
        lines = code.splitlines()
        for i, line in enumerate(lines):
            if "System.out.println" in line and "//" not in line:
                diagnostics.append(
                    make_diag(
                        msg="Remove debug prints (`System.out.println`) before shipping",
                        severity="info",
                        line=i,
                        column=line.index("System.out.println"),
                        end_line=i,
                        end_column=line.index("System.out.println") + len("System.out.println"),
                        code="JAVA001",
                    )
                )
            if _JAVA_STRING_EQ.search(line):
                diagnostics.append(
                    make_diag(
                        msg="Use `.equals()` to compare strings instead of `==`/`!=`",
                        severity="warning",
                        line=i,
                        column=_JAVA_STRING_EQ.search(line).start(),
                        end_line=i,
                        end_column=_JAVA_STRING_EQ.search(line).end(),
                        code="JAVA002",
                    )
                )
            if _JAVA_RAW_NEW.search(line) and "try" in "".join(lines[max(0, i - 2): i + 2]):
                pass  # allow within try-blocks
        if "ClassNotFoundException" in code and "try" not in code:
            diagnostics.append(
                make_diag(
                    msg="Wrap reflection/Class.forName usage in try-catch",
                    severity="info",
                    line=0,
                    end_line=0,
                    end_column=1,
                    code="JAVA003",
                )
            )
        return diagnostics


class GoAnalyzer(BaseAnalyzer):
    language = "go"
    aliases = ("golang",)

    def analyze(self, code: str):
        diagnostics: List[dict] = []
        lines = code.splitlines()
        for i, line in enumerate(lines):
            if _GO_RAW_HTTP.search(line) and "defer resp.Body.Close()" not in code:
                diagnostics.append(
                    make_diag(
                        msg="Remember to close HTTP response bodies: `defer resp.Body.Close()`",
                        severity="warning",
                        line=i,
                        column=_GO_RAW_HTTP.search(line).start(),
                        end_line=i,
                        end_column=_GO_RAW_HTTP.search(line).end(),
                        code="GO001",
                    )
                )
            if _GO_PANIC.search(line):
                diagnostics.append(
                    make_diag(
                        msg="Avoid `panic`; return errors instead in production code",
                        severity="info",
                        line=i,
                        column=_GO_PANIC.search(line).start(),
                        end_line=i,
                        end_column=_GO_PANIC.search(line).end(),
                        code="GO002",
                    )
                )
        if _GO_GLOBAL_VAR.search(code):
            diagnostics.append(
                make_diag(
                    msg="Prefer local variables or type-safe consts over package-level mutable vars",
                    severity="info",
                    line=0,
                    end_line=0,
                    end_column=1,
                    code="GO003",
                )
            )
        return diagnostics


@dataclass
class PythonAstVisitor(ast.NodeVisitor):
    diagnostics: List[dict]
    imports: Dict[str, int] = field(default_factory=dict)
    used_names: Set[str] = field(default_factory=set)

    def visit_Import(self, node: ast.Import):  # type: ignore[override]
        for alias in node.names:
            name = alias.asname or alias.name.split(".")[0]
            self.imports[name] = node.lineno - 1
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom):  # type: ignore[override]
        for alias in node.names:
            name = alias.asname or alias.name
            self.imports[name] = node.lineno - 1
        self.generic_visit(node)

    def visit_Name(self, node: ast.Name):  # type: ignore[override]
        if isinstance(node.ctx, ast.Load):
            self.used_names.add(node.id)
        self.generic_visit(node)

    def visit_ExceptHandler(self, node: ast.ExceptHandler):  # type: ignore[override]
        if node.type is None:
            self.diagnostics.append(
                make_diag(
                    msg="Bare except detected; catch specific exceptions",
                    severity="warning",
                    line=node.lineno - 1,
                    end_line=(node.end_lineno or node.lineno) - 1,
                    end_column=node.end_col_offset,
                    code="PY004",
                )
            )
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call):  # type: ignore[override]
        if isinstance(node.func, ast.Name) and node.func.id in {"eval", "exec"}:
            self.diagnostics.append(
                make_diag(
                    msg=f"Avoid `{node.func.id}`; it is unsafe in most cases",
                    severity="warning",
                    line=node.lineno - 1,
                    column=node.col_offset,
                    end_line=(node.end_lineno or node.lineno) - 1,
                    end_column=node.end_col_offset,
                    code="PY005",
                )
            )
        self.generic_visit(node)

    def visit_FunctionDef(self, node: ast.FunctionDef):  # type: ignore[override]
        self._checkDocstring(node)
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):  # type: ignore[override]  # noqa: E501
        self._checkDocstring(node)
        self.generic_visit(node)

    def visit_ClassDef(self, node: ast.ClassDef):  # type: ignore[override]
        self._checkDocstring(node, entity_type="class")
        self.generic_visit(node)

    def _checkDocstring(self, node: ast.AST, entity_type: str = "function"):
        docstring = ast.get_docstring(node)
        if docstring:
            return
        name = getattr(node, "name", entity_type)
        self.diagnostics.append(
            make_diag(
                msg=f"Missing docstring for {entity_type} `{name}`",
                severity="info",
                line=(getattr(node, "lineno", 1) or 1) - 1,
                end_line=(getattr(node, "end_lineno", 1) or 1) - 1,
                end_column=getattr(node, "end_col_offset", None),
                code="PY003",
            )
        )

    def finalize(self) -> None:
        for name, line in self.imports.items():
            if name not in self.used_names and not name.startswith("_"):
                self.diagnostics.append(
                    make_diag(
                        msg=f"Import `{name}` appears unused",
                        severity="warning",
                        line=line,
                        column=0,
                        end_line=line,
                        end_column=1,
                        code="PY002",
                    )
                )