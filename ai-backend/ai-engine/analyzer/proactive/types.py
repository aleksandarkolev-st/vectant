"""
Type definitions for the Proactive Analysis system.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple


class Severity(str, Enum):
    """Diagnostic severity levels following LSP conventions."""
    ERROR = "error"
    WARNING = "warning"
    INFO = "info"
    HINT = "hint"


class AnalysisTier(str, Enum):
    """Analysis tier indicating which layer produced the diagnostic."""
    STATIC = "static"      # Fast pattern-based (< 100ms)
    SEMANTIC = "semantic"  # AST-based (< 500ms)
    AI = "ai"              # LLM-powered (< 3s)


class DiagnosticCategory(str, Enum):
    """Categories of issues detected."""
    SYNTAX = "syntax"
    TYPE_ERROR = "type_error"
    NULL_REFERENCE = "null_reference"
    UNDEFINED_VARIABLE = "undefined_variable"
    UNUSED_CODE = "unused_code"
    SECURITY = "security"
    PERFORMANCE = "performance"
    STYLE = "style"
    LOGIC_ERROR = "logic_error"
    RESOURCE_LEAK = "resource_leak"
    CONCURRENCY = "concurrency"
    BEST_PRACTICE = "best_practice"


@dataclass
class DiagnosticLocation:
    """Precise location of a diagnostic in source code."""
    line: int           # 0-indexed line number
    column: int         # 0-indexed column number
    end_line: int       # 0-indexed end line
    end_column: int     # 0-indexed end column
    
    def to_dict(self) -> Dict[str, int]:
        return {
            "line": self.line,
            "column": self.column,
            "endLine": self.end_line,
            "endColumn": self.end_column,
        }


@dataclass
class CodeFix:
    """Suggested fix for a diagnostic."""
    description: str
    replacement_text: str
    location: DiagnosticLocation
    is_preferred: bool = False
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "description": self.description,
            "replacementText": self.replacement_text,
            "location": self.location.to_dict(),
            "isPreferred": self.is_preferred,
        }


@dataclass
class Diagnostic:
    """A single diagnostic (error, warning, etc.)."""
    message: str
    severity: Severity
    tier: AnalysisTier
    location: DiagnosticLocation
    code: str                                    # Unique diagnostic code e.g. "PY001"
    category: DiagnosticCategory = DiagnosticCategory.SYNTAX
    source: str = "synthi"                       # Tool that produced this
    related_information: List[Dict] = field(default_factory=list)
    fixes: List[CodeFix] = field(default_factory=list)
    explanation: Optional[str] = None            # Detailed explanation for AI diagnostics
    confidence: float = 1.0                      # Confidence score (0-1) for AI diagnostics
    
    def to_dict(self) -> Dict[str, Any]:
        result = {
            "message": self.message,
            "severity": self.severity.value,
            "tier": self.tier.value,
            "location": self.location.to_dict(),
            "code": self.code,
            "category": self.category.value,
            "source": self.source,
        }
        
        if self.related_information:
            result["relatedInformation"] = self.related_information
        if self.fixes:
            result["fixes"] = [f.to_dict() for f in self.fixes]
        if self.explanation:
            result["explanation"] = self.explanation
        if self.confidence < 1.0:
            result["confidence"] = self.confidence
            
        return result


@dataclass
class FileContext:
    """Context about a file being analyzed."""
    path: str
    content: str
    language: str
    content_hash: str = ""
    
    def __post_init__(self):
        if not self.content_hash:
            import hashlib
            self.content_hash = hashlib.sha256(self.content.encode()).hexdigest()[:16]


@dataclass 
class AnalysisRequest:
    """Request for proactive analysis."""
    file: FileContext
    related_files: List[FileContext] = field(default_factory=list)
    tiers: List[AnalysisTier] = field(default_factory=lambda: list(AnalysisTier))
    max_diagnostics: int = 50
    include_fixes: bool = True
    workspace_id: Optional[str] = None


@dataclass
class TierResult:
    """Result from a single analysis tier."""
    tier: AnalysisTier
    diagnostics: List[Diagnostic]
    elapsed_ms: float
    from_cache: bool = False
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "tier": self.tier.value,
            "diagnostics": [d.to_dict() for d in self.diagnostics],
            "elapsedMs": self.elapsed_ms,
            "fromCache": self.from_cache,
        }


@dataclass
class AnalysisResult:
    """Complete analysis result from all tiers."""
    file_path: str
    content_hash: str
    language: str
    tiers: Dict[AnalysisTier, TierResult] = field(default_factory=dict)
    total_elapsed_ms: float = 0.0
    
    @property
    def all_diagnostics(self) -> List[Diagnostic]:
        """Get all diagnostics from all tiers, sorted by severity and line."""
        severity_order = {Severity.ERROR: 0, Severity.WARNING: 1, Severity.INFO: 2, Severity.HINT: 3}
        all_diags = []
        for tier_result in self.tiers.values():
            all_diags.extend(tier_result.diagnostics)
        return sorted(all_diags, key=lambda d: (severity_order[d.severity], d.location.line))
    
    @property
    def error_count(self) -> int:
        return sum(1 for d in self.all_diagnostics if d.severity == Severity.ERROR)
    
    @property
    def warning_count(self) -> int:
        return sum(1 for d in self.all_diagnostics if d.severity == Severity.WARNING)
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "filePath": self.file_path,
            "contentHash": self.content_hash,
            "language": self.language,
            "diagnostics": [d.to_dict() for d in self.all_diagnostics],
            "tiers": {k.value: v.to_dict() for k, v in self.tiers.items()},
            "summary": {
                "errors": self.error_count,
                "warnings": self.warning_count,
                "total": len(self.all_diagnostics),
            },
            "totalElapsedMs": self.total_elapsed_ms,
        }
