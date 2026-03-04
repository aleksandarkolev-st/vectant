"""
Universal healing rule: Deprecated / legacy API usage.

Detects:
- Deprecated built-in usage (Python 2 relics, old JS APIs)
- Legacy patterns that have modern replacements
- Removed/sunset APIs
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


_PY_LANGS = {"python", "py"}
_JS_LANGS = {"javascript", "js", "jsx", "typescript", "ts", "tsx"}


# ── Data tables ───────────────────────────────────────────────────────

_PY_DEPRECATED = [
    (r"\bprint\s*>>", "print >>stream", "print(..., file=stream)"),
    (r"\bhas_key\s*\(", "dict.has_key()", "'key in dict'"),
    (r"\braw_input\s*\(", "raw_input()", "input()"),
    (r"\bexecfile\s*\(", "execfile()", "exec(open(...).read())"),
    (r"\burllib2\.", "urllib2", "urllib.request"),
    (r"\burllib\.urlopen\b", "urllib.urlopen", "urllib.request.urlopen"),
    (r"\bos\.popen\s*\(", "os.popen()", "subprocess.run()"),
    (r"\bos\.system\s*\(", "os.system()", "subprocess.run()"),
    (r"from\s+collections\s+import\s+.*\bMutableMapping\b",
     "collections.MutableMapping", "collections.abc.MutableMapping"),
    (r"\bimport\s+imp\b", "imp module", "importlib"),
    (r"\boptparse\b", "optparse", "argparse"),
]

_JS_DEPRECATED = [
    (r"\bdocument\.write\s*\(", "document.write()", "DOM manipulation"),
    (r"\b__proto__\b", "__proto__", "Object.getPrototypeOf()"),
    (r"\barguments\b", "arguments object", "rest parameters (...args)"),
    (r"\bvar\s+", "var keyword", "let/const"),
    (r"new\s+Boolean\(", "new Boolean()", "Boolean literal"),
    (r"new\s+Number\(", "new Number()", "Number literal"),
    (r"new\s+String\(", "new String()", "String literal"),
    (r"\.substr\s*\(", ".substr()", ".slice() or .substring()"),
    (r"\bescape\s*\(", "escape()", "encodeURIComponent()"),
    (r"\bunescape\s*\(", "unescape()", "decodeURIComponent()"),
]


# ── Rule: Deprecated Python APIs ──────────────────────────────────────

@healing_rule(
    rule_id="UNI_DEP_001",
    category=HealingCategory.UNUSED_IMPORT,
    description="Detect deprecated or legacy Python API usage",
)
def detect_deprecated_python(code: str, language: str, file_path: str) -> List[HealingFix]:
    lang = language.lower()
    if lang not in _PY_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        for pattern, old_name, replacement in _PY_DEPRECATED:
            if re.search(pattern, line):
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_IMPORT,
                    severity=HealingSeverity.MODERATE,
                    action=HealingAction.REPLACE,
                    description=f"'{old_name}' is deprecated — use {replacement}",
                    line=idx,
                    column=0,
                    end_line=idx,
                    end_column=len(line),
                    original_text="",
                    replacement_text="",
                    confidence=0.80,
                    is_safe=False,
                    affects_logic=False,
                ))
                break  # one warning per line

    return fixes


# ── Rule: Deprecated JS / TS APIs ─────────────────────────────────────

@healing_rule(
    rule_id="UNI_DEP_002",
    category=HealingCategory.UNUSED_IMPORT,
    description="Detect deprecated or legacy JavaScript/TypeScript API usage",
)
def detect_deprecated_js(code: str, language: str, file_path: str) -> List[HealingFix]:
    lang = language.lower()
    if lang not in _JS_LANGS:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    in_comment = False
    for idx, line in enumerate(lines):
        stripped = line.strip()

        if "/*" in stripped:
            in_comment = True
        if "*/" in stripped:
            in_comment = False
            continue
        if in_comment or stripped.startswith("//"):
            continue

        for pattern, old_name, replacement in _JS_DEPRECATED:
            if re.search(pattern, line):
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_IMPORT,
                    severity=HealingSeverity.MODERATE,
                    action=HealingAction.REPLACE,
                    description=f"'{old_name}' is deprecated — use {replacement}",
                    line=idx,
                    column=0,
                    end_line=idx,
                    end_column=len(line),
                    original_text="",
                    replacement_text="",
                    confidence=0.78,
                    is_safe=False,
                    affects_logic=False,
                ))
                break

    return fixes


# ── Rule: Deprecated CSS / HTML patterns ──────────────────────────────

@healing_rule(
    rule_id="UNI_DEP_003",
    category=HealingCategory.UNUSED_IMPORT,
    description="Detect deprecated HTML/CSS patterns",
)
def detect_deprecated_markup(code: str, language: str, file_path: str) -> List[HealingFix]:
    lang = language.lower()
    if lang not in {"html", "css", "scss", "less", "vue", "svelte"}:
        return []

    fixes: List[HealingFix] = []
    lines = code.split("\n")

    deprecated_html = [
        (r"<\s*center\b", "<center>", "CSS text-align:center"),
        (r"<\s*font\b", "<font>", "CSS font-family/font-size"),
        (r"<\s*marquee\b", "<marquee>", "CSS animation"),
        (r"<\s*blink\b", "<blink>", "CSS animation"),
        (r'\balign\s*=\s*["\']', "align attribute", "CSS text-align"),
        (r'\bbgcolor\s*=\s*["\']', "bgcolor attribute", "CSS background-color"),
    ]

    for idx, line in enumerate(lines):
        for pattern, old_name, replacement in deprecated_html:
            if re.search(pattern, line, re.IGNORECASE):
                fixes.append(HealingFix(
                    category=HealingCategory.UNUSED_IMPORT,
                    severity=HealingSeverity.LOW,
                    action=HealingAction.REPLACE,
                    description=f"'{old_name}' is deprecated — use {replacement}",
                    line=idx,
                    column=0,
                    end_line=idx,
                    end_column=len(line),
                    original_text="",
                    replacement_text="",
                    confidence=0.85,
                    is_safe=True,
                    affects_logic=False,
                ))
                break

    return fixes
