"""
Cross-file dependency tracker for AI agent.

Maintains a lightweight dependency graph so the AI agent can identify
which files are affected when a change is made.  Used by:
  - Project-level analysis (detect issues across imports)
  - Incremental re-analysis (only re-check dependents after an edit)

The graph is built lazily from import/require statements and is NOT a
full-blown language server — it's a 90% heuristic that works well
enough for the "small error detection" use-case.
"""

from __future__ import annotations

import os
import re
import logging
from typing import Dict, List, Optional, Set
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger("healing.ai_deps")


# ── Import extractors per language family ─────────────────────────────

_JS_IMPORT_RE = re.compile(
    r"""(?:import\s+.*?from\s+['"](.+?)['"]|"""
    r"""require\s*\(\s*['"](.+?)['"]\s*\))""",
    re.MULTILINE,
)

_PY_IMPORT_RE = re.compile(
    r"""^(?:from\s+(\S+)\s+import|import\s+(\S+))""",
    re.MULTILINE,
)

_RUST_USE_RE = re.compile(
    r"""^use\s+(?:crate::)?(\S+?)(?:::\{|;)""",
    re.MULTILINE,
)


def _extract_import_specifiers(code: str, lang: str) -> List[str]:
    """Return raw import specifier strings from source code."""
    if lang in ("javascript", "typescript", "javascriptreact", "typescriptreact"):
        matches = _JS_IMPORT_RE.findall(code)
        return [m[0] or m[1] for m in matches if (m[0] or m[1])]
    elif lang == "python":
        matches = _PY_IMPORT_RE.findall(code)
        return [m[0] or m[1] for m in matches if (m[0] or m[1])]
    elif lang == "rust":
        return [m for m in _RUST_USE_RE.findall(code) if m]
    return []


def _resolve_specifier(specifier: str, file_path: str, workspace_root: str) -> Optional[str]:
    """
    Best-effort resolve of a relative import specifier to a workspace-relative path.

    We only resolve relative paths (./ and ../).  Bare specifiers (npm packages,
    stdlib modules) are ignored — they don't point to user code.
    """
    if not specifier.startswith("."):
        return None

    file_dir = os.path.dirname(file_path)
    joined = os.path.normpath(os.path.join(file_dir, specifier))

    # Try common extensions
    for ext in ("", ".js", ".ts", ".jsx", ".tsx", "/index.js", "/index.ts"):
        candidate = joined + ext
        full = os.path.join(workspace_root, candidate)
        if os.path.isfile(full):
            return candidate.replace("\\", "/")

    return None


# ── Dependency graph ──────────────────────────────────────────────────

@dataclass
class DepNode:
    """One file in the dependency graph."""
    path: str
    imports: Set[str] = field(default_factory=set)     # files this file imports
    imported_by: Set[str] = field(default_factory=set)  # files that import this file


class DependencyGraph:
    """
    Lightweight dependency graph built from import statements.

    Usage:
        graph = DependencyGraph(workspace_root="/home/user/project")
        graph.add_file("src/utils.js", code, "javascript")
        graph.add_file("src/app.js", code, "javascript")

        graph.dependents_of("src/utils.js")
        # → {"src/app.js"}  (because app.js imports utils.js)
    """

    def __init__(self, workspace_root: str = ""):
        self._workspace_root = workspace_root
        self._nodes: Dict[str, DepNode] = {}

    @property
    def files(self) -> List[str]:
        return list(self._nodes.keys())

    def add_file(self, file_path: str, code: str, lang: str) -> None:
        """Parse imports and register the file in the graph."""
        norm_path = file_path.replace("\\", "/")
        node = self._nodes.setdefault(norm_path, DepNode(path=norm_path))
        node.imports.clear()

        specifiers = _extract_import_specifiers(code, lang)

        for spec in specifiers:
            resolved = _resolve_specifier(spec, norm_path, self._workspace_root)
            if resolved:
                node.imports.add(resolved)
                # Register reverse edge
                dep_node = self._nodes.setdefault(resolved, DepNode(path=resolved))
                dep_node.imported_by.add(norm_path)

    def remove_file(self, file_path: str) -> None:
        """Remove a file and clean up edges."""
        norm = file_path.replace("\\", "/")
        node = self._nodes.pop(norm, None)
        if not node:
            return
        # Remove forward edges
        for imp in node.imports:
            other = self._nodes.get(imp)
            if other:
                other.imported_by.discard(norm)
        # Remove reverse edges
        for dep in node.imported_by:
            other = self._nodes.get(dep)
            if other:
                other.imports.discard(norm)

    def dependents_of(self, file_path: str) -> Set[str]:
        """Return files that import the given file (direct dependents)."""
        norm = file_path.replace("\\", "/")
        node = self._nodes.get(norm)
        return set(node.imported_by) if node else set()

    def dependencies_of(self, file_path: str) -> Set[str]:
        """Return files that the given file imports."""
        norm = file_path.replace("\\", "/")
        node = self._nodes.get(norm)
        return set(node.imports) if node else set()

    def transitive_dependents(self, file_path: str, max_depth: int = 3) -> Set[str]:
        """Return all transitive dependents up to max_depth."""
        norm = file_path.replace("\\", "/")
        visited: Set[str] = set()
        frontier = {norm}
        depth = 0

        while frontier and depth < max_depth:
            next_frontier: Set[str] = set()
            for f in frontier:
                for dep in self.dependents_of(f):
                    if dep not in visited and dep != norm:
                        visited.add(dep)
                        next_frontier.add(dep)
            frontier = next_frontier
            depth += 1

        return visited

    def summary(self) -> Dict:
        """Return a summary of the dependency graph."""
        return {
            "total_files": len(self._nodes),
            "total_edges": sum(len(n.imports) for n in self._nodes.values()),
            "files_with_dependents": sum(
                1 for n in self._nodes.values() if n.imported_by
            ),
        }


# ── Module singleton ──────────────────────────────────────────────────

_instance: Optional[DependencyGraph] = None


def get_dependency_graph(workspace_root: str = "") -> DependencyGraph:
    """Get or create the module-level dependency graph singleton."""
    global _instance
    if _instance is None or _instance._workspace_root != workspace_root:
        _instance = DependencyGraph(workspace_root=workspace_root)
    return _instance
