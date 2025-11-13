from __future__ import annotations

import ast
from dataclasses import dataclass, field
from typing import Dict, List, Set

from analyzer.baseAnalyzer import BaseAnalyzer
from analyzer.utils import make_diag


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

        visitor = _PythonAstVisitor(diagnostics)
        visitor.visit(tree)
        visitor.finalize()

        # Surface TODO/FIXME comments for quick cleanup.
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


@dataclass
class _PythonAstVisitor(ast.NodeVisitor):
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
        self._check_docstring(node)
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef):  # type: ignore[override]  # noqa: E501
        self._check_docstring(node)
        self.generic_visit(node)

    def visit_ClassDef(self, node: ast.ClassDef):  # type: ignore[override]
        self._check_docstring(node, entity_type="class")
        self.generic_visit(node)

    def _check_docstring(self, node: ast.AST, entity_type: str = "function"):
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
