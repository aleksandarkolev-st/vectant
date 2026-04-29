"""Run the shadow pipeline against a corpus and emit metrics.

Invoke via:  python -m bench.harness --corpus bench/corpus --out bench/report.md
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

# Allow running via `python -m bench.harness` from the ai-engine dir.
_AI_ENGINE = Path(__file__).resolve().parent.parent
if str(_AI_ENGINE) not in sys.path:
    sys.path.insert(0, str(_AI_ENGINE))

from shadow import events as ev_mod  # noqa: E402
from shadow.api import _resolve_patches  # noqa: E402
from shadow.api import PatchModel  # noqa: E402
from shadow.multiverse import run_job  # noqa: E402

logger = logging.getLogger("bench.harness")


@dataclass
class FixtureResult:
    fixture_id: str
    duration_s: float
    success: bool
    universes: Dict[str, Any] = field(default_factory=dict)
    error: Optional[str] = None


async def _ensure_git_repo(workspace: Path) -> None:
    """The shadow worktree pool requires a git repo. Initialize one in
    the fixture's workspace if it isn't already a repo. Idempotent.
    """
    if (workspace / ".git").exists():
        return
    proc = await asyncio.create_subprocess_exec(
        "git", "init", "-q", "--initial-branch=main",
        cwd=str(workspace),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
    )
    await proc.communicate()
    # Configure a local identity so commit doesn't depend on global config.
    for key, val in (("user.email", "bench@synthi-genome"), ("user.name", "Synthi Bench")):
        p = await asyncio.create_subprocess_exec(
            "git", "config", "--local", key, val, cwd=str(workspace),
            stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
        )
        await p.communicate()
    p = await asyncio.create_subprocess_exec(
        "git", "add", "-A", cwd=str(workspace),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
    )
    await p.communicate()
    p = await asyncio.create_subprocess_exec(
        "git", "commit", "-q", "-m", "bench: initial fixture",
        cwd=str(workspace),
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
    )
    await p.communicate()


async def run_fixture(fixture_dir: Path) -> FixtureResult:
    started = time.time()
    fixture_id = fixture_dir.name
    workspace = fixture_dir / "workspace"
    if not workspace.is_dir():
        return FixtureResult(fixture_id, 0.0, False, error="missing workspace/")

    await _ensure_git_repo(workspace)

    try:
        request = (fixture_dir / "request.txt").read_text(encoding="utf-8").strip()
    except FileNotFoundError:
        return FixtureResult(fixture_id, 0.0, False, error="missing request.txt")

    metadata: Dict[str, Any] = {}
    meta_path = fixture_dir / "metadata.json"
    if meta_path.exists():
        metadata = json.loads(meta_path.read_text(encoding="utf-8"))

    # The harness expects `seed_patches.json` describing the chat-supplied
    # patches the pipeline should evaluate. Real corpora use the golden patch
    # as the seed and rely on the runner + Critic to validate.
    seed_path = fixture_dir / "seed_patches.json"
    if not seed_path.exists():
        return FixtureResult(fixture_id, 0.0, False, error="missing seed_patches.json")
    seed_models = [PatchModel(**p) for p in json.loads(seed_path.read_text(encoding="utf-8"))]
    seed = _resolve_patches(workspace, seed_models)

    job = ev_mod.JobState(
        job_id=f"bench_{fixture_id}",
        tier=metadata.get("tier", "standard"),
        workspace_path=str(workspace),
        user_id="bench",
    )
    ev_mod.register(job)

    # Drain queue concurrently so the job doesn't block.
    drained: List[Dict[str, Any]] = []
    async def _drain():
        while True:
            try:
                evt = await asyncio.wait_for(job.queue.get(), timeout=60.0)
            except asyncio.TimeoutError:
                break
            if evt.get("type") == "_eof":
                break
            drained.append(evt)
    drain_task = asyncio.create_task(_drain())

    try:
        await run_job(
            job=job, repo=workspace, seed_patches=seed,
            user_request=request, intent=metadata.get("intent", "fix"),
        )
    except Exception as e:
        await drain_task
        return FixtureResult(fixture_id, time.time() - started, False, error=str(e))

    await drain_task
    return FixtureResult(
        fixture_id=fixture_id,
        duration_s=time.time() - started,
        success=True,
        universes=dict(job.universes),
    )


async def main(corpus: Path, out: Path, results_json: Optional[Path] = None) -> int:
    fixtures = sorted([p for p in corpus.iterdir() if p.is_dir()])
    if not fixtures:
        logger.warning("corpus is empty: %s", corpus)
    results: List[FixtureResult] = []
    for f in fixtures:
        logger.info("running fixture %s", f.name)
        results.append(await run_fixture(f))

    from .metrics import summarize
    from .report import render

    summary = summarize(results)
    out.write_text(render(summary, results), encoding="utf-8")
    logger.info("wrote %s", out)

    if results_json is not None:
        # Capture the raw evidence for offline tooling (weight tuner).
        payload = [
            {
                "fixture_id": r.fixture_id,
                "duration_s": r.duration_s,
                "success": r.success,
                "error": r.error,
                "universes": r.universes,
            }
            for r in results
        ]
        results_json.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        logger.info("wrote %s", results_json)
    return 0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", default="bench/corpus")
    parser.add_argument("--out", default="bench/report.md")
    parser.add_argument("--results-json", default="bench/results.json",
                        help="Per-universe evidence dump for the weight tuner.")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    rc = asyncio.run(main(
        Path(args.corpus), Path(args.out),
        results_json=Path(args.results_json) if args.results_json else None,
    ))
    sys.exit(rc)
