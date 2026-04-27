"""Go toolchain. Master plan §9 row 4 (Wave 3).

`go vet` for types/lint, `go test -timeout 10s ./...` for tests, `go build`
for the runtime probe. All stages are wall-clock budgeted via run_cmd; a
missing `go` binary returns the runner with everything skipped — the
universe still scores against whatever else the worktree exposes.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Dict, List

from .base import BUDGETS, Diagnostic, Runner, RunResult, run_cmd

logger = logging.getLogger("shadow.runner.go")


class GoRunner(Runner):
    name = "go"

    async def run(self, worktree: Path, changed_files: List[str]) -> RunResult:
        result = RunResult()
        go_files = [f for f in changed_files if f.endswith(".go")]
        targets = ["./..."]

        # ---- vet: combines lint + light type-check for Go ----------------
        rc, out, err, finished = await run_cmd(
            ["go", "vet", *targets],
            cwd=worktree,
            timeout=BUDGETS["types"],
        )
        if finished and rc != 127:
            diags = _parse_go_diagnostics(out + "\n" + err)
            # vet's exit code is non-zero on any reported issue, but the diags
            # carry the actual error count.
            result.types = (diags, True)
            # Reuse the same diags as the lint stage — Go's vet covers both
            # categories conceptually; downstream scoring just sums errors.
            result.lint = (diags, True)

        # ---- tests: go test ---------------------------------------------
        rc, out, err, finished = await run_cmd(
            ["go", "test", "-timeout", "10s", "-count=1", *targets],
            cwd=worktree,
            timeout=BUDGETS["tests"],
        )
        if finished and rc != 127:
            passed, total = _parse_go_test(out)
            result.tests = ({"passed": passed, "total": total, "rc": rc}, True)

        # ---- runtime probe: go build ------------------------------------
        if go_files:
            rc, out, err, finished = await run_cmd(
                ["go", "build", "-o", "/dev/null", *targets],
                cwd=worktree, timeout=BUDGETS["runtime"],
            )
            failures: List[Dict[str, Any]] = []
            if not finished:
                failures.append({"file": "build", "msg": "go build timed out"})
            elif rc != 0:
                failures.append({
                    "file": "build",
                    "msg": (err.strip().splitlines()[-1] if err else f"exit {rc}")[:240],
                })
            result.runtime = ({"clean": not failures, "failures": failures}, True)
        else:
            result.runtime = ({"clean": True}, False)
        return result


_GO_VET_LINE = re.compile(r"^(?P<file>[^:]+):(?P<line>\d+)(?::\d+)?:\s*(?P<msg>.+)$")


def _parse_go_diagnostics(text: str) -> List[Diagnostic]:
    diags: List[Diagnostic] = []
    for raw in text.splitlines():
        if not raw or raw.startswith("ok ") or raw.startswith("--- "):
            continue
        m = _GO_VET_LINE.match(raw)
        if not m:
            continue
        diags.append(Diagnostic(
            code="go-vet",
            msg=m.group("msg").strip(),
            file=m.group("file"),
            line=int(m.group("line")),
            severity="error",
        ))
    return diags


_GO_TEST_PASS = re.compile(r"^--- PASS: ", re.MULTILINE)
_GO_TEST_FAIL = re.compile(r"^--- FAIL: ", re.MULTILINE)


def _parse_go_test(stdout: str) -> tuple[int, int]:
    passed = len(_GO_TEST_PASS.findall(stdout))
    failed = len(_GO_TEST_FAIL.findall(stdout))
    return passed, passed + failed
