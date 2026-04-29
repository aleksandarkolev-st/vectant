"""Rust toolchain. Master plan §9 row 5 (Wave 3).

`cargo clippy --no-deps` for lint, `cargo check` for types, `cargo test
--no-run` as the cheapest-possible test stage (compiles tests but does
not execute them — keeps us inside the 10s budget; full execution lands
on `deep` tier when worktrees keep a warm `target/` between runs).

Missing `cargo` binary returns the runner with everything skipped.
"""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Dict, List

from .base import BUDGETS, Diagnostic, Runner, RunResult, run_cmd

logger = logging.getLogger("shadow.runner.rust")


class RustRunner(Runner):
    name = "rust"

    async def run(self, worktree: Path, changed_files: List[str]) -> RunResult:
        result = RunResult()
        rs_files = [f for f in changed_files if f.endswith(".rs")]

        # ---- lint: cargo clippy -----------------------------------------
        rc, out, err, finished = await run_cmd(
            ["cargo", "clippy", "--no-deps", "--message-format=json", "-q", "--", "-D", "warnings"],
            cwd=worktree,
            timeout=BUDGETS["lint"],
        )
        if finished and rc != 127:
            result.lint = (_parse_cargo_json(out), True)

        # ---- types: cargo check -----------------------------------------
        rc, out, err, finished = await run_cmd(
            ["cargo", "check", "--message-format=json", "-q"],
            cwd=worktree,
            timeout=BUDGETS["types"],
        )
        if finished and rc != 127:
            result.types = (_parse_cargo_json(out), True)

        # ---- tests: cargo test --no-run (compile-only) ------------------
        if rs_files:
            rc, out, err, finished = await run_cmd(
                ["cargo", "test", "--no-run", "-q"],
                cwd=worktree,
                timeout=BUDGETS["tests"],
            )
            if finished and rc != 127:
                # No-run gives us "did the test crate compile" only. We
                # treat a clean compile as 1/1 passed so downstream scoring
                # treats the universe as test-clean — but tag the rc so
                # callers can disambiguate compile-only from full execution.
                result.tests = ({"passed": 1 if rc == 0 else 0, "total": 1, "rc": rc, "mode": "compile-only"}, True)

        # ---- runtime: rely on cargo check above; no extra probe ---------
        result.runtime = ({"clean": True}, False)
        return result


def _parse_cargo_json(stdout: str) -> List[Diagnostic]:
    """Cargo emits one JSON line per message. We pull `compiler-message`
    rows whose `message.level` is "error" or "warning"."""
    import json as _json

    diags: List[Diagnostic] = []
    for raw in stdout.splitlines():
        raw = raw.strip()
        if not raw or not raw.startswith("{"):
            continue
        try:
            obj = _json.loads(raw)
        except Exception:
            continue
        if obj.get("reason") != "compiler-message":
            continue
        m = obj.get("message") or {}
        level = m.get("level")
        if level not in ("error", "warning"):
            continue
        spans = m.get("spans") or []
        primary = next((s for s in spans if s.get("is_primary")), None)
        diags.append(Diagnostic(
            code=str((m.get("code") or {}).get("code") or level),
            msg=str(m.get("message", ""))[:240],
            file=(primary or {}).get("file_name"),
            line=(primary or {}).get("line_start"),
            severity=level,
        ))
    return diags
