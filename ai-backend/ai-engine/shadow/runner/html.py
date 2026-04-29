"""HTML / CSS toolchain. Master plan §9 row 6 (Wave 3).

`htmlhint` for HTML, `stylelint` for CSS. Headless-Chromium snapshot diff
is master-plan-listed but heavyweight — left for a follow-up; the cheap
linters cover most "patch broke the markup" failures.

Missing binaries return the runner with everything skipped — the
worktree still has the syntax-runner fallback to catch parse errors.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path
from typing import Any, Dict, List

from .base import BUDGETS, Diagnostic, Runner, RunResult, run_cmd

logger = logging.getLogger("shadow.runner.html")


class HtmlRunner(Runner):
    name = "html"

    async def run(self, worktree: Path, changed_files: List[str]) -> RunResult:
        result = RunResult()
        html_files = [f for f in changed_files if f.endswith(".html") or f.endswith(".htm")]
        css_files = [f for f in changed_files if f.endswith(".css")]
        targets = html_files or css_files
        if not targets:
            return result

        diags: List[Diagnostic] = []

        # ---- htmlhint ----------------------------------------------------
        if html_files:
            rc, out, err, finished = await run_cmd(
                ["npx", "--no-install", "htmlhint", "--format", "json", *html_files],
                cwd=worktree, timeout=BUDGETS["lint"],
            )
            if finished and rc != 127:
                diags.extend(_parse_htmlhint_json(out))

        # ---- stylelint ---------------------------------------------------
        if css_files:
            rc, out, err, finished = await run_cmd(
                ["npx", "--no-install", "stylelint", "--formatter=json", *css_files],
                cwd=worktree, timeout=BUDGETS["lint"],
            )
            if finished and rc != 127:
                diags.extend(_parse_stylelint_json(out))

        result.lint = (diags, True)
        # No type, test, or runtime stage on the cheap path.
        return result


def _parse_htmlhint_json(stdout: str) -> List[Diagnostic]:
    try:
        files = json.loads(stdout)
    except Exception:
        return []
    diags: List[Diagnostic] = []
    for f in files or []:
        for msg in f.get("messages", []):
            sev = "error" if msg.get("type") == "error" else "warning"
            diags.append(Diagnostic(
                code=str(msg.get("rule", {}).get("id") or "htmlhint"),
                msg=str(msg.get("message", ""))[:240],
                file=f.get("file"),
                line=msg.get("line"),
                severity=sev,
            ))
    return diags


def _parse_stylelint_json(stdout: str) -> List[Diagnostic]:
    try:
        files = json.loads(stdout)
    except Exception:
        return []
    diags: List[Diagnostic] = []
    for f in files or []:
        for msg in f.get("warnings", []):
            sev = "error" if msg.get("severity") == "error" else "warning"
            diags.append(Diagnostic(
                code=str(msg.get("rule") or "stylelint"),
                msg=str(msg.get("text", ""))[:240],
                file=f.get("source"),
                line=msg.get("line"),
                severity=sev,
            ))
    return diags
