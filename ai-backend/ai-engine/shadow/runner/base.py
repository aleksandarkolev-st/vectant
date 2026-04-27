"""Runner protocol. Master plan §9.

A Runner takes a worktree path + the list of changed files, executes the
language toolchain stages (lint, types, tests, runtime), and returns a
structured RunResult. Each stage has a wall-clock budget.
"""

from __future__ import annotations

import asyncio
import logging
import os
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

logger = logging.getLogger("shadow.runner")

# Wall-clock budgets per stage (seconds), §9.
BUDGETS = {"lint": 5, "types": 8, "tests": 10, "runtime": 6}


@dataclass
class Diagnostic:
    code: str
    msg: str
    file: Optional[str] = None
    line: Optional[int] = None
    severity: str = "error"  # "error" | "warning" | "note"


@dataclass
class RunResult:
    lint:    Tuple[List[Diagnostic], bool] = field(default_factory=lambda: ([], False))    # (diags, ran)
    types:   Tuple[List[Diagnostic], bool] = field(default_factory=lambda: ([], False))
    tests:   Tuple[Dict[str, Any], bool]   = field(default_factory=lambda: ({"passed": 0, "total": 0}, False))
    runtime: Tuple[Dict[str, Any], bool]   = field(default_factory=lambda: ({"clean": True}, False))

    def diagnostics_count(self) -> int:
        return (
            sum(1 for d in self.lint[0] if d.severity == "error")
            + sum(1 for d in self.types[0] if d.severity == "error")
        )

    def to_evidence(self) -> Dict[str, Any]:
        def diag_summary(diags: List[Diagnostic], ran: bool):
            if not ran:
                return "skipped"
            errs = [d for d in diags if d.severity == "error"]
            if not errs:
                return "clean"
            return [{"code": d.code, "msg": d.msg, "at": f"{d.file or '?'}:{d.line or '?'}"} for d in errs[:5]]

        tests, tests_ran = self.tests
        runtime, runtime_ran = self.runtime
        return {
            "lint":    diag_summary(self.lint[0],  self.lint[1]),
            "types":   diag_summary(self.types[0], self.types[1]),
            "tests":   (f"{tests.get('passed', 0)}/{tests.get('total', 0)} passed" if tests_ran else "skipped"),
            "runtime": ("clean" if (runtime_ran and runtime.get("clean")) else ("dirty" if runtime_ran else "skipped")),
        }


class Runner(ABC):
    name: str = "base"

    @abstractmethod
    async def run(self, worktree: Path, changed_files: List[str]) -> RunResult:
        ...


# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------

def detect_runner(worktree: Path, changed_files: List[str]) -> Runner:
    """Pick the most specific runner that matches the workspace + changes.

    Priority: any changed file that's clearly Python/Node beats project-wide
    detection, because we want to run exactly what was touched.
    """
    has_py = any(f.endswith((".py",)) for f in changed_files)
    has_node = any(f.endswith((".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs")) for f in changed_files)

    if has_node:
        from .node import NodeRunner
        return NodeRunner()
    if has_py:
        from .python import PythonRunner
        return PythonRunner()

    # Project-level fallback
    if (worktree / "package.json").exists():
        from .node import NodeRunner
        return NodeRunner()
    if (worktree / "pyproject.toml").exists() or (worktree / "requirements.txt").exists():
        from .python import PythonRunner
        return PythonRunner()

    from .syntax import SyntaxRunner
    return SyntaxRunner()


# ---------------------------------------------------------------------------
# Subprocess helpers shared by runners
# ---------------------------------------------------------------------------

async def run_cmd(
    argv: List[str],
    *,
    cwd: Path,
    timeout: float,
    env_extra: Optional[Dict[str, str]] = None,
) -> Tuple[int, str, str, bool]:
    """Run a command with a wall-clock budget. Returns (rc, stdout, stderr, finished)."""
    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)
    try:
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=str(cwd),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
    except FileNotFoundError:
        return 127, "", f"binary not found: {argv[0]}", False

    try:
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError:
        proc.kill()
        await proc.wait()
        return -1, "", f"timed out after {timeout}s", False

    return (
        proc.returncode if proc.returncode is not None else -1,
        stdout.decode("utf-8", errors="replace"),
        stderr.decode("utf-8", errors="replace"),
        True,
    )
