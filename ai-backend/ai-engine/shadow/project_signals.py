"""Project signal detection for Critic-Critic calibration. Master plan §6.3.

The Critic-Critic uses these signals to decide whether a non-executable
attack is *actionable for this codebase* or pedantic (e.g. "add retries
to the network call" is pedantic in a hobby script, actionable in a
high-availability service).

Detection is intentionally cheap and best-effort. It runs once per
universe at the worktree-acquire step, walks a bounded number of files,
and never blocks the universe — missing/unknown signals fall through to
sensible defaults so the Critic-Critic still has something to work with.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger("shadow.project_signals")

# Bound the walk so a 100k-file monorepo doesn't slow the universe.
_MAX_FILES_SCANNED = 4000
_PROJECT_TYPE_HINTS = {
    "web-app":    {"next.config.js", "next.config.mjs", "vite.config.ts",
                   "vite.config.js", "remix.config.js", "nuxt.config.ts",
                   "svelte.config.js"},
    "library":    {"setup.py", "pyproject.toml", "package.json"},  # refined below
    "cli":        {"bin", "scripts/cli", "src/cli"},
    "service":    {"Dockerfile", "docker-compose.yml", "fly.toml",
                   "render.yaml", "Procfile"},
    "hobby":      set(),  # fallback when nothing else matches
}


@dataclass
class ProjectSignals:
    """Compact bundle the Critic-Critic and Arbiter both consume."""
    project_type: str = "library"
    languages: List[str] = None
    test_framework: Optional[str] = None
    has_ci: bool = False
    has_lockfile: bool = False
    package_manager: Optional[str] = None  # npm | pnpm | yarn | poetry | pip | cargo | go
    style_hints: List[str] = None  # textual hints e.g. "uses async", "type-annotated"

    def __post_init__(self) -> None:
        if self.languages is None:
            self.languages = []
        if self.style_hints is None:
            self.style_hints = []

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


def detect(workspace: Path) -> ProjectSignals:
    """Walk `workspace` and return a `ProjectSignals` bundle."""
    if not workspace or not workspace.exists():
        return ProjectSignals()

    sig = ProjectSignals()
    files: List[str] = []
    try:
        for i, p in enumerate(workspace.rglob("*")):
            if i >= _MAX_FILES_SCANNED:
                break
            # Skip the worktree's own scratch/cache + heavy vendored trees.
            rel = p.relative_to(workspace).as_posix()
            if any(rel.startswith(s) for s in (".shadow-cache", "node_modules",
                                                ".venv", "venv", ".git",
                                                "__pycache__", "target",
                                                "dist", "build")):
                continue
            if p.is_file():
                files.append(rel)
    except Exception as e:
        logger.debug("project_signals walk failed: %s", e)

    sig.languages = _detect_languages(files)
    sig.test_framework = _detect_test_framework(workspace, files)
    sig.has_ci = _detect_ci(files)
    sig.has_lockfile, sig.package_manager = _detect_packaging(workspace, files)
    sig.project_type = _detect_project_type(workspace, files, sig)
    sig.style_hints = _detect_style_hints(workspace, files)
    return sig


# ---------------------------------------------------------------------------
# Detection helpers — each is independent so missing data degrades gracefully.
# ---------------------------------------------------------------------------

_EXT_LANGUAGE = {
    ".py": "python",
    ".pyi": "python",
    ".js": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".jsx": "javascript",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".kt": "kotlin",
    ".rb": "ruby",
    ".php": "php",
    ".cs": "csharp",
    ".cpp": "cpp",
    ".c": "c",
    ".swift": "swift",
}


def _detect_languages(files: List[str]) -> List[str]:
    counts: Dict[str, int] = {}
    for f in files:
        # Cheap split — Path(...) per file is too expensive for big repos.
        idx = f.rfind(".")
        if idx == -1:
            continue
        ext = f[idx:]
        lang = _EXT_LANGUAGE.get(ext)
        if lang:
            counts[lang] = counts.get(lang, 0) + 1
    # Surface languages with at least 2 files; preserves "primarily python"
    # signal without flagging a single stray .js example.
    return [l for l, n in sorted(counts.items(), key=lambda x: -x[1]) if n >= 2]


def _detect_test_framework(workspace: Path, files: List[str]) -> Optional[str]:
    has_pytest = any(f == "pytest.ini" or f.endswith("conftest.py")
                     or f.startswith("tests/") and f.endswith(".py")
                     for f in files)
    has_unittest = any(f.startswith("tests/") and "unittest" in f for f in files)
    if has_pytest:
        return "pytest"

    pkg_json = workspace / "package.json"
    if pkg_json.exists():
        try:
            data = json.loads(pkg_json.read_text(encoding="utf-8"))
        except Exception:
            data = {}
        deps = {**(data.get("dependencies") or {}),
                **(data.get("devDependencies") or {})}
        if "vitest" in deps:
            return "vitest"
        if "jest" in deps:
            return "jest"
        if "mocha" in deps:
            return "mocha"
        if "playwright" in deps or "@playwright/test" in deps:
            return "playwright"

    if has_unittest:
        return "unittest"

    pyproject = workspace / "pyproject.toml"
    if pyproject.exists():
        try:
            text = pyproject.read_text(encoding="utf-8")
        except Exception:
            text = ""
        if "pytest" in text:
            return "pytest"

    return None


def _detect_ci(files: List[str]) -> bool:
    for f in files:
        if f.startswith(".github/workflows/"):
            return True
        if f in (".gitlab-ci.yml", ".circleci/config.yml",
                 "azure-pipelines.yml", "Jenkinsfile"):
            return True
    return False


def _detect_packaging(workspace: Path, files: List[str]) -> tuple[bool, Optional[str]]:
    fset = set(files)
    if "package-lock.json" in fset:
        return True, "npm"
    if "pnpm-lock.yaml" in fset:
        return True, "pnpm"
    if "yarn.lock" in fset:
        return True, "yarn"
    if "poetry.lock" in fset:
        return True, "poetry"
    if "Pipfile.lock" in fset:
        return True, "pipenv"
    if "Cargo.lock" in fset:
        return True, "cargo"
    if "go.sum" in fset:
        return True, "go"
    if "requirements.txt" in fset:
        return False, "pip"
    if "package.json" in fset:
        return False, "npm"
    if "pyproject.toml" in fset:
        return False, "pip"
    return False, None


def _detect_project_type(workspace: Path, files: List[str], sig: ProjectSignals) -> str:
    fset = set(files)
    for ptype, hints in _PROJECT_TYPE_HINTS.items():
        if ptype == "hobby":
            continue
        if any(h in fset for h in hints):
            if ptype == "library" and "package.json" in fset:
                # Refine: package.json with a non-private + main field → library;
                # otherwise (no main/private:true) treat as web-app/cli.
                try:
                    data = json.loads((workspace / "package.json").read_text(encoding="utf-8"))
                except Exception:
                    data = {}
                if data.get("private") is True or not data.get("main"):
                    continue
            return ptype
    # No hints → call it "hobby" if it's tiny, else "library".
    return "hobby" if len(files) < 20 else "library"


def _detect_style_hints(workspace: Path, files: List[str]) -> List[str]:
    """Cheap textual hints sampled from a few files. Best-effort only."""
    hints: List[str] = []
    sample_paths = [p for p in files if p.endswith((".py", ".ts", ".js"))][:25]
    has_async = False
    has_types = False
    has_jsdoc = False
    for rel in sample_paths:
        try:
            text = (workspace / rel).read_text(encoding="utf-8", errors="ignore")[:2000]
        except Exception:
            continue
        if "async def " in text or "async function" in text or "await " in text:
            has_async = True
        if rel.endswith(".py") and ") -> " in text:
            has_types = True
        if rel.endswith((".ts", ".tsx")):
            has_types = True
        if rel.endswith((".js", ".ts")) and "/**" in text and "@param" in text:
            has_jsdoc = True
    if has_async:
        hints.append("uses-async")
    if has_types:
        hints.append("type-annotated")
    if has_jsdoc:
        hints.append("jsdoc-style-comments")
    return hints
