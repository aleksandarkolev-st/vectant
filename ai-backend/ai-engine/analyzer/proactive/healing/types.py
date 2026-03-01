"""Type definitions for the Targeted Auto-Fix system.

These types define the classification of issues that can be auto-fixed
vs. those that require user intervention.  Detection is regex-based;
confidence values are hand-tuned heuristics, not calibrated probabilities.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional
import hashlib
import time


class HealingCategory(str, Enum):
    """Categories of auto-healable issues.
    
    Only micro-fixes are auto-healed. The system explicitly avoids
    touching anything that changes program logic or structure.
    """
    # Syntax micro-fixes (safe to auto-correct)
    MISSING_COLON = "missing_colon"
    MISSING_SEMICOLON = "missing_semicolon"
    MISSING_BRACKET = "missing_bracket"
    MISSING_PAREN = "missing_paren"
    TRAILING_COMMA = "trailing_comma"
    
    # Import management
    UNUSED_IMPORT = "unused_import"
    MISSING_IMPORT = "missing_import"
    DUPLICATE_IMPORT = "duplicate_import"
    IMPORT_ORDER = "import_order"
    
    # Variable/symbol fixes
    UNDECLARED_VARIABLE = "undeclared_variable"
    UNUSED_VARIABLE = "unused_variable"
    TYPO_IN_IDENTIFIER = "typo_in_identifier"
    
    # Formatting micro-fixes
    TRAILING_WHITESPACE = "trailing_whitespace"
    MISSING_NEWLINE_EOF = "missing_newline_eof"
    INCONSISTENT_INDENTATION = "inconsistent_indentation"
    
    # Type annotation micro-fixes
    MISSING_RETURN_TYPE = "missing_return_type"
    OBVIOUS_TYPE_MISMATCH = "obvious_type_mismatch"
    
    # String/literal fixes
    UNCLOSED_STRING = "unclosed_string"
    MISMATCHED_QUOTES = "mismatched_quotes"
    
    # Common patterns
    COMPARISON_TO_NONE = "comparison_to_none"
    EQUALITY_VS_ASSIGNMENT = "equality_vs_assignment"


class HealingSeverity(str, Enum):
    """How severe the issue is (affects auto-heal priority)."""
    CRITICAL = "critical"     # Will cause immediate errors (missing colon, bracket)
    MODERATE = "moderate"     # Will cause issues at runtime (missing imports)
    LOW = "low"               # Style/convention issues (unused imports, formatting)


class HealingAction(str, Enum):
    """What the healing system should do."""
    INSERT = "insert"         # Add text at position
    DELETE = "delete"         # Remove text range
    REPLACE = "replace"       # Replace text range
    REORDER = "reorder"       # Reorder lines (e.g., import sorting)


@dataclass
class HealingFix:
    """A single auto-healing fix to apply."""
    category: HealingCategory
    severity: HealingSeverity
    action: HealingAction
    description: str
    
    # Location in source code (0-indexed)
    line: int
    column: int
    end_line: int
    end_column: int
    
    # The fix itself
    original_text: str          # Text being replaced/removed
    replacement_text: str       # New text (empty for DELETE)
    
    # Safety metadata
    confidence: float = 1.0    # 0.0-1.0 confidence in the fix
    is_safe: bool = True       # Whether this is safe to auto-apply
    affects_logic: bool = False # Whether this could change program logic
    
    # Tracking
    rule_id: str = ""          # Which rule produced this fix
    fix_id: str = ""           # Unique identifier for this fix
    
    def __post_init__(self):
        if not self.fix_id:
            content = f"{self.line}:{self.column}:{self.category.value}:{self.rule_id}"
            self.fix_id = hashlib.md5(content.encode()).hexdigest()[:12]
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "category": self.category.value,
            "severity": self.severity.value,
            "action": self.action.value,
            "description": self.description,
            "location": {
                "line": self.line,
                "column": self.column,
                "endLine": self.end_line,
                "endColumn": self.end_column,
            },
            "originalText": self.original_text,
            "replacementText": self.replacement_text,
            "confidence": self.confidence,
            "isSafe": self.is_safe,
            "affectsLogic": self.affects_logic,
            "ruleId": self.rule_id,
            "fixId": self.fix_id,
        }


@dataclass
class HealingResult:
    """Result of the self-healing analysis for a file."""
    file_path: str
    language: str
    content_hash: str
    fixes: List[HealingFix] = field(default_factory=list)
    skipped_issues: List[Dict[str, Any]] = field(default_factory=list)
    elapsed_ms: float = 0.0
    timestamp: float = field(default_factory=time.time)
    
    @property
    def safe_fixes(self) -> List[HealingFix]:
        """Only fixes that are safe to auto-apply."""
        return [f for f in self.fixes if f.is_safe and f.confidence >= 0.9]
    
    @property
    def moderate_fixes(self) -> List[HealingFix]:
        """Fixes that need user confirmation."""
        return [f for f in self.fixes if not f.is_safe or f.confidence < 0.9]
    
    @property
    def fix_count(self) -> int:
        return len(self.fixes)
    
    @property
    def auto_fixable_count(self) -> int:
        return len(self.safe_fixes)
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "filePath": self.file_path,
            "language": self.language,
            "contentHash": self.content_hash,
            "fixes": [f.to_dict() for f in self.fixes],
            "skippedIssues": self.skipped_issues,
            "elapsedMs": self.elapsed_ms,
            "timestamp": self.timestamp,
            "summary": {
                "totalFixes": self.fix_count,
                "autoFixable": self.auto_fixable_count,
                "needsConfirmation": len(self.moderate_fixes),
            },
        }


@dataclass
class HealingConfig:
    """Configuration for the self-healing engine."""
    enabled: bool = True
    
    # Which categories to auto-heal
    auto_heal_categories: List[HealingCategory] = field(default_factory=lambda: [
        HealingCategory.MISSING_COLON,
        HealingCategory.MISSING_SEMICOLON,
        HealingCategory.MISSING_BRACKET,
        HealingCategory.MISSING_PAREN,
        HealingCategory.UNUSED_IMPORT,
        HealingCategory.MISSING_IMPORT,
        HealingCategory.DUPLICATE_IMPORT,
        HealingCategory.TRAILING_WHITESPACE,
        HealingCategory.MISSING_NEWLINE_EOF,
        HealingCategory.UNCLOSED_STRING,
        HealingCategory.MISMATCHED_QUOTES,
        HealingCategory.TRAILING_COMMA,
        HealingCategory.COMPARISON_TO_NONE,
    ])
    
    # Safety thresholds
    min_confidence: float = 0.9          # Minimum confidence to auto-apply
    max_fixes_per_pass: int = 5          # Max fixes per single pass
    max_affected_lines: int = 3          # Max lines a single fix can touch
    
    # Rate limiting
    cooldown_ms: int = 1000              # Min time between healing passes
    debounce_ms: int = 800               # Debounce after last keystroke
    
    # What NOT to touch
    never_modify_logic: bool = True      # Never change program logic
    never_modify_comments: bool = True   # Never modify comments
    never_modify_strings: bool = True    # Never modify string literals
    
    # User interaction
    show_preview: bool = True            # Show fix before applying
    auto_apply_safe: bool = True         # Auto-apply safe fixes
    require_confirm_unsafe: bool = True  # Require confirmation for risky fixes
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "enabled": self.enabled,
            "autoHealCategories": [c.value for c in self.auto_heal_categories],
            "minConfidence": self.min_confidence,
            "maxFixesPerPass": self.max_fixes_per_pass,
            "maxAffectedLines": self.max_affected_lines,
            "cooldownMs": self.cooldown_ms,
            "debounceMs": self.debounce_ms,
            "neverModifyLogic": self.never_modify_logic,
            "neverModifyComments": self.never_modify_comments,
            "neverModifyStrings": self.never_modify_strings,
            "showPreview": self.show_preview,
            "autoApplySafe": self.auto_apply_safe,
            "requireConfirmUnsafe": self.require_confirm_unsafe,
        }


@dataclass
class HealingEvent:
    """An event emitted by the self-healing system for logging/UI."""
    event_type: str       # "fix_detected", "fix_applied", "fix_rejected", "fix_undone"
    fix: Optional[HealingFix] = None
    file_path: str = ""
    timestamp: float = field(default_factory=time.time)
    details: Dict[str, Any] = field(default_factory=dict)
    
    def to_dict(self) -> Dict[str, Any]:
        result = {
            "eventType": self.event_type,
            "filePath": self.file_path,
            "timestamp": self.timestamp,
            "details": self.details,
        }
        if self.fix:
            result["fix"] = self.fix.to_dict()
        return result


@dataclass
class HealingStats:
    """Statistics about the self-healing system's activity."""
    total_fixes_detected: int = 0
    total_fixes_applied: int = 0
    total_fixes_rejected: int = 0
    total_fixes_undone: int = 0
    fixes_by_category: Dict[str, int] = field(default_factory=dict)
    avg_confidence: float = 0.0
    session_start: float = field(default_factory=time.time)
    
    def record_fix(self, fix: HealingFix, applied: bool = True):
        self.total_fixes_detected += 1
        cat = fix.category.value
        self.fixes_by_category[cat] = self.fixes_by_category.get(cat, 0) + 1
        
        if applied:
            self.total_fixes_applied += 1
        else:
            self.total_fixes_rejected += 1
        
        # Rolling average confidence
        total = self.total_fixes_detected
        self.avg_confidence = (
            (self.avg_confidence * (total - 1) + fix.confidence) / total
        )
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "totalFixesDetected": self.total_fixes_detected,
            "totalFixesApplied": self.total_fixes_applied,
            "totalFixesRejected": self.total_fixes_rejected,
            "totalFixesUndone": self.total_fixes_undone,
            "fixesByCategory": self.fixes_by_category,
            "avgConfidence": round(self.avg_confidence, 3),
            "uptimeSeconds": round(time.time() - self.session_start, 1),
        }
