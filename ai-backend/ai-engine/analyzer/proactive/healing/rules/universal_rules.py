"""
Universal healing rules that apply to all languages.

These handle common issues that aren't language-specific:
- Trailing whitespace
- Missing newline at end of file
- Mismatched quotes
- Unclosed strings (simple cases)
"""

from __future__ import annotations

import re
from typing import List

from ..healing.types import (
    HealingCategory,
    HealingSeverity,
    HealingAction,
    HealingFix,
)
from ..healing.rule_registry import healing_rule


@healing_rule(
    rule_id="UNI_HEAL_001",
    category=HealingCategory.TRAILING_WHITESPACE,
    languages={"*"},
    description="Remove trailing whitespace from lines",
)
def detect_trailing_whitespace(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect trailing whitespace on lines."""
    fixes = []
    lines = code.split('\n')
    
    for idx, line in enumerate(lines):
        # Check for trailing spaces/tabs
        stripped = line.rstrip()
        if len(stripped) < len(line) and stripped:  # Don't flag blank lines
            trailing = line[len(stripped):]
            fixes.append(HealingFix(
                category=HealingCategory.TRAILING_WHITESPACE,
                severity=HealingSeverity.LOW,
                action=HealingAction.DELETE,
                description="Remove trailing whitespace",
                line=idx,
                column=len(stripped),
                end_line=idx,
                end_column=len(line),
                original_text=trailing,
                replacement_text="",
                confidence=1.0,
                is_safe=True,
                affects_logic=False,
            ))
    
    return fixes


@healing_rule(
    rule_id="UNI_HEAL_002",
    category=HealingCategory.MISSING_NEWLINE_EOF,
    languages={"*"},
    description="Add missing newline at end of file",
)
def detect_missing_newline_eof(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect missing newline at end of file."""
    fixes = []
    
    if code and not code.endswith('\n'):
        lines = code.split('\n')
        last_line = len(lines) - 1
        last_col = len(lines[-1]) if lines else 0
        
        fixes.append(HealingFix(
            category=HealingCategory.MISSING_NEWLINE_EOF,
            severity=HealingSeverity.LOW,
            action=HealingAction.INSERT,
            description="Add missing newline at end of file",
            line=last_line,
            column=last_col,
            end_line=last_line,
            end_column=last_col,
            original_text="",
            replacement_text="\n",
            confidence=1.0,
            is_safe=True,
            affects_logic=False,
        ))
    
    return fixes


@healing_rule(
    rule_id="UNI_HEAL_003",
    category=HealingCategory.UNCLOSED_STRING,
    languages={"*"},
    description="Close unclosed string literals on the same line",
)
def detect_unclosed_strings(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect unclosed string literals (single-line only)."""
    fixes = []
    lines = code.split('\n')
    
    for idx, line in enumerate(lines):
        stripped = line.rstrip()
        if not stripped:
            continue
        
        # Skip comment-only lines
        lstripped = stripped.lstrip()
        if lstripped.startswith('//') or lstripped.startswith('#'):
            continue
        
        # Count unescaped quotes
        in_single = False
        in_double = False
        
        for i, ch in enumerate(stripped):
            # Skip escaped characters
            if i > 0 and stripped[i - 1] == '\\':
                continue
            
            if ch == "'" and not in_double:
                in_single = not in_single
            elif ch == '"' and not in_single:
                in_double = not in_double
        
        # If we ended with an open string, suggest closing it
        if in_single:
            col = len(stripped)
            fixes.append(HealingFix(
                category=HealingCategory.UNCLOSED_STRING,
                severity=HealingSeverity.CRITICAL,
                action=HealingAction.INSERT,
                description="Close unclosed single-quoted string",
                line=idx,
                column=col,
                end_line=idx,
                end_column=col,
                original_text="",
                replacement_text="'",
                confidence=0.85,
                is_safe=True,
            ))
        
        if in_double:
            col = len(stripped)
            fixes.append(HealingFix(
                category=HealingCategory.UNCLOSED_STRING,
                severity=HealingSeverity.CRITICAL,
                action=HealingAction.INSERT,
                description="Close unclosed double-quoted string",
                line=idx,
                column=col,
                end_line=idx,
                end_column=col,
                original_text="",
                replacement_text='"',
                confidence=0.85,
                is_safe=True,
            ))
    
    return fixes


@healing_rule(
    rule_id="UNI_HEAL_004",
    category=HealingCategory.MISMATCHED_QUOTES,
    languages={"*"},
    description="Fix mismatched quotes in string literals",
)
def detect_mismatched_quotes(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect mismatched quote types in string literals."""
    fixes = []
    lines = code.split('\n')
    
    for idx, line in enumerate(lines):
        stripped = line.rstrip()
        if not stripped:
            continue
        
        # Look for patterns like "text' or 'text"
        # This is a heuristic - only flag obvious cases
        patterns = [
            # Opens with " but closes with '
            (r'"([^"\'\\]|\\.)*\'', '"', "'"),
            # Opens with ' but closes with "
            (r"'([^'\"\\]|\\.)*\"", "'", '"'),
        ]
        
        for pattern, open_q, close_q in patterns:
            for match in re.finditer(pattern, stripped):
                start = match.start()
                end = match.end()
                original = match.group(0)
                
                # Fix by changing the closing quote to match the opening
                fixed = original[:-1] + open_q
                
                fixes.append(HealingFix(
                    category=HealingCategory.MISMATCHED_QUOTES,
                    severity=HealingSeverity.CRITICAL,
                    action=HealingAction.REPLACE,
                    description=f"Fix mismatched quotes: change closing {close_q} to {open_q}",
                    line=idx,
                    column=start,
                    end_line=idx,
                    end_column=end,
                    original_text=original,
                    replacement_text=fixed,
                    confidence=0.80,
                    is_safe=True,
                ))
    
    return fixes


@healing_rule(
    rule_id="UNI_HEAL_005",
    category=HealingCategory.TRAILING_COMMA,
    languages={"javascript", "js", "typescript", "ts", "tsx", "json"},
    description="Fix trailing comma issues in JSON (not allowed) and add in JS/TS where helpful",
)
def detect_trailing_comma_issues(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect trailing comma issues."""
    fixes = []
    lines = code.split('\n')
    lang_lower = language.lower()
    
    # In JSON, trailing commas are NOT allowed - detect and remove them
    if lang_lower == 'json':
        for idx, line in enumerate(lines):
            stripped = line.rstrip()
            # Look for ,} or ,] patterns
            if stripped.endswith(',') and idx + 1 < len(lines):
                next_line = lines[idx + 1].strip()
                if next_line.startswith('}') or next_line.startswith(']'):
                    comma_pos = len(stripped) - 1
                    fixes.append(HealingFix(
                        category=HealingCategory.TRAILING_COMMA,
                        severity=HealingSeverity.CRITICAL,
                        action=HealingAction.REPLACE,
                        description="Remove trailing comma (not valid in JSON)",
                        line=idx,
                        column=comma_pos,
                        end_line=idx,
                        end_column=comma_pos + 1,
                        original_text=",",
                        replacement_text="",
                        confidence=0.98,
                        is_safe=True,
                        affects_logic=False,
                    ))
    
    return fixes
