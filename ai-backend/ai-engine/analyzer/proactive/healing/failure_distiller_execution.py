"""Fail-closed execution backends for Failure Distiller.

Repository code is never trusted.  The production backend requires a running
OCI engine and starts every candidate in a network-disabled, capability-free
container with bounded resources.  Local execution exists only as an injected
test backend; it is not selected by the authenticated service.
"""
from __future__ import annotations

import asyncio
import hashlib
import os
import shutil
import tempfile
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
    output_sha256: str = ""
    output_truncated: bool = False


class LocalTestExecutor:
    """Explicitly non-production backend used by hermetic unit fixtures only."""

    async def run(self, command: Sequence[str], cwd: Path, env: Dict[str, str], timeout_sec: int) -> ExecutionResult:
        started = time.perf_counter()
        # This backend is only injected by local unit/benchmark fixtures. On
        # Windows, Python uses APPDATA to locate an already-installed test
        # runner; keep that locator without inheriting the rest of the host
        # environment. Production always uses ContainerExecutor instead.
        # Test runners such as Vitest use TEMP/TMP rather than TMPDIR on
        # Windows.  Inheriting an ambient value can point at a protected
        # system directory, so give every run an owned, disposable directory.
        with tempfile.TemporaryDirectory(prefix="vfd-run-") as temporary_directory:
            runtime_env = {
                "PATH": os.environ.get("PATH", ""), "HOME": str(cwd),
                "TMPDIR": temporary_directory, "TEMP": temporary_directory, "TMP": temporary_directory,
                "APPDATA": os.environ.get("APPDATA", ""), "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),
                "WINDIR": os.environ.get("WINDIR", ""), "COMSPEC": os.environ.get("COMSPEC", ""), **env,
            }
            try:
                process = await asyncio.create_subprocess_exec(*command, cwd=str(cwd), env=runtime_env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
                output, digest, truncated = await asyncio.wait_for(_capture_process(process), timeout=timeout_sec)
                return ExecutionResult(process.returncode or 0, output, int((time.perf_counter() - started) * 1000), output_sha256=digest, output_truncated=truncated)
            except asyncio.TimeoutError:
                process.kill()
                await _capture_process(process)
                return ExecutionResult(-1, "command timed out", int((time.perf_counter() - started) * 1000), True, hashlib.sha256(b"command timed out").hexdigest())
            except FileNotFoundError:
                return ExecutionResult(-2, "command not found", int((time.perf_counter() - started) * 1000), output_sha256=hashlib.sha256(b"command not found").hexdigest())


class ContainerExecutor:
    """OCI execution with no host credentials, network, or package installs."""
    BLOCKED_PACKAGE_OPERATIONS = {"install", "add", "ci", "update", "upgrade"}

    MAX_CAPTURE_BYTES = 1024 * 1024
    MAX_TMPFS_MB = 256
    MAX_CONCURRENT_JOBS = 4
    _job_slots = asyncio.Semaphore(MAX_CONCURRENT_JOBS)

    def __init__(self, image: str, engine: str = "docker", memory_mb: int = 1024, cpu_count: float = 1.0, process_limit: int = 64, *, allowed_images: Sequence[str] = ()) -> None:
        if not image or any(char.isspace() for char in image):
            raise IsolationError("isolation.image is required for container execution")
        if "@sha256:" not in image or len(image.rsplit("@sha256:", 1)[1]) != 64:
            raise IsolationError("isolation.image must be pinned by a sha256 digest")
        if image not in set(allowed_images):
            raise IsolationError("isolation.image is not in the server allowlist")
        if engine not in {"docker", "podman"}:
            raise IsolationError("isolation.engine must be docker or podman")
        if memory_mb < 64 or cpu_count <= 0 or process_limit < 1:
            raise IsolationError("isolation resource limits are invalid")
        self.image, self.engine, self.memory_mb, self.cpu_count, self.process_limit = image, engine, memory_mb, cpu_count, process_limit

    @classmethod
    def from_request(cls, raw: object) -> "ContainerExecutor":
        if not isinstance(raw, dict) or raw.get("mode", "container") != "container":
            raise IsolationError("a container isolation profile is required")
        allowed = tuple(value.strip() for value in os.environ.get("VECTANT_FAILURE_DISTILLER_ALLOWED_IMAGES", "").split(",") if value.strip())
        return cls(str(raw.get("image", "")), str(raw.get("engine", "docker")), int(raw.get("memoryMb", raw.get("memory_mb", 1024))), float(raw.get("cpuCount", raw.get("cpu_count", 1))), int(raw.get("processLimit", raw.get("process_limit", 64)),), allowed_images=allowed)

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
        inspect = await asyncio.create_subprocess_exec(self.engine, "image", "inspect", self.image, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL)
        if await inspect.wait() != 0:
            raise IsolationError("required allowlisted image is not pre-provisioned locally")
        container_command = ["/workspace" + str(Path(part).resolve()).replace("\\", "/").replace(str(cwd.resolve()).replace("\\", "/"), "") if index and Path(part).is_absolute() and str(Path(part).resolve()).startswith(str(cwd.resolve())) else part for index, part in enumerate(command)]
        argv = [self.engine, "run", "--rm", "--pull=never", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", str(self.process_limit), "--memory", f"{self.memory_mb}m", "--cpus", str(self.cpu_count), "--ulimit", "nofile=256:256", "--user", "65534:65534", "--tmpfs", f"/tmp:rw,noexec,nosuid,size={self.MAX_TMPFS_MB}m", "--workdir", "/workspace", "--mount", f"type=bind,src={cwd.resolve()},dst=/workspace,readonly", "--env", "HOME=/tmp", "--env", "TMPDIR=/tmp"]
        for key, value in sorted(env.items()):
            argv.extend(["--env", f"{key}={value}"])
        argv.extend([self.image, *container_command])
        started = time.perf_counter()
        async with self._job_slots:
            process = await asyncio.create_subprocess_exec(*argv, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
            try:
                output, digest, truncated = await asyncio.wait_for(_capture_process(process), timeout=timeout_sec)
                return ExecutionResult(process.returncode or 0, output, int((time.perf_counter() - started) * 1000), output_sha256=digest, output_truncated=truncated)
            except asyncio.TimeoutError:
                process.kill()
                await _capture_process(process)
                return ExecutionResult(-1, "command timed out", int((time.perf_counter() - started) * 1000), True, output_sha256=hashlib.sha256(b"command timed out").hexdigest())
            except asyncio.CancelledError:
                process.kill()
                await _capture_process(process)
                raise



async def _capture_process(process: asyncio.subprocess.Process, limit: int = ContainerExecutor.MAX_CAPTURE_BYTES) -> tuple[str, str, bool]:
    """Drain both pipes without retaining unbounded hostile output."""
    retained = bytearray()
    digest = hashlib.sha256()
    truncated = False

    async def drain(reader: asyncio.StreamReader | None) -> None:
        nonlocal truncated
        if reader is None:
            return
        while chunk := await reader.read(64 * 1024):
            digest.update(chunk)
            remaining = limit - len(retained)
            if remaining > 0:
                retained.extend(chunk[:remaining])
            if len(chunk) > remaining:
                truncated = True

    await asyncio.gather(drain(process.stdout), drain(process.stderr))
    await process.wait()
    suffix = b"\n[output truncated; sha256 retained in evidence]\n" if truncated else b""
    return (bytes(retained + suffix).decode("utf-8", "replace"), digest.hexdigest(), truncated)
