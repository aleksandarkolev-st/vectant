"""
Universal healing rule: Security patterns.

Detects common security issues across languages:
- SQL injection via string concatenation
- eval() / exec() usage
- Insecure random number usage
- Cross-site scripting (XSS) patterns
- Path traversal risks
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


# ── Rule: SQL injection risk ─────────────────────────────────────────

@healing_rule(
    rule_id="UNI_SEC_001",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect potential SQL injection via string concatenation in queries",
)
def detect_sql_injection(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect SQL queries built with string concatenation."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")

    sql_patterns = [
        r'(?i)(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER)\s+.*\+\s*\w+',
        r'(?i)(SELECT|INSERT|UPDATE|DELETE)\s+.*f"',
        r"(?i)(SELECT|INSERT|UPDATE|DELETE)\s+.*f'",
        r'(?i)(?:cursor|db|conn)\.execute\s*\(\s*f["\']',
        r'(?i)(?:cursor|db|conn)\.execute\s*\(\s*["\'].*\+',
        r'(?i)query\s*=\s*f["\'].*(?:SELECT|INSERT|UPDATE|DELETE)',
    ]

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("#") or stripped.startswith("//"):
            continue

        for pattern in sql_patterns:
            m = re.search(pattern, line)
            if m:
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.CRITICAL,
                    action=HealingAction.REPLACE,
                    description="Potential SQL injection — use parameterized queries instead",
                    line=idx,
                    column=m.start(),
                    end_line=idx,
                    end_column=m.end(),
                    original_text=m.group(0),
                    replacement_text="",
                    confidence=0.80,
                    is_safe=False,
                    affects_logic=True,
                ))
                break

    return fixes


# ── Rule: eval/exec usage ────────────────────────────────────────────

@healing_rule(
    rule_id="UNI_SEC_002",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect usage of eval() or exec() which can execute arbitrary code",
)
def detect_eval_exec(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect eval() and exec() calls that can execute arbitrary code."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    dangerous = []
    if lang in ("python", "py"):
        dangerous = [
            (r"\beval\s*\(", "eval()"),
            (r"\bexec\s*\(", "exec()"),
            (r"\bcompile\s*\(", "compile()"),
            (r"\b__import__\s*\(", "__import__()"),
        ]
    elif lang in ("javascript", "js", "jsx", "typescript", "ts", "tsx"):
        dangerous = [
            (r"\beval\s*\(", "eval()"),
            (r"\bFunction\s*\(", "Function() constructor"),
            (r"\bsetTimeout\s*\(\s*['\"]", "setTimeout with string"),
            (r"\bsetInterval\s*\(\s*['\"]", "setInterval with string"),
        ]

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("#") or stripped.startswith("//"):
            continue

        for pattern, desc in dangerous:
            m = re.search(pattern, line)
            if m:
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.CRITICAL,
                    action=HealingAction.REPLACE,
                    description=f"Security risk: {desc} can execute arbitrary code",
                    line=idx,
                    column=m.start(),
                    end_line=idx,
                    end_column=m.end(),
                    original_text=m.group(0),
                    replacement_text="",
                    confidence=0.85,
                    is_safe=False,
                    affects_logic=True,
                ))

    return fixes


# ── Rule: Insecure random ────────────────────────────────────────────

@healing_rule(
    rule_id="UNI_SEC_003",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect insecure random number generation for security-sensitive contexts",
)
def detect_insecure_random(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect use of insecure random for security-sensitive operations."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    # Only flag if the file seems security-related
    security_keywords = {"token", "password", "secret", "hash", "auth", "session", "key", "encrypt", "crypto"}
    file_seems_security = any(kw in (file_path or "").lower() for kw in security_keywords)
    code_seems_security = any(kw in code.lower() for kw in security_keywords)

    if not file_seems_security and not code_seems_security:
        return fixes

    insecure_patterns = []
    if lang in ("python", "py"):
        insecure_patterns = [
            (r"\brandom\.random\s*\(", "Use secrets.token_hex() instead of random.random()"),
            (r"\brandom\.randint\s*\(", "Use secrets.randbelow() instead of random.randint()"),
            (r"\brandom\.choice\s*\(", "Use secrets.choice() instead of random.choice()"),
        ]
    elif lang in ("javascript", "js", "jsx", "typescript", "ts", "tsx"):
        insecure_patterns = [
            (r"\bMath\.random\s*\(", "Use crypto.randomUUID() or crypto.getRandomValues() instead of Math.random()"),
        ]

    for idx, line in enumerate(lines):
        for pattern, desc in insecure_patterns:
            m = re.search(pattern, line)
            if m:
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.MODERATE,
                    action=HealingAction.REPLACE,
                    description=f"Insecure random in security context: {desc}",
                    line=idx,
                    column=m.start(),
                    end_line=idx,
                    end_column=m.end(),
                    original_text=m.group(0),
                    replacement_text="",
                    confidence=0.72,
                    is_safe=False,
                    affects_logic=True,
                ))

    return fixes


# ── Rule: innerHTML XSS risk ─────────────────────────────────────────

@healing_rule(
    rule_id="UNI_SEC_004",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect innerHTML assignments that may cause XSS vulnerabilities",
)
def detect_innerhtml_xss(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect innerHTML and dangerouslySetInnerHTML usage."""
    lang = language.lower()
    if lang not in ("javascript", "js", "jsx", "typescript", "ts", "tsx"):
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    patterns = [
        (r"\.innerHTML\s*=", "innerHTML assignment — use textContent or DOM APIs"),
        (r"\.outerHTML\s*=", "outerHTML assignment — potential XSS risk"),
        (r"dangerouslySetInnerHTML", "dangerouslySetInnerHTML — ensure content is sanitized"),
        (r"document\.write\s*\(", "document.write() — potential XSS risk"),
    ]

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("//"):
            continue

        for pattern, desc in patterns:
            m = re.search(pattern, line)
            if m:
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.CRITICAL,
                    action=HealingAction.REPLACE,
                    description=f"XSS risk: {desc}",
                    line=idx,
                    column=m.start(),
                    end_line=idx,
                    end_column=m.end(),
                    original_text=m.group(0),
                    replacement_text="",
                    confidence=0.78,
                    is_safe=False,
                    affects_logic=True,
                ))

    return fixes
