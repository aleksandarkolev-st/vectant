"""
Universal healing rule: Missing statement terminators.

Detects and fixes missing colons (Python), semicolons (JS/TS/C/C++/Java/Go),
and other statement terminators across all supported languages.

This single rule handles what was previously split across python_rules,
javascript_rules, typescript_rules, and cpp_rules.
"""

from __future__ import annotations

import re
from typing import List

from ..types import (
    HealingCategory,
    HealingSeverity,
    HealingAction,
    HealingFix,
)
from ..rule_registry import healing_rule


# ── Language classification helpers ────────────────────────────────────

# Languages that use colons for blocks
COLON_LANGUAGES = {'python', 'py'}

# Languages that use semicolons as statement terminators
SEMICOLON_LANGUAGES = {
    'javascript', 'js', 'typescript', 'ts', 'tsx', 'jsx',
    'c', 'cpp', 'c++', 'cxx', 'java', 'csharp', 'cs',
    'rust', 'rs', 'go', 'dart', 'swift', 'kotlin',
    'php', 'scala', 'perl',
}

# ── Python colon patterns ──────────────────────────────────────────────

_PY_BLOCK_PATTERNS = [
    (r'^(async\s+)?def\s+\w+\s*\(.*\)\s*(->\s*\S+\s*)?$', 'function definition'),
    (r'^class\s+\w+(\s*\(.*\))?\s*$', 'class definition'),
    (r'^if\s+.+$', 'if statement'),
    (r'^elif\s+.+$', 'elif clause'),
    (r'^else\s*$', 'else clause'),
    (r'^for\s+.+\s+in\s+.+$', 'for loop'),
    (r'^while\s+.+$', 'while loop'),
    (r'^try\s*$', 'try block'),
    (r'^except(\s+.+)?\s*$', 'except clause'),
    (r'^finally\s*$', 'finally block'),
    (r'^with\s+.+$', 'with statement'),
    (r'^(async\s+)?for\s+.+\s+in\s+.+$', 'async for loop'),
    (r'^(async\s+)?with\s+.+$', 'async with statement'),
]


def _detect_missing_colon(code: str) -> List[HealingFix]:
    """Detect missing colons in Python block statements."""
    fixes = []
    lines = code.split('\n')

    for idx, line in enumerate(lines):
        stripped = line.rstrip()
        if not stripped:
            continue

        lstripped = stripped.lstrip()

        # Skip comments and strings
        if lstripped.startswith('#') or lstripped.startswith('"""') or lstripped.startswith("'''"):
            continue

        # Already has a colon – skip
        if stripped.endswith(':'):
            continue

        # Skip lines ending in a backslash (continuation)
        if stripped.endswith('\\'):
            continue

        for pattern, desc in _PY_BLOCK_PATTERNS:
            if re.match(pattern, lstripped):
                col = len(stripped)
                fixes.append(HealingFix(
                    category=HealingCategory.MISSING_COLON,
                    severity=HealingSeverity.CRITICAL,
                    action=HealingAction.INSERT,
                    description=f'Add missing colon after {desc}',
                    line=idx,
                    column=col,
                    end_line=idx,
                    end_column=col,
                    original_text='',
                    replacement_text=':',
                    confidence=0.95,
                    is_safe=True,
                    affects_logic=False,
                ))
                break

    return fixes


# ── Semicolon patterns ─────────────────────────────────────────────────

# Lines that should NOT get a semicolon
_SEMICOLON_EXEMPT_PATTERNS = [
    r'^\s*$',                          # blank
    r'^\s*//',                         # line comment
    r'^\s*/\*',                        # block comment start
    r'^\s*\*',                         # block comment body
    r'^\s*#',                          # preprocessor / python comment
    r'.*[\{]\s*$',                     # ends with {
    r'.*[\}]\s*;?\s*$',               # ends with } or };
    r'^\s*[\}]',                       # starts with }
    r'^\s*(if|else|for|while|switch|do|try|catch|finally|case|default)\b.*[\{:\(]\s*$',
    r'^\s*(function|class|interface|enum|namespace|module|export)\b',
    r'^\s*import\s',                   # import (handled separately)
    r'^\s*@',                          # decorator
    r'^\s*\*/',                        # block comment end
    r'.*,\s*$',                        # ends with comma (multi-line)
    r'.*\(\s*$',                       # ends with open paren
    r'.*\[\s*$',                       # ends with open bracket
    r'^\s*\)',                         # starts with close paren
    r'^\s*\]',                         # starts with close bracket
    r'.*=>\s*\{?\s*$',                # arrow function
    r'^\s*#(include|define|pragma|ifdef|endif|ifndef|else|elif)',  # C preprocessor
]


def _detect_missing_semicolon(code: str, language: str) -> List[HealingFix]:
    """Detect missing semicolons in C-style languages."""
    fixes = []
    lines = code.split('\n')
    lang = language.lower()

    # Some languages (Go, Swift, Kotlin) have optional semicolons
    # For those we only suggest, not insist
    optional_semi_langs = {'go', 'swift', 'kotlin', 'scala'}
    is_optional = lang in optional_semi_langs

    in_block_comment = False

    for idx, line in enumerate(lines):
        stripped = line.rstrip()
        if not stripped:
            continue

        # Track block comments
        if '/*' in stripped:
            in_block_comment = True
        if '*/' in stripped:
            in_block_comment = False
            continue
        if in_block_comment:
            continue

        # Check exempt patterns
        exempt = False
        for pat in _SEMICOLON_EXEMPT_PATTERNS:
            if re.match(pat, stripped):
                exempt = True
                break
        if exempt:
            continue

        # Already ends with semicolon
        if stripped.endswith(';'):
            continue

        # Check if this looks like a statement that needs a semicolon
        lstripped = stripped.lstrip()

        # Variable declarations, assignments, function calls, return/throw
        statement_patterns = [
            r'^(let|const|var)\s+\w+',       # declarations
            r'^return\s',                      # return
            r'^throw\s',                       # throw
            r'^break\s*$',                     # break
            r'^continue\s*$',                  # continue
            r'^\w+\s*[\+\-\*\/]?=\s*',        # assignment
            r'^\w+[\.\w]*\(.*\)\s*$',          # function call
            r'^(console|document|window)\.',   # common objects
            r'^(this|self|super)\.',           # this/self
            r'^(int|float|double|char|bool|void|auto|string|long|short|unsigned)\s+',  # C/C++ type declarations
            r'^std::\w+',                       # C++ std namespace
            r'^(printf|scanf|puts|gets|malloc|free|sizeof)\s*\(', # C functions
        ]

        needs_semi = False
        for pat in statement_patterns:
            if re.match(pat, lstripped):
                needs_semi = True
                break

        if needs_semi and not is_optional:
            col = len(stripped)
            fixes.append(HealingFix(
                category=HealingCategory.MISSING_SEMICOLON,
                severity=HealingSeverity.MODERATE,
                action=HealingAction.INSERT,
                description='Add missing semicolon',
                line=idx,
                column=col,
                end_line=idx,
                end_column=col,
                original_text='',
                replacement_text=';',
                confidence=0.90,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes


# ── Unified entry point ────────────────────────────────────────────────

@healing_rule(
    rule_id='UNI_TERM_001',
    category=HealingCategory.MISSING_COLON,
    languages={'*'},
    description='Add missing statement terminators (colons for Python, semicolons for C-style languages)',
)
def detect_missing_terminators(code: str, language: str, file_path: str) -> List[HealingFix]:
    """
    Universal rule: detect missing statement terminators.
    Dispatches to colon detection for Python, semicolon detection for C-style.
    """
    lang = language.lower()

    if lang in COLON_LANGUAGES:
        return _detect_missing_colon(code)
    elif lang in SEMICOLON_LANGUAGES:
        return _detect_missing_semicolon(code, lang)
    else:
        # For unknown languages, try semicolon heuristic with lower confidence
        fixes = _detect_missing_semicolon(code, lang)
        for f in fixes:
            f.confidence = max(0.5, f.confidence - 0.2)
        return fixes
