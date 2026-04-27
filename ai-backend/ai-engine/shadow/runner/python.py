"""Python toolchain: ruff + mypy + pytest. Master plan §9."""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import List

from .base import BUDGETS, Diagnostic, Runner, RunResult, run_cmd

logger = logging.getLogger("shadow.runner.python")


class PythonRunner(Runner):
    name = "python"

    async def run(self, worktree: Path, changed_files: List[str]) -> RunResult:
        result = RunResult()
        py_files = [f for f in changed_files if f.endswith(".py")]
        targets = py_files or ["."]

        # ---- lint: ruff ---------------------------------------------------
        rc, out, err, finished = await run_cmd(
            ["ruff", "check", "--output-format=json", *targets],
            cwd=worktree,
            timeout=BUDGETS["lint"],
        )
        if finished and rc != 127:
            diags: List[Diagnostic] = []
            try:
                items = json.loads(out) if out.strip() else []
                for item in items:
                    diags.append(Diagnostic(
                        code=str(item.get("code") or "ruff"),
                        msg=str(item.get("message", "")),
                        file=item.get("filename"),
                        line=(item.get("location") or {}).get("row"),
                        severity="error",
                    ))
            except Exception:
                if out.strip():
                    diags.append(Diagnostic(code="ruff", msg=out.strip()[:300]))
            result.lint = (diags, True)

        # ---- types: mypy --------------------------------------------------
        rc, out, err, finished = await run_cmd(
            ["mypy", "--hide-error-context", "--no-color-output", "--no-error-summary", *targets],
            cwd=worktree,
            timeout=BUDGETS["types"],
        )
        if finished and rc != 127:
            diags = _parse_mypy(out)
            result.types = (diags, True)

        # ---- tests: pytest (changed-modules only) -------------------------
        if py_files:
            rc, out, err, finished = await run_cmd(
                ["pytest", "-x", "--timeout=10", "-q", *py_files],
                cwd=worktree,
                timeout=BUDGETS["tests"],
            )
            if finished and rc != 127:
                passed, total = _parse_pytest_summary(out)
                result.tests = ({"passed": passed, "total": total, "rc": rc}, True)

        # ---- runtime: import-time smoke test (master plan §9 row 1) ------
        # For each changed Python file, exec the module body in a fresh
        # subprocess and capture stderr. Catches NameError / ImportError /
        # SyntaxError that lint+types+pytest didn't (e.g. modules with no
        # tests, top-level statements that throw on import).
        if py_files:
            failures: List[Dict[str, Any]] = []
            for f in py_files[:8]:  # cap at 8 files to stay in budget
                rc, out, err, finished = await run_cmd(
                    [
                        "python", "-c",
                        # Use exec_module to mirror real import semantics
                        # without firing __name__ == "__main__" blocks.
                        "import sys, importlib.util\n"
                        f"_p = {f!r}\n"
                        "spec = importlib.util.spec_from_file_location('__shadow_probe', _p)\n"
                        "if spec is None or spec.loader is None: sys.exit(0)\n"
                        "m = importlib.util.module_from_spec(spec)\n"
                        "try:\n"
                        "    spec.loader.exec_module(m)\n"
                        "except SystemExit:\n"
                        "    pass\n",
                    ],
                    cwd=worktree, timeout=BUDGETS["runtime"],
                )
                if not finished:
                    failures.append({"file": f, "msg": "runtime probe timed out"})
                elif rc != 0:
                    failures.append({"file": f, "msg": (err.strip().splitlines()[-1] if err else f"exit {rc}")[:240]})
            result.runtime = ({"clean": not failures, "failures": failures}, True)
        else:
            result.runtime = ({"clean": True}, False)
        return result


_MYPY_LINE = re.compile(r"^(?P<file>[^:]+):(?P<line>\d+):\s*(?P<sev>error|warning|note):\s*(?P<msg>.+?)(?:\s+\[(?P<code>[^\]]+)\])?\s*$")


def _parse_mypy(stdout: str) -> List[Diagnostic]:
    diags: List[Diagnostic] = []
    for raw in stdout.splitlines():
        m = _MYPY_LINE.match(raw)
        if not m:
            continue
        diags.append(Diagnostic(
            code=m.group("code") or "mypy",
            msg=m.group("msg"),
            file=m.group("file"),
            line=int(m.group("line")),
            severity=m.group("sev"),
        ))
    return diags


_PYTEST_SUMMARY = re.compile(r"(?P<passed>\d+)\s+passed|(?P<failed>\d+)\s+failed|(?P<errors>\d+)\s+error")


def _parse_pytest_summary(stdout: str) -> tuple[int, int]:
    passed = failed = errors = 0
    for line in stdout.splitlines()[-12:]:
        for m in _PYTEST_SUMMARY.finditer(line):
            if m.group("passed"):
                passed = int(m.group("passed"))
            if m.group("failed"):
                failed = int(m.group("failed"))
            if m.group("errors"):
                errors = int(m.group("errors"))
    total = passed + failed + errors
    return passed, total
