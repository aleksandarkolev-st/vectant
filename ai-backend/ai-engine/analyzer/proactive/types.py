"""
Type definitions for the Proactive Analysis system.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple
import hashlib


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
    id: Optional[str] = None                     # Unique identifier for this diagnostic
    related_information: List[Dict] = field(default_factory=list)
    fixes: List[CodeFix] = field(default_factory=list)
    explanation: Optional[str] = None            # Detailed explanation for AI diagnostics
    confidence: float = 1.0                      # Confidence score (0-1) for AI diagnostics
    originalText: Optional[str] = None           # Original code that caused the diagnostic
    
    def __post_init__(self):
        if not self.id:
            # Generate deterministic ID from content available
            # We use message, code, and location to create a unique signature
            content = f"{self.location.line}:{self.location.column}:{self.message}:{self.code}"
            self.id = hashlib.md5(content.encode()).hexdigest()[:12]

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
        
        if self.id:
            result["id"] = self.id
        if self.related_information:
            result["relatedInformation"] = self.related_information
        if self.fixes:
            result["fixes"] = [f.to_dict() for f in self.fixes]
        if self.explanation:
            result["explanation"] = self.explanation
        if self.confidence < 1.0:
            result["confidence"] = self.confidence
        if self.originalText:
            result["originalText"] = self.originalText
            
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
        """
        Get all diagnostics from all tiers, sorted by severity and line.
        Deduplicates similar diagnostics that appear in multiple tiers.
        """
        severity_order = {Severity.ERROR: 0, Severity.WARNING: 1, Severity.INFO: 2, Severity.HINT: 3}
        tier_priority = {AnalysisTier.AI: 0, AnalysisTier.SEMANTIC: 1, AnalysisTier.STATIC: 2}
        
        all_diags = []
        for tier_result in self.tiers.values():
            all_diags.extend(tier_result.diagnostics)
        
        # Deduplicate diagnostics by creating a key from location and similar message
        # Keep the highest-priority tier's diagnostic (AI > SEMANTIC > STATIC)
        seen: Dict[str, Diagnostic] = {}
        
        for diag in all_diags:
            # Create a key for deduplication:
            # Same line and similar message content (ignoring tier-specific wording)
            loc = diag.location
            # Extract core message by removing common prefixes/suffixes
            core_msg = diag.message.lower()
            # Normalize message for comparison
            core_msg = core_msg.replace('`', '').replace("'", '')
            
            # Key combines location and core diagnostic concept
            # For include errors, group by the header being suggested
            if 'include' in core_msg and '<' in core_msg:
                # Extract header name for grouping include-related errors
                import re
                header_match = re.search(r'<([^>]+)>', core_msg)
                header = header_match.group(1) if header_match else ''
                key = f"{loc.line}:{header}:include"
            else:
                # For other errors, use line + first 30 chars of message
                key = f"{loc.line}:{loc.column}:{core_msg[:30]}"
            
            if key in seen:
                existing = seen[key]
                # Keep the one from higher priority tier
                if tier_priority.get(diag.tier, 3) < tier_priority.get(existing.tier, 3):
                    seen[key] = diag
            else:
                seen[key] = diag
        
        # Return deduplicated list sorted by severity and line
        return sorted(seen.values(), key=lambda d: (severity_order[d.severity], d.location.line))
    
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


# ============================================================================
# Multi-File / Workspace Analysis Types
# ============================================================================

@dataclass
class Hunk:
    """A line-range replacement, half-open [start_line, end_line)."""
    start_line: int
    end_line: int
    new_lines: List[str]


@dataclass
class FileChange:
    """Represents a change in a file for incremental analysis."""
    path: str
    content_hash: str
    change_type: str  # "added", "modified", "deleted"
    content: Optional[str] = None  # Only for added/modified
    language: Optional[str] = None
    # Hunk-only optimization: when set, content may be omitted and the
    # backend reconstructs it from the stored baseline whose hash equals
    # base_hash. content_hash must match the post-apply hash.
    hunks: Optional[List[Hunk]] = None
    base_hash: Optional[str] = None


@dataclass
class FileDependency:
    """Tracks dependency relationship between files."""
    source_path: str      # File that imports
    target_path: str      # File being imported
    import_name: str      # The import identifier
    is_resolved: bool = True


@dataclass
class CrossFileReference:
    """Reference to a related location in another file."""
    file_path: str
    location: DiagnosticLocation
    message: str
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "filePath": self.file_path,
            "location": self.location.to_dict(),
            "message": self.message,
        }


@dataclass
class MultiFileDiagnostic:
    """A diagnostic that may span or relate to multiple files."""
    primary_file: str                           # Main file where issue is detected
    message: str
    severity: Severity
    tier: AnalysisTier
    location: DiagnosticLocation
    code: str
    category: DiagnosticCategory = DiagnosticCategory.SYNTAX
    source: str = "synthi"
    # Cross-file references (e.g., "also affects file X at line Y")
    cross_file_refs: List[CrossFileReference] = field(default_factory=list)
    fixes: List['MultiFileFix'] = field(default_factory=list)
    explanation: Optional[str] = None
    confidence: float = 1.0
    originalText: Optional[str] = None
    
    def to_dict(self) -> Dict[str, Any]:
        result = {
            "primaryFile": self.primary_file,
            "message": self.message,
            "severity": self.severity.value,
            "tier": self.tier.value,
            "location": self.location.to_dict(),
            "code": self.code,
            "category": self.category.value,
            "source": self.source,
        }
        
        if self.cross_file_refs:
            result["crossFileRefs"] = [r.to_dict() for r in self.cross_file_refs]
        if self.fixes:
            result["fixes"] = [f.to_dict() for f in self.fixes]
        if self.explanation:
            result["explanation"] = self.explanation
        if self.confidence < 1.0:
            result["confidence"] = self.confidence
        if self.originalText:
            result["originalText"] = self.originalText
            
        return result
    
    def to_single_file_diagnostic(self) -> Diagnostic:
        """Convert to single-file diagnostic for backwards compatibility."""
        fixes = [CodeFix(
            description=f.description,
            replacement_text=f.edits[0].new_text if f.edits else "",
            location=f.edits[0].location if f.edits else self.location,
            is_preferred=f.is_preferred,
        ) for f in self.fixes if f.edits]
        
        related_info = [
            {
                "location": {
                    "filePath": ref.file_path,
                    **ref.location.to_dict(),
                },
                "message": ref.message,
            }
            for ref in self.cross_file_refs
        ]
        
        return Diagnostic(
            message=self.message,
            severity=self.severity,
            tier=self.tier,
            location=self.location,
            code=self.code,
            category=self.category,
            source=self.source,
            related_information=related_info,
            fixes=fixes,
            explanation=self.explanation,
            confidence=self.confidence,
            originalText=self.originalText,
        )


@dataclass
class FileEdit:
    """A single text edit within a file."""
    file_path: str
    location: DiagnosticLocation
    new_text: str
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "filePath": self.file_path,
            "location": self.location.to_dict(),
            "newText": self.new_text,
        }


@dataclass
class MultiFileFix:
    """A suggested fix that may span multiple files."""
    description: str
    edits: List[FileEdit]                  # All edits to apply
    is_preferred: bool = False
    preview_label: Optional[str] = None    # Short label for UI
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "description": self.description,
            "edits": [e.to_dict() for e in self.edits],
            "isPreferred": self.is_preferred,
            "previewLabel": self.preview_label,
        }


@dataclass
class WorkspaceAnalysisRequest:
    """Request for workspace-level analysis."""
    workspace_id: str
    # Files that changed since last analysis (for incremental)
    changed_files: List[FileChange] = field(default_factory=list)
    # All files in workspace (for full analysis or dependency resolution)
    all_files: List[FileContext] = field(default_factory=list)
    # File currently being edited (prioritize for AI analysis)
    focus_file: Optional[str] = None
    # Analysis configuration
    tiers: List[AnalysisTier] = field(default_factory=lambda: [AnalysisTier.STATIC, AnalysisTier.SEMANTIC])
    include_ai: bool = False
    max_diagnostics_per_file: int = 30
    max_total_diagnostics: int = 200
    # Optimization flags
    incremental: bool = True              # Use cached results for unchanged files
    analyze_dependents: bool = True       # Re-analyze files that import changed files


@dataclass 
class FileAnalysisResult:
    """Analysis result for a single file in workspace context."""
    file_path: str
    content_hash: str
    language: str
    diagnostics: List[MultiFileDiagnostic]
    from_cache: bool = False
    elapsed_ms: float = 0.0
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "filePath": self.file_path,
            "contentHash": self.content_hash,
            "language": self.language,
            "diagnostics": [d.to_dict() for d in self.diagnostics],
            "fromCache": self.from_cache,
            "elapsedMs": self.elapsed_ms,
        }


@dataclass
class WorkspaceAnalysisResult:
    """Complete workspace analysis result."""
    workspace_id: str
    files: Dict[str, FileAnalysisResult] = field(default_factory=dict)
    # Cross-file issues that involve multiple files
    cross_file_diagnostics: List[MultiFileDiagnostic] = field(default_factory=list)
    # Suggested multi-file refactors / batch fixes
    suggestions: List['WorkspaceSuggestion'] = field(default_factory=list)
    # Dependency graph (for UI visualization)
    dependencies: List[FileDependency] = field(default_factory=list)
    # Performance metrics
    total_elapsed_ms: float = 0.0
    files_analyzed: int = 0
    files_from_cache: int = 0
    
    @property
    def all_diagnostics(self) -> List[MultiFileDiagnostic]:
        """Get all diagnostics from all files."""
        diags = []
        for file_result in self.files.values():
            diags.extend(file_result.diagnostics)
        diags.extend(self.cross_file_diagnostics)
        return diags
    
    @property
    def summary(self) -> Dict[str, Any]:
        """Get summary counts by severity and file."""
        all_diags = self.all_diagnostics
        by_severity = {
            "errors": sum(1 for d in all_diags if d.severity == Severity.ERROR),
            "warnings": sum(1 for d in all_diags if d.severity == Severity.WARNING),
            "infos": sum(1 for d in all_diags if d.severity == Severity.INFO),
            "hints": sum(1 for d in all_diags if d.severity == Severity.HINT),
        }
        by_file = {
            path: len(result.diagnostics)
            for path, result in self.files.items()
        }
        return {
            "bySeverity": by_severity,
            "byFile": by_file,
            "total": len(all_diags),
            "filesWithIssues": sum(1 for count in by_file.values() if count > 0),
        }
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "workspaceId": self.workspace_id,
            "files": {k: v.to_dict() for k, v in self.files.items()},
            "crossFileDiagnostics": [d.to_dict() for d in self.cross_file_diagnostics],
            "suggestions": [s.to_dict() for s in self.suggestions],
            "dependencies": [
                {"source": d.source_path, "target": d.target_path, "import": d.import_name}
                for d in self.dependencies
            ],
            "summary": self.summary,
            "performance": {
                "totalElapsedMs": self.total_elapsed_ms,
                "filesAnalyzed": self.files_analyzed,
                "filesFromCache": self.files_from_cache,
            },
        }


@dataclass
class WorkspaceSuggestion:
    """
    A proactive suggestion for improving the workspace.
    Can be a refactoring, batch fix, or code improvement that spans files.
    """
    id: str                                    # Unique identifier
    title: str                                 # Short title for UI
    description: str                           # Detailed description
    category: str                              # "refactor", "fix", "improvement", "cleanup"
    severity: Severity = Severity.HINT
    # Files affected by this suggestion
    affected_files: List[str] = field(default_factory=list)
    # The actual fix to apply
    fix: Optional[MultiFileFix] = None
    # Related diagnostics that this suggestion addresses
    related_diagnostic_codes: List[str] = field(default_factory=list)
    # Confidence in the suggestion (for AI-generated)
    confidence: float = 1.0
    # Preview of what changes would be made
    preview: Optional[str] = None
    
    def to_dict(self) -> Dict[str, Any]:
        result = {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "category": self.category,
            "severity": self.severity.value,
            "affectedFiles": self.affected_files,
        }
        if self.fix:
            result["fix"] = self.fix.to_dict()
        if self.related_diagnostic_codes:
            result["relatedDiagnosticCodes"] = self.related_diagnostic_codes
        if self.confidence < 1.0:
            result["confidence"] = self.confidence
        if self.preview:
            result["preview"] = self.preview
        return result
