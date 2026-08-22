"""Hardened Docker launcher for live-workspace coding agents.

The control plane deliberately does not execute agent CLIs in its own process:
it has broader access to telemetry and the shared workspace volume.  This
module emits an argv-only Docker command which is safe to pass to
``subprocess.run(shell=False)``.
"""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path
from typing import List

from .workspace_write_policy import protected_paths


PROTECTED_TOP_LEVEL = (".git", ".vectant", ".synthi", ".claude", ".codex", ".agents")
PROTECTED_FILE_NAMES = (".env", ".env.local", ".env.production", ".envrc")


@dataclass(frozen=True)
class AgentContainerPolicy:
    image: str
    network: str
    workspace_volume: str = ""
    workspace_volume_root: str = "/data"
    credentials_volume: str = ""
    memory: str = "2g"
    cpus: str = "2"
    pids_limit: int = 512
    timeout_seconds: int = 300

    @classmethod
    def from_environment(cls) -> "AgentContainerPolicy":
        image = os.environ.get("SYNTHI_AGENT_RUNNER_IMAGE", "vectant-agent-runner:local").strip()
        network = os.environ.get("SYNTHI_AGENT_RUNNER_NETWORK", "").strip()
        if not image or not network:
            raise ValueError("agent runner image and isolated network must be configured")
        return cls(
            image=image,
            network=network,
            workspace_volume=os.environ.get("SYNTHI_AGENT_WORKSPACE_VOLUME", "").strip(),
            workspace_volume_root=os.environ.get("SYNTHI_AGENT_WORKSPACE_VOLUME_ROOT", "/data").strip(),
            credentials_volume=os.environ.get("SYNTHI_AGENT_CREDENTIALS_VOLUME", "").strip(),
            memory=os.environ.get("SYNTHI_AGENT_MEMORY", "2g").strip(),
            cpus=os.environ.get("SYNTHI_AGENT_CPUS", "2").strip(),
            pids_limit=int(os.environ.get("SYNTHI_AGENT_PIDS_LIMIT", "512")),
        )


def docker_command(*, workspace: Path, run_id: str, runner_command: List[str], policy: AgentContainerPolicy) -> List[str]:
    """Build a fail-closed, unprivileged live-write harness invocation."""
    root = Path(workspace).resolve()
    if not root.is_dir():
        raise ValueError("agent workspace must be an existing directory")
    if not runner_command or any(not isinstance(part, str) or not part for part in runner_command):
        raise ValueError("agent runner command must be a non-empty argv list")
    if not policy.image or not policy.network:
        raise ValueError("agent runner image and isolated network are required")
    name = "agent-run-" + hashlib.sha256(run_id.encode("utf-8")).hexdigest()[:20]
    command = [
        "docker", "run", "--rm", "--name", name,
        "--network", policy.network,
        "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
        "--pids-limit", str(policy.pids_limit), "--memory", policy.memory, "--cpus", policy.cpus,
        # gid 1000 is the workspace collaboration group provisioned by the
        # trusted runtime; the harness UID is otherwise unique and unprivileged.
        "--user", "10001:1000", "--workdir", "/workspace",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
        "--tmpfs", "/run/agent-output:rw,noexec,nosuid,size=16m",
        "--env", "HOME=/tmp", "--env", "TMPDIR=/tmp",
        "--env", "HERMES_WRITE_SAFE_ROOT=/workspace",
        "--env", "CODEX_HOME=/run/agent-credentials/codex",
        "--env", "CLAUDE_CONFIG_DIR=/run/agent-credentials/claude",
        "--env", "HERMES_HOME=/run/agent-credentials/hermes",
    ]
    command.extend(_workspace_mount_args(root, policy))
    command.extend(_protected_mount_args(root, policy))
    if policy.credentials_volume:
        command.extend(["--mount", f"type=volume,src={policy.credentials_volume},dst=/run/agent-credentials,readonly"])
    command.append(policy.image)
    command.extend(runner_command)
    return command


def _workspace_mount_args(root: Path, policy: AgentContainerPolicy) -> List[str]:
    if policy.workspace_volume:
        volume_root = Path(policy.workspace_volume_root).resolve()
        try:
            subpath = root.relative_to(volume_root).as_posix()
        except ValueError as error:
            raise ValueError("workspace is outside the configured agent volume root") from error
        if not subpath or subpath.startswith("../"):
            raise ValueError("workspace volume subpath is invalid")
        return ["--mount", f"type=volume,src={policy.workspace_volume},dst=/workspace,volume-subpath={subpath}"]
    return ["--mount", f"type=bind,src={root},dst=/workspace"]


def _protected_mount_args(root: Path, policy: AgentContainerPolicy) -> List[str]:
    mounts: List[str] = []
    volume_root = Path(policy.workspace_volume_root).resolve() if policy.workspace_volume else None
    for protected in protected_paths(root):
        relative = protected.relative_to(root).as_posix()
        if policy.workspace_volume:
            assert volume_root is not None
            source = protected.resolve().relative_to(volume_root).as_posix()
            mounts.extend(["--mount", f"type=volume,src={policy.workspace_volume},dst=/workspace/{relative},readonly,volume-subpath={source}"])
        else:
            mounts.extend(["--mount", f"type=bind,src={protected.resolve()},dst=/workspace/{relative},readonly"])
    return mounts
