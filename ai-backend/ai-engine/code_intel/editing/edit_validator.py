"""
Edit Validator - Validate edits before execution.

Validates:
- File exists (for modifications)
- Line numbers are valid
- Old content matches current content
- Syntax validity (basic)
- No conflicting edits
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List, Optional, Set

from .edit_planner import EditPlan, PlannedEdit, EditType


logger = logging.getLogger("code_intel.editing.validator")


@dataclass
class ValidationIssue:
    """An issue found during validation."""
    
    edit_id: str
    severity: str  # "error", "warning", "info"
    code: str
    message: str
    suggestion: Optional[str] = None


@dataclass
class ValidationResult:
    """Result of validating an edit plan."""
    
    is_valid: bool
    issues: List[ValidationIssue] = field(default_factory=list)
    
    # Statistics
    edits_validated: int = 0
    errors: int = 0
    warnings: int = 0
    
    def add_error(
        self,
        edit_id: str,
        code: str,
        message: str,
        suggestion: Optional[str] = None,
    ) -> None:
        """Add an error issue."""
        self.issues.append(ValidationIssue(
            edit_id=edit_id,
            severity="error",
            code=code,
            message=message,
            suggestion=suggestion,
        ))
        self.errors += 1
        self.is_valid = False
    
    def add_warning(
        self,
        edit_id: str,
        code: str,
        message: str,
        suggestion: Optional[str] = None,
    ) -> None:
        """Add a warning issue."""
        self.issues.append(ValidationIssue(
            edit_id=edit_id,
            severity="warning",
            code=code,
            message=message,
            suggestion=suggestion,
        ))
        self.warnings += 1
    
    def get_summary(self) -> str:
        """Get summary of validation result."""
        if self.is_valid:
            status = "✓ Plan is valid"
        else:
            status = "✗ Plan has errors"
        
        lines = [status]
        
        if self.errors > 0:
            lines.append(f"  Errors: {self.errors}")
        if self.warnings > 0:
            lines.append(f"  Warnings: {self.warnings}")
        
        return "\n".join(lines)


class EditValidator:
    """
    Validate edit plans before execution.
    
    Checks:
    - File existence
    - Line number validity
    - Content matching
    - Basic syntax (language-specific)
    - Conflict detection
    """
    
    def __init__(
        self,
        workspace_root: str,
        strict_content_match: bool = True,
    ):
        self.workspace_root = Path(workspace_root)
        self.strict_content_match = strict_content_match
    
    def validate(self, plan: EditPlan) -> ValidationResult:
        """
        Validate an edit plan.
        
        Args:
            plan: The plan to validate
            
        Returns:
            ValidationResult
        """
        result = ValidationResult(is_valid=True)
        
        # Load current file contents
        file_contents = self._load_files(plan.get_affected_files())
        
        # Validate each edit
        for edit in plan.edits:
            self._validate_edit(edit, file_contents, result)
            result.edits_validated += 1
        
        # Check for overlapping edits
        self._check_overlaps(plan, result)
        
        # Update plan validation state
        plan.validated = result.is_valid
        
        return result
    
    def _load_files(self, file_paths: List[str]) -> Dict[str, List[str]]:
        """Load current content of files."""
        contents = {}
        
        for file_path in file_paths:
            full_path = self.workspace_root / file_path
            
            if full_path.exists() and full_path.is_file():
                try:
                    with open(full_path, "r", encoding="utf-8") as f:
                        contents[file_path] = f.readlines()
                except Exception as e:
                    logger.error(f"Error reading {file_path}: {e}")
                    contents[file_path] = None
            else:
                contents[file_path] = None
        
        return contents
    
    def _validate_edit(
        self,
        edit: PlannedEdit,
        file_contents: Dict[str, List[str]],
        result: ValidationResult,
    ) -> None:
        """Validate a single edit."""
        file_path = edit.location.file_path
        lines = file_contents.get(file_path)
        
        # Check file existence
        if edit.edit_type == EditType.CREATE_FILE:
            if lines is not None:
                result.add_warning(
                    edit.id,
                    "FILE_EXISTS",
                    f"File already exists: {file_path}",
                    "Will be overwritten",
                )
        elif edit.edit_type == EditType.DELETE_FILE:
            if lines is None:
                result.add_error(
                    edit.id,
                    "FILE_NOT_FOUND",
                    f"File not found: {file_path}",
                )
        else:
            # Modification edit - file must exist
            if lines is None:
                result.add_error(
                    edit.id,
                    "FILE_NOT_FOUND",
                    f"File not found: {file_path}",
                )
                return
            
            # Check line numbers
            total_lines = len(lines)
            if edit.location.start_line < 1:
                result.add_error(
                    edit.id,
                    "INVALID_LINE",
                    f"Start line must be >= 1, got {edit.location.start_line}",
                )
            if edit.location.end_line > total_lines + 1:
                result.add_error(
                    edit.id,
                    "INVALID_LINE",
                    f"End line {edit.location.end_line} exceeds file length {total_lines}",
                )
            
            # Check content match
            if self.strict_content_match and edit.old_content:
                self._validate_content_match(edit, lines, result)
        
        # Validate new content (basic syntax check)
        if edit.new_content:
            self._validate_syntax(edit, result)
        
        # Mark as validated (even if errors found)
        edit.validated = True
        edit.validation_errors = [
            i.message for i in result.issues
            if i.edit_id == edit.id and i.severity == "error"
        ]
    
    def _validate_content_match(
        self,
        edit: PlannedEdit,
        lines: List[str],
        result: ValidationResult,
    ) -> None:
        """Validate that old_content matches current file content."""
        start = edit.location.start_line - 1
        end = edit.location.end_line
        
        if start >= len(lines):
            return
        
        current = "".join(lines[start:end])
        expected = edit.old_content
        
        # Normalize for comparison
        current_norm = current.strip()
        expected_norm = expected.strip()
        
        if current_norm != expected_norm:
            # Try fuzzy match
            similarity = self._compute_similarity(current_norm, expected_norm)
            
            if similarity < 0.8:
                result.add_error(
                    edit.id,
                    "CONTENT_MISMATCH",
                    f"Content at lines {edit.location.start_line}-{edit.location.end_line} "
                    f"does not match expected content",
                    "The file may have changed. Refresh and try again.",
                )
            else:
                result.add_warning(
                    edit.id,
                    "CONTENT_SIMILAR",
                    f"Content at lines {edit.location.start_line}-{edit.location.end_line} "
                    f"is similar but not identical (similarity: {similarity:.0%})",
                )
    
    def _compute_similarity(self, a: str, b: str) -> float:
        """Compute similarity between two strings."""
        if not a or not b:
            return 0.0
        
        # Simple character-based similarity
        a_set = set(a)
        b_set = set(b)
        intersection = len(a_set & b_set)
        union = len(a_set | b_set)
        
        return intersection / union if union > 0 else 0.0
    
    def _validate_syntax(
        self,
        edit: PlannedEdit,
        result: ValidationResult,
    ) -> None:
        """Basic syntax validation for new content."""
        content = edit.new_content
        file_path = edit.location.file_path
        
        # Determine language
        ext = Path(file_path).suffix.lower()
        
        # Python-specific checks
        if ext == ".py":
            self._validate_python_syntax(edit, content, result)
        
        # JavaScript/TypeScript checks
        elif ext in (".js", ".ts", ".jsx", ".tsx"):
            self._validate_js_syntax(edit, content, result)
    
    def _validate_python_syntax(
        self,
        edit: PlannedEdit,
        content: str,
        result: ValidationResult,
    ) -> None:
        """Basic Python syntax validation."""
        # Check for obvious issues
        
        # Unmatched brackets
        brackets = {"(": ")", "[": "]", "{": "}"}
        stack = []
        
        for char in content:
            if char in brackets:
                stack.append(char)
            elif char in brackets.values():
                if not stack:
                    result.add_warning(
                        edit.id,
                        "UNMATCHED_BRACKET",
                        f"Possible unmatched closing bracket: {char}",
                    )
                    break
                expected = brackets[stack.pop()]
                if char != expected:
                    result.add_warning(
                        edit.id,
                        "UNMATCHED_BRACKET",
                        f"Mismatched brackets: expected {expected}, got {char}",
                    )
                    break
        
        if stack:
            result.add_warning(
                edit.id,
                "UNMATCHED_BRACKET",
                f"Unclosed brackets: {''.join(stack)}",
            )
        
        # Check indentation (basic)
        lines = content.split("\n")
        for i, line in enumerate(lines):
            if line and not line[0].isspace() and line[0] not in ("#", '"', "'"):
                stripped = line.lstrip()
                indent = len(line) - len(stripped)
                if indent % 4 != 0 and indent % 2 != 0:
                    result.add_warning(
                        edit.id,
                        "ODD_INDENT",
                        f"Unusual indentation at line {i + 1}",
                    )
    
    def _validate_js_syntax(
        self,
        edit: PlannedEdit,
        content: str,
        result: ValidationResult,
    ) -> None:
        """Basic JavaScript/TypeScript syntax validation."""
        # Similar bracket checking
        brackets = {"(": ")", "[": "]", "{": "}"}
        stack = []
        
        # Skip strings and comments
        in_string = None
        in_comment = False
        prev_char = ""
        
        for char in content:
            if in_comment:
                if prev_char == "*" and char == "/":
                    in_comment = False
                prev_char = char
                continue
            
            if prev_char == "/" and char == "*":
                in_comment = True
                prev_char = char
                continue
            
            if char in ('"', "'", "`") and prev_char != "\\":
                if in_string == char:
                    in_string = None
                elif in_string is None:
                    in_string = char
            
            if in_string is None:
                if char in brackets:
                    stack.append(char)
                elif char in brackets.values():
                    if stack:
                        expected = brackets[stack.pop()]
                        if char != expected:
                            result.add_warning(
                                edit.id,
                                "UNMATCHED_BRACKET",
                                f"Mismatched brackets",
                            )
            
            prev_char = char
        
        if stack:
            result.add_warning(
                edit.id,
                "UNMATCHED_BRACKET",
                f"Unclosed brackets: {''.join(stack)}",
            )
    
    def _check_overlaps(
        self,
        plan: EditPlan,
        result: ValidationResult,
    ) -> None:
        """Check for overlapping edits in the same file."""
        # Group edits by file
        by_file: Dict[str, List[PlannedEdit]] = {}
        
        for edit in plan.edits:
            if edit.edit_type in (EditType.CREATE_FILE, EditType.DELETE_FILE):
                continue
            
            file_path = edit.location.file_path
            if file_path not in by_file:
                by_file[file_path] = []
            by_file[file_path].append(edit)
        
        # Check for overlaps within each file
        for file_path, edits in by_file.items():
            for i, edit1 in enumerate(edits):
                for edit2 in edits[i + 1:]:
                    if self._ranges_overlap(
                        edit1.location.start_line, edit1.location.end_line,
                        edit2.location.start_line, edit2.location.end_line,
                    ):
                        result.add_error(
                            edit1.id,
                            "OVERLAPPING_EDITS",
                            f"Edit overlaps with {edit2.id} in {file_path}",
                        )
    
    def _ranges_overlap(
        self,
        start1: int, end1: int,
        start2: int, end2: int,
    ) -> bool:
        """Check if two line ranges overlap."""
        return not (end1 < start2 or end2 < start1)
