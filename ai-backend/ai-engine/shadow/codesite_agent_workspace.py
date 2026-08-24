"""Isolated, auditable worktrees for CodeSite-managed agent runs.

The agent runner must never receive the shared checkout for a CodeSite task.
This module creates a detached Git worktree below a server-configured root and
binds that worktree into the unprivileged harness.  Only the control plane can
later consume its diff; agents cannot mutate the source checkout or its Git
metadata.
"""

from __future__ import annotations

import hashlib
import re
import subprocess
from dataclasses import dataclass
from pathlib import Path


_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
_COMMIT = re.compile(r"^[0-9a-fA-F]{7,64}$")


@dataclass(frozen=True)
class CodeSiteExecutionBinding:
    """Server-validated identity of one CodeSite agent execution."""

    workspace_slug: str
    project_id: str
    agent_session_id: str
    mutation_lease_id: str
    transaction_id: str
    base_commit: str

    def __post_init__(self) -> None:
        for field in (
            "workspace_slug",
            "project_id",
            "agent_session_id",
            "mutation_lease_id",
            "transaction_id",
        ):
            value = getattr(self, field)
            if not _IDENTIFIER.fullmatch(value):
                raise ValueError(f"invalid CodeSite {field}")
        if not _COMMIT.fullmatch(self.base_commit):
            raise ValueError("invalid CodeSite base_commit")

    @property
    def overlay_id(self) -> str:
        material = "\x00".join((
            self.workspace_slug,
            self.project_id,
            self.agent_session_id,
            self.mutation_lease_id,
            self.transaction_id,
            self.base_commit.lower(),
        ))
        return hashlib.sha256(material.encode("utf-8")).hexdigest()[:32]


@dataclass(frozen=True)
class CodeSiteAgentWorktree:
    """A detached worktree owned by a single CodeSite transaction."""

    root: Path
    source_workspace: Path
    binding: CodeSiteExecutionBinding

    @property
    def path(self) -> Path:
        return self.root / self.binding.workspace_slug / self.binding.transaction_id / self.binding.overlay_id


def create_codesite_agent_worktree(
    *,
    source_workspace: Path,
    overlay_root: Path,
    binding: CodeSiteExecutionBinding,
) -> CodeSiteAgentWorktree:
    """Create an isolated detached worktree pinned to the declared base commit.

    ``overlay_root`` is service configuration, never supplied by an agent.  A
    failed Git command is deliberately fatal: falling back to the source
    workspace would defeat the concurrency and containment guarantees.
    """
    source = Path(source_workspace).resolve()
    root = Path(overlay_root).resolve()
    if not source.is_dir() or not (source / ".git").exists():
        raise ValueError("CodeSite agent execution requires a Git workspace")
    if not root.is_dir():
        raise ValueError("configured CodeSite overlay root must exist")
    worktree = CodeSiteAgentWorktree(root=root, source_workspace=source, binding=binding)
    target = worktree.path
    _assert_within(root, target)
    if target.exists():
        raise FileExistsError("CodeSite agent overlay already exists")
    target.parent.mkdir(parents=True, exist_ok=True)
    _git(source, ["worktree", "add", "--detach", "--no-checkout", str(target), binding.base_commit])
    try:
        _git(target, ["reset", "--hard", binding.base_commit])
    except Exception:
        _remove_worktree(source, target)
        raise
    return worktree


def remove_codesite_agent_worktree(worktree: CodeSiteAgentWorktree) -> None:
    """Remove a disposable worktree through Git, never recursive shell deletion."""
    _assert_within(worktree.root, worktree.path)
    _remove_worktree(worktree.source_workspace, worktree.path)


def worktree_base_commit(worktree: CodeSiteAgentWorktree) -> str:
    return _git(worktree.path, ["rev-parse", "HEAD"]).strip()


def _remove_worktree(source: Path, target: Path) -> None:
    _git(source, ["worktree", "remove", "--force", str(target)])


def _git(cwd: Path, args: list[str]) -> str:
    completed = subprocess.run(
        ["git", *args], cwd=cwd, shell=False, check=False,
        capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
    )
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "git command failed").strip()
        raise RuntimeError(detail[:1_000])
    return completed.stdout


def _assert_within(root: Path, candidate: Path) -> None:
    try:
        candidate.relative_to(root)
    except ValueError as error:
        raise ValueError("CodeSite worktree path escaped configured overlay root") from error
