from __future__ import annotations

import re
from typing import List

from analyzer.baseAnalyzer import BaseAnalyzer
from analyzer.utils import make_diag

_IO_HEADER = "#include <iostream>"
_IO_USAGE = re.compile(r"\b(?:std::)?c(?:out|in)\b")
_USING_NAMESPACE_STD = re.compile(r"using\s+namespace\s+std\s*;")


class CppAnalyzer(BaseAnalyzer):
    language = "cpp"
    aliases = ("c++", "cc")

    def analyze(self, code: str):
        diagnostics: List[dict] = []
        stripped = code.strip()
        if not stripped:
            return diagnostics

        self._check_iostream_include(code, diagnostics)
        self._check_using_namespace_std(code, diagnostics)
        self._check_raw_new_usage(code, diagnostics)
        self._check_null_usage(code, diagnostics)
        self._check_main_return(code, diagnostics)

        return diagnostics

    def _check_iostream_include(self, code: str, diagnostics: List[dict]):
        if _IO_USAGE.search(code) and _IO_HEADER not in code:
            diagnostics.append(
                make_diag(
                    msg="Missing `#include <iostream>` for cin/cout usage",
                    severity="error",
                    line=0,
                    code="CPP001",
                )
            )

    def _check_using_namespace_std(self, code: str, diagnostics: List[dict]):
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

    def _check_raw_new_usage(self, code: str, diagnostics: List[dict]):
        if re.search(r"\bnew\b", code) and not re.search(r"\bdelete\b", code):
            diagnostics.append(
                make_diag(
                    msg="Raw `new` detected without matching `delete`",
                    severity="warning",
                    line=0,
                    code="CPP003",
                )
            )

    def _check_null_usage(self, code: str, diagnostics: List[dict]):
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

    def _check_main_return(self, code: str, diagnostics: List[dict]):
        if "int main" in code and "return" not in code:
            diagnostics.append(
                make_diag(
                    msg="`int main` should return a status code",
                    severity="info",
                    line=0,
                    code="CPP005",
                )
            )
