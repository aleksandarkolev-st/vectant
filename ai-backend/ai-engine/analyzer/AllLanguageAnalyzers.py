from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field
from typing import Dict, List, Set

from analyzer.baseAnalyzer import BaseAnalyzer
from analyzer.utils import make_diag

_STRICT_EQUALITY = re.compile(r"(?<![=!])==(?!=)")
_ANY_TYPE = re.compile(r":\s*any\b")
_DECLARATION = re.compile(r"^(?:export\s+)?(?:const|let)\s+.+$")

_IO_HEADER = "#include <iostream>"
_IO_USAGE = re.compile(r"\b(?:std::)?c(?:out|in)\b")
_USING_NAMESPACE_STD = re.compile(r"using\s+namespace\s+std\s*;")


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
                diagnostics.append(
                    make_diag(
                        msg="Address TODO/FIXME comment before shipping",
                        severity="info",
                        line=idx,
                        code="PY006",
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
                    code="TS002",
                )
            )

    def _detectVarUsage(self, line: str, line_no: int, diagnostics: List[dict]):
        if "var " in line:
            diagnostics.append(
                make_diag(
                    msg="Prefer `let` or `const` instead of `var`",
                    severity="warning",
                    line=line_no,
                    column=line.index("var"),
                    code="TS003",
                )
            )

    def _detectConsoleLog(self, line: str, line_no: int, diagnostics: List[dict]):
        if "console.log" in line:
            diagnostics.append(
                make_diag(
                    msg="Remove `console.log` statements in production code",
                    severity="info",
                    line=line_no,
                    column=line.index("console.log"),
                    code="TS004",
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
        diagnostics.append(
            make_diag(
                msg="Possible missing semicolon",
                severity="info",
                line=line_no,
                column=len(raw_line.rstrip()),
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

        return diagnostics

    def _checkIostreamInclude(self, code: str, diagnostics: List[dict]):
        if _IO_USAGE.search(code) and _IO_HEADER not in code:
            diagnostics.append(
                make_diag(
                    msg="Missing `#include <iostream>` for cin/cout usage",
                    severity="error",
                    line=0,
                    code="CPP001",
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
        diagnostics.append(
            make_diag(
                msg="Prefer `nullptr` over legacy `NULL`",
                severity="info",
                line=first_line,
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
                    code="CPP005",
                )
            )


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
                        code="PY002",
                    )
                )