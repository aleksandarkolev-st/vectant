from __future__ import annotations

import re
from typing import List

from analyzer.baseAnalyzer import BaseAnalyzer
from analyzer.utils import make_diag

_STRICT_EQUALITY = re.compile(r"(?<![=!])==(?!=)")
_ANY_TYPE = re.compile(r":\s*any\b")
_DECLARATION = re.compile(r"^(?:export\s+)?(?:const|let)\s+.+$")


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

            self._detect_strict_equality(line, line_no, diagnostics)
            self._detect_any_type(line, line_no, diagnostics)
            self._detect_var_usage(line, line_no, diagnostics)
            self._detect_console_log(line, line_no, diagnostics)
            self._detect_missing_semicolon(stripped, line, line_no, diagnostics)

        return diagnostics

    def _detect_strict_equality(self, line: str, line_no: int, diagnostics: List[dict]):
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

    def _detect_any_type(self, line: str, line_no: int, diagnostics: List[dict]):
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

    def _detect_var_usage(self, line: str, line_no: int, diagnostics: List[dict]):
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

    def _detect_console_log(self, line: str, line_no: int, diagnostics: List[dict]):
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

    def _detect_missing_semicolon(
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
