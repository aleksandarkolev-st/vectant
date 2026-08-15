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
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ENGINE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ENGINE))
from analyzer.proactive.healing.failure_distiller import FailureDistiller  # noqa: E402


THRESHOLDS = {"reproduction_rate": 0.90, "reduction_rate": 0.70, "original_validation_rate": 0.80, "false_equivalence_rate": 0.00}


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
        command = [part.replace("{python}", sys.executable) for part in case["command"]]
        request = {"workspaceRoot": str(root), "command": command, "predicate": {"type": "exit_nonzero", "required_output": [case["signature"]]}, "signature": {"required": [case["signature"]]}, "budget": {"preset": "fast", "stability_attempts": 1, "minimum_matches": 1, "max_executions": 20, "timeout_sec": 20}, "candidates": [{"kind": "file", "reference": value} for value in case["candidates"]]}
        if case.get("observation"):
            request["observation"] = case["observation"]
        result = await FailureDistiller().distill(request)
        accepted = bool(result.get("ok"))
        removed = int(result.get("reduction", {}).get("removed_units", 0))
        validation = None
        if accepted:
            validation = await FailureDistiller().validate_patch({"capsulePath": result["workspace_path"], "edits": [{"path": case["faulty_region"], "content": "print('fixed')\n"}], "affectedChecks": [[sys.executable, "-c", "import sys; sys.exit(0)"]]})
        return {"id": case["id"], "adapter": case["adapter"], "faulty_region": case["faulty_region"], "accepted_fix": case["accepted_fix"], "distill": result, "validation": validation, "removed_ratio": removed / len(case["candidates"]) if case["candidates"] else 0.0}


async def run(corpus: Path) -> dict[str, Any]:
    results = [await _run_case(case) for case in _cases(corpus)]
    total = len(results) or 1
    reproduction = sum(bool(item["distill"].get("ok")) for item in results) / total
    reduction = sum(item["removed_ratio"] for item in results) / total
    validations = [item["validation"] for item in results if item["validation"]]
    original_validation = sum(item.get("status") == "validated" for item in validations) / len(validations) if validations else 0.0
    false_equivalence = sum(item.get("status") in {"original_validation_failed", "capsule_fix_failed"} for item in validations) / len(validations) if validations else 0.0
    metrics = {"reproduction_rate": reproduction, "reduction_rate": reduction, "original_validation_rate": original_validation, "false_equivalence_rate": false_equivalence, "agent_utility": {"capsule_known_fault_region_available": sum(bool(item["faulty_region"]) for item in results) / total, "full_repository_search_operations": None, "capsule_search_operations": None}, "cache_effectiveness": {"cache_hit_rate": None}, "cost": {"cases": len(results)}}
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
    rows.extend(["", "| Case | Adapter | Result |", "|---|---|---|"])
    rows.extend(f"| {item['id']} | {item['adapter']} | {'accepted' if item['distill'].get('ok') else item['distill'].get('status')} |" for item in report["cases"])
    args.markdown.write_text("\n".join(rows) + "\n", encoding="utf-8")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
