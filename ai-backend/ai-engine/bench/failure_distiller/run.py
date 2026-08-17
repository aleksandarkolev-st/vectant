#!/usr/bin/env python3
"""Versioned, repeatable Failure Distiller benchmark runner.

The corpus records a known faulty region and accepted repair for every case.
It emits JSON for CI and a concise Markdown report for operators.  A failed
quality threshold makes the command non-zero so CI cannot silently publish a
regression.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ENGINE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ENGINE))
from analyzer.proactive.healing.failure_distiller import FailureDistiller  # noqa: E402


THRESHOLDS = {
    "reproduction_rate": 0.90,
    "reduction_rate": 0.70,
    "original_validation_rate": 0.80,
    "false_equivalence_rate": 0.00,
    "capsule_discovery_reduction": 0.50,
}


def _git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True, text=True)


def _cases(corpus: Path) -> list[dict[str, Any]]:
    return [json.loads(path.read_text(encoding="utf-8")) for path in sorted(corpus.glob("*.json"))]


async def _run_case(case: dict[str, Any]) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="vectant-distiller-benchmark-") as raw:
        root = Path(raw) / "workspace"
        root.mkdir()
        for relative, content in case["files"].items():
            target = root / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        _git(root, "init")
        _git(root, "config", "user.email", "benchmark@vectant.local")
        _git(root, "config", "user.name", "Vectant benchmark")
        _git(root, "add", ".")
        _git(root, "commit", "-m", "benchmark fixture")
        vitest = ENGINE.parents[1] / "synthi" / "node_modules" / "vitest" / "vitest.mjs"
        replacements = {"{python}": sys.executable, "{node}": shutil.which("node") or "node", "{vitest}": str(vitest)}
        command = [replacements.get(part, part) for part in case["command"]]
        request = {"workspaceRoot": str(root), "command": command, "predicate": {"type": "exit_nonzero", "required_output": [case["signature"]]}, "signature": {"required": [case["signature"]]}, "budget": {"preset": "fast", "stability_attempts": 1, "minimum_matches": 1, "max_executions": 20, "timeout_sec": 20}, "candidates": [{"kind": "file", "reference": value} for value in case["candidates"]]}
        if case.get("observation"):
            request["observation"] = case["observation"]
        distiller = FailureDistiller()
        result = await distiller.distill(request)
        accepted = bool(result.get("ok"))
        removed = int(result.get("reduction", {}).get("removed_units", 0))
        validation = None
        if accepted:
            fixed_content = case.get("fixed_content") or ("console.log('fixed');\n" if case["faulty_region"].endswith((".js", ".mjs", ".ts", ".tsx")) else "print('fixed')\n")
            # The original reproduction command is an affected check. A benchmark
            # repair must prove it fixed the real target, not merely pass a no-op.
            validation = await distiller.validate_patch({"capsulePath": result["workspace_path"], "edits": [{"path": case["faulty_region"], "content": fixed_content}], "affectedChecks": [command]})
        # The full-world baseline is an exhaustive deterministic source search:
        # every repository file is read to discover the faulty region. The capsule
        # equivalent resolves that region through one provenance lookup.
        full_searches = len(case["files"])
        # This is a deterministic path-discovery measurement, not a claim about
        # an LLM's reasoning or token consumption.
        provenance = {}
        if accepted:
            provenance = json.loads((Path(result["workspace_path"]) / "provenance.json").read_text(encoding="utf-8"))
        capsule_searches = 1 if case["faulty_region"] in provenance else full_searches
        return {
            "id": case["id"], "adapter": case["adapter"], "faulty_region": case["faulty_region"],
            "accepted_fix": case["accepted_fix"], "distill": result, "validation": validation,
            "removed_ratio": removed / len(case["candidates"]) if case["candidates"] else 0.0,
            "discovery": {"full_repository_search_operations": full_searches, "capsule_search_operations": capsule_searches},
            "cost": distiller.metrics(),
        }


async def run(corpus: Path) -> dict[str, Any]:
    results = [await _run_case(case) for case in _cases(corpus)]
    # Browser/native/HMR/GPU observations are adapter-only/experimental until
    # their real replay-to-repair round trips are independently proven. Keep
    # them in the report, never in release-quality aggregate gates.
    release = [item for item in results if item["adapter"] in {"pytest", "vitest", "test"}]
    experimental = [item for item in results if item not in release]
    total = len(release) or 1
    reproduction = sum(bool(item["distill"].get("ok")) for item in release) / total
    reduction = sum(item["removed_ratio"] for item in release) / total
    validations = [item["validation"] for item in release if item["validation"]]
    original_validation = sum(item.get("status") == "validated" for item in validations) / len(validations) if validations else 0.0
    false_equivalence = sum(item.get("status") in {"original_validation_failed", "capsule_fix_failed"} for item in validations) / len(validations) if validations else 0.0
    full_searches = sum(item["discovery"]["full_repository_search_operations"] for item in release)
    capsule_searches = sum(item["discovery"]["capsule_search_operations"] for item in release)
    discovery_reduction = 1.0 - (capsule_searches / full_searches) if full_searches else 0.0
    candidate_executions = sum(item["cost"]["candidate_executions"] for item in release)
    cache_hits = sum(item["cost"]["cache_hits"] for item in release)
    metrics = {
        "reproduction_rate": reproduction, "reduction_rate": reduction,
        "original_validation_rate": original_validation, "false_equivalence_rate": false_equivalence,
        "capsule_discovery_reduction": discovery_reduction,
        "agent_utility": {"measurement": "deterministic_path_discovery", "full_repository_search_operations": full_searches, "capsule_search_operations": capsule_searches},
        "cache_effectiveness": {"cache_hits": cache_hits, "candidate_executions": candidate_executions, "cache_hit_rate": cache_hits / (cache_hits + candidate_executions) if cache_hits + candidate_executions else 0.0},
        "cost": {"release_cases": len(release), "experimental_cases_excluded": len(experimental), "candidate_executions": candidate_executions},
    }
    gates = {name: value >= THRESHOLDS[name] if name != "false_equivalence_rate" else value <= THRESHOLDS[name] for name, value in metrics.items() if name in THRESHOLDS}
    return {"schema_version": "vectant.failure_distiller.benchmark.v1", "generated_at": datetime.now(timezone.utc).isoformat(), "thresholds": THRESHOLDS, "metrics": metrics, "gates": gates, "ok": all(gates.values()), "cases": results}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", type=Path, default=Path(__file__).parent / "corpus" / "v1")
    parser.add_argument("--json", type=Path, required=True)
    parser.add_argument("--markdown", type=Path, required=True)
    args = parser.parse_args()
    report = asyncio.run(run(args.corpus))
    args.json.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    rows = ["# Failure Distiller benchmark", "", f"Status: {'PASS' if report['ok'] else 'FAIL'}", "", "| Metric | Value | Threshold |", "|---|---:|---:|"]
    for name, threshold in report["thresholds"].items():
        rows.append(f"| {name} | {report['metrics'][name]:.2%} | {'≤' if name == 'false_equivalence_rate' else '≥'} {threshold:.2%} |")
    utility = report["metrics"]["agent_utility"]
    cache = report["metrics"]["cache_effectiveness"]
    rows.extend([
        "", "| Operational metric | Value |", "|---|---:|",
        f"| Full-repository path discovery operations | {utility['full_repository_search_operations']} |",
        f"| Capsule path discovery operations | {utility['capsule_search_operations']} |",
        f"| Release-quality cases | {report['metrics']['cost']['release_cases']} |",
        f"| Experimental cases excluded from gates | {report['metrics']['cost']['experimental_cases_excluded']} |",
        f"| Candidate executions | {report['metrics']['cost']['candidate_executions']} |",
        f"| Cache hit rate | {cache['cache_hit_rate']:.2%} |",
        "", "| Case | Adapter | Result |", "|---|---|---|",
    ])
    rows.extend(f"| {item['id']} | {item['adapter']} | {'accepted' if item['distill'].get('ok') else item['distill'].get('status')} |" for item in report["cases"])
    args.markdown.write_text("\n".join(rows) + "\n", encoding="utf-8")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
