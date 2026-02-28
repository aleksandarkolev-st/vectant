"""
AI context collector.

Gathers contextual information for the AI agent:
- Import/require statements from the target file
- Related files (same directory, shared imports)
- Project structure hints (package.json, Cargo.toml, etc.)
- Surrounding code context for focused analysis

This extra context lets the LLM make better detection decisions.
"""

from __future__ import annotations

import os
import re
import logging
from typing import Any, Dict, List, Optional, Tuple
from dataclasses import dataclass, field
from pathlib import PurePosixPath

logger = logging.getLogger("healing.ai_context")

# ── Max sizes to keep token usage reasonable ──────────────────────────

MAX_CONTEXT_FILES = 5
MAX_FILE_CHARS = 8_000       # ~2k tokens per related file
MAX_TOTAL_CHARS = 40_000     # ~10k tokens total context budget
MAX_IMPORT_DEPTH = 1         # Only resolve first-level imports


# ── Data classes ──────────────────────────────────────────────────────

@dataclass
class FileContext:
    """Context for a single related file."""
    path: str
    content: str
    relation: str           # "import", "same_dir", "test_pair"
    relevance: float = 0.5  # 0..1, higher = more relevant


@dataclass
class AnalysisContext:
    """Full context bundle for AI analysis."""
    file_path: str
    source_code: str
    language: str
    imports: List[str] = field(default_factory=list)
    related_files: List[FileContext] = field(default_factory=list)
    project_hints: Dict[str, Any] = field(default_factory=dict)
    focus_range: Optional[Tuple[int, int]] = None  # (start_line, end_line)
    context_notes: List[str] = field(default_factory=list)


# ── Import extraction ─────────────────────────────────────────────────

_IMPORT_PATTERNS = {
    "python": [
        re.compile(r"^\s*import\s+([\w.]+)", re.MULTILINE),
        re.compile(r"^\s*from\s+([\w.]+)\s+import", re.MULTILINE),
    ],
    "javascript": [
        re.compile(r"""^\s*import\s+.*?from\s+['"]([^'"]+)['"]""", re.MULTILINE),
        re.compile(r"""^\s*const\s+.*?=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)""", re.MULTILINE),
        re.compile(r"""^\s*import\s*\(\s*['"]([^'"]+)['"]\s*\)""", re.MULTILINE),
    ],
    "typescript": [
        re.compile(r"""^\s*import\s+.*?from\s+['"]([^'"]+)['"]""", re.MULTILINE),
        re.compile(r"""^\s*const\s+.*?=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)""", re.MULTILINE),
    ],
    "rust": [
        re.compile(r"^\s*use\s+([\w:]+)", re.MULTILINE),
        re.compile(r"^\s*extern\s+crate\s+(\w+)", re.MULTILINE),
    ],
    "go": [
        re.compile(r"""^\s*"([^"]+)"\s*$""", re.MULTILINE),
    ],
    "java": [
        re.compile(r"^\s*import\s+([\w.]+)", re.MULTILINE),
    ],
    "csharp": [
        re.compile(r"^\s*using\s+([\w.]+)\s*;", re.MULTILINE),
    ],
}

# Map file extensions to language keys
_EXT_TO_LANG = {
    ".py": "python",
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".rs": "rust",
    ".go": "go",
    ".java": "java",
    ".cs": "csharp",
    ".kt": "java",       # Kotlin uses Java-style imports
    ".scala": "java",
}


def extract_imports(source: str, language: str) -> List[str]:
    """Extract import/require paths from source code."""
    lang_key = language.lower()
    patterns = _IMPORT_PATTERNS.get(lang_key, [])

    imports = []
    for pat in patterns:
        for match in pat.finditer(source):
            imports.append(match.group(1))

    return imports


def detect_language(file_path: str) -> str:
    """Detect language from file extension."""
    ext = os.path.splitext(file_path)[1].lower()
    return _EXT_TO_LANG.get(ext, "unknown")


# ── Related file discovery ────────────────────────────────────────────

def _resolve_import_path(
    import_path: str,
    file_path: str,
    workspace_root: str,
) -> Optional[str]:
    """
    Try to resolve an import path to an actual file.
    Returns the absolute path if found, else None.
    """
    file_dir = os.path.dirname(file_path)

    # Relative imports
    if import_path.startswith("."):
        candidates = _generate_candidates(os.path.join(file_dir, import_path))
        for c in candidates:
            if os.path.isfile(c):
                return os.path.normpath(c)

    # Non-relative: try as relative to workspace
    candidates = _generate_candidates(os.path.join(workspace_root, import_path))
    for c in candidates:
        if os.path.isfile(c):
            return os.path.normpath(c)

    return None


def _generate_candidates(base: str) -> List[str]:
    """Generate candidate file paths with common extensions."""
    if os.path.isfile(base):
        return [base]

    extensions = [".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go"]
    index_files = ["index.ts", "index.tsx", "index.js", "index.jsx"]

    candidates = []
    for ext in extensions:
        candidates.append(base + ext)
    for idx in index_files:
        candidates.append(os.path.join(base, idx))

    return candidates


def find_same_dir_files(
    file_path: str,
    language: str,
    max_files: int = 3,
) -> List[str]:
    """Find related files in the same directory."""
    file_dir = os.path.dirname(file_path)
    file_name = os.path.basename(file_path)
    file_ext = os.path.splitext(file_path)[1]

    if not os.path.isdir(file_dir):
        return []

    related = []
    try:
        entries = os.listdir(file_dir)
    except OSError:
        return []

    for entry in sorted(entries):
        if entry == file_name:
            continue
        entry_ext = os.path.splitext(entry)[1]
        if entry_ext == file_ext:
            full = os.path.join(file_dir, entry)
            if os.path.isfile(full):
                related.append(full)
                if len(related) >= max_files:
                    break

    return related


def find_test_pair(file_path: str) -> Optional[str]:
    """
    Find the test file for a source file, or vice versa.
    E.g. foo.py <-> test_foo.py, foo.ts <-> foo.test.ts
    """
    dir_path = os.path.dirname(file_path)
    name = os.path.basename(file_path)
    stem, ext = os.path.splitext(name)

    candidates = []

    # Python convention
    if stem.startswith("test_"):
        candidates.append(os.path.join(dir_path, stem[5:] + ext))
    else:
        candidates.append(os.path.join(dir_path, "test_" + name))

    # JS/TS convention
    if ".test." in name or ".spec." in name:
        clean = name.replace(".test.", ".").replace(".spec.", ".")
        candidates.append(os.path.join(dir_path, clean))
    else:
        candidates.append(os.path.join(dir_path, stem + ".test" + ext))
        candidates.append(os.path.join(dir_path, stem + ".spec" + ext))

    # Check __tests__ directory
    tests_dir = os.path.join(dir_path, "__tests__")
    candidates.append(os.path.join(tests_dir, name))

    for c in candidates:
        if os.path.isfile(c):
            return c

    return None


# ── Project hints ─────────────────────────────────────────────────────

def collect_project_hints(workspace_root: str) -> Dict[str, Any]:
    """
    Collect project-level hints: framework, runtime, etc.
    Just checks for existence of config files, doesn't parse them.
    """
    hints: Dict[str, Any] = {}

    config_signals = {
        "package.json": "node",
        "tsconfig.json": "typescript",
        "next.config.mjs": "nextjs",
        "next.config.js": "nextjs",
        "vite.config.ts": "vite",
        "vite.config.js": "vite",
        "Cargo.toml": "rust",
        "go.mod": "go",
        "requirements.txt": "python",
        "pyproject.toml": "python",
        "setup.py": "python",
        "pom.xml": "java_maven",
        "build.gradle": "java_gradle",
        ".eslintrc": "eslint",
        "eslint.config.mjs": "eslint",
        ".prettierrc": "prettier",
    }

    detected = []
    for filename, signal in config_signals.items():
        if os.path.exists(os.path.join(workspace_root, filename)):
            detected.append(signal)

    hints["frameworks"] = list(set(detected))
    return hints


# ── Main context builder ─────────────────────────────────────────────

def collect_context(
    file_path: str,
    source_code: str,
    language: Optional[str] = None,
    workspace_root: Optional[str] = None,
    focus_range: Optional[Tuple[int, int]] = None,
    read_file_fn=None,
) -> AnalysisContext:
    """
    Build a full AnalysisContext for AI analysis.

    Args:
        file_path: Absolute path to the file being analyzed
        source_code: Current source code of the file
        language: Language identifier (auto-detected if None)
        workspace_root: Project root directory
        focus_range: Optional (start_line, end_line) to focus on
        read_file_fn: Optional callable(path) -> str for reading files
    """
    if language is None:
        language = detect_language(file_path)

    if workspace_root is None:
        # Best-effort: go up until we find a config file
        workspace_root = _guess_workspace_root(file_path)

    ctx = AnalysisContext(
        file_path=file_path,
        source_code=source_code,
        language=language,
        focus_range=focus_range,
    )

    # 1. Extract imports
    ctx.imports = extract_imports(source_code, language)
    if ctx.imports:
        ctx.context_notes.append(
            f"File imports {len(ctx.imports)} module(s)"
        )

    # 2. Collect project hints
    if workspace_root:
        ctx.project_hints = collect_project_hints(workspace_root)

    # 3. Resolve imported files
    total_chars = 0
    if workspace_root and read_file_fn:
        for imp in ctx.imports[:MAX_CONTEXT_FILES]:
            resolved = _resolve_import_path(imp, file_path, workspace_root)
            if resolved and total_chars < MAX_TOTAL_CHARS:
                try:
                    content = read_file_fn(resolved)
                    truncated = content[:MAX_FILE_CHARS]
                    total_chars += len(truncated)
                    ctx.related_files.append(FileContext(
                        path=resolved,
                        content=truncated,
                        relation="import",
                        relevance=0.8,
                    ))
                except Exception:
                    pass

    # 4. Same-directory files (lower priority)
    remaining_slots = MAX_CONTEXT_FILES - len(ctx.related_files)
    if remaining_slots > 0 and read_file_fn:
        same_dir = find_same_dir_files(file_path, language, max_files=remaining_slots)
        for sd in same_dir:
            if total_chars >= MAX_TOTAL_CHARS:
                break
            existing_paths = {f.path for f in ctx.related_files}
            if sd not in existing_paths:
                try:
                    content = read_file_fn(sd)
                    truncated = content[:MAX_FILE_CHARS]
                    total_chars += len(truncated)
                    ctx.related_files.append(FileContext(
                        path=sd,
                        content=truncated,
                        relation="same_dir",
                        relevance=0.4,
                    ))
                except Exception:
                    pass

    # 5. Test pair
    test_file = find_test_pair(file_path)
    if test_file and read_file_fn:
        existing_paths = {f.path for f in ctx.related_files}
        if test_file not in existing_paths and total_chars < MAX_TOTAL_CHARS:
            try:
                content = read_file_fn(test_file)
                truncated = content[:MAX_FILE_CHARS]
                ctx.related_files.append(FileContext(
                    path=test_file,
                    content=truncated,
                    relation="test_pair",
                    relevance=0.6,
                ))
            except Exception:
                pass

    # 6. Add context notes
    if focus_range:
        ctx.context_notes.append(
            f"Focus on lines {focus_range[0]}-{focus_range[1]}"
        )
    if ctx.related_files:
        ctx.context_notes.append(
            f"{len(ctx.related_files)} related files included for context"
        )

    return ctx


def _guess_workspace_root(file_path: str) -> str:
    """Walk up from file_path until we find a project marker."""
    markers = [
        "package.json", "pyproject.toml", "Cargo.toml",
        "go.mod", ".git", "requirements.txt",
    ]
    current = os.path.dirname(os.path.abspath(file_path))
    for _ in range(10):  # max 10 levels up
        for marker in markers:
            if os.path.exists(os.path.join(current, marker)):
                return current
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    return os.path.dirname(file_path)
