"""
Universal healing rule: Logging and debugging.

Detects common logging/debugging issues:
- Console.log / print statements left in production code
- Debug flags still enabled
- Hardcoded credentials or secrets
- TODO/FIXME in production paths
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


# ── Language sets ──────────────────────────────────────────────────────

_PY_LANGS = {"python", "py"}
_JS_LANGS = {"javascript", "js", "jsx", "typescript", "ts", "tsx"}


# ── Rule: Debug print/log statements ─────────────────────────────────

@healing_rule(
    rule_id="UNI_LOG_001",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect debug print/console.log statements that may be left in code",
)
def detect_debug_statements(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect debug print/log statements left in code."""
    fixes: List[HealingFix] = []
    lang = language.lower()
    lines = code.split("\n")

    # Patterns per language
    debug_patterns = []

    if lang in _PY_LANGS:
        debug_patterns = [
            (r"^\s*print\s*\(", "print() statement"),
            (r"^\s*pprint\s*\(", "pprint() statement"),
            (r"^\s*breakpoint\s*\(", "breakpoint() statement"),
            (r"^\s*import\s+pdb", "pdb import"),
            (r"^\s*pdb\.set_trace\s*\(", "pdb.set_trace() call"),
            (r"^\s*import\s+ipdb", "ipdb import"),
            (r"^\s*ipdb\.set_trace\s*\(", "ipdb.set_trace() call"),
        ]
    elif lang in _JS_LANGS:
        debug_patterns = [
            (r"^\s*console\.log\s*\(", "console.log() statement"),
            (r"^\s*console\.debug\s*\(", "console.debug() statement"),
            (r"^\s*console\.info\s*\(", "console.info() statement"),
            (r"^\s*console\.warn\s*\(", "console.warn() statement"),
            (r"^\s*console\.dir\s*\(", "console.dir() statement"),
            (r"^\s*console\.table\s*\(", "console.table() statement"),
            (r"^\s*console\.trace\s*\(", "console.trace() statement"),
            (r"^\s*debugger\s*;?\s*$", "debugger statement"),
            (r"^\s*alert\s*\(", "alert() call"),
        ]
    elif lang in {"c", "cpp", "c++", "cxx"}:
        debug_patterns = [
            (r'^\s*printf\s*\(\s*"debug', "printf debug statement"),
            (r'^\s*fprintf\s*\(\s*stderr', "stderr debug output"),
        ]
    elif lang in {"java"}:
        debug_patterns = [
            (r"^\s*System\.out\.print", "System.out.print statement"),
            (r"^\s*System\.err\.print", "System.err.print statement"),
        ]
    elif lang in {"go"}:
        debug_patterns = [
            (r"^\s*fmt\.Print", "fmt.Print statement"),
            (r"^\s*log\.Print", "log.Print statement"),
        ]
    elif lang in {"rust", "rs"}:
        debug_patterns = [
            (r"^\s*println!\s*\(", "println! macro"),
            (r"^\s*dbg!\s*\(", "dbg! macro"),
            (r"^\s*eprintln!\s*\(", "eprintln! macro"),
        ]
    else:
        return fixes

    for idx, line in enumerate(lines):
        for pattern, desc in debug_patterns:
            if re.match(pattern, line):
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.DELETE,
                    description=f"Debug {desc} — consider removing before production",
                    line=idx,
                    column=0,
                    end_line=idx,
                    end_column=len(line),
                    original_text=line.strip(),
                    replacement_text="",
                    confidence=0.65,
                    is_safe=False,
                    affects_logic=False,
                ))

    return fixes


# ── Rule: Hardcoded secrets ───────────────────────────────────────────

@healing_rule(
    rule_id="UNI_LOG_002",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect potential hardcoded secrets, API keys, or passwords",
)
def detect_hardcoded_secrets(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect potential hardcoded credentials and secrets."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")

    # Patterns that suggest hardcoded secrets
    secret_patterns = [
        (r'(?i)(password|passwd|pwd)\s*=\s*["\'][^"\']{3,}["\']', "Hardcoded password"),
        (r'(?i)(api_?key|apikey|api_?secret)\s*=\s*["\'][^"\']{8,}["\']', "Hardcoded API key"),
        (r'(?i)(secret_?key|private_?key)\s*=\s*["\'][^"\']{8,}["\']', "Hardcoded secret key"),
        (r'(?i)(token|auth_?token|access_?token)\s*=\s*["\'][^"\']{8,}["\']', "Hardcoded token"),
        (r'(?i)(db_?password|database_?password)\s*=\s*["\'][^"\']{3,}["\']', "Hardcoded database password"),
        (r'(?i)Bearer\s+[A-Za-z0-9\-_.]{20,}', "Hardcoded Bearer token"),
    ]

    for idx, line in enumerate(lines):
        stripped = line.strip()
        # Skip comments
        if stripped.startswith("#") or stripped.startswith("//") or stripped.startswith("/*"):
            continue
        # Skip environment variable patterns (those are OK)
        if "os.environ" in line or "process.env" in line or "getenv" in line:
            continue
        # Skip .env example files
        if file_path and (".env.example" in file_path or ".env.sample" in file_path):
            continue

        for pattern, desc in secret_patterns:
            m = re.search(pattern, line)
            if m:
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.CRITICAL,
                    action=HealingAction.REPLACE,
                    description=f"{desc} detected — use environment variables instead",
                    line=idx,
                    column=m.start(),
                    end_line=idx,
                    end_column=m.end(),
                    original_text=m.group(0),
                    replacement_text="",
                    confidence=0.75,
                    is_safe=False,
                    affects_logic=True,
                ))

    return fixes


# ── Rule: Debug flags ────────────────────────────────────────────────

@healing_rule(
    rule_id="UNI_LOG_003",
    category=HealingCategory.UNUSED_VARIABLE,
    description="Detect debug flags/constants left enabled",
)
def detect_debug_flags(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Detect debug flags that are still set to True/true."""
    fixes: List[HealingFix] = []
    lines = code.split("\n")

    # Common debug flag patterns
    flag_patterns = [
        r"(?i)\bDEBUG\s*=\s*(?:True|true|1)\b",
        r"(?i)\bVERBOSE\s*=\s*(?:True|true|1)\b",
        r"(?i)\bDEV_MODE\s*=\s*(?:True|true|1)\b",
        r"(?i)\bTEST_MODE\s*=\s*(?:True|true|1)\b",
        r"(?i)\bDEBUG_MODE\s*=\s*(?:True|true|1)\b",
    ]

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("#") or stripped.startswith("//"):
            continue

        for pattern in flag_patterns:
            m = re.search(pattern, line)
            if m:
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_VARIABLE,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.REPLACE,
                    description=f"Debug flag enabled — ensure this is disabled for production",
                    line=idx,
                    column=m.start(),
                    end_line=idx,
                    end_column=m.end(),
                    original_text=m.group(0),
                    replacement_text="",
                    confidence=0.55,
                    is_safe=False,
                    affects_logic=True,
                ))

    return fixes
