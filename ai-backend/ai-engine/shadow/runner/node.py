"""Node.js / TypeScript toolchain. Master plan §9.

eslint + tsc --noEmit + vitest/jest run --changed. Wave 3 adds the
dev-server runtime probe — boot Next.js for ~5s in the worktree, hit
the routes derived from changed files, capture any 5xx responses or
hard crashes.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import socket
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

from .base import BUDGETS, Diagnostic, Runner, RunResult, run_cmd

logger = logging.getLogger("shadow.runner.node")

# Next.js dev-server probe knobs (Wave 3, master plan §9 row 2 col 5).
DEV_SERVER_BOOT_BUDGET_SEC = 5.0
DEV_SERVER_HIT_BUDGET_SEC = 1.5
DEV_SERVER_ROUTE_CAP = 4


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
        # Wave 3 layers a Next.js dev-server probe on top: boot `next dev`
        # for ~5s in the worktree and hit the routes derived from the
        # changed files. Failures from either stage are merged into a
        # single runtime evidence block.
        failures: List[Dict[str, Any]] = []
        if node_files:
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

        # Next.js dev-server probe — only when the project is detectably
        # Next.js *and* the patch touched routable files. Cheap to skip
        # entirely when neither condition holds.
        if _looks_like_next_app(worktree):
            routes = _routes_for_changes(worktree, node_files)
            if routes:
                dev_failures = await _next_dev_probe(worktree, routes)
                failures.extend(dev_failures)

        if node_files or _looks_like_next_app(worktree):
            result.runtime = ({"clean": not failures, "failures": failures}, True)
        else:
            result.runtime = ({"clean": True}, False)
        return result


def _looks_like_next_app(worktree: Path) -> bool:
    pkg = worktree / "package.json"
    if not pkg.exists():
        return False
    try:
        data = json.loads(pkg.read_text(encoding="utf-8"))
    except Exception:
        return False
    deps = {**(data.get("dependencies") or {}), **(data.get("devDependencies") or {})}
    return "next" in deps


_APP_DIR_ROUTE = re.compile(r"app/(.+?)/(?:page|route)\.(?:t|j)sx?$")
_PAGES_ROUTE = re.compile(r"pages/(?!api/)(.+?)\.(?:t|j)sx?$")
_API_ROUTE = re.compile(r"(?:app/(.+?)/route|pages/api/(.+?))\.(?:t|j)sx?$")


def _routes_for_changes(worktree: Path, changed_files: List[str]) -> List[str]:
    """Map changed Next.js source files to URL paths to probe.

    Conservative — bail out fast when the path doesn't look routable.
    Always include "/" if any change touched a layout or page so we get
    at least one HTTP hit per probe.
    """
    routes: List[str] = []
    for rel in changed_files:
        rel_norm = rel.replace("\\", "/")
        m_api = _API_ROUTE.search(rel_norm)
        if m_api:
            stem = m_api.group(1) or m_api.group(2) or ""
            stem = stem.replace("/index", "")
            routes.append(f"/api/{stem}".rstrip("/") or "/api")
            continue
        m_app = _APP_DIR_ROUTE.search(rel_norm)
        if m_app:
            seg = m_app.group(1).replace("(", "").replace(")", "")
            routes.append("/" + seg.lstrip("/"))
            continue
        m_pages = _PAGES_ROUTE.search(rel_norm)
        if m_pages:
            seg = m_pages.group(1)
            seg = seg.replace("/index", "")
            routes.append("/" + seg.lstrip("/"))
            continue
        if rel_norm.endswith(("layout.tsx", "layout.jsx", "layout.ts", "layout.js")):
            routes.append("/")

    # Dedup + cap. Drop dynamic-segment routes (`[id]`) since we have no
    # value to fill in; only the static prefix gets probed.
    cleaned: List[str] = []
    seen: set = set()
    for r in routes:
        # Strip dynamic segments — replace `[foo]` with `_` so the path is
        # at least valid HTTP, even if it 404s.
        r2 = re.sub(r"\[([^\]]+)\]", "_", r)
        if r2 not in seen:
            cleaned.append(r2)
            seen.add(r2)
    return cleaned[:DEV_SERVER_ROUTE_CAP]


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


async def _next_dev_probe(worktree: Path, routes: List[str]) -> List[Dict[str, Any]]:
    """Boot `next dev` on a free port, wait for ready, hit each route,
    capture 5xx + connect failures. Always tear the process down.
    """
    failures: List[Dict[str, Any]] = []
    port = _free_port()
    env = os.environ.copy()
    env.setdefault("NEXT_TELEMETRY_DISABLED", "1")
    env.setdefault("NODE_ENV", "development")

    try:
        proc = await asyncio.create_subprocess_exec(
            "npx", "--no-install", "next", "dev",
            "-p", str(port), "-H", "127.0.0.1",
            cwd=str(worktree),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=env,
        )
    except FileNotFoundError:
        return [{"file": "next-dev", "msg": "next binary not found"}]

    try:
        ready = await _wait_for_ready(proc, port, DEV_SERVER_BOOT_BUDGET_SEC)
        if not ready:
            failures.append({"file": "next-dev", "msg": f"server did not bind :{port} within {DEV_SERVER_BOOT_BUDGET_SEC}s"})
        else:
            for r in routes:
                hit = await _hit_route(port, r, DEV_SERVER_HIT_BUDGET_SEC)
                if hit is not None:
                    failures.append(hit)
    finally:
        try:
            proc.terminate()
            await asyncio.wait_for(proc.wait(), timeout=2.0)
        except (asyncio.TimeoutError, ProcessLookupError):
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            try:
                await proc.wait()
            except Exception:
                pass
    return failures


async def _wait_for_ready(proc, port: int, budget: float) -> bool:
    """Poll the port until the dev-server accepts a TCP connection or the
    process exits / budget elapses.
    """
    deadline = asyncio.get_event_loop().time() + budget
    while asyncio.get_event_loop().time() < deadline:
        if proc.returncode is not None:
            return False
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection("127.0.0.1", port),
                timeout=0.4,
            )
            writer.close()
            try:
                await writer.wait_closed()
            except Exception:
                pass
            return True
        except (OSError, asyncio.TimeoutError):
            await asyncio.sleep(0.25)
    return False


async def _hit_route(port: int, path: str, budget: float) -> Optional[Dict[str, Any]]:
    """One HTTP GET against the dev server. Returns a failure dict only
    when the server crashed or returned 5xx.
    """
    url = f"http://127.0.0.1:{port}{path if path.startswith('/') else '/' + path}"

    def _do() -> Optional[Dict[str, Any]]:
        try:
            with urllib.request.urlopen(url, timeout=budget) as resp:
                code = resp.status
                if code >= 500:
                    return {"file": path, "msg": f"dev-server returned {code}"}
                return None
        except urllib.error.HTTPError as e:
            if e.code >= 500:
                return {"file": path, "msg": f"dev-server returned {e.code}"}
            return None
        except (OSError, urllib.error.URLError) as e:
            return {"file": path, "msg": f"dev-server probe failed: {e}"}

    return await asyncio.to_thread(_do)


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
