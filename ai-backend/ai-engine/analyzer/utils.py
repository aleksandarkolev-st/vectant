from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal, Optional, List, Dict, Any

Severity = Literal["error", "warning", "info", "hint"]
_DEFAULT_SEVERITY: Severity = "info"


@dataclass(frozen=True)
class CodeFix:
    """A suggested fix for a diagnostic."""
    description: str
    replacement_text: str
    line: int = 0
    column: int = 0
    end_line: int = 0
    end_column: int = 0
    is_preferred: bool = False
    
    def as_dict(self) -> dict:
        return {
            "description": self.description,
            "replacementText": self.replacement_text,
            "location": {
                "line": self.line,
                "column": self.column,
                "endLine": self.end_line,
                "endColumn": self.end_column,
            },
            "isPreferred": self.is_preferred,
        }


@dataclass
class Diagnostic:
    message: str
    severity: Severity = _DEFAULT_SEVERITY
    line: int = 0
    column: Optional[int] = None
    end_line: Optional[int] = None
    end_column: Optional[int] = None
    code: Optional[str] = None
    fixes: List[CodeFix] = field(default_factory=list)

    def as_dict(self) -> dict:
        payload = {
            "message": self.message,
            "severity": self.severity,
            "line": max(0, self.line),
        }
        if self.column is not None:
            payload["column"] = max(0, self.column)
        if self.end_line is not None:
            payload["end_line"] = max(0, self.end_line)
        if self.end_column is not None:
            payload["end_column"] = max(0, self.end_column)
        if self.code:
            payload["code"] = self.code
        if self.fixes:
            payload["fixes"] = [f.as_dict() for f in self.fixes]
        return payload


def make_diag(
    msg: str,
    severity: Severity = _DEFAULT_SEVERITY,
    line: int = 0,
    *,
    column: Optional[int] = None,
    end_line: Optional[int] = None,
    end_column: Optional[int] = None,
    code: Optional[str] = None,
    fixes: Optional[List[CodeFix]] = None,
) -> dict:
    """Helper to ensure consistent diagnostic payloads."""
    return Diagnostic(
        message=msg,
        severity=severity,
        line=line,
        column=column,
        end_line=end_line,
        end_column=end_column,
        code=code,
        fixes=fixes or [],
    ).as_dict()