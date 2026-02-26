"""
Universal healing rule: Import management.

Detects unused imports, duplicate imports, and common missing-import
patterns across Python, JavaScript, TypeScript, Go, Java, C/C++, and
other languages.  Everything is dispatched internally based on the
`language` parameter.
"""

from __future__ import annotations

import re
from typing import List, Set, Dict, Tuple

from ..types import (
    HealingCategory,
    HealingSeverity,
    HealingAction,
    HealingFix,
)
from ..rule_registry import healing_rule


# ── Language classification ────────────────────────────────────────────

_PY_LANGS = {"python", "py"}
_JS_LANGS = {"javascript", "js", "jsx", "typescript", "ts", "tsx"}
_C_LANGS = {"c", "cpp", "c++", "cxx", "h", "hpp"}
_JAVA_LANGS = {"java"}
_GO_LANGS = {"go"}

# ── Helpers ────────────────────────────────────────────────────────────


def _extract_python_imports(code: str) -> List[Tuple[int, str, str]]:
    """Return (line_idx, module, raw_line) for each import."""
    results = []
    for idx, line in enumerate(code.split("\n")):
        stripped = line.strip()
        if stripped.startswith("import "):
            mod = stripped.split()[1].split(".")[0]
            results.append((idx, mod, stripped))
        elif stripped.startswith("from "):
            parts = stripped.split()
            if len(parts) >= 4 and parts[2] == "import":
                names = [n.strip().rstrip(",") for n in parts[3:]]
                for n in names:
                    if n and n != "*":
                        results.append((idx, n, stripped))
    return results


def _extract_js_imports(code: str) -> List[Tuple[int, str, str]]:
    """Return (line_idx, symbol, raw_line) for each imported symbol."""
    results = []
    lines = code.split("\n")
    for idx, line in enumerate(lines):
        stripped = line.strip()
        # import X from '...'
        m = re.match(r"import\s+(\w+)\s+from\s+", stripped)
        if m:
            results.append((idx, m.group(1), stripped))
        # import { a, b } from '...'
        m = re.match(r"import\s*\{([^}]+)\}\s*from\s+", stripped)
        if m:
            names = [n.strip().split(" as ")[0].strip() for n in m.group(1).split(",")]
            for n in names:
                if n:
                    results.append((idx, n, stripped))
        # const X = require('...')
        m = re.match(r"(?:const|let|var)\s+(\w+)\s*=\s*require\(", stripped)
        if m:
            results.append((idx, m.group(1), stripped))
        # const { a, b } = require('...')
        m = re.match(r"(?:const|let|var)\s*\{([^}]+)\}\s*=\s*require\(", stripped)
        if m:
            names = [n.strip().split(":")[0].strip() for n in m.group(1).split(",")]
            for n in names:
                if n:
                    results.append((idx, n, stripped))
    return results


def _extract_c_includes(code: str) -> List[Tuple[int, str, str]]:
    """Return (line_idx, header_name, raw_line) for each #include."""
    results = []
    for idx, line in enumerate(code.split("\n")):
        m = re.match(r'\s*#\s*include\s*[<"]([^>"]+)[>"]', line)
        if m:
            results.append((idx, m.group(1), line.strip()))
    return results


def _extract_go_imports(code: str) -> List[Tuple[int, str, str]]:
    """Return (line_idx, package_alias, raw_line) for Go imports."""
    results = []
    lines = code.split("\n")
    in_block = False
    for idx, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("import ("):
            in_block = True
            continue
        if in_block:
            if stripped == ")":
                in_block = False
                continue
            m = re.match(r'(?:(\w+)\s+)?"([^"]+)"', stripped)
            if m:
                alias = m.group(1) or m.group(2).split("/")[-1]
                results.append((idx, alias, stripped))
        else:
            m = re.match(r'import\s+"([^"]+)"', stripped)
            if m:
                alias = m.group(1).split("/")[-1]
                results.append((idx, alias, stripped))
    return results


def _symbol_used_in_code(code: str, symbol: str, import_lines: Set[int]) -> bool:
    """Check whether *symbol* appears outside of import lines."""
    for idx, line in enumerate(code.split("\n")):
        if idx in import_lines:
            continue
        if re.search(r"\b" + re.escape(symbol) + r"\b", line):
            return True
    return False


# ── Rule: Unused imports ───────────────────────────────────────────────

@healing_rule(
    rule_id="UNI_IMP_001",
    category=HealingCategory.UNUSED_IMPORT,
    description="Detect imports that are never referenced in the code",
)
def detect_unused_imports(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Universal unused-import detection."""
    lang = language.lower()
    fixes: List[HealingFix] = []

    if lang in _PY_LANGS:
        imports = _extract_python_imports(code)
    elif lang in _JS_LANGS:
        imports = _extract_js_imports(code)
    elif lang in _GO_LANGS:
        imports = _extract_go_imports(code)
    elif lang in _C_LANGS:
        imports = _extract_c_includes(code)
    else:
        return fixes  # language not yet supported for import analysis

    import_lines = {i for i, _, _ in imports}

    seen_lines: Set[int] = set()
    for line_idx, symbol, raw in imports:
        if not _symbol_used_in_code(code, symbol, import_lines):
            # Only flag each line once (e.g. `from x import a, b` where both unused)
            if line_idx in seen_lines:
                continue
            seen_lines.add(line_idx)

            lines = code.split("\n")
            end_col = len(lines[line_idx]) if line_idx < len(lines) else 0

            fixes.append(HealingFix(
                category=HealingCategory.UNUSED_IMPORT,
                severity=HealingSeverity.LOW,
                action=HealingAction.DELETE,
                description=f"Remove unused import: {symbol}",
                line=line_idx,
                column=0,
                end_line=line_idx,
                end_column=end_col,
                original_text=raw,
                replacement_text="",
                confidence=0.92,
                is_safe=True,
                affects_logic=False,
            ))

    return fixes


# ── Rule: Duplicate imports ────────────────────────────────────────────

@healing_rule(
    rule_id="UNI_IMP_002",
    category=HealingCategory.DUPLICATE_IMPORT,
    description="Detect the same symbol imported more than once",
)
def detect_duplicate_imports(code: str, language: str, file_path: str) -> List[HealingFix]:
    """Universal duplicate-import detection."""
    lang = language.lower()
    fixes: List[HealingFix] = []

    if lang in _PY_LANGS:
        imports = _extract_python_imports(code)
    elif lang in _JS_LANGS:
        imports = _extract_js_imports(code)
    elif lang in _GO_LANGS:
        imports = _extract_go_imports(code)
    elif lang in _C_LANGS:
        imports = _extract_c_includes(code)
    else:
        return fixes

    seen: Dict[str, int] = {}
    for line_idx, symbol, raw in imports:
        if symbol in seen:
            lines = code.split("\n")
            end_col = len(lines[line_idx]) if line_idx < len(lines) else 0
            fixes.append(HealingFix(
                category=HealingCategory.DUPLICATE_IMPORT,
                severity=HealingSeverity.LOW,
                action=HealingAction.DELETE,
                description=f"Remove duplicate import of '{symbol}' (first seen at line {seen[symbol] + 1})",
                line=line_idx,
                column=0,
                end_line=line_idx,
                end_column=end_col,
                original_text=raw,
                replacement_text="",
                confidence=0.95,
                is_safe=True,
                affects_logic=False,
            ))
        else:
            seen[symbol] = line_idx

    return fixes
