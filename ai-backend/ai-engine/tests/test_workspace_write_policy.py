from __future__ import annotations

import sys
import os
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shadow.workspace_write_policy import assert_protected_unchanged, protected_snapshot, provision_agent_write_access


def test_protected_snapshot_detects_secret_and_control_plane_changes(tmp_path):
    (tmp_path / ".env").write_text("TOKEN=before\n", encoding="utf-8")
    (tmp_path / ".git").mkdir()
    (tmp_path / ".git" / "config").write_text("[core]\n", encoding="utf-8")
    (tmp_path / "app.py").write_text("print('safe')\n", encoding="utf-8")
    before = protected_snapshot(tmp_path)

    (tmp_path / "app.py").write_text("print('changed')\n", encoding="utf-8")
    assert_protected_unchanged(before, tmp_path)

    (tmp_path / ".env").write_text("TOKEN=after\n", encoding="utf-8")
    with pytest.raises(PermissionError, match=".env"):
        assert_protected_unchanged(before, tmp_path)


def test_protected_snapshot_detects_new_key_material(tmp_path):
    before = protected_snapshot(tmp_path)
    (tmp_path / "service.key").write_text("private", encoding="utf-8")

    with pytest.raises(PermissionError, match="service.key"):
        assert_protected_unchanged(before, tmp_path)


def test_protected_snapshot_allows_only_the_expected_controller_artifact(tmp_path):
    before = protected_snapshot(tmp_path)
    artifact = tmp_path / ".vectant" / "runner-artifacts" / "run" / "codex-A.json"
    artifact.parent.mkdir(parents=True)
    artifact.write_text("redacted", encoding="utf-8")

    assert_protected_unchanged(before, tmp_path, allowed_paths=[".vectant/runner-artifacts/run/codex-A.json"])
    (tmp_path / ".vectant" / "config.json").write_text("unexpected", encoding="utf-8")
    with pytest.raises(PermissionError, match="config.json"):
        assert_protected_unchanged(before, tmp_path, allowed_paths=[".vectant/runner-artifacts/run/codex-A.json"])


def test_provisioning_grants_only_group_write_to_ordinary_workspace_paths(tmp_path):
    if not hasattr(os, "chown"):
        pytest.skip("permission provisioning executes in the Linux service container")
    source = tmp_path / "src"
    source.mkdir()
    app = source / "app.py"
    app.write_text("pass\n", encoding="utf-8")
    secret = tmp_path / ".env"
    secret.write_text("TOKEN=x\n", encoding="utf-8")

    provision_agent_write_access(tmp_path)

    assert app.stat().st_mode & 0o060
    assert source.stat().st_mode & 0o2070
    assert not secret.stat().st_mode & 0o020
