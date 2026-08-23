from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shadow.codesite_agent_workspace import (
    CodeSiteExecutionBinding,
    create_codesite_agent_worktree,
    remove_codesite_agent_worktree,
    worktree_base_commit,
)
from shadow.runner_base import BaseRunnerAdapter


def _git(cwd: Path, *args: str) -> str:
    completed = subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True)
    return completed.stdout.strip()


def _workspace(tmp_path: Path) -> Path:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    _git(workspace, "init")
    _git(workspace, "config", "user.email", "tests@example.invalid")
    _git(workspace, "config", "user.name", "CodeSite Tests")
    (workspace / "README.md").write_text("base\n", encoding="utf-8")
    _git(workspace, "add", "README.md")
    _git(workspace, "commit", "-m", "base")
    return workspace


def _binding(workspace: Path) -> CodeSiteExecutionBinding:
    return CodeSiteExecutionBinding(
        workspace_slug="demo",
        project_id="project-1",
        agent_session_id="agent-1",
        mutation_lease_id="lease-1",
        transaction_id="txn-1",
        base_commit=_git(workspace, "rev-parse", "HEAD"),
    )


def test_codesite_agent_worktree_is_detached_and_does_not_change_source(tmp_path):
    workspace = _workspace(tmp_path)
    overlay_root = tmp_path / "codesite-overlays"
    overlay_root.mkdir()
    binding = _binding(workspace)

    worktree = create_codesite_agent_worktree(
        source_workspace=workspace, overlay_root=overlay_root, binding=binding,
    )
    try:
        assert worktree.path.is_dir()
        assert worktree_base_commit(worktree) == binding.base_commit
        (worktree.path / "README.md").write_text("agent change\n", encoding="utf-8")
        assert (workspace / "README.md").read_text(encoding="utf-8") == "base\n"
        assert _git(workspace, "status", "--porcelain") == ""
        assert _git(worktree.path, "status", "--porcelain") == "M README.md"
    finally:
        remove_codesite_agent_worktree(worktree)

    assert not worktree.path.exists()


def test_codesite_agent_worktree_requires_configured_existing_root(tmp_path):
    workspace = _workspace(tmp_path)
    with pytest.raises(ValueError, match="overlay root"):
        create_codesite_agent_worktree(
            source_workspace=workspace,
            overlay_root=tmp_path / "missing",
            binding=_binding(workspace),
        )


def test_runner_diff_reports_untracked_worktree_files(tmp_path):
    workspace = _workspace(tmp_path)
    (workspace / "new-file.txt").write_text("new\n", encoding="utf-8")
    diff = BaseRunnerAdapter().collect_diff(workspace, "base")
    assert "new-file.txt" in diff["changed_paths"]


@pytest.mark.parametrize("field,value", [
    ("workspace_slug", "../escape"),
    ("transaction_id", "bad/path"),
    ("base_commit", "not-a-commit"),
])
def test_codesite_binding_rejects_untrusted_identifiers(field, value):
    values = {
        "workspace_slug": "demo", "project_id": "project-1", "agent_session_id": "agent-1",
        "mutation_lease_id": "lease-1", "transaction_id": "txn-1", "base_commit": "a" * 40,
    }
    values[field] = value
    with pytest.raises(ValueError):
        CodeSiteExecutionBinding(**values)
