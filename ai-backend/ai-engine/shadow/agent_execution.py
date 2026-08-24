"""Hardened Docker launcher for live-workspace coding agents.

The control plane deliberately does not execute agent CLIs in its own process:
it has broader access to telemetry and the shared workspace volume.  This
module emits an argv-only Docker command which is safe to pass to
``subprocess.run(shell=False)``.
"""

from __future__ import annotations

import hashlib
import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import List

from .codesite_agent_workspace import CodeSiteExecutionBinding
from .workspace_write_policy import protected_paths


@dataclass(frozen=True)
class AgentContainerPolicy:
    image: str
    network: str
    workspace_volume: str = ""
    workspace_volume_root: str = "/data"
    credentials_volume: str = ""
    shared_workspace_gid: int = 1000
    memory: str = "2g"
    cpus: str = "2"
    pids_limit: int = 512
    timeout_seconds: int = 300
    codesite_overlay_root: str = ""
    codesite_control_plane_url: str = ""

    @classmethod
    def from_environment(cls) -> "AgentContainerPolicy":
        image = os.environ.get("SYNTHI_AGENT_RUNNER_IMAGE", "vectant-agent-runner:local").strip()
        network = os.environ.get("SYNTHI_AGENT_RUNNER_NETWORK", "").strip()
        credentials_volume = os.environ.get("SYNTHI_AGENT_CREDENTIALS_VOLUME", "").strip()
        if not image or not network or not credentials_volume:
            raise ValueError("agent runner image, isolated network, and credentials volume must be configured")
        try:
            shared_workspace_gid = int(os.environ.get("SYNTHI_RUNTIME_SHARED_GID", "1000"))
        except ValueError as error:
            raise ValueError("SYNTHI_RUNTIME_SHARED_GID must be a numeric group id") from error
        if not 1 <= shared_workspace_gid <= 2_147_483_647:
            raise ValueError("SYNTHI_RUNTIME_SHARED_GID is outside the valid range")
        return cls(
            image=image,
            network=network,
            workspace_volume=os.environ.get("SYNTHI_AGENT_WORKSPACE_VOLUME", "").strip(),
            workspace_volume_root=os.environ.get("SYNTHI_AGENT_WORKSPACE_VOLUME_ROOT", "/data").strip(),
            credentials_volume=credentials_volume,
            shared_workspace_gid=shared_workspace_gid,
            memory=os.environ.get("SYNTHI_AGENT_MEMORY", "2g").strip(),
            cpus=os.environ.get("SYNTHI_AGENT_CPUS", "2").strip(),
            pids_limit=int(os.environ.get("SYNTHI_AGENT_PIDS_LIMIT", "512")),
            codesite_overlay_root=os.environ.get("SYNTHI_CODESITE_AGENT_OVERLAY_ROOT", "").strip(),
            codesite_control_plane_url=os.environ.get("SYNTHI_CODESITE_CONTROL_PLANE_URL", "").strip(),
        )


def docker_command(*, workspace: Path, run_id: str, runner_command: List[str], policy: AgentContainerPolicy, volume_mountpoint: Path | None = None, codesite_binding: CodeSiteExecutionBinding | None = None) -> List[str]:
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
        # The workspace group is provisioned by the trusted runtime; the
        # harness UID is otherwise unique and unprivileged.
        "--user", f"10001:{policy.shared_workspace_gid}", "--workdir", "/workspace",
        "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m",
        "--tmpfs", "/run/agent-output:rw,noexec,nosuid,size=16m",
        "--env", "HOME=/tmp", "--env", "TMPDIR=/tmp",
        "--env", "HERMES_WRITE_SAFE_ROOT=/workspace",
        "--env", "CODEX_HOME=/tmp/codex",
        "--env", "CLAUDE_CONFIG_DIR=/tmp/claude",
        "--env", "HERMES_HOME=/tmp/hermes",
    ]
    if codesite_binding:
        command.extend([
            "--env", "SYNTHI_CODESITE_MANAGED_AGENT=1",
            "--env", f"CODESITE_WORKSPACE_SLUG={codesite_binding.workspace_slug}",
            "--env", f"CODESITE_PROJECT_ID={codesite_binding.project_id}",
            "--env", f"CODESITE_AGENT_SESSION_ID={codesite_binding.agent_session_id}",
            "--env", f"CODESITE_MUTATION_LEASE_ID={codesite_binding.mutation_lease_id}",
            "--env", f"CODESITE_TRANSACTION_ID={codesite_binding.transaction_id}",
            "--env", f"CODESITE_BASE_COMMIT={codesite_binding.base_commit}",
        ])
    daemon_root = _daemon_workspace_path(root, policy, volume_mountpoint=volume_mountpoint)
    command.extend(_workspace_mount_args(daemon_root))
    command.extend(_protected_mount_args(root, daemon_root))
    if policy.credentials_volume:
        command.extend(["--mount", f"type=volume,src={policy.credentials_volume},dst=/run/agent-credentials,readonly"])
    command.append(policy.image)
    command.extend(runner_command)
    return command


def _daemon_workspace_path(root: Path, policy: AgentContainerPolicy, *, volume_mountpoint: Path | None) -> Path:
    if not policy.workspace_volume:
        return root
    volume_root = Path(policy.workspace_volume_root).resolve()
    try:
        relative = root.relative_to(volume_root)
    except ValueError as error:
        raise ValueError("workspace is outside the configured agent volume root") from error
    mountpoint = Path(volume_mountpoint) if volume_mountpoint is not None else _volume_mountpoint(policy.workspace_volume)
    candidate = mountpoint / relative
    if not candidate.is_dir():
        raise ValueError("workspace does not exist in the configured Docker volume")
    return candidate


def _volume_mountpoint(volume: str) -> Path:
    inspected = subprocess.run(
        ["docker", "volume", "inspect", "--format", "{{.Mountpoint}}", volume],
        shell=False, check=False, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10,
    )
    if inspected.returncode != 0 or not inspected.stdout.strip():
        raise OSError("unable to resolve the agent workspace Docker volume")
    return Path(inspected.stdout.strip()).resolve()


def _workspace_mount_args(daemon_root: Path) -> List[str]:
    return ["--mount", f"type=bind,src={daemon_root},dst=/workspace"]


def _protected_mount_args(root: Path, daemon_root: Path) -> List[str]:
    mounts: List[str] = []
    for protected in protected_paths(root):
        relative = protected.relative_to(root).as_posix()
        source = daemon_root / protected.relative_to(root)
        mounts.extend(["--mount", f"type=bind,src={source},dst=/workspace/{relative},readonly"])
    return mounts
