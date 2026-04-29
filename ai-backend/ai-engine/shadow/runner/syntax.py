"""Tree-sitter parse-only fallback. Master plan §9.

Used when no language-specific runner matches. Catches "patch is not even
syntactically valid" cheaply, which is enough to reject the worst Generator
failures before they reach the Critic.

The current implementation lazily imports tree-sitter so the rest of the
shadow subsystem works on hosts where tree-sitter isn't installed.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import List

from .base import Diagnostic, Runner, RunResult

logger = logging.getLogger("shadow.runner.syntax")


class SyntaxRunner(Runner):
    name = "syntax"

    async def run(self, worktree: Path, changed_files: List[str]) -> RunResult:
        result = RunResult()
        diags: List[Diagnostic] = []
        ok = True
        for rel in changed_files:
            full = worktree / rel
            try:
                src = full.read_text(encoding="utf-8")
            except Exception:
                continue
            err = self._parse_check(rel, src)
            if err is not None:
                diags.append(err)
                ok = False
        # Always mark "ran" so a clean parse counts as evidence.
        result.lint = (diags, True)
        return result

    def _parse_check(self, path: str, src: str) -> Diagnostic | None:
        # tree-sitter is optional. If unavailable we degrade to "no syntax check"
        # but never fail the universe over a missing dev dependency.
        try:
            import tree_sitter_languages  # type: ignore
        except Exception:
            return None
        try:
            lang = _lang_for_path(path)
            if lang is None:
                return None
            parser = tree_sitter_languages.get_parser(lang)
            tree = parser.parse(src.encode("utf-8"))
            if tree.root_node.has_error:
                return Diagnostic(
                    code="syntax", msg=f"tree-sitter parse error in {path}",
                    file=path, line=tree.root_node.start_point[0] + 1,
                    severity="error",
                )
        except Exception as e:
            logger.debug("tree-sitter check failed for %s: %s", path, e)
        return None


_EXT_LANG = {
    ".py": "python",
    ".ts": "typescript",
    ".tsx": "tsx",
    ".js": "javascript",
    ".jsx": "javascript",
    ".go": "go",
    ".rs": "rust",
    ".html": "html",
    ".css": "css",
    ".json": "json",
    ".md": "markdown",
}


def _lang_for_path(path: str) -> str | None:
    for ext, lang in _EXT_LANG.items():
        if path.endswith(ext):
            return lang
    return None
