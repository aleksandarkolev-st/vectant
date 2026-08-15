import asyncio
from pathlib import Path

from bench.failure_distiller.run import run


def test_versioned_failure_distiller_benchmark_meets_release_gates():
    report = asyncio.run(run(Path(__file__).parents[1] / "bench" / "failure_distiller" / "corpus" / "v1"))
    assert report["ok"], report
    assert {"test", "browser", "native", "hmr", "gpu"} <= {case["adapter"] for case in report["cases"]}
    assert all(case["validation"]["status"] == "validated" for case in report["cases"])
    assert report["metrics"]["agent_utility"]["capsule_search_operations"] < report["metrics"]["agent_utility"]["full_repository_search_operations"]
    assert report["metrics"]["cost"]["candidate_executions"] > 0
