"""
Sandboxed Execution Environment.

Provides an isolated workspace for repair actions so that:
- Fixes are applied to a *copy*, never the live workspace directly
- Build/test commands run in an ephemeral directory
- Resource limits (CPU, memory, time, network) are enforced
- File write allowlist prevents escaping the sandbox
- Results are collected and diffed before promoting to live

Architecture:
    live workspace → snapshot(copy) → sandbox dir →
    apply patch → build/test → collect results →
    if OK: promote patch to live
    if FAIL: discard sandbox
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import shutil
import stat
import tempfile
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Set

logger = logging.getLogger("healing.sandbox")


# ── Types ─────────────────────────────────────────────────────────────

class SandboxState(str, Enum):
    CREATED = "created"
    SNAPSHOTTED = "snapshotted"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    FAILED = "failed"
    DISCARDED = "discarded"


class ResourceLimit(str, Enum):
    """Resource limits that can be enforced."""
    CPU_TIME = "cpu_time"
    WALL_TIME = "wall_time"
    MEMORY_MB = "memory_mb"
    DISK_MB = "disk_mb"
    PROCESSES = "processes"
    NETWORK = "network"


@dataclass
class SandboxConfig:
    """Configuration for sandbox execution."""
    # Directory limits
    max_files: int = 200
    max_file_size_bytes: int = 10 * 1024 * 1024   # 10 MB
    max_total_size_bytes: int = 100 * 1024 * 1024  # 100 MB

    # Execution limits
    max_wall_time_sec: float = 60.0
    max_cpu_time_sec: float = 30.0
    max_memory_mb: int = 512
    max_processes: int = 10

    # Network
    allow_network: bool = False

    # File system
    write_allowlist: List[str] = field(default_factory=lambda: [
        "*.py", "*.js", "*.ts", "*.jsx", "*.tsx",
        "*.json", "*.yaml", "*.yml", "*.toml",
        "*.css", "*.html", "*.md",
        "*.go", "*.rs", "*.java", "*.kt",
        "*.c", "*.cpp", "*.h", "*.hpp",
    ])
    write_denylist: List[str] = field(default_factory=lambda: [
        ".env", ".env.*", "*.pem", "*.key",
        "*.p12", "*.pfx", "*.cer",
        "credentials.*", "*secret*",
        "node_modules/**", ".git/**",
        "__pycache__/**", "*.pyc",
    ])

    # Snapshot options
    exclude_patterns: List[str] = field(default_factory=lambda: [
        "node_modules", ".git", "__pycache__", ".venv",
        "venv", ".next", "dist", "build", ".cache",
        "*.pyc", "*.pyo", ".DS_Store", "Thumbs.db",
    ])

    # Cleanup
    auto_cleanup: bool = True
    keep_on_failure: bool = False

    def to_dict(self) -> Dict[str, Any]:
        return {
            "maxFiles": self.max_files,
            "maxFileSizeBytes": self.max_file_size_bytes,
            "maxTotalSizeBytes": self.max_total_size_bytes,
            "maxWallTimeSec": self.max_wall_time_sec,
            "maxCpuTimeSec": self.max_cpu_time_sec,
            "maxMemoryMb": self.max_memory_mb,
            "maxProcesses": self.max_processes,
            "allowNetwork": self.allow_network,
            "autoCleanup": self.auto_cleanup,
        }


@dataclass
class SandboxResult:
    """Result of a sandbox execution."""
    state: SandboxState
    exit_code: int = -1
    stdout: str = ""
    stderr: str = ""
    duration_sec: float = 0.0
    files_modified: List[str] = field(default_factory=list)
    diffs: Dict[str, str] = field(default_factory=dict)  # file -> unified diff
    resource_usage: Dict[str, Any] = field(default_factory=dict)
    error: str = ""

    def to_dict(self) -> Dict[str, Any]:
        return {
            "state": self.state.value,
            "exitCode": self.exit_code,
            "stdout": self.stdout[:5000],
            "stderr": self.stderr[:5000],
            "durationSec": round(self.duration_sec, 2),
            "filesModified": self.files_modified,
            "diffs": {k: v[:2000] for k, v in self.diffs.items()},
            "resourceUsage": self.resource_usage,
            "error": self.error,
        }


@dataclass
class FileChecksum:
    """Track file state for diff detection."""
    path: str
    size: int
    checksum: str
    mtime: float


# ── Sandbox ───────────────────────────────────────────────────────────

class Sandbox:
    """
    An ephemeral sandbox environment for running repair operations.

    Lifecycle:
    1. snapshot() - copy relevant files from workspace
    2. apply_patch() - modify files in sandbox
    3. run_command() - execute build/test in sandbox
    4. collect_results() - compute diffs
    5. cleanup() - remove sandbox directory

    All operations are scoped to the sandbox directory.
    """

    def __init__(
        self,
        workspace_root: str,
        config: Optional[SandboxConfig] = None,
        sandbox_id: Optional[str] = None,
    ):
        self._workspace = Path(workspace_root).resolve()
        self._config = config or SandboxConfig()
        self._id = sandbox_id or f"sandbox_{int(time.time() * 1000)}"
        self._sandbox_dir: Optional[Path] = None
        self._state = SandboxState.CREATED
        self._file_checksums: Dict[str, FileChecksum] = {}
        self._created_at = time.time()

    @property
    def sandbox_dir(self) -> Optional[Path]:
        return self._sandbox_dir

    @property
    def state(self) -> SandboxState:
        return self._state

    @property
    def sandbox_id(self) -> str:
        return self._id

    def snapshot(
        self,
        files: Optional[List[str]] = None,
        max_depth: int = 5,
    ) -> str:
        """
        Create a snapshot of the workspace (or specific files).

        Args:
            files: Specific files to copy. If None, copies workspace
                   (respecting exclude_patterns and limits).
            max_depth: Max directory recursion depth.

        Returns:
            Path to the sandbox directory.
        """
        # Create temp directory
        self._sandbox_dir = Path(tempfile.mkdtemp(
            prefix=f"synthi_sandbox_{self._id}_",
        ))

        try:
            if files:
                self._snapshot_files(files)
            else:
                self._snapshot_workspace(max_depth)

            # Record initial checksums
            self._record_checksums()
            self._state = SandboxState.SNAPSHOTTED

            logger.info(
                f"Sandbox {self._id}: snapshotted "
                f"{len(self._file_checksums)} files to {self._sandbox_dir}"
            )

        except Exception as e:
            self._state = SandboxState.FAILED
            self.cleanup()
            raise RuntimeError(f"Snapshot failed: {e}") from e

        return str(self._sandbox_dir)

    def _snapshot_files(self, files: List[str]) -> None:
        """Copy specific files into sandbox."""
        assert self._sandbox_dir is not None
        copied = 0

        for rel_path in files:
            src = self._workspace / rel_path
            if not src.exists():
                logger.debug(f"Skipping missing file: {rel_path}")
                continue

            if not self._is_within_workspace(src):
                logger.warning(f"Path escapes workspace: {rel_path}")
                continue

            if src.stat().st_size > self._config.max_file_size_bytes:
                logger.debug(f"Skipping large file: {rel_path}")
                continue

            dst = self._sandbox_dir / rel_path
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(src), str(dst))
            copied += 1

            if copied >= self._config.max_files:
                logger.warning(f"File limit reached ({self._config.max_files})")
                break

    def _snapshot_workspace(self, max_depth: int) -> None:
        """Copy workspace tree into sandbox (respecting excludes)."""
        assert self._sandbox_dir is not None
        copied = 0
        total_size = 0
        exclude = set(self._config.exclude_patterns)

        for root_str, dirs, filenames in os.walk(str(self._workspace)):
            root = Path(root_str)
            depth = len(root.relative_to(self._workspace).parts)
            if depth > max_depth:
                dirs.clear()
                continue

            # Filter excluded directories
            dirs[:] = [
                d for d in dirs
                if d not in exclude and not any(
                    d.endswith(p.lstrip("*")) for p in exclude if "*" in p
                )
            ]

            for fn in filenames:
                if copied >= self._config.max_files:
                    return
                if fn in exclude or any(
                    fn.endswith(p.lstrip("*")) for p in exclude if "*" in p
                ):
                    continue

                src = root / fn
                try:
                    fsize = src.stat().st_size
                except OSError:
                    continue

                if fsize > self._config.max_file_size_bytes:
                    continue
                if total_size + fsize > self._config.max_total_size_bytes:
                    logger.warning("Total size limit reached")
                    return

                rel = src.relative_to(self._workspace)
                dst = self._sandbox_dir / rel
                dst.parent.mkdir(parents=True, exist_ok=True)

                try:
                    shutil.copy2(str(src), str(dst))
                    copied += 1
                    total_size += fsize
                except (PermissionError, OSError) as e:
                    logger.debug(f"Cannot copy {rel}: {e}")

    def _record_checksums(self) -> None:
        """Record checksums of all files in sandbox."""
        assert self._sandbox_dir is not None
        self._file_checksums.clear()

        for path in self._sandbox_dir.rglob("*"):
            if path.is_file():
                try:
                    data = path.read_bytes()
                    rel = str(path.relative_to(self._sandbox_dir))
                    self._file_checksums[rel] = FileChecksum(
                        path=rel,
                        size=len(data),
                        checksum=hashlib.sha256(data).hexdigest(),
                        mtime=path.stat().st_mtime,
                    )
                except (PermissionError, OSError):
                    pass

    def _is_within_workspace(self, path: Path) -> bool:
        """Check path doesn't escape workspace."""
        try:
            path.resolve().relative_to(self._workspace)
            return True
        except ValueError:
            return False

    def _is_write_allowed(self, rel_path: str) -> bool:
        """Check if writing to this file is allowed by config."""
        from fnmatch import fnmatch

        # Check denylist first
        for pattern in self._config.write_denylist:
            if fnmatch(rel_path, pattern):
                return False

        # Check allowlist
        for pattern in self._config.write_allowlist:
            if fnmatch(rel_path, pattern) or fnmatch(os.path.basename(rel_path), pattern):
                return True

        return False

    def apply_patch(
        self,
        file_path: str,
        new_content: str,
    ) -> bool:
        """
        Apply a file change in the sandbox.

        Args:
            file_path: Relative path within sandbox.
            new_content: New file content.

        Returns:
            True on success.

        Raises:
            RuntimeError: if sandbox not snapshotted or write not allowed.
        """
        if self._state not in (SandboxState.SNAPSHOTTED, SandboxState.RUNNING):
            raise RuntimeError(f"Cannot apply patch in state {self._state.value}")

        if not self._sandbox_dir:
            raise RuntimeError("No sandbox directory")

        if not self._is_write_allowed(file_path):
            raise RuntimeError(f"Write not allowed: {file_path}")

        target = self._sandbox_dir / file_path
        if not str(target.resolve()).startswith(str(self._sandbox_dir.resolve())):
            raise RuntimeError(f"Path escapes sandbox: {file_path}")

        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(new_content, encoding="utf-8")

        self._state = SandboxState.RUNNING
        return True

    async def run_command(
        self,
        command: List[str],
        env: Optional[Dict[str, str]] = None,
        timeout: Optional[float] = None,
    ) -> SandboxResult:
        """
        Execute a command in the sandbox directory.

        Args:
            command: Command and arguments.
            env: Extra environment variables.
            timeout: Override wall time limit.

        Returns:
            SandboxResult with stdout, stderr, exit_code.
        """
        if not self._sandbox_dir:
            return SandboxResult(
                state=SandboxState.FAILED,
                error="No sandbox directory",
            )

        self._state = SandboxState.RUNNING
        wall_time = timeout or self._config.max_wall_time_sec

        # Build environment
        cmd_env = os.environ.copy()
        # Strip dangerous env vars
        for key in ["AWS_", "AZURE_", "GCP_", "GITHUB_TOKEN", "NPM_TOKEN"]:
            for k in list(cmd_env.keys()):
                if k.startswith(key) or k == key:
                    del cmd_env[k]

        if env:
            cmd_env.update(env)

        start = time.perf_counter()

        try:
            proc = await asyncio.create_subprocess_exec(
                *command,
                cwd=str(self._sandbox_dir),
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env=cmd_env,
            )

            try:
                stdout_bytes, stderr_bytes = await asyncio.wait_for(
                    proc.communicate(), timeout=wall_time
                )
            except asyncio.TimeoutError:
                proc.kill()
                await proc.wait()
                elapsed = time.perf_counter() - start
                return SandboxResult(
                    state=SandboxState.FAILED,
                    exit_code=-1,
                    stderr=f"Killed: exceeded wall time limit ({wall_time}s)",
                    duration_sec=elapsed,
                    error=f"Timeout after {elapsed:.1f}s",
                )

            elapsed = time.perf_counter() - start

            exit_code = proc.returncode or 0
            state = SandboxState.SUCCEEDED if exit_code == 0 else SandboxState.FAILED

            return SandboxResult(
                state=state,
                exit_code=exit_code,
                stdout=stdout_bytes.decode("utf-8", errors="replace")[:50000],
                stderr=stderr_bytes.decode("utf-8", errors="replace")[:50000],
                duration_sec=elapsed,
            )

        except FileNotFoundError:
            return SandboxResult(
                state=SandboxState.FAILED,
                error=f"Command not found: {command[0]}",
            )
        except Exception as e:
            return SandboxResult(
                state=SandboxState.FAILED,
                error=str(e),
            )

    def collect_results(self) -> SandboxResult:
        """
        Collect diffs by comparing sandbox to initial checksums.

        Returns a SandboxResult with modified files and diffs.
        """
        if not self._sandbox_dir:
            return SandboxResult(
                state=SandboxState.FAILED,
                error="No sandbox directory",
            )

        import difflib

        modified = []
        diffs = {}

        for path in self._sandbox_dir.rglob("*"):
            if not path.is_file():
                continue

            rel = str(path.relative_to(self._sandbox_dir))

            try:
                data = path.read_bytes()
                new_checksum = hashlib.sha256(data).hexdigest()
            except (PermissionError, OSError):
                continue

            old_cs = self._file_checksums.get(rel)

            if old_cs is None:
                # New file
                modified.append(rel)
                diffs[rel] = f"+++ {rel} (new file)\n"
            elif new_checksum != old_cs.checksum:
                # Modified file
                modified.append(rel)

                # Generate unified diff
                try:
                    old_content = (self._workspace / rel).read_text(
                        encoding="utf-8", errors="replace"
                    )
                    new_content = data.decode("utf-8", errors="replace")
                    diff_lines = difflib.unified_diff(
                        old_content.splitlines(keepends=True),
                        new_content.splitlines(keepends=True),
                        fromfile=f"a/{rel}",
                        tofile=f"b/{rel}",
                    )
                    diffs[rel] = "".join(diff_lines)
                except Exception:
                    diffs[rel] = f"--- {rel}\n+++ {rel}\n(binary or unreadable)\n"

        # Check for deleted files
        for rel in self._file_checksums:
            sandbox_path = self._sandbox_dir / rel
            if not sandbox_path.exists():
                modified.append(rel)
                diffs[rel] = f"--- {rel} (deleted)\n"

        return SandboxResult(
            state=self._state,
            files_modified=modified,
            diffs=diffs,
        )

    def promote(self, files: Optional[List[str]] = None) -> List[str]:
        """
        Copy modified files from sandbox back to the real workspace.

        Args:
            files: Specific files to promote. If None, promotes all modified.

        Returns:
            List of promoted file paths.
        """
        if not self._sandbox_dir:
            raise RuntimeError("No sandbox directory")

        results = self.collect_results()
        to_promote = files or results.files_modified
        promoted = []

        for rel in to_promote:
            src = self._sandbox_dir / rel
            dst = self._workspace / rel

            if not src.exists():
                # File was deleted in sandbox → delete from workspace
                if dst.exists():
                    dst.unlink()
                    promoted.append(rel)
                continue

            if not self._is_write_allowed(rel):
                logger.warning(f"Cannot promote {rel}: not in write allowlist")
                continue

            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(str(src), str(dst))
            promoted.append(rel)

        logger.info(f"Sandbox {self._id}: promoted {len(promoted)} files")
        return promoted

    def cleanup(self) -> None:
        """Remove the sandbox directory."""
        if self._sandbox_dir and self._sandbox_dir.exists():
            try:
                # Handle read-only files (e.g., .git objects)
                def _rm_readonly(func, path, exc_info):
                    os.chmod(path, stat.S_IWRITE)
                    func(path)

                shutil.rmtree(str(self._sandbox_dir), onerror=_rm_readonly)
                logger.debug(f"Sandbox {self._id}: cleaned up")
            except Exception as e:
                logger.warning(f"Sandbox cleanup failed: {e}")

        self._state = SandboxState.DISCARDED

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        if self._config.auto_cleanup:
            if not (exc_type and self._config.keep_on_failure):
                self.cleanup()
        return False


# ── Sandbox Manager ───────────────────────────────────────────────────

class SandboxManager:
    """
    Manages sandbox lifecycle: creation, tracking, cleanup.

    Limits the number of concurrent sandboxes and provides
    cleanup of stale ones.
    """

    def __init__(
        self,
        workspace_root: str,
        default_config: Optional[SandboxConfig] = None,
        max_concurrent: int = 3,
        max_age_sec: float = 300.0,
    ):
        self._workspace = workspace_root
        self._default_config = default_config or SandboxConfig()
        self._max_concurrent = max_concurrent
        self._max_age = max_age_sec
        self._active: Dict[str, Sandbox] = {}

    @property
    def active_count(self) -> int:
        return len(self._active)

    def create(
        self,
        config: Optional[SandboxConfig] = None,
        sandbox_id: Optional[str] = None,
    ) -> Sandbox:
        """Create a new sandbox."""
        # Cleanup stale sandboxes
        self._cleanup_stale()

        if len(self._active) >= self._max_concurrent:
            # Evict oldest
            oldest_id = min(
                self._active,
                key=lambda k: self._active[k]._created_at,
            )
            self._active[oldest_id].cleanup()
            del self._active[oldest_id]

        sandbox = Sandbox(
            workspace_root=self._workspace,
            config=config or self._default_config,
            sandbox_id=sandbox_id,
        )
        self._active[sandbox.sandbox_id] = sandbox
        return sandbox

    def get(self, sandbox_id: str) -> Optional[Sandbox]:
        return self._active.get(sandbox_id)

    def discard(self, sandbox_id: str) -> None:
        """Cleanup and remove a sandbox."""
        sandbox = self._active.pop(sandbox_id, None)
        if sandbox:
            sandbox.cleanup()

    def discard_all(self) -> None:
        """Cleanup all sandboxes."""
        for sandbox in self._active.values():
            sandbox.cleanup()
        self._active.clear()

    def _cleanup_stale(self) -> None:
        """Remove sandboxes that have exceeded their max age."""
        now = time.time()
        stale = [
            sid for sid, sb in self._active.items()
            if (now - sb._created_at) > self._max_age
        ]
        for sid in stale:
            self._active[sid].cleanup()
            del self._active[sid]

    def status(self) -> Dict[str, Any]:
        return {
            "activeSandboxes": self.active_count,
            "maxConcurrent": self._max_concurrent,
            "sandboxes": [
                {
                    "id": sb.sandbox_id,
                    "state": sb.state.value,
                    "dir": str(sb.sandbox_dir) if sb.sandbox_dir else None,
                    "ageSec": round(time.time() - sb._created_at, 1),
                }
                for sb in self._active.values()
            ],
        }


# ── Module-level singleton ────────────────────────────────────────────

_sandbox_manager: Optional[SandboxManager] = None


def get_sandbox_manager(workspace_root: str = "", **kwargs) -> SandboxManager:
    """Get or create the global sandbox manager."""
    global _sandbox_manager
    if _sandbox_manager is None:
        if not workspace_root:
            raise ValueError("workspace_root required for first call")
        _sandbox_manager = SandboxManager(workspace_root, **kwargs)
    return _sandbox_manager


def reset_sandbox_manager() -> None:
    """Reset and cleanup (for testing)."""
    global _sandbox_manager
    if _sandbox_manager:
        _sandbox_manager.discard_all()
    _sandbox_manager = None
