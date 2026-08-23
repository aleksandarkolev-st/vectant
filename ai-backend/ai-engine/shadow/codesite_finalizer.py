"""Trusted, fail-closed landing of a CodeSite agent worktree."""
from __future__ import annotations

import fnmatch
import subprocess
import tempfile
from pathlib import Path

from .codesite_agent_workspace import CodeSiteAgentWorktree, CodeSiteExecutionBinding


class CodeSiteFinalizationError(RuntimeError):
    pass


def finalize_codesite_worktree(*, source_workspace: Path, worktree: CodeSiteAgentWorktree,
                               binding: CodeSiteExecutionBinding, allowed_paths: tuple[str, ...],
                               test_command: list[str]) -> list[str]:
    """Validate and land one overlay.  No agent process calls this function."""
    source = Path(source_workspace).resolve()
    if worktree.binding != binding or _git(source, ["rev-parse", "HEAD"]).strip() != binding.base_commit:
        raise CodeSiteFinalizationError("CodeSite base changed; overlay must be rebased")
    if _git(source, ["status", "--porcelain", "--untracked-files=no"]).strip():
        raise CodeSiteFinalizationError("shared workspace is dirty; refusing automatic landing")
    _git(worktree.path, ["add", "-N", "."])
    paths = [line for line in _git(worktree.path, ["diff", "--name-only", binding.base_commit, "--"]).splitlines() if line]
    if not paths:
        return []
    if any(not _allowed(path, allowed_paths) for path in paths):
        raise CodeSiteFinalizationError("overlay contains a path outside its CodeSite lease")
    patch = _git_bytes(worktree.path, ["diff", "--binary", binding.base_commit, "--"])
    with tempfile.TemporaryDirectory(prefix="codesite-integration-") as temp:
        chamber = Path(temp) / "workspace"
        _git(source, ["worktree", "add", "--detach", str(chamber), binding.base_commit])
        try:
            _git_bytes(chamber, ["apply", "--check", "--binary", "-"], stdin=patch)
            _git_bytes(chamber, ["apply", "--binary", "-"], stdin=patch)
            _run(test_command, chamber)
        finally:
            _git(source, ["worktree", "remove", "--force", str(chamber)])
    if _git(source, ["rev-parse", "HEAD"]).strip() != binding.base_commit or _git(source, ["status", "--porcelain", "--untracked-files=no"]).strip():
        raise CodeSiteFinalizationError("shared workspace changed during finalization")
    _git_bytes(source, ["apply", "--check", "--binary", "-"], stdin=patch)
    _git_bytes(source, ["apply", "--binary", "-"], stdin=patch)
    return paths


def rollback_codesite_worktree(*, source_workspace: Path, worktree: CodeSiteAgentWorktree,
                               binding: CodeSiteExecutionBinding) -> None:
    """Reverse the exact retained overlay patch after a rejected landing gate."""
    source = Path(source_workspace).resolve()
    if _git(source, ["rev-parse", "HEAD"]).strip() != binding.base_commit:
        raise CodeSiteFinalizationError("cannot roll back a CodeSite overlay after base movement")
    patch = _git_bytes(worktree.path, ["diff", "--binary", binding.base_commit, "--"])
    _git_bytes(source, ["apply", "--check", "--reverse", "--binary", "-"], stdin=patch)
    _git_bytes(source, ["apply", "--reverse", "--binary", "-"], stdin=patch)


def _allowed(path: str, patterns: tuple[str, ...]) -> bool:
    return any(fnmatch.fnmatchcase(path, pattern) for pattern in patterns)


def _git(cwd: Path, args: list[str]) -> str:
    return _run(["git", *args], cwd, capture=True).decode("utf-8", errors="replace")


def _git_bytes(cwd: Path, args: list[str], stdin: bytes | None = None) -> bytes:
    return _run(["git", *args], cwd, capture=True, stdin=stdin)


def _run(command: list[str], cwd: Path, *, capture: bool = False, stdin: bytes | None = None) -> bytes:
    if not command or not all(isinstance(item, str) and item for item in command):
        raise CodeSiteFinalizationError("finalizer command must be a non-empty argv")
    result = subprocess.run(command, cwd=cwd, input=stdin, capture_output=True, shell=False, timeout=300)
    if result.returncode:
        detail = (result.stderr or result.stdout).decode("utf-8", errors="replace").strip()
        raise CodeSiteFinalizationError(detail[:1000] or "CodeSite finalization command failed")
    return result.stdout if capture else b""
