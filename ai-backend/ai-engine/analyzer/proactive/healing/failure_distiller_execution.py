"""Fail-closed execution backends for Failure Distiller.

Repository code is never trusted.  The production backend requires a running
OCI engine and starts every candidate in a network-disabled, capability-free
container with bounded resources.  Local execution exists only as an injected
test backend; it is not selected by the authenticated service.
"""
from __future__ import annotations

import asyncio
import os
import shutil
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, Sequence


class IsolationError(ValueError):
    pass


@dataclass(frozen=True)
class ExecutionResult:
    exit_code: int
    output: str
    duration_ms: int
    timed_out: bool = False


class LocalTestExecutor:
    """Explicitly non-production backend used by hermetic unit fixtures only."""

    async def run(self, command: Sequence[str], cwd: Path, env: Dict[str, str], timeout_sec: int) -> ExecutionResult:
        started = time.perf_counter()
        # This backend is only injected by local unit/benchmark fixtures. On
        # Windows, Python uses APPDATA to locate an already-installed test
        # runner; keep that locator without inheriting the rest of the host
        # environment. Production always uses ContainerExecutor instead.
        runtime_env = {"PATH": os.environ.get("PATH", ""), "HOME": str(cwd), "TMPDIR": os.environ.get("TMPDIR", os.environ.get("TEMP", "")), "APPDATA": os.environ.get("APPDATA", ""), "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""), "WINDIR": os.environ.get("WINDIR", ""), "COMSPEC": os.environ.get("COMSPEC", ""), **env}
        try:
            process = await asyncio.create_subprocess_exec(*command, cwd=str(cwd), env=runtime_env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_sec)
            return ExecutionResult(process.returncode or 0, (stdout + stderr).decode("utf-8", "replace"), int((time.perf_counter() - started) * 1000))
        except asyncio.TimeoutError:
            process.kill()
            await process.communicate()
            return ExecutionResult(-1, "command timed out", int((time.perf_counter() - started) * 1000), True)
        except FileNotFoundError:
            return ExecutionResult(-2, "command not found", int((time.perf_counter() - started) * 1000))


class ContainerExecutor:
    """OCI execution with no host credentials, network, or package installs."""
    BLOCKED_PACKAGE_OPERATIONS = {"install", "add", "ci", "update", "upgrade"}

    def __init__(self, image: str, engine: str = "docker", memory_mb: int = 1024, cpu_count: float = 1.0, process_limit: int = 64) -> None:
        if not image or any(char.isspace() for char in image):
            raise IsolationError("isolation.image is required for container execution")
        if engine not in {"docker", "podman"}:
            raise IsolationError("isolation.engine must be docker or podman")
        if memory_mb < 64 or cpu_count <= 0 or process_limit < 1:
            raise IsolationError("isolation resource limits are invalid")
        self.image, self.engine, self.memory_mb, self.cpu_count, self.process_limit = image, engine, memory_mb, cpu_count, process_limit

    @classmethod
    def from_request(cls, raw: object) -> "ContainerExecutor":
        if not isinstance(raw, dict) or raw.get("mode", "container") != "container":
            raise IsolationError("a container isolation profile is required")
        return cls(str(raw.get("image", "")), str(raw.get("engine", "docker")), int(raw.get("memoryMb", raw.get("memory_mb", 1024))), float(raw.get("cpuCount", raw.get("cpu_count", 1))), int(raw.get("processLimit", raw.get("process_limit", 64))))

    def _validate_command(self, command: Sequence[str]) -> None:
        joined = [part.lower() for part in command]
        if any(part in self.BLOCKED_PACKAGE_OPERATIONS for part in joined[1:]) and any(tool in joined[0] for tool in ("npm", "pnpm", "yarn", "pip", "poetry")):
            raise IsolationError("package installation and lifecycle execution are denied")
        if any("--privileged" in part or "docker.sock" in part for part in joined):
            raise IsolationError("container escape arguments are denied")

    async def run(self, command: Sequence[str], cwd: Path, env: Dict[str, str], timeout_sec: int) -> ExecutionResult:
        self._validate_command(command)
        if not shutil.which(self.engine):
            raise IsolationError(f"required isolation engine is unavailable: {self.engine}")
        # Verify the daemon before starting user code.  A missing daemon is a
        # safety failure, not an invitation to run the command on the host.
        probe = await asyncio.create_subprocess_exec(self.engine, "info", stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        if await probe.wait() != 0:
            raise IsolationError(f"required isolation engine is not running: {self.engine}")
        container_command = ["/workspace" + str(Path(part).resolve()).replace("\\", "/").replace(str(cwd.resolve()).replace("\\", "/"), "") if index and Path(part).is_absolute() and str(Path(part).resolve()).startswith(str(cwd.resolve())) else part for index, part in enumerate(command)]
        argv = [self.engine, "run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", str(self.process_limit), "--memory", f"{self.memory_mb}m", "--cpus", str(self.cpu_count), "--user", "65534:65534", "--tmpfs", "/tmp:rw,noexec,nosuid,size=256m", "--workdir", "/workspace", "--mount", f"type=bind,src={cwd.resolve()},dst=/workspace", "--env", "HOME=/tmp", "--env", "TMPDIR=/tmp"]
        for key, value in sorted(env.items()):
            argv.extend(["--env", f"{key}={value}"])
        argv.extend([self.image, *container_command])
        started = time.perf_counter()
        process = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_sec)
            return ExecutionResult(process.returncode or 0, (stdout + stderr).decode("utf-8", "replace"), int((time.perf_counter() - started) * 1000))
        except asyncio.TimeoutError:
            process.kill()
            await process.communicate()
            return ExecutionResult(-1, "command timed out", int((time.perf_counter() - started) * 1000), True)
