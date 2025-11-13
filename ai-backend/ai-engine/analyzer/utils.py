from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Optional

Severity = Literal["error", "warning", "info", "hint"]
_DEFAULT_SEVERITY: Severity = "info"


@dataclass(frozen=True)
class Diagnostic:
    message: str
    severity: Severity = _DEFAULT_SEVERITY
    line: int = 0
    column: Optional[int] = None
    code: Optional[str] = None

    def as_dict(self) -> dict:
        payload = {
            "message": self.message,
            "severity": self.severity,
            "line": max(0, self.line),
        }
        if self.column is not None:
            payload["column"] = max(0, self.column)
        if self.code:
            payload["code"] = self.code
        return payload


def make_diag(
    msg: str,
    severity: Severity = _DEFAULT_SEVERITY,
    line: int = 0,
    *,
    column: Optional[int] = None,
    code: Optional[str] = None,
) -> dict:
    """Helper to ensure consistent diagnostic payloads."""
    return Diagnostic(
        message=msg,
        severity=severity,
        line=line,
        column=column,
        code=code,
    ).as_dict()
