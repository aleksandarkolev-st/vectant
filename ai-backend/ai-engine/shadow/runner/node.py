"""Node.js / TypeScript toolchain. Master plan §9.

eslint + tsc --noEmit + vitest/jest run --changed. Wave 1 also reserves
hooks for the dev-server runtime probe (Wave 3).
"""

from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any, Dict, List

from .base import BUDGETS, Diagnostic, Runner, RunResult, run_cmd

logger = logging.getLogger("shadow.runner.node")


class NodeRunner(Runner):
    name = "node"

    async def run(self, worktree: Path, changed_files: List[str]) -> RunResult:
        result = RunResult()
        node_files = [
            f for f in changed_files
            if f.endswith((".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"))
        ]
        targets = node_files or ["."]

        # ---- lint: eslint -----------------------------------------------
        rc, out, err, finished = await run_cmd(
            ["npx", "--no-install", "eslint", "-f", "json", "--no-error-on-unmatched-pattern", *targets],
            cwd=worktree,
            timeout=BUDGETS["lint"],
        )
        if finished and rc != 127:
            result.lint = (_parse_eslint_json(out), True)

        # ---- types: tsc --------------------------------------------------
        if (worktree / "tsconfig.json").exists():
            rc, out, err, finished = await run_cmd(
                ["npx", "--no-install", "tsc", "--noEmit", "--pretty", "false"],
                cwd=worktree,
                timeout=BUDGETS["types"],
            )
            if finished and rc != 127:
                result.types = (_parse_tsc(out + "\n" + err), True)

        # ---- tests: vitest preferred, jest fallback ----------------------
        test_runner = _detect_test_runner(worktree)
        if test_runner == "vitest":
            rc, out, err, finished = await run_cmd(
                ["npx", "--no-install", "vitest", "run", "--changed", "--reporter=json"],
                cwd=worktree,
                timeout=BUDGETS["tests"],
            )
            if finished and rc != 127:
                result.tests = (_parse_vitest_json(out), True)
        elif test_runner == "jest":
            rc, out, err, finished = await run_cmd(
                ["npx", "--no-install", "jest", "-o", "--json"],
                cwd=worktree,
                timeout=BUDGETS["tests"],
            )
            if finished and rc != 127:
                result.tests = (_parse_jest_json(out), True)

        # ---- runtime: per-file `node --check` + require()-style smoke ----
        # Catches syntax + module-resolution errors lint/types missed.
        # The full `next dev` for 5s + route-hitting probe (master plan §9
        # row 2 column 5) is heavier and Next.js-specific; we ship the
        # cheap baseline now and leave the dev-server probe for Wave 3.
        if node_files:
            failures: List[Dict[str, Any]] = []
            check_targets = [f for f in node_files if f.endswith((".js", ".mjs", ".cjs"))]
            for f in check_targets[:8]:
                rc, out, err, finished = await run_cmd(
                    ["node", "--check", f], cwd=worktree, timeout=BUDGETS["runtime"] / 2,
                )
                if not finished:
                    failures.append({"file": f, "msg": "node --check timed out"})
                elif rc != 0:
                    failures.append({"file": f, "msg": (err.strip().splitlines()[-1] if err else f"exit {rc}")[:240]})
            # Try to actually require() the first changed JS module.
            # `require()` treats bare names as node_modules; use a "./" prefix
            # so the relative path resolves against the CWD.
            if check_targets:
                first = check_targets[0]
                first_rel = first if first.startswith(("./", "../", "/")) else f"./{first}"
                rc, out, err, finished = await run_cmd(
                    ["node", "-e", f"try {{ require({first_rel!r}); }} catch (e) {{ console.error(e.message); process.exit(1); }}"],
                    cwd=worktree, timeout=BUDGETS["runtime"] / 2,
                )
                if finished and rc != 0:
                    failures.append({"file": first, "msg": (err.strip().splitlines()[-1] if err else "require failed")[:240]})
            result.runtime = ({"clean": not failures, "failures": failures}, True)
        else:
            result.runtime = ({"clean": True}, False)
        return result


def _detect_test_runner(worktree: Path) -> str:
    pkg = worktree / "package.json"
    if not pkg.exists():
        return ""
    try:
        data = json.loads(pkg.read_text(encoding="utf-8"))
    except Exception:
        return ""
    deps = {**(data.get("dependencies") or {}), **(data.get("devDependencies") or {})}
    if "vitest" in deps:
        return "vitest"
    if "jest" in deps:
        return "jest"
    return ""


def _parse_eslint_json(stdout: str) -> List[Diagnostic]:
    diags: List[Diagnostic] = []
    try:
        files = json.loads(stdout) if stdout.strip().startswith("[") else []
    except Exception:
        return diags
    for f in files:
        for msg in f.get("messages", []):
            sev = "error" if msg.get("severity") == 2 else "warning"
            diags.append(Diagnostic(
                code=str(msg.get("ruleId") or "eslint"),
                msg=str(msg.get("message", "")),
                file=f.get("filePath"),
                line=msg.get("line"),
                severity=sev,
            ))
    return diags


_TSC_LINE = re.compile(r"^(?P<file>[^()]+)\((?P<line>\d+),\d+\):\s+(?P<sev>error|warning)\s+(?P<code>TS\d+):\s+(?P<msg>.+)$")


def _parse_tsc(stdout: str) -> List[Diagnostic]:
    diags: List[Diagnostic] = []
    for raw in stdout.splitlines():
        m = _TSC_LINE.match(raw)
        if not m:
            continue
        diags.append(Diagnostic(
            code=m.group("code"),
            msg=m.group("msg"),
            file=m.group("file"),
            line=int(m.group("line")),
            severity=m.group("sev"),
        ))
    return diags


def _parse_vitest_json(stdout: str) -> Dict[str, Any]:
    try:
        data = json.loads(stdout)
    except Exception:
        return {"passed": 0, "total": 0}
    passed = int(data.get("numPassedTests", 0))
    total = int(data.get("numTotalTests", 0))
    return {"passed": passed, "total": total}


def _parse_jest_json(stdout: str) -> Dict[str, Any]:
    try:
        data = json.loads(stdout)
    except Exception:
        return {"passed": 0, "total": 0}
    return {
        "passed": int(data.get("numPassedTests", 0)),
        "total": int(data.get("numTotalTests", 0)),
    }
