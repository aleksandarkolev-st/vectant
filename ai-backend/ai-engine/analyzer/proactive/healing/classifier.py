"""
Healing Classifier

Determines whether a detected diagnostic is safe to auto-heal or 
requires user intervention. This is the safety gate that prevents
the system from making changes it shouldn't.

Key principles:
1. Only micro-fixes (1-3 lines affected)
2. Never change program logic
3. Never modify inside strings or comments
4. High confidence required (>= 0.9)
5. Conservative: when in doubt, DON'T auto-heal
"""

from __future__ import annotations

import re
from typing import Dict, List, Optional, Set, Tuple

from .types import (
    HealingCategory,
    HealingSeverity,
    HealingAction,
    HealingFix,
)


# Categories that are ALWAYS safe to auto-apply
ALWAYS_SAFE_CATEGORIES: Set[HealingCategory] = {
    HealingCategory.TRAILING_WHITESPACE,
    HealingCategory.MISSING_NEWLINE_EOF,
    HealingCategory.TRAILING_COMMA,
    HealingCategory.DUPLICATE_IMPORT,
}

# Categories that MIGHT be safe depending on context
CONDITIONALLY_SAFE_CATEGORIES: Set[HealingCategory] = {
    HealingCategory.MISSING_COLON,
    HealingCategory.MISSING_SEMICOLON,
    HealingCategory.MISSING_BRACKET,
    HealingCategory.MISSING_PAREN,
    HealingCategory.UNUSED_IMPORT,
    HealingCategory.MISSING_IMPORT,
    HealingCategory.UNCLOSED_STRING,
    HealingCategory.MISMATCHED_QUOTES,
    HealingCategory.COMPARISON_TO_NONE,
}

# Categories that should NEVER be auto-applied without user confirmation
NEVER_AUTO_CATEGORIES: Set[HealingCategory] = {
    HealingCategory.UNDECLARED_VARIABLE,
    HealingCategory.TYPO_IN_IDENTIFIER,
    HealingCategory.MISSING_RETURN_TYPE,
    HealingCategory.OBVIOUS_TYPE_MISMATCH,
    HealingCategory.EQUALITY_VS_ASSIGNMENT,
    HealingCategory.IMPORT_ORDER,
    HealingCategory.INCONSISTENT_INDENTATION,
}

# Maximum number of lines a fix can affect to be considered "micro"
MAX_MICRO_FIX_LINES = 3

# Patterns that indicate we're inside a string or comment
COMMENT_PATTERNS = {
    "python": [r"#.*$", r'"""[\s\S]*?"""', r"'''[\s\S]*?'''"],
    "javascript": [r"//.*$", r"/\*[\s\S]*?\*/"],
    "typescript": [r"//.*$", r"/\*[\s\S]*?\*/"],
    "cpp": [r"//.*$", r"/\*[\s\S]*?\*/"],
    "java": [r"//.*$", r"/\*[\s\S]*?\*/"],
    "go": [r"//.*$", r"/\*[\s\S]*?\*/"],
    "rust": [r"//.*$", r"/\*[\s\S]*?\*/"],
    "c": [r"//.*$", r"/\*[\s\S]*?\*/"],
}


class HealingClassifier:
    """
    Classifies diagnostics and determines if they're safe to auto-heal.
    
    This is the safety gate of the self-healing system. It ensures:
    1. Only micro-fixes are auto-applied
    2. No logic changes
    3. No changes inside strings/comments
    4. High confidence required
    """
    
    def __init__(
        self,
        min_confidence: float = 0.9,
        max_fix_lines: int = MAX_MICRO_FIX_LINES,
    ):
        self._min_confidence = min_confidence
        self._max_fix_lines = max_fix_lines
    
    def classify_fix(
        self,
        fix: HealingFix,
        code: str,
        language: str,
    ) -> HealingFix:
        """
        Classify a fix and determine if it's safe to auto-apply.
        
        Modifies the fix in-place with safety metadata.
        Returns the same fix for chaining.
        """
        # Check category-level safety
        if fix.category in ALWAYS_SAFE_CATEGORIES:
            fix.is_safe = True
            fix.affects_logic = False
        elif fix.category in NEVER_AUTO_CATEGORIES:
            fix.is_safe = False
            fix.affects_logic = True
        else:
            # Conditionally safe - need deeper analysis
            fix.is_safe = self._analyze_safety(fix, code, language)
            fix.affects_logic = self._could_affect_logic(fix, code, language)
        
        # Override: never auto-apply low confidence
        if fix.confidence < self._min_confidence:
            fix.is_safe = False
        
        # Override: never auto-apply multi-line fixes beyond threshold
        affected_lines = abs(fix.end_line - fix.line) + 1
        if affected_lines > self._max_fix_lines:
            fix.is_safe = False
        
        # Override: never auto-apply if inside a string or comment
        if self._is_in_string_or_comment(fix.line, fix.column, code, language):
            fix.is_safe = False
        
        return fix
    
    def classify_fixes(
        self,
        fixes: List[HealingFix],
        code: str,
        language: str,
    ) -> List[HealingFix]:
        """Classify multiple fixes. Returns the same list for chaining."""
        for fix in fixes:
            self.classify_fix(fix, code, language)
        return fixes
    
    def _analyze_safety(
        self,
        fix: HealingFix,
        code: str,
        language: str,
    ) -> bool:
        """Analyze whether a conditionally-safe fix is actually safe."""
        lines = code.split('\n')
        
        # Missing colon: safe if it's at end of def/if/for/while/class/etc.
        if fix.category == HealingCategory.MISSING_COLON:
            return self._is_safe_colon_fix(fix, lines, language)
        
        # Missing semicolon: safe in C-style languages at end of statement
        if fix.category == HealingCategory.MISSING_SEMICOLON:
            return self._is_safe_semicolon_fix(fix, lines, language)
        
        # Missing bracket/paren: safe if it's clearly the closing match
        if fix.category in (HealingCategory.MISSING_BRACKET, HealingCategory.MISSING_PAREN):
            return self._is_safe_bracket_fix(fix, lines, language)
        
        # Unused import: safe to remove (doesn't affect runtime)
        if fix.category == HealingCategory.UNUSED_IMPORT:
            return self._is_safe_unused_import(fix, lines, language)
        
        # Missing import: safe if the symbol is clearly used
        if fix.category == HealingCategory.MISSING_IMPORT:
            return self._is_safe_missing_import(fix, lines, language)
        
        # Unclosed string: safe if it's on the same line
        if fix.category == HealingCategory.UNCLOSED_STRING:
            return fix.line == fix.end_line
        
        # Mismatched quotes: safe if it's a simple quote swap
        if fix.category == HealingCategory.MISMATCHED_QUOTES:
            return fix.line == fix.end_line
        
        # Comparison to None: safe (== None → is None)
        if fix.category == HealingCategory.COMPARISON_TO_NONE:
            return True
        
        return False
    
    def _could_affect_logic(
        self,
        fix: HealingFix,
        code: str,
        language: str,
    ) -> bool:
        """Check if applying this fix could change program logic."""
        # Syntax fixes don't change logic (they fix broken code)
        if fix.category in (
            HealingCategory.MISSING_COLON,
            HealingCategory.MISSING_SEMICOLON,
            HealingCategory.MISSING_BRACKET,
            HealingCategory.MISSING_PAREN,
            HealingCategory.UNCLOSED_STRING,
            HealingCategory.MISMATCHED_QUOTES,
        ):
            return False
        
        # Import removal could change behavior if import has side effects
        if fix.category == HealingCategory.UNUSED_IMPORT:
            return self._import_might_have_side_effects(fix, code, language)
        
        # Formatting fixes never affect logic
        if fix.category in (
            HealingCategory.TRAILING_WHITESPACE,
            HealingCategory.MISSING_NEWLINE_EOF,
            HealingCategory.TRAILING_COMMA,
        ):
            return False
        
        # Default: assume it could affect logic
        return True
    
    def _is_safe_colon_fix(
        self, fix: HealingFix, lines: List[str], language: str
    ) -> bool:
        """Check if adding a missing colon is safe."""
        if language not in ("python", "py"):
            return False
        
        if fix.line >= len(lines):
            return False
        
        line = lines[fix.line].rstrip()
        # Safe if line ends with common Python block starters
        block_patterns = [
            r'^\s*def\s+\w+',
            r'^\s*class\s+\w+',
            r'^\s*if\s+.+',
            r'^\s*elif\s+.+',
            r'^\s*else\s*$',
            r'^\s*for\s+.+',
            r'^\s*while\s+.+',
            r'^\s*try\s*$',
            r'^\s*except\s*',
            r'^\s*finally\s*$',
            r'^\s*with\s+.+',
            r'^\s*async\s+def\s+',
            r'^\s*async\s+for\s+',
            r'^\s*async\s+with\s+',
        ]
        return any(re.match(pat, line) for pat in block_patterns)
    
    def _is_safe_semicolon_fix(
        self, fix: HealingFix, lines: List[str], language: str
    ) -> bool:
        """Check if adding a missing semicolon is safe."""
        c_style = ("c", "cpp", "java", "javascript", "typescript", "rust", "go")
        if language.lower() not in c_style:
            return False
        
        if fix.line >= len(lines):
            return False
        
        line = lines[fix.line].rstrip()
        # Not safe inside for-loop header, or after { or before }
        if re.search(r'for\s*\(', line):
            return False
        if line.endswith('{') or line.endswith('}'):
            return False
        # Safe for simple statements
        return True
    
    def _is_safe_bracket_fix(
        self, fix: HealingFix, lines: List[str], language: str
    ) -> bool:
        """Check if adding a missing bracket/paren is safe."""
        # Only safe if we're adding a single closing bracket/paren
        if fix.action != HealingAction.INSERT:
            return False
        if len(fix.replacement_text) != 1:
            return False
        if fix.replacement_text not in (')', ']', '}'):
            return False
        return True
    
    def _is_safe_unused_import(
        self, fix: HealingFix, lines: List[str], language: str
    ) -> bool:
        """Check if removing an unused import is safe."""
        if fix.action != HealingAction.DELETE:
            return False
        # Not safe to remove wildcard imports (might have side effects)
        if fix.line < len(lines):
            line = lines[fix.line]
            if '*' in line:
                return False
            # Python: from module import * - not safe
            if re.search(r'from\s+\S+\s+import\s+\*', line):
                return False
        return True
    
    def _is_safe_missing_import(
        self, fix: HealingFix, lines: List[str], language: str
    ) -> bool:
        """Check if adding a missing import is safe."""
        if fix.action != HealingAction.INSERT:
            return False
        # Only safe if high confidence
        return fix.confidence >= 0.95
    
    def _import_might_have_side_effects(
        self, fix: HealingFix, code: str, language: str
    ) -> bool:
        """Check if an import might have side effects."""
        lines = code.split('\n')
        if fix.line >= len(lines):
            return True
        
        line = lines[fix.line].strip()
        
        if language in ("python", "py"):
            # These Python imports commonly have side effects
            side_effect_modules = {
                'logging', 'warnings', 'signal', 'atexit',
                'unittest', 'pytest', 'django', 'flask',
            }
            for mod in side_effect_modules:
                if mod in line:
                    return True
        
        return False
    
    def _is_in_string_or_comment(
        self,
        line: int,
        column: int,
        code: str,
        language: str,
    ) -> bool:
        """Check if a position is inside a string literal or comment."""
        lines = code.split('\n')
        if line >= len(lines):
            return False
        
        text = lines[line]
        
        # Simple heuristic: check if we're after a # (Python) or // (C-style)
        lang_lower = language.lower()
        
        if lang_lower in ("python", "py"):
            # Check for # comment
            in_string = False
            quote_char = None
            for i, ch in enumerate(text):
                if i >= column:
                    break
                if ch in ('"', "'") and not in_string:
                    in_string = True
                    quote_char = ch
                elif ch == quote_char and in_string:
                    in_string = False
                    quote_char = None
                elif ch == '#' and not in_string:
                    return True
            return in_string
        
        if lang_lower in ("javascript", "typescript", "java", "cpp", "c", "go", "rust"):
            # Check for // comment
            in_string = False
            quote_char = None
            for i, ch in enumerate(text):
                if i >= column:
                    break
                if ch in ('"', "'", '`') and not in_string:
                    in_string = True
                    quote_char = ch
                elif ch == quote_char and in_string:
                    in_string = False
                    quote_char = None
                elif ch == '/' and i + 1 < len(text) and text[i + 1] == '/' and not in_string:
                    return True
            return in_string
        
        return False
