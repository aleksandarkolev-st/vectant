from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from shadow.agent_execution import AgentContainerPolicy, docker_command


def test_agent_container_has_only_a_bounded_workspace_and_no_privilege(tmp_path):
    command = docker_command(
        workspace=tmp_path, run_id="run-1", runner_command=["codex", "exec", "task"],
        policy=AgentContainerPolicy(image="runner@sha256:abc", network="agent-egress"),
    )

    assert command[:3] == ["docker", "run", "--rm"]
    assert "--read-only" in command
    assert command[command.index("--cap-drop") + 1] == "ALL"
    assert command[command.index("--security-opt") + 1] == "no-new-privileges"
    assert "--privileged" not in command
    assert "/var/run/docker.sock" not in " ".join(command)
    assert "type=bind,src=" + str(tmp_path.resolve()) + ",dst=/workspace" in command
    assert command[-4:] == ["runner@sha256:abc", "codex", "exec", "task"]


def test_agent_container_uses_only_configured_volume_subpath(tmp_path):
    workspace = tmp_path / "repos" / "demo" / "user"
    workspace.mkdir(parents=True)
    policy = AgentContainerPolicy(image="runner", network="isolated", workspace_volume="collab-data", workspace_volume_root=str(tmp_path))

    command = docker_command(workspace=workspace, run_id="r", runner_command=["claude", "-p", "fix"], policy=policy)

    assert "type=volume,src=collab-data,dst=/workspace,volume-subpath=repos/demo/user" in command


def test_agent_container_overmounts_secrets_and_git_readonly(tmp_path):
    (tmp_path / ".env").write_text("TOKEN=x", encoding="utf-8")
    (tmp_path / ".git").mkdir()
    command = docker_command(
        workspace=tmp_path, run_id="r", runner_command=["codex", "exec", "task"],
        policy=AgentContainerPolicy(image="runner", network="isolated"),
    )

    joined = " ".join(command)
    assert f"type=bind,src={tmp_path / '.env'},dst=/workspace/.env,readonly" in joined
    assert f"type=bind,src={tmp_path / '.git'},dst=/workspace/.git,readonly" in joined


def test_agent_container_rejects_workspace_outside_configured_volume(tmp_path):
    with pytest.raises(ValueError, match="outside"):
        docker_command(
            workspace=tmp_path, run_id="r", runner_command=["hermes", "chat"],
            policy=AgentContainerPolicy(image="runner", network="isolated", workspace_volume="collab-data", workspace_volume_root=str(tmp_path / "other")),
        )
